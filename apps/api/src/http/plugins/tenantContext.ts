import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import {
  acceptResolvedTenant,
  selectTenantLookup,
  subdomainFromHost,
  type ResolvedTenant,
  type TenantDirectory,
  type TenantHintSource,
} from '@multitenant-base/tenancy';

/**
 * Resolves the tenant before any business logic runs (§4.1).
 *
 * Registered as an `onRequest` hook so it precedes route handlers, schema validation and
 * the use cases underneath them. Resolution establishes *context*, not access:
 * authentication decides who is asking (VC-29/30) and the use case decides whether they
 * may (VC-32). This layer only decides *whose data* the request is about — and refuses
 * the request outright when it cannot decide unambiguously.
 *
 * Health probes and other public routes are exempt: they are tenant-agnostic by design, as
 * are requests from platform staff, who belong to no tenant at all.
 */

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: ResolvedTenant;
    tenantSource?: TenantHintSource;
  }
}

const API_KEY_HEADER = 'x-api-key';

export interface TenantContextOptions {
  readonly directory: TenantDirectory;
  /** Host suffix under which tenant subdomains live, e.g. `example.test`. */
  readonly rootDomain: string;
  /** Prefixes that must resolve a tenant. Everything else is left untouched. */
  readonly tenantScopedPrefixes: readonly string[];
  /**
   * Paths under those prefixes that legitimately have no tenant yet — the session
   * endpoints, which are what *produce* the identity a tenant is resolved from.
   */
  readonly exemptPaths?: readonly string[];
  /**
   * Reads the `tenant_id` claim from the request's **verified** token.
   *
   * Injected rather than read directly so this plugin cannot accidentally trust an
   * unverified token: it never parses an Authorization header itself. Authentication
   * (VC-29/30) supplies the real implementation; until then there is no token path, and
   * no tenant-scoped route exists for one to matter on.
   */
  readonly readVerifiedTenantId?: (request: FastifyRequest) => string | undefined;
}

const plugin: FastifyPluginCallback<TenantContextOptions> = (app, options, ready) => {
  app.decorateRequest('tenant', undefined);
  app.decorateRequest('tenantSource', undefined);

  app.addHook('onRequest', async (request) => {
    const requiresTenant = options.tenantScopedPrefixes.some((prefix) =>
      request.url.startsWith(prefix),
    );
    const isExempt = (options.exemptPaths ?? []).some((path) => request.url.split('?')[0] === path);
    if (!requiresTenant || isExempt) return;

    // platform staff belong to no tenant (§8.1), so resolving one for them is not merely
    // unnecessary — it is the wrong question, and answering it would mean inventing a
    // company for someone who has none. Their routes read `platformPrincipal` and touch no
    // tenant schema; a staff member reaching a tenant route still fails, because that route
    // reads `principal`, which they do not carry.
    if (request.platformPrincipal !== undefined) return;

    const hints = {
      // Populated by the authentication layer from a *verified* token only. Until that
      // lands there is no token path, and no route under a tenant-scoped prefix exists.
      tokenTenantId: options.readVerifiedTenantId?.(request),
      subdomain: subdomainFromHost(request.headers.host, options.rootDomain),
      apiKeyPrefix: readApiKeyPrefix(request.headers[API_KEY_HEADER]),
    };

    const selection = selectTenantLookup(hints);
    if (selection.outcome === 'no-hint') {
      request.log.warn({ reason: 'no-hint' }, 'tenant resolution rejected');
      throw tenantNotResolved();
    }

    const resolution = acceptResolvedTenant({
      source: selection.source,
      tenant: await options.directory.find(selection.lookup),
      hints,
    });

    if (resolution.outcome === 'rejected') {
      request.log.warn(
        { reason: resolution.rejection.reason, source: selection.source },
        'tenant resolution rejected',
      );
      // Deliberately one opaque code for every rejection. Distinguishing "no such
      // tenant" from "wrong subdomain" would let anyone enumerate which companies are
      // customers, which is commercially sensitive on its own.
      throw tenantNotResolved();
    }

    request.tenant = resolution.tenant;
    request.tenantSource = resolution.source;
  });

  ready();
};

function readApiKeyPrefix(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  // The key is `<prefix>.<secret>`; only the prefix identifies. The secret is verified
  // by the API key authentication layer (VC-80), never here.
  const prefix = value.split('.')[0];
  return prefix !== undefined && /^mtb_(live|test)_[A-Za-z0-9]{8,64}$/.test(prefix)
    ? prefix
    : undefined;
}

/**
 * Answers exactly as a nonexistent route does: 404 with `NOT_FOUND`.
 *
 * Not merely "404 rather than 403". A distinct code such as TENANT_NOT_RESOLVED would
 * still be an oracle: probing `/api/v1/anything` across subdomains would return one code
 * for real customers and another for the rest, which enumerates the client list. The
 * real reason is logged, with the correlation id, and never put on the wire.
 */
function tenantNotResolved(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('NOT_FOUND'), { statusCode: 404, code: 'NOT_FOUND' });
}

export const tenantContextPlugin = fastifyPlugin(plugin, {
  name: 'tenant-context',
  fastify: '5.x',
});
