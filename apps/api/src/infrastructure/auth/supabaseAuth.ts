import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Logger } from 'pino';

/**
 * Authentication, brokered through Supabase Auth.
 *
 * Two rules shape everything here:
 *
 * **We never hand-roll authentication.** Passwords are hashed, compared and rotated by
 * the provider. This module holds a plaintext password only for the microseconds it takes
 * to forward it, and never logs, stores or returns one.
 *
 * **The browser never receives a token.** The client posts credentials to our API; the
 * API talks to the provider and puts the tokens in httpOnly cookies. That is what makes
 * "never store tokens in localStorage" achievable rather than aspirational — a token the
 * browser cannot read is a token XSS cannot steal.
 *
 * Ref: Tech specs §8.2; security-iaaa.md.
 */

export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds until the access token expires, as the provider reports it. */
  readonly expiresIn: number;
}

export interface VerifiedPrincipal {
  /** `sub` from the verified token: the canonical user id. Never an email. */
  readonly authUserId: string;
  readonly email: string | undefined;
  readonly expiresAt: number;
}

export type AuthFailure =
  | { readonly reason: 'invalid-credentials' }
  | { readonly reason: 'provider-unavailable' }
  | { readonly reason: 'rate-limited' };

export class AuthenticationError extends Error {
  public constructor(public readonly failure: AuthFailure) {
    super(failure.reason);
    this.name = 'AuthenticationError';
  }
}

export interface SupabaseAuthOptions {
  /** e.g. http://127.0.0.1:55321/auth/v1 */
  readonly authUrl: string;
  /** The publishable anon key. Public by design; it only identifies the project. */
  readonly anonKey: string;
  readonly logger: Logger;
  /** Bounded so a slow provider surfaces as a fast failure, not a hung login. */
  readonly timeoutMs?: number;
}

export class SupabaseAuth {
  readonly #authUrl: string;
  readonly #anonKey: string;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  public constructor(options: SupabaseAuthOptions) {
    this.#authUrl = options.authUrl.replace(/\/$/, '');
    this.#anonKey = options.anonKey;
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? 5_000;

    // Asymmetric verification against the provider's published keys. The API never holds
    // a signing secret, so a compromise of this process cannot mint tokens.
    this.#jwks = createRemoteJWKSet(new URL(`${this.#authUrl}/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
    });
  }

  /**
   * Exchanges an email and password for tokens.
   *
   * Every failure that could distinguish "no such account" from "wrong password" is
   * collapsed into one: signup, login and reset must answer identically whether the
   * account exists, or the login form becomes a way to enumerate customers' staff.
   */
  public async signInWithPassword(email: string, password: string): Promise<AuthTokens> {
    const response = await this.#post('/token?grant_type=password', { email, password });

    if (!response.ok) {
      if (response.status === 429) throw new AuthenticationError({ reason: 'rate-limited' });
      if (response.status >= 500) {
        this.#logger.error({ status: response.status }, 'auth provider returned an error');
        throw new AuthenticationError({ reason: 'provider-unavailable' });
      }
      // 400 and 401 are both "these credentials do not work". The distinction the
      // provider draws is not passed on.
      throw new AuthenticationError({ reason: 'invalid-credentials' });
    }

    return this.#readTokens(await response.json());
  }

  /**
   * Rotates a refresh token.
   *
   * The provider is configured to rotate on use with reuse detection: presenting a
   * refresh token twice revokes the whole family, on the assumption that the second
   * presenter stole it.
   */
  public async refresh(refreshToken: string): Promise<AuthTokens> {
    const response = await this.#post('/token?grant_type=refresh_token', {
      refresh_token: refreshToken,
    });

    if (!response.ok) throw new AuthenticationError({ reason: 'invalid-credentials' });
    return this.#readTokens(await response.json());
  }

  /**
   * Ends the session at the provider.
   *
   * Clearing the cookie alone would leave a refresh token that still works — logout has
   * to revoke server-side, or "log out" means "hide the key" (§8.2).
   */
  public async signOut(accessToken: string): Promise<void> {
    try {
      await fetch(`${this.#authUrl}/logout`, {
        method: 'POST',
        headers: {
          apikey: this.#anonKey,
          authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error: unknown) {
      // The cookies are cleared regardless. A failed revocation is logged and alerted on;
      // leaving the browser logged in because the provider hiccuped would be worse.
      this.#logger.error({ err: error }, 'could not revoke session at the auth provider');
    }
  }

  /**
   * Verifies a token: signature against the JWKS, plus issuer, audience and expiry.
   *
   * Never `decode` without verify. A decoded token is a claim the caller made about
   * themselves.
   */
  public async verify(accessToken: string): Promise<VerifiedPrincipal | undefined> {
    try {
      const { payload } = await jwtVerify(accessToken, this.#jwks, {
        issuer: this.#authUrl,
        audience: 'authenticated',
      });
      return this.#readPrincipal(payload);
    } catch {
      // An invalid or expired token is an ordinary event, not an error worth a stack
      // trace on every request. The caller turns it into a 401.
      return undefined;
    }
  }

  #readPrincipal(payload: JWTPayload): VerifiedPrincipal | undefined {
    const sub = payload.sub;
    const exp = payload.exp;
    if (typeof sub !== 'string' || typeof exp !== 'number') return undefined;
    return {
      authUserId: sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      expiresAt: exp,
    };
  }

  #readTokens(body: unknown): AuthTokens {
    const payload = body as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof payload.access_token !== 'string' ||
      typeof payload.refresh_token !== 'string' ||
      typeof payload.expires_in !== 'number'
    ) {
      throw new AuthenticationError({ reason: 'provider-unavailable' });
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresIn: payload.expires_in,
    };
  }

  async #post(path: string, body: Record<string, unknown>): Promise<Response> {
    try {
      return await fetch(`${this.#authUrl}${path}`, {
        method: 'POST',
        headers: { apikey: this.#anonKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error: unknown) {
      this.#logger.error({ err: error, path }, 'auth provider is unreachable');
      throw new AuthenticationError({ reason: 'provider-unavailable' });
    }
  }
}
