import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import { hasValidCsrfToken, readAccessToken } from './session.js';
import type { SupabaseAuth } from '../../infrastructure/auth/supabaseAuth.js';
import type { ControlDatabase } from '../../infrastructure/controlDatabase.js';

/**
 * Authentication (§8.2) and the identity every later layer depends on.
 *
 * The token is verified on *every* request — signature, issuer, audience, expiry — and
 * the membership is re-derived from the token's subject rather than read from anything
 * the client sent. A `tenantId` in a body or a header is data, not identity.
 *
 * This layer decides *who is asking*. It deliberately does not decide what they may do:
 * that is the use case's job (§8.3, layer 3), and putting it here would mean every new
 * route silently inherits whatever this middleware happened to allow.
 */

export interface Principal {
  readonly authUserId: string;
  readonly memberId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly schemaName: string;
  readonly subdomain: string;
  readonly timezone: string;
  readonly roleCode: string;
  readonly fullName: string;
  readonly email: string;
  /** Effective capabilities, from the role. Checked in the use case, never here. */
  readonly permissions: readonly string[];
  /**
   * Set when this principal is a platform staff member acting inside the client's account
   * (§8.1, VC-101), and absent for the ordinary case.
   *
   * It rides on the principal rather than only on the request so that the actor every use
   * case is handed knows it: an audit row written during a support session has to say
   * `platform_admin`, and a field the composition root has to remember to pass separately
   * is a field it eventually does not.
   */
  readonly supportAccess?: SupportAccess;
}

/**
 * platform staff (§8.1).
 *
 * Deliberately a *separate* decoration rather than a variant of `Principal`. A route that
 * reads `request.principal` gets `undefined` for a staff member, so every existing
 * tenant-scoped route refuses them by construction — "ningún acceso implícito de staff a
 * datos de un tenant" becomes a property of the type rather than a rule each route has to
 * remember.
 *
 * Reaching a client's data as staff therefore requires a deliberate, audited elevation
 * (VC-101), which is the only shape that rule can honestly take.
 */
export interface PlatformPrincipal {
  readonly authUserId: string;
  readonly platformUserId: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleCode: string;
  readonly permissions: readonly string[];
}

/**
 * A staff member acting inside a client's account (§8.1, VC-101).
 *
 * Present *instead of* `platformPrincipal`, never alongside it. While a grant is live the
 * request carries the client's `principal` and nothing else: a session that held both
 * would let someone provision tenants and read a company's books in the same breath, which
 * is two powers this product deliberately keeps apart.
 *
 * What it does carry is who the human really is, so every event the request produces can
 * name them. Impersonation that the trail cannot see through is not support access; it is
 * an unattributable action, and §8.4 has exactly one rule against that.
 */
export interface SupportAccess {
  readonly grantId: string;
  readonly staffAuthUserId: string;
  readonly staffPlatformUserId: string;
  readonly staffFullName: string;
  readonly staffEmail: string;
  readonly expiresAt: string;
  readonly reason: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    platformPrincipal?: PlatformPrincipal;
    supportAccess?: SupportAccess;
  }
}

interface PlatformRow {
  readonly platform_user_id: string;
  readonly email: string;
  readonly full_name: string;
  readonly role_code: string;
  readonly permissions: string[];
}

interface MemberRow {
  readonly member_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly schema_name: string;
  readonly subdomain: string;
  readonly timezone: string;
  readonly role_code: string;
  readonly full_name: string;
  /** Nullable: a member row can predate the address being captured. */
  readonly email: string | null;
  readonly permissions: string[];
}

export interface AuthenticationOptions {
  readonly auth: SupabaseAuth;
  readonly controlDatabase: ControlDatabase;
  /** Prefixes that require an authenticated principal. */
  readonly protectedPrefixes: readonly string[];
  /**
   * Endpoints under those prefixes that are deliberately public, keyed by *method as well
   * as path*.
   *
   * Method matters: `POST /auth/session` is the login, which by definition has no session
   * yet, while `DELETE /auth/session` is the logout, which must be authenticated and
   * CSRF-checked like any other state-changing request. Exempting the path alone let a
   * cross-site page force a logout — and would have exempted anything else later added
   * under the same path.
   */
  readonly publicEndpoints: readonly { readonly method: string; readonly path: string }[];
}

function unauthorized(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('UNAUTHENTICATED'), {
    statusCode: 401,
    code: 'UNAUTHENTICATED',
  });
}

