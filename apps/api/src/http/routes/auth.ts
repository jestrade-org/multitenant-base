import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { AuditWriter } from '../../infrastructure/auditRecorder.js';
import { AuthenticationError, type SupabaseAuth } from '../../infrastructure/auth/supabaseAuth.js';
import type { ControlDatabase } from '../../infrastructure/controlDatabase.js';
import { resolvePlatformPrincipal, resolvePrincipal } from '../plugins/authentication.js';
import {
  clearSession,
  issueSession,
  readAccessToken,
  readRefreshToken,
  type SessionCookieOptions,
} from '../plugins/session.js';

/**
 * The session endpoints.
 *
 * A session is a resource: creating one is a POST, ending it is a DELETE. The tokens
 * never appear in a response body — they go into httpOnly cookies, and the body carries
 * only what the interface needs to render.
 *
 * Ref: Tech specs §8.2; api-design.md.
 */

const credentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    // Bounded, not validated for shape: rejecting a *correct* password because it is
    // longer than we expected is a bug, and the provider owns the policy anyway.
    password: z.string().min(1).max(256),
  })
  .strict();

export interface AuthRoutesOptions {
  readonly auth: SupabaseAuth;
  readonly controlDatabase: ControlDatabase;
  readonly cookies: SessionCookieOptions;
  /** Records the §8.4 authentication events. Never blocks the response. */
  readonly audit: AuditWriter;
}

/**
 * The address is recorded on a failed sign-in, and it is the whole point.
 *
 * Without it the trail says "someone failed to log in" a thousand times and answers no
 * question. With it, a credential-stuffing run against one company is visible. The address
 * is not a credential — knowing it grants nothing (§8.1) — and it is the identifier the
 * person themselves would quote to support.
 */
function actorFor(email: string | undefined): string {
  return email ?? 'unknown';
}

/** One shape for every failure: the response must not say which part was wrong. */
function invalidCredentials(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('INVALID_CREDENTIALS'), {
    statusCode: 401,
    code: 'INVALID_CREDENTIALS',
  });
}

