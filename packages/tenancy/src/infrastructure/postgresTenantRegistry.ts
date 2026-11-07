import { z } from 'zod';

import { TenantNotFoundError } from '../application/provisionTenant.js';
import type {
  LifecycleAudit,
  TenantRegistry,
  TenantSummaryDto,
} from '../application/provisionTenant.js';

/**
 * The tenant roster, in the control plane.
 *
 * Runs on the control connection with no tenant bound: this *is* the table that decides
 * which tenants exist, so scoping it to one would be circular.
 */

export interface SqlClient {
  query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

/** Runs `work` inside one transaction, on one connection. */
export interface TransactionRunner {
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}

/**
 * The audit trail, written on a caller-supplied connection.
 *
 * Taking the client is the whole point: the event commits with the change it describes, or
 * neither does. A sink that opened its own connection could record a suspension that was
 * rolled back, or miss one that stood (§8.4).
 */
export interface TenantAuditSink {
  record(
    client: SqlClient,
    event: {
      readonly tenantId: string;
      readonly actorId: string;
      readonly action: string;
      readonly occurredAt: Date;
      readonly changes?: Readonly<Record<string, string>>;
    },
  ): Promise<void>;
}

export interface PostgresTenantRegistryOptions {
  readonly client: SqlClient;
  readonly transactions: TransactionRunner;
  readonly audit: TenantAuditSink;
  readonly clock: { now(): Date };
}

const rowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  tax_id: z.string(),
  subdomain: z.string(),
  schema_name: z.string(),
  timezone: z.string(),
  plan_code: z.string(),
  lifecycle_status: z.string(),
  provisioned_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
});

const SELECT = `
  select t.id, t.name, t.tax_id, t.subdomain, t.schema_name, t.timezone,
         p.code as plan_code, t.lifecycle_status, t.provisioned_at, t.created_at
    from control.tenants t
    join control.plans p on p.id = t.plan_id
`;

function toDto(row: Record<string, unknown>): TenantSummaryDto {
  const parsed = rowSchema.parse(row);
  return {
    id: parsed.id,
    name: parsed.name,
    taxId: parsed.tax_id,
    subdomain: parsed.subdomain,
    schemaName: parsed.schema_name,
    timezone: parsed.timezone,
    planCode: parsed.plan_code,
    lifecycleStatus: parsed.lifecycle_status,
    // `provisioned_at` is the only thing that says a client is ready. A row without it is
    // the visible state of a provisioning that stopped part-way.
    isProvisioned: parsed.provisioned_at !== null,
    createdAt: parsed.created_at.toISOString(),
  };
}

export class PostgresTenantRegistry implements TenantRegistry {
  readonly #client: SqlClient;
  readonly #transactions: TransactionRunner;
  readonly #audit: TenantAuditSink;
  readonly #clock: { now(): Date };

  public constructor(options: PostgresTenantRegistryOptions) {
    this.#client = options.client;
    this.#transactions = options.transactions;
    this.#audit = options.audit;
    this.#clock = options.clock;
  }

  public async findByTaxId(taxId: string): Promise<TenantSummaryDto | undefined> {
    const rows = await this.#client.query(`${SELECT} where t.tax_id = $1`, [taxId]);
    return rows[0] === undefined ? undefined : toDto(rows[0]);
  }

  public async findBySubdomain(subdomain: string): Promise<TenantSummaryDto | undefined> {
    const rows = await this.#client.query(`${SELECT} where t.subdomain = $1`, [subdomain]);
    return rows[0] === undefined ? undefined : toDto(rows[0]);
  }

  public async findById(tenantId: string): Promise<TenantSummaryDto | undefined> {
    const rows = await this.#client.query(`${SELECT} where t.id = $1`, [tenantId]);
    return rows[0] === undefined ? undefined : toDto(rows[0]);
  }

  public async list(): Promise<readonly TenantSummaryDto[]> {
    const rows = await this.#client.query(`${SELECT} order by t.created_at desc`);
    return rows.map(toDto);
  }

  public async register(input: {
    readonly id: string;
    readonly name: string;
    readonly taxId: string;
    readonly subdomain: string;
    readonly schemaName: string;
    readonly timezone: string;
    readonly planCode: string;
  }): Promise<TenantSummaryDto> {
    const rows = await this.#client.query(
      `insert into control.tenants (id, name, tax_id, plan_id, schema_name, subdomain, timezone)
       select $1, $2, $3, p.id, $4, $5, $6 from control.plans p where p.code = $7
       on conflict (id) do nothing
       returning id`,
      [
        input.id,
        input.name,
        input.taxId,
        input.schemaName,
        input.subdomain,
        input.timezone,
        input.planCode,
      ],
    );

    if (rows.length === 0) {
      // Either the id already existed, or the plan code does not. The second is the
      // interesting one: a typo in a plan code would otherwise create a client with no plan
      // and no quota, silently.
      const existing = await this.findById(input.id);
      if (existing === undefined) {
        throw new Error(`No plan with code "${input.planCode}"`);
      }
      return existing;
    }

    const created = await this.findById(input.id);
    if (created === undefined) throw new Error('the tenant row vanished after insert');
    return created;
  }

  public async markProvisioned(tenantId: string, at: Date, audit: LifecycleAudit): Promise<void> {
    await this.#transactions.transaction(async (client) => {
      // `coalesce`: re-running a finished provisioning must not move the date, which is a
      // record of when the client actually became ready.
      await client.query(
        'update control.tenants set provisioned_at = coalesce(provisioned_at, $2) where id = $1',
        [tenantId, at],
      );

      await this.#audit.record(client, {
        tenantId,
        actorId: audit.actorId,
        action: audit.action,
        occurredAt: this.#clock.now(),
        ...(audit.correlationId === undefined ? {} : { correlationId: audit.correlationId }),
      });
    });
  }

  public async setLifecycleStatus(
    tenantId: string,
    status: string,
    audit: LifecycleAudit,
  ): Promise<void> {
    await this.#transactions.transaction(async (client) => {
      const rows = await client.query(
        `update control.tenants
            set lifecycle_status = $2::control.tenant_lifecycle_status
          where id = $1
        returning id`,
        [tenantId, status],
      );

      // Nothing updated means no such client. Recording a suspension of a tenant that does
      // not exist would put a fiction in a six-year record.
      if (rows.length === 0) throw new TenantNotFoundError(tenantId);

      await this.#audit.record(client, {
        tenantId,
        actorId: audit.actorId,
        action: audit.action,
        occurredAt: this.#clock.now(),
        // What it became. The trail is ordered, so the previous value is the one the
        // last event for this client recorded.
        changes: { lifecycleStatus: status },
      });
    });
  }
}