function csrfRejected(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('CSRF_TOKEN_INVALID'), {
    statusCode: 403,
    code: 'CSRF_TOKEN_INVALID',
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Resolves platform staff. Returns nothing for anyone who is not on the platform roster. */
export async function resolvePlatformPrincipal(
  options: { readonly controlDatabase: ControlDatabase },
  authUserId: string,
): Promise<PlatformPrincipal | undefined> {
  const rows = await options.controlDatabase.query<PlatformRow>(
    `select platform_user_id, email, full_name, role_code, permissions
       from control.resolve_platform_user($1)`,
    [authUserId],
  );

  const row = rows[0];
  if (row === undefined) return undefined;

  return {
    authUserId,
    platformUserId: row.platform_user_id,
    email: row.email,
    fullName: row.full_name,
    roleCode: row.role_code,
    permissions: row.permissions,
  };
}

interface SupportAccessRow {
  readonly grant_id: string;
  readonly expires_at: Date;
  readonly reason: string;
  readonly member_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly schema_name: string;
  readonly subdomain: string;
  readonly timezone: string;
  readonly role_code: string;
  readonly full_name: string;
  readonly email: string | null;
  readonly permissions: string[];
}

/**
 * The membership a staff member is currently acting as, if any.
 *
 * Expiry lives in the SQL, not here: a grant has to stop working at the moment it expires
 * whether or not anything swept the table, and a check written in the application is one
 * that a second entry point can forget.
 */
export async function resolveSupportAccess(
  options: { readonly controlDatabase: ControlDatabase },
  staff: PlatformPrincipal,
): Promise<{ readonly principal: Principal; readonly access: SupportAccess } | undefined> {
  const rows = await options.controlDatabase.query<SupportAccessRow>(
    `select grant_id, expires_at, reason, member_id, tenant_id, tenant_name, schema_name,
            subdomain, timezone, role_code, full_name, email, permissions
       from control.resolve_support_access($1)`,
    [staff.authUserId],
  );

  const row = rows[0];
  if (row === undefined) return undefined;

  const access: SupportAccess = {
    grantId: row.grant_id,
    staffAuthUserId: staff.authUserId,
    staffPlatformUserId: staff.platformUserId,
    staffFullName: staff.fullName,
    staffEmail: staff.email,
    expiresAt: row.expires_at.toISOString(),
    reason: row.reason,
  };

  return {
    principal: {
      // The *staff member's* id, deliberately, and it is the whole design.
      //
      // The tenant and the role come from the grant, so the request is scoped and
      // permitted exactly as the client's own user would be. But the human who acted is
      // the staff member, so that is who `created_by` and every audit row name. Writing
      // the client's id instead would produce a trail in which support activity is
      // indistinguishable from the client's own, which is the one outcome §8.4 forbids.
      authUserId: staff.authUserId,
      memberId: row.member_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      schemaName: row.schema_name,
      subdomain: row.subdomain,
      timezone: row.timezone,
      roleCode: row.role_code,
      fullName: row.full_name,
      email: row.email ?? '',
      permissions: row.permissions,
      supportAccess: access,
    },
    access,
  };
}

export async function resolvePrincipal(
  options: { readonly controlDatabase: ControlDatabase },
  authUserId: string,
  email: string | undefined,
): Promise<Principal | undefined> {
  const rows = await options.controlDatabase.query<MemberRow>(
    `select member_id, tenant_id, tenant_name, schema_name, subdomain, timezone,
            role_code, full_name, email, permissions
       from control.resolve_member($1)`,
    [authUserId],
  );

  const row = rows[0];
  if (row === undefined) return undefined;

  // More than one membership is a legitimate future state (an accountant serving two
  // companies), but choosing between them is a product decision nobody has made. Failing
  // here is better than silently picking the first row and showing someone the wrong
  // company's cash position.
  if (rows.length > 1) {
    throw Object.assign(new Error('MULTIPLE_MEMBERSHIPS'), {
      statusCode: 409,
      code: 'MULTIPLE_MEMBERSHIPS',
    });
  }

  return {
    authUserId,
    memberId: row.member_id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    schemaName: row.schema_name,
    subdomain: row.subdomain,
    timezone: row.timezone,
    roleCode: row.role_code,
    fullName: row.full_name,
    email: row.email ?? email ?? '',
    permissions: row.permissions,
  };
}

const plugin: FastifyPluginCallback<AuthenticationOptions> = (app, options, ready) => {
  app.decorateRequest('principal', undefined);
  app.decorateRequest('platformPrincipal', undefined);
  app.decorateRequest('supportAccess', undefined);

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    const isPublic = options.publicEndpoints.some(
      (endpoint) => endpoint.method === request.method && endpoint.path === path,
    );
    const needsAuth =
      options.protectedPrefixes.some((prefix) => request.url.startsWith(prefix)) && !isPublic;

    if (!needsAuth) return;

    // CSRF is checked before anything else on a state-changing request: a forged request
    // that gets as far as being authenticated has already cost us the assumption that
    // only our own client can reach this endpoint.
    if (!SAFE_METHODS.has(request.method) && !hasValidCsrfToken(request)) {
      request.log.warn({ method: request.method }, 'request rejected: csrf token missing or wrong');
      throw csrfRejected();
    }

    const accessToken = readAccessToken(request);
    if (accessToken === undefined) throw unauthorized();

    const verified = await options.auth.verify(accessToken);
    if (verified === undefined) {
      // Expired is the common case and the client is expected to refresh and retry, so
      // this is not logged as an error.
      throw unauthorized();
    }

    const principal = await resolvePrincipal(options, verified.authUserId, verified.email);
    if (principal !== undefined) {
      request.principal = principal;
      return;
    }

    // Not a member of any tenant. They may still be platform staff, whose identity lives
    // elsewhere and carries no company at all.
    const platformPrincipal = await resolvePlatformPrincipal(options, verified.authUserId);
    if (platformPrincipal !== undefined) {
      const support = await resolveSupportAccess(options, platformPrincipal);
      if (support !== undefined) {
        // Deliberately *not* also setting `platformPrincipal`: for as long as the grant is
        // live this request is the client's user and nothing more. Every platform route
        // refuses them, which is the point — the staff powers are what they stepped out of.
        request.principal = support.principal;
        request.supportAccess = support.access;
        return;
      }

      request.platformPrincipal = platformPrincipal;
      return;
    }

    // A valid token for someone who is neither. Logged, because it means an account
    // outlived its membership.
    request.log.warn({ authUserId: verified.authUserId }, 'verified user has no active membership');
    throw unauthorized();
  });

  ready();
};

export const authenticationPlugin = fastifyPlugin(plugin, {
  name: 'authentication',
  fastify: '5.x',
});

/** Reads the tenant the verified principal belongs to, for the tenant resolver (§4.1). */
export function tenantIdFromPrincipal(request: FastifyRequest): string | undefined {
  return request.principal?.tenantId;
}
