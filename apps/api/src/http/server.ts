import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import type { Logger } from 'pino';

import type { TenantDirectory } from '@multitenant-base/tenancy';

import type { AppConfig } from '../config/environment.js';
import type { AuditWriter } from '../infrastructure/auditRecorder.js';
import type { SupabaseAuth } from '../infrastructure/auth/supabaseAuth.js';
import type { ControlDatabase } from '../infrastructure/controlDatabase.js';
import { authenticationPlugin, tenantIdFromPrincipal } from './plugins/authentication.js';
import {
  CORRELATION_HEADER,
  correlationIdPlugin,
  resolveCorrelationId,
} from './plugins/correlationId.js';
import { tenantContextPlugin } from './plugins/tenantContext.js';
import { auditTrailRoutes, type AuditTrailRoutesOptions } from './routes/auditTrail.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes, type ReadinessRegistry } from './routes/health.js';
import { planRoutes, type PlanRoutesOptions } from './routes/plans.js';
import { platformRoutes, type PlatformRoutesOptions } from './routes/platform.js';
import { queueRoutes, type QueueRoutesOptions } from './routes/queues.js';
import { roleRoutes, type RoleRoutesOptions } from './routes/roles.js';
import { supportAccessRoutes, type SupportAccessRoutesOptions } from './routes/supportAccess.js';

/**
 * Builds the HTTP server.
 *
 * The registration order below *is* the middleware order, and it is not arbitrary — a
 * layer that runs too late is a layer that can be bypassed:
 *
 *   1. correlation id          — every later layer logs against it
 *   2. structured logger       — bound once per request, never re-bound by hand
 *   3. security headers, CORS  — before anything reads the body
 *   4. body limit, rate limit  — bound cost before doing work
 *   5. authentication          — verify the JWT server-side  (VC-29, VC-30)
 *   6. tenant resolution       — before any business logic   (VC-24)
 *   7. schema validation       — per route
 *   8. authorization           — inside the use case, the authoritative decision point
 *   9. audit                   — same transaction as the change (VC-34, VC-35)
 *  10. central error mapper    — last
 *
 * Business routes land with their guard, never before it.
 */

export interface BuildServerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly readiness: ReadinessRegistry;
  readonly isAcceptingTraffic: () => boolean;
  readonly tenantDirectory: TenantDirectory;
  readonly auth: SupabaseAuth;
  readonly controlDatabase: ControlDatabase;
  /** Writes the §8.4 authentication events. */
  readonly audit: AuditWriter;
  /** Role, member and API key administration (§8.3). Optional so health-only tests need not wire it. */
  readonly roles?: RoleRoutesOptions;
  /** The platform panel (§9). Optional for the same reason. */
  readonly platform?: PlatformRoutesOptions;
  /** Plans, quotas and usage (§4.2, §9). Optional for the same reason. */
  readonly plans?: PlanRoutesOptions;
  /** Queue and dead-letter monitoring (§7, §9). Optional for the same reason. */
  readonly queues?: QueueRoutesOptions;
  /** The cross-tenant audit query (§8.4, §9). Optional for the same reason. */
  readonly auditTrail?: AuditTrailRoutesOptions;
  /** Entering and leaving a client's account (§8.1, VC-101). */
  readonly supportAccess?: SupportAccessRoutesOptions;
}

/**
 * Maps a domain or application error to its HTTP status (api-design.md).
 *
 * Without this everything the domain throws arrives as a 500, and an authorization refusal
 * — the most common non-success outcome in the system — is reported to the client as "we
 * broke". A user then sees a broken screen where they should see "you cannot do that", and
 * an operator sees an error page in the logs for something working exactly as designed.
 *
 * A resource that is not visible to this tenant is 404 rather than 403 on purpose: a 403
 * confirms it exists (§8.3).
 */
function statusForDomainError(error: { readonly code?: string }): number {
  // An error with no code is not a domain error at all — it is a bug, a driver failure, or
  // something nobody classified. 500 with a correlation id is the honest answer.
  if (error.code === undefined) return 500;

  switch (error.code) {
    case 'NOT_AUTHORIZED':
      return 403;
    case 'ROLE_NOT_FOUND':
    case 'TENANT_NOT_FOUND':
    case 'API_KEY_NOT_FOUND':
    case 'MEMBER_NOT_FOUND':
    case 'PLAN_NOT_FOUND':
      return 404;
    case 'CONCURRENCY_CONFLICT':
      return 409;
    case 'TENANT_ALREADY_REGISTERED':
      return 409;
    case 'VALIDATION_FAILED':
    case 'AUDIT_WINDOW_TOO_WIDE':
      return 400;
    // A business rule said no: the request was well-formed and the caller was allowed to
    // make it, but the domain refuses.
    case 'ROLE_NOT_ASSIGNABLE':
    case 'CAPABILITY_NOT_DELEGATABLE':
    case 'API_KEY_REVOKED':
    case 'CANNOT_DEACTIVATE_SELF':
    case 'LAST_ADMINISTRATOR':
    case 'MEMBER_ALREADY_INVITED':
    case 'PLAN_CODE_ALREADY_EXISTS':
    case 'PLAN_QUOTA_EXCEEDED':
    case 'ROLE_CODE_ALREADY_EXISTS':
    case 'ROLE_IS_SYSTEM_DEFINED':
    case 'ROLE_STILL_ASSIGNED':
    case 'PERMISSION_NOT_GRANTABLE':
      return 409;
    default:
      return 500;
  }
}

/**
 * The parameters a domain error carries, if they are safe to send.
 *
 * Only primitives, and only from an error that declared them: an arbitrary `error.params`
 * could be a driver payload holding a connection string, and this is the one place that
 * decides what leaves the process.
 */