export const authRoutes: FastifyPluginCallback<AuthRoutesOptions> = (app, options, ready) => {
  const { auth, controlDatabase, cookies, audit } = options;

  /**
   * Sign in.
   *
   * Rate limited harder than the rest of the API: this is the endpoint someone brings a
   * password list to. The limit is per IP here; per-account lockout lands with the audit
   * trail that can count attempts (VC-35).
   */
  app.post(
    '/api/v1/auth/session',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const parsed = credentialsSchema.safeParse(request.body);
      if (!parsed.success) {
        // A malformed body and wrong credentials answer identically. Anything else lets
        // a caller learn which addresses exist by watching the shape of the rejection.
        throw invalidCredentials();
      }

      let tokens;
      try {
        tokens = await auth.signInWithPassword(parsed.data.email, parsed.data.password);
      } catch (error: unknown) {
        if (error instanceof AuthenticationError) {
          if (error.failure.reason === 'provider-unavailable') {
            request.log.error('auth provider unavailable during sign-in');
            throw Object.assign(new Error('AUTH_UNAVAILABLE'), {
              statusCode: 503,
              code: 'AUTH_UNAVAILABLE',
            });
          }
          if (error.failure.reason === 'rate-limited') {
            throw Object.assign(new Error('TOO_MANY_ATTEMPTS'), {
              statusCode: 429,
              code: 'TOO_MANY_ATTEMPTS',
            });
          }
        }
        request.log.info({ email: parsed.data.email }, 'sign-in rejected');
        audit.recordInBackground({
          occurredAt: new Date(),
          actorType: 'user',
          actorId: actorFor(parsed.data.email),
          action: 'authentication.sign_in_failed',
          result: 'denied',
          ipAddress: request.ip,
          correlationId: request.id,
        });
        throw invalidCredentials();
      }

      const verified = await auth.verify(tokens.accessToken);
      if (verified === undefined) throw invalidCredentials();

      const principal = await resolvePrincipal(
        { controlDatabase },
        verified.authUserId,
        verified.email,
      );

      // platform staff are not members of any tenant (§8.1), so a failed membership lookup is
      // not yet a failed sign-in. Their identity lives in a different table and carries no
      // company at all.
      const staff =
        principal === undefined
          ? await resolvePlatformPrincipal({ controlDatabase }, verified.authUserId)
          : undefined;

      if (principal === undefined && staff !== undefined) {
        const csrfToken = issueSession(reply, tokens, cookies);

        audit.recordInBackground({
          occurredAt: new Date(),
          actorType: 'platform_admin',
          actorId: staff.authUserId,
          action: 'authentication.signed_in',
          result: 'success',
          ipAddress: request.ip,
          correlationId: request.id,
        });

        return reply.code(201).send({
          csrfToken,
          user: { fullName: staff.fullName, email: staff.email, roleCode: staff.roleCode },
          // No tenant, and deliberately null rather than absent: the client renders a
          // platform session differently, and a missing key would be read as "still
          // loading" by anything that checks for one.
          tenant: null,
          permissions: staff.permissions,
          // A fresh sign-in is never a support session: a grant is opened afterwards, from
          // inside the platform panel.
          supportAccess: null,
        });
      }

      if (principal === undefined) {
        // Authenticated, but a member of nothing that serves traffic. Revoke immediately
        // rather than leaving a usable token attached to an account that cannot act.
        await auth.signOut(tokens.accessToken);
        request.log.warn({ authUserId: verified.authUserId }, 'sign-in by a non-member');
        audit.recordInBackground({
          occurredAt: new Date(),
          actorType: 'user',
          actorId: verified.authUserId,
          action: 'authentication.sign_in_failed',
          result: 'denied',
          ipAddress: request.ip,
          correlationId: request.id,
          changes: { reason: 'no active membership' },
        });
        throw invalidCredentials();
      }

      const csrfToken = issueSession(reply, tokens, cookies);

      audit.recordInBackground({
        occurredAt: new Date(),
        tenantId: principal.tenantId,
        actorType: 'user',
        actorId: principal.authUserId,
        action: 'authentication.signed_in',
        result: 'success',
        ipAddress: request.ip,
        correlationId: request.id,
      });

      return reply.code(201).send({
        csrfToken,
        user: {
          fullName: principal.fullName,
          email: principal.email,
          roleCode: principal.roleCode,
        },
        tenant: {
          name: principal.tenantName,
          subdomain: principal.subdomain,
          timezone: principal.timezone,
        },
        permissions: principal.permissions,
        supportAccess: null,
      });
    },
  );

  /**
   * Rotate the session.
   *
   * The refresh cookie is scoped to this path, so it is the only request that carries it.
   * The provider rotates on use with reuse detection: presenting the same refresh token
   * twice revokes the whole family.
   */
  app.post(
    '/api/v1/auth/session/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const refreshToken = readRefreshToken(request);
      if (refreshToken === undefined) throw invalidCredentials();

      try {
        const tokens = await auth.refresh(refreshToken);
        const csrfToken = issueSession(reply, tokens, cookies);
        // Awaited inside the try on purpose: returning the promise unawaited would let a
        // send failure escape this catch and skip clearing the cookies.
        return await reply.code(200).send({ csrfToken });
      } catch {
        // A refresh that fails means the session is over — clear it rather than leaving
        // the browser holding cookies that will fail on every subsequent request.
        clearSession(reply, { secure: cookies.secure });
        throw invalidCredentials();
      }
    },
  );

  /**
   * Sign out.
   *
   * Revokes at the provider *and* clears the cookies. Clearing alone would leave a
   * refresh token that still works, which makes "log out" mean "hide the key".
   */
  app.delete('/api/v1/auth/session', async (request, reply) => {
    const accessToken = readAccessToken(request);
    if (accessToken !== undefined) await auth.signOut(accessToken);
    clearSession(reply, { secure: cookies.secure });

    const principal = request.principal;
    const staff = request.platformPrincipal;

    if (principal !== undefined) {
      audit.recordInBackground({
        occurredAt: new Date(),
        tenantId: principal.tenantId,
        actorType: 'user',
        actorId: principal.authUserId,
        action: 'authentication.signed_out',
        result: 'success',
        ipAddress: request.ip,
        correlationId: request.id,
      });
    } else if (staff !== undefined) {
      audit.recordInBackground({
        occurredAt: new Date(),
        actorType: 'platform_admin',
        actorId: staff.authUserId,
        action: 'authentication.signed_out',
        result: 'success',
        ipAddress: request.ip,
        correlationId: request.id,
      });
    }

    return reply.code(204).send();
  });

  /** Who the current session belongs to. The client renders from this, never from a token. */
  app.get('/api/v1/auth/me', (request, reply) => {
    const staff = request.platformPrincipal;
    if (staff !== undefined) {
      return reply.send({
        user: { fullName: staff.fullName, email: staff.email, roleCode: staff.roleCode },
        tenant: null,
        permissions: staff.permissions,
        supportAccess: null,
      });
    }

    const principal = request.principal;
    if (principal === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    /**
     * A support session says so, on every screen, for as long as it lasts.
     *
     * Not a nicety. A staff member who forgets which account they are in makes a change
     * in the wrong company's books, and the client reading the audit trail afterwards
     * finds our name on it either way. The interface carrying the state is the cheapest
     * of the three controls around this feature, and the only one the person can see.
     */
    const support = request.supportAccess;

    return reply.send({
      user: {
        fullName: principal.fullName,
        email: principal.email,
        roleCode: principal.roleCode,
      },
      tenant: {
        name: principal.tenantName,
        subdomain: principal.subdomain,
        timezone: principal.timezone,
      },
      permissions: principal.permissions,
      supportAccess:
        support === undefined
          ? null
          : {
              grantId: support.grantId,
              // Who is really here. The client shows it, and the person can read their own
              // name and check they are where they meant to be.
              staffFullName: support.staffFullName,
              staffEmail: support.staffEmail,
              expiresAt: support.expiresAt,
              reason: support.reason,
            },
    });
  });

  ready();
};
