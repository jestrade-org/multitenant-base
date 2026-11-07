/**
 * Deciding which tenant a request belongs to.
 *
 * This runs before any business logic, and getting it wrong is the worst failure this
 * product has: the platform may hold the data of companies that compete with each other,
 * so a request resolved to the wrong tenant is not a bug, it is the end
 * of the product's credibility.
 *
 * The decision is pure — no database, no HTTP — so every precedence and conflict case
 * can be tested exhaustively. Looking the tenant up is a separate concern (the
 * TenantDirectory port); binding a connection to it is another (the delivery layer).
 *
 * Ref: Tech specs §4.1, §4.3, §8.3.
 */

export type TenantHintSource = 'token' | 'subdomain' | 'api-key';

/** What the edge could observe about which tenant this request is for. */
export interface TenantHints {
  /** `tenant_id` claim from a **verified** JWT. Never read from an unverified token. */
  readonly tokenTenantId?: string | undefined;
  /** Host label, e.g. `acme` from `acme.example.test`. A hint, never a credential. */
  readonly subdomain?: string | undefined;
  /** Public prefix of an API key presented on this request. */
  readonly apiKeyPrefix?: string | undefined;
}

export type TenantLookup =
  | { readonly by: 'id'; readonly value: string }
  | { readonly by: 'subdomain'; readonly value: string }
  | { readonly by: 'api-key-prefix'; readonly value: string };

export type TenantSelection =
  | { readonly outcome: 'lookup'; readonly source: TenantHintSource; readonly lookup: TenantLookup }
  | { readonly outcome: 'no-hint' };

/**
 * Step 1 — applies the precedence of §4.1: verified token, then subdomain, then API key.
 *
 * The subdomain never overrides a verified token. Anyone can type a hostname, so on its
 * own it establishes *context*, not access: authentication and authorization still run
 * afterwards (§8.3, layers 2 and 3).
 */
export function selectTenantLookup(hints: TenantHints): TenantSelection {
  const { tokenTenantId, subdomain, apiKeyPrefix } = hints;

  if (isPresent(tokenTenantId)) {
    return { outcome: 'lookup', source: 'token', lookup: { by: 'id', value: tokenTenantId } };
  }
  if (isPresent(subdomain)) {
    return {
      outcome: 'lookup',
      source: 'subdomain',
      lookup: { by: 'subdomain', value: subdomain },
    };
  }
  if (isPresent(apiKeyPrefix)) {
    return {
      outcome: 'lookup',
      source: 'api-key',
      lookup: { by: 'api-key-prefix', value: apiKeyPrefix },
    };
  }
  return { outcome: 'no-hint' };
}

/** The subset of a tenant record the edge needs to bind a connection. */
export interface ResolvedTenant {
  readonly id: string;
  readonly name: string;
  readonly schemaName: string;
  readonly subdomain: string;
  readonly isolationMode: 'shared_schema' | 'dedicated_project';
  readonly lifecycleStatus: 'onboarding' | 'active' | 'suspended' | 'terminated';
  readonly timezone: string;
}

export type TenantRejection =
  | { readonly reason: 'no-hint' }
  | { readonly reason: 'unknown-tenant' }
  /**
   * The verified principal belongs to one tenant and the request arrived on a different
   * tenant's host. A user of company A probing company B's subdomain is exactly what
   * this stops — and it stops rather than silently preferring one, because "silently
   * preferred the right one" is indistinguishable from "nearly leaked".
   */
  | { readonly reason: 'subdomain-mismatch'; readonly expected: string; readonly received: string }
  /** Terminated tenants keep their data for statutory retention; they serve no traffic. */
  | { readonly reason: 'tenant-not-serving'; readonly lifecycleStatus: string };

export type TenantResolution =
  | {
      readonly outcome: 'resolved';
      readonly source: TenantHintSource;
      readonly tenant: ResolvedTenant;
    }
  | { readonly outcome: 'rejected'; readonly rejection: TenantRejection };

/**
 * Step 2 — validates the tenant the directory returned against the rest of the request.
 *
 * Separate from the lookup because these checks need the tenant record, and separate
 * from the directory because they are policy, not storage.
 */
export function acceptResolvedTenant(options: {
  readonly source: TenantHintSource;
  readonly tenant: ResolvedTenant | undefined;
  readonly hints: TenantHints;
}): TenantResolution {
  const { source, tenant, hints } = options;

  if (tenant === undefined) {
    return { outcome: 'rejected', rejection: { reason: 'unknown-tenant' } };
  }

  // A token resolved the tenant, but the request came in on some host. If that host
  // names a different tenant, the two disagree and neither is trusted.
  if (source === 'token' && isPresent(hints.subdomain) && hints.subdomain !== tenant.subdomain) {
    return {
      outcome: 'rejected',
      rejection: {
        reason: 'subdomain-mismatch',
        expected: tenant.subdomain,
        received: hints.subdomain,
      },
    };
  }

  if (tenant.lifecycleStatus === 'terminated' || tenant.lifecycleStatus === 'suspended') {
    return {
      outcome: 'rejected',
      rejection: { reason: 'tenant-not-serving', lifecycleStatus: tenant.lifecycleStatus },
    };
  }

  return { outcome: 'resolved', source, tenant };
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/**
 * Extracts the tenant label from a Host header.
 *
 * Returns undefined for anything that is not `<label>.<root domain>` — an IP address,
 * `localhost`, the apex domain, or a host with too few labels. A caller must not be able
 * to smuggle a tenant name in through a malformed Host.
 */
export function subdomainFromHost(
  host: string | undefined,
  rootDomain: string,
): string | undefined {
  if (host === undefined || host === '') return undefined;

  const hostname = (host.split(':')[0] ?? '').toLowerCase();
  const suffix = `.${rootDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;

  const label = hostname.slice(0, -suffix.length);
  // One label only: `a.b.example.test` is not tenant `a.b`.
  return /^[a-z0-9][a-z0-9-]{0,60}$/.test(label) ? label : undefined;
}