function safeParams(error: unknown): { readonly params?: Readonly<Record<string, string>> } {
  if (typeof error !== 'object' || error === null || !('params' in error)) return {};

  const params = (error as { readonly params: unknown }).params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return {};

  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = String(value);
    }
  }

  return Object.keys(safe).length === 0 ? {} : { params: safe };
}

export async function buildServer(options: BuildServerOptions) {
  const {
    config,
    logger,
    readiness,
    isAcceptingTraffic,
    tenantDirectory,
    auth,
    controlDatabase,
    audit,
    roles,
    platform,
    plans,
    queues,
    auditTrail,
    supportAccess,
  } = options;

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: config.http.bodyLimitBytes,
    // Trust the proxy only where one actually terminates TLS in front of us; otherwise
    // a client could spoof its own source address for rate limiting and audit records.
    trustProxy: config.isProduction,
    genReqId: (request) => resolveCorrelationId(request.headers[CORRELATION_HEADER]),
  });

  // The central error mapper and the not-found handler are *registered* first, even
  // though they *run* last: in Fastify a child context inherits the handler that existed
  // when it was created, so registering after the routes leaves them answering with the
  // framework's default shape. That default leaks `"error":"Unauthorized"` and drops the
  // correlation id the contract promises (api-design.md).
  // 10 — central error mapper. Domain error codes map to HTTP here (VC-78); until
  // then the contract already holds: never leak a stack trace, always return the
  // correlation id so a log line can be found from a user's screenshot.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? statusForDomainError(error);

    if (statusCode >= 500) {
      request.log.error(
        { err: error, correlationId: request.correlationId },
        'unhandled request error',
      );
    }

    return reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : error.code,
        // The contract is "a stable code plus parameters" (api-design.md): without the
        // parameters the client can only render one sentence per code, so a form that
        // refused a field cannot say which field. Dropped entirely above 500, where the
        // detail names schemas and drivers.
        ...(statusCode >= 500 ? {} : safeParams(error)),
        correlationId: request.correlationId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', correlationId: request.correlationId },
    }),
  );

  // 1 — correlation
  await app.register(correlationIdPlugin);

  // 3 — security headers and CORS. An empty allowlist means no cross-origin caller is
  // permitted, which is the correct default until the web client's origin is known.
  await app.register(
    helmet,
    config.isProduction
      ? { hsts: { maxAge: 31_536_000, includeSubDomains: true } }
      : // A strict CSP and HSTS on http://localhost only break local development;
        // production keeps helmet's defaults plus a one-year HSTS.
        { contentSecurityPolicy: false, hsts: false },
  );
  await app.register(cors, {
    origin: config.http.corsAllowedOrigins.length > 0 ? [...config.http.corsAllowedOrigins] : false,
    credentials: true,
  });

  // 4 — rate limiting. Per-key and per-endpoint limits tighten in VC-80.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  // Cookies carry the session. The browser never receives a token in a response body.
  await app.register(cookie);

  const sessionCookies = {
    secure: config.isProduction,
    // Matches the provider's access token lifetime, so the cookie does not outlive what
    // it holds.
    accessMaxAgeSeconds: 900,
    refreshMaxAgeSeconds: config.auth.sessionMaxAgeSeconds,
  };

  // 5 — authentication. Verifies the token on every request and re-derives the
  // membership from its subject; a tenant id in a body or header is data, not identity.
  await app.register(authenticationPlugin, {
    auth,
    controlDatabase,
    protectedPrefixes: ['/api/v1'],
    // Only these two, and only by these methods. Logout is deliberately absent: it
    // changes state, so it is authenticated and CSRF-checked like anything else.
    publicEndpoints: [
      { method: 'POST', path: '/api/v1/auth/session' },
      { method: 'POST', path: '/api/v1/auth/session/refresh' },
    ],
  });

  await app.register(authRoutes, { auth, controlDatabase, cookies: sessionCookies, audit });

  // 6 — tenant resolution, before any business logic. Only routes under a tenant-scoped
  // prefix are affected; the health probes below belong to no tenant.
  await app.register(tenantContextPlugin, {
    directory: tenantDirectory,
    rootDomain: config.tenancy.rootDomain,
    // Auth endpoints establish the session; there is no tenant to resolve until one
    // exists.
    tenantScopedPrefixes: ['/api/v1'],
    exemptPaths: ['/api/v1/auth/session', '/api/v1/auth/session/refresh', '/api/v1/auth/me'],
    // The verified principal is the first-precedence hint (§4.1). Read from the request
    // this plugin never parses itself, so it cannot trust an unverified token.
    readVerifiedTenantId: tenantIdFromPrincipal,
  });

  // After the tenant context plugin: every business route needs a resolved tenant, and
  // registering one earlier would let a request through before the tenant was bound.
  if (roles !== undefined) {
    await app.register(roleRoutes, roles);
  }

  if (platform !== undefined) {
    await app.register(platformRoutes, platform);
  }

  if (plans !== undefined) {
    await app.register(planRoutes, plans);
  }

  if (queues !== undefined) {
    await app.register(queueRoutes, queues);
  }

  if (auditTrail !== undefined) {
    await app.register(auditTrailRoutes, auditTrail);
  }

  if (supportAccess !== undefined) {
    await app.register(supportAccessRoutes, supportAccess);
  }

  // Health probes are deliberately unauthenticated and deliberately uninformative:
  // they report which named dependencies failed, never why.
  await app.register(healthRoutes, { readiness, isAcceptingTraffic });

  return app;
}

/** The concrete server type, for callers that need to name it. */
export type ApiServer = Awaited<ReturnType<typeof buildServer>>;
