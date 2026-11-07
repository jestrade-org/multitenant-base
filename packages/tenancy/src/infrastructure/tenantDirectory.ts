import type { ResolvedTenant, TenantLookup } from '../application/tenantResolution.js';
import type { SqlClient } from './migrations/runner.js';

/**
 * Reads tenant records from the control plane.
 *
 * Every request needs one of these lookups, so it is cached — but with a short TTL and a
 * bounded size, because a stale entry here means a suspended or terminated tenant keeps
 * being served, and an unbounded cache keyed by attacker-supplied subdomains is a memory
 * exhaustion vector.
 */

interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly schema_name: string;
  readonly subdomain: string;
  readonly isolation_mode: string;
  readonly lifecycle_status: string;
  readonly timezone: string;
}

function toResolvedTenant(row: TenantRow): ResolvedTenant {
  return {
    id: row.id,
    name: row.name,
    schemaName: row.schema_name,
    subdomain: row.subdomain,
    isolationMode: row.isolation_mode as ResolvedTenant['isolationMode'],
    lifecycleStatus: row.lifecycle_status as ResolvedTenant['lifecycleStatus'],
    timezone: row.timezone,
  };
}

const TENANT_COLUMNS = `t.id, t.name, t.schema_name, t.subdomain, t.isolation_mode,
                        t.lifecycle_status, t.timezone`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantDirectoryOptions {
  readonly client: SqlClient;
  /** Short by design: a revoked or suspended tenant must stop being served quickly. */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export class TenantDirectory {
  readonly #client: SqlClient;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #cache = new Map<
    string,
    { readonly tenant: ResolvedTenant; readonly expiresAt: number }
  >();

  public constructor(options: TenantDirectoryOptions) {
    this.#client = options.client;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#maxEntries = options.maxEntries ?? 500;
    this.#now = options.now ?? Date.now;
  }

  public async find(lookup: TenantLookup): Promise<ResolvedTenant | undefined> {
    const cacheKey = `${lookup.by}:${lookup.value}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      return cached.tenant;
    }
    this.#cache.delete(cacheKey);

    const tenant = await this.#query(lookup);
    if (tenant !== undefined) {
      // Bound the cache before inserting. Eviction is oldest-first, which is enough:
      // the point is a ceiling on memory, not an optimal hit rate.
      if (this.#cache.size >= this.#maxEntries) {
        const oldest = this.#cache.keys().next();
        if (!oldest.done) this.#cache.delete(oldest.value);
      }
      this.#cache.set(cacheKey, { tenant, expiresAt: this.#now() + this.#ttlMs });
    }
    return tenant;
  }

  /** Drops cached entries, e.g. after a tenant's lifecycle status changes. */
  public invalidate(): void {
    this.#cache.clear();
  }

  async #query(lookup: TenantLookup): Promise<ResolvedTenant | undefined> {
    // Parameterised in every branch. The column being compared is chosen from a closed
    // set here, never from input.
    // Postgres raises on a malformed uuid literal. A caller must not be able to turn a
    // bad token claim into a 500 — an unknown tenant is an unknown tenant.
    if (lookup.by === 'id' && !UUID.test(lookup.value)) {
      return undefined;
    }

    const sql =
      lookup.by === 'id'
        ? `select ${TENANT_COLUMNS} from control.tenants t where t.id = $1`
        : lookup.by === 'subdomain'
          ? `select ${TENANT_COLUMNS} from control.tenants t where t.subdomain = $1`
          : `select ${TENANT_COLUMNS}
               from control.tenants t
               join control.api_keys k on k.tenant_id = t.id
              where k.key_prefix = $1 and k.revoked_at is null`;

    const rows = await this.#client.query(sql, [lookup.value]);
    const row = rows[0];
    return row === undefined ? undefined : toResolvedTenant(row as unknown as TenantRow);
  }
}
