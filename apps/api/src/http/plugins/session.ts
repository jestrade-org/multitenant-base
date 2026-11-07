import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The session, as cookies the browser cannot read.
 *
 * Three cookies, and each one earns its place:
 *
 *   `mtb_at`  the access token — httpOnly, so XSS cannot read it
 *   `mtb_rt`  the refresh token — httpOnly, and scoped to the refresh path only, so it
 *              is not sent on every request it is not needed for
 *   `mtb_csrf` a random value that is *not* httpOnly, because the client has to read it
 *              and echo it back in a header
 *
 * The last one is the double-submit defence. `SameSite=Lax` already stops the common
 * cross-site POST, but it is a browser policy rather than a check we perform, and it does
 * nothing for a same-site subdomain an attacker gets a foothold on. A value that must be
 * copied from a cookie into a header cannot be forged by a page that cannot read the
 * cookie.
 *
 * Ref: Tech specs §8.2; security-iaaa.md.
 */

export const ACCESS_COOKIE = 'mtb_at';
export const REFRESH_COOKIE = 'mtb_rt';
export const CSRF_COOKIE = 'mtb_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** The refresh token is only ever sent to the one endpoint that consumes it. */
export const REFRESH_PATH = '/api/v1/auth/session/refresh';

export interface SessionCookieOptions {
  readonly secure: boolean;
  readonly accessMaxAgeSeconds: number;
  /** Absolute session lifetime. A refresh token older than this stops working. */
  readonly refreshMaxAgeSeconds: number;
}

export function issueSession(
  reply: FastifyReply,
  tokens: { readonly accessToken: string; readonly refreshToken: string },
  options: SessionCookieOptions,
): string {
  const csrfToken = randomBytes(32).toString('base64url');

  void reply.setCookie(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: options.accessMaxAgeSeconds,
  });

  void reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'strict',
    // Narrower than the access cookie on purpose: a token that is not sent is a token
    // that cannot leak from a request that had no use for it.
    path: REFRESH_PATH,
    maxAge: options.refreshMaxAgeSeconds,
  });

  void reply.setCookie(CSRF_COOKIE, csrfToken, {
    // Readable by design — the client copies it into a header. It is not a credential:
    // knowing it proves only that you can read this site's cookies, which is the point.
    httpOnly: false,
    secure: options.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: options.refreshMaxAgeSeconds,
  });

  return csrfToken;
}

export function clearSession(reply: FastifyReply, options: { readonly secure: boolean }): void {
  const base = { secure: options.secure, sameSite: 'lax' as const, path: '/' };
  void reply.clearCookie(ACCESS_COOKIE, { ...base, httpOnly: true });
  void reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
  void reply.clearCookie(REFRESH_COOKIE, {
    secure: options.secure,
    sameSite: 'strict',
    path: REFRESH_PATH,
    httpOnly: true,
  });
}

export function readAccessToken(request: FastifyRequest): string | undefined {
  return request.cookies[ACCESS_COOKIE];
}

export function readRefreshToken(request: FastifyRequest): string | undefined {
  return request.cookies[REFRESH_COOKIE];
}

/**
 * Checks the double-submit token.
 *
 * Compared in constant time. The window is small — an attacker would need many attempts
 * to read a secret a byte at a time — but comparing secrets with `===` is a habit that is
 * only ever wrong, and the cost of doing it properly is nothing.
 */
export function hasValidCsrfToken(request: FastifyRequest): boolean {
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  const presented = Array.isArray(header) ? header[0] : header;

  if (cookie === undefined || presented === undefined) return false;

  const a = Buffer.from(cookie);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
