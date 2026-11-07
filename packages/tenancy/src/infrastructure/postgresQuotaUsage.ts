import { z } from 'zod';

import type { SqlClient } from './postgresTenantRegistry.js';
import type {
  QuotaTenantDirectory,
  QuotaUsageSnapshot,
  QuotaUsageStore,
  TenantToMeasure,
} from '../application/quotaUsage.js';
import type { QuotaStatus } from '../domain/planQuota.js';

/**
 * Quota usage snapshots, in the control plane (§4.2, VC-28).
 *
 * Counts and a timestamp per tenant. There is deliberately nowhere in this adapter to put
 * a record — the platform panel reads it, and §8.1 says the platform panel holds no
 * client data.
 */

const snapshotSchema = z.object({
  tenant_id: z.string().uuid(),
  users: z.number().int(),
  notified_status: z.enum(['within', 'warning', 'exceeded']),
  measured_at: z.coerce.date(),
});

function toSnapshot(row: Record<string, unknown>): QuotaUsageSnapshot {
  const parsed = snapshotSchema.parse(row);

  return {
    tenantId: parsed.tenant_id,
    measuredAt: parsed.measured_at,
    usage: {
      users: parsed.users,
    },
    notifiedStatus: parsed.notified_status satisfies QuotaStatus,
  };
}

const SELECT_SNAPSHOT = `
  select tenant_id, users, notified_status, measured_at
    from control.tenant_quota_usage
`;

export class PostgresQuotaUsageStore implements QuotaUsageStore {
  readonly #client: SqlClient;

  public constructor(client: SqlClient) {
    this.#client = client;
  }

  public async save(snapshot: QuotaUsageSnapshot): Promise<void> {
    // Upsert rather than delete-then-insert: a verification pass that crashed between the
    // two would leave a client with no measurement at all, which the panel would render
    // as "never measured" for a client measured every day for a year.
    await this.#client.query(
      `insert into control.tenant_quota_usage
         (tenant_id, users, notified_status, measured_at)
       values ($1, $2, $3, $4)
       on conflict (tenant_id) do update
          set users           = excluded.users,
              notified_status = excluded.notified_status,
              measured_at     = excluded.measured_at`,
      [snapshot.tenantId, snapshot.usage.users, snapshot.notifiedStatus, snapshot.measuredAt],
    );
  }

  public async latest(tenantId: string): Promise<QuotaUsageSnapshot | undefined> {
    const rows = await this.#client.query(`${SELECT_SNAPSHOT} where tenant_id = $1`, [tenantId]);
    return rows[0] === undefined ? undefined : toSnapshot(rows[0]);
  }

  public async listLatest(): Promise<readonly QuotaUsageSnapshot[]> {
    const rows = await this.#client.query(SELECT_SNAPSHOT);
    return rows.map(toSnapshot);
  }
}

const measurableSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  schema_name: z.string(),
  isolation_mode: z.string(),
  timezone: z.string(),
  plan_code: z.string(),
  max_users: z.number().int(),
});

export class PostgresQuotaTenantDirectory implements QuotaTenantDirectory {
  readonly #client: SqlClient;

  public constructor(client: SqlClient) {
    this.#client = client;
  }

  public async listMeasurable(): Promise<readonly TenantToMeasure[]> {
    const rows = await this.#client.query(
      `select t.id, t.name, t.schema_name, t.isolation_mode, t.timezone,
              p.code as plan_code,
              p.max_users
         from control.tenants t
         join control.plans p on p.id = t.plan_id
        -- Only clients whose schema exists. A provisioning that stopped before step 2 has
        -- no tables to count, and counting it would fail the whole pass for everyone else.
        where t.provisioned_at is not null
        order by t.name`,
    );

    return rows.map((row) => {
      const parsed = measurableSchema.parse(row);

      return {
        id: parsed.id,
        name: parsed.name,
        schemaName: parsed.schema_name,
        isolationMode: parsed.isolation_mode,
        timezone: parsed.timezone,
        planCode: parsed.plan_code,
        quotas: {
          users: parsed.max_users,
        },
      };
    });
  }
}
