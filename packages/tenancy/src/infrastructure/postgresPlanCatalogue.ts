import { z } from 'zod';

import type { SqlClient, TransactionRunner } from './postgresTenantRegistry.js';
import type {
  PlanAssignmentAudit,
  PlanAudit,
  PlanCatalogue,
  PlanDto,
} from '../application/managePlans.js';
import { PlanNotFoundError, type PlanQuotas } from '../domain/planQuota.js';

/**
 * Plans and their quotas, in the control plane (§4.2).
 *
 * Every write runs in a transaction with its audit row, for the same reason the tenant
 * lifecycle does: a price change that rolled back must leave no record of having happened,
 * and one that stood must leave one (§8.4).
 */

/**
 * The audit trail, written on a caller-supplied connection.
 *
 * `tenantId` is optional here and required by the tenant sink, because a plan belongs to
 * the platform and no client. The audit table's check constraint allows a null tenant for
 * a `platform_admin` actor, which is exactly this case.
 */
export interface PlatformAuditSink {
  record(
    client: SqlClient,
    event: {
      readonly tenantId?: string | undefined;
      readonly actorId: string;
      readonly action: string;
      readonly resourceType: string;
      readonly resourceId: string;
      readonly occurredAt: Date;
      readonly changes: Readonly<Record<string, string>>;
    },
  ): Promise<void>;
}

export interface PostgresPlanCatalogueOptions {
  readonly client: SqlClient;
  readonly transactions: TransactionRunner;
  readonly audit: PlatformAuditSink;
  readonly clock: { now(): Date };
}

const rowSchema = z.object({
  code: z.string(),
  name: z.string(),
  // `numeric` arrives as a string from node-postgres, which is the only safe thing it
  // could do: routing a numeric(19,4) through a JS number would lose precision on a price.
  monthly_price: z.string(),
  currency: z.string(),
  max_users: z.number().int(),
  tenant_count: z.coerce.number().int(),
  updated_at: z.coerce.date(),
});

const SELECT = `
  select p.code, p.name, p.monthly_price, p.currency,
         p.max_users,
         (select count(*) from control.tenants t where t.plan_id = p.id) as tenant_count,
         p.updated_at
    from control.plans p
`;

function toDto(row: Record<string, unknown>): PlanDto {
  const parsed = rowSchema.parse(row);

  return {
    code: parsed.code,
    name: parsed.name,
    // A string on the wire, always. A JSON number goes through an IEEE-754 double.
    monthlyPrice: { amount: parsed.monthly_price, currency: parsed.currency },
    quotas: {
      users: parsed.max_users,
    },
    tenantCount: parsed.tenant_count,
    updatedAt: parsed.updated_at.toISOString(),
  };
}

export class PostgresPlanCatalogue implements PlanCatalogue {
  readonly #client: SqlClient;
  readonly #transactions: TransactionRunner;
  readonly #audit: PlatformAuditSink;
  readonly #clock: { now(): Date };

  public constructor(options: PostgresPlanCatalogueOptions) {
    this.#client = options.client;
    this.#transactions = options.transactions;
    this.#audit = options.audit;
    this.#clock = options.clock;
  }

  public async list(): Promise<readonly PlanDto[]> {
    // Priced order, not alphabetical: the panel reads as a ladder, which is how the
    // commercial offer is actually shaped.
    const rows = await this.#client.query(`${SELECT} order by p.monthly_price, p.code`);
    return rows.map(toDto);
  }

  public async findByCode(code: string): Promise<PlanDto | undefined> {
    const rows = await this.#client.query(`${SELECT} where p.code = $1`, [code]);
    return rows[0] === undefined ? undefined : toDto(rows[0]);
  }

  public async create(
    plan: {
      readonly code: string;
      readonly name: string;
      readonly monthlyPrice: string;
      readonly currency: string;
      readonly quotas: PlanQuotas;
    },
    audit: PlanAudit,
  ): Promise<PlanDto> {
    return this.#transactions.transaction(async (client) => {
      const rows = await client.query(
        `insert into control.plans
           (code, name, monthly_price, currency, max_users)
         values ($1, $2, $3::numeric, $4, $5)
         returning code`,
        [plan.code, plan.name, plan.monthlyPrice, plan.currency, plan.quotas.users],
      );

      if (rows.length === 0) throw new PlanNotFoundError(plan.code);

      await this.#audit.record(client, {
        actorId: audit.actorId,
        action: audit.action,
        resourceType: 'plan',
        resourceId: plan.code,
        occurredAt: this.#clock.now(),
        changes: audit.changes,
      });

      return this.#readInTransaction(client, plan.code);
    });
  }

  public async redefine(
    plan: {
      readonly code: string;
      readonly name: string;
      readonly monthlyPrice: string;
      readonly currency: string;
      readonly quotas: PlanQuotas;
    },
    audit: PlanAudit,
  ): Promise<PlanDto> {
    return this.#transactions.transaction(async (client) => {
      const rows = await client.query(
        `update control.plans
            set name = $2, monthly_price = $3::numeric, currency = $4,
                max_users = $5
          where code = $1
        returning code`,
        [plan.code, plan.name, plan.monthlyPrice, plan.currency, plan.quotas.users],
      );

      // Nothing updated means no such plan. Recording a repricing of a plan that does not
      // exist would put a fiction in a six-year record.
      if (rows.length === 0) throw new PlanNotFoundError(plan.code);

      await this.#audit.record(client, {
        actorId: audit.actorId,
        action: audit.action,
        resourceType: 'plan',
        resourceId: plan.code,
        occurredAt: this.#clock.now(),
        changes: audit.changes,
      });

      return this.#readInTransaction(client, plan.code);
    });
  }

  public async assignToTenant(
    input: { readonly tenantId: string; readonly planCode: string },
    audit: PlanAssignmentAudit,
  ): Promise<void> {
    await this.#transactions.transaction(async (client) => {
      const rows = await client.query(
        `update control.tenants t
            set plan_id = p.id
           from control.plans p
          where t.id = $1 and p.code = $2
        returning t.id`,
        [input.tenantId, input.planCode],
      );

      if (rows.length === 0) throw new PlanNotFoundError(input.planCode);

      await this.#audit.record(client, {
        tenantId: input.tenantId,
        actorId: audit.actorId,
        action: audit.action,
        resourceType: 'tenant',
        resourceId: input.tenantId,
        occurredAt: this.#clock.now(),
        changes: audit.changes,
      });
    });
  }

  public async planCodeOfTenant(tenantId: string): Promise<string | undefined> {
    const rows = await this.#client.query(
      `select p.code
         from control.tenants t
         join control.plans p on p.id = t.plan_id
        where t.id = $1`,
      [tenantId],
    );

    const code = rows[0]?.code;
    return typeof code === 'string' ? code : undefined;
  }

  /**
   * Reads the plan back on the same connection.
   *
   * Inside the transaction on purpose: reading it afterwards on the pool could see a
   * different state, and the value returned to the operator would then not be the value
   * their change produced.
   */
  async #readInTransaction(client: SqlClient, code: string): Promise<PlanDto> {
    const rows = await client.query(`${SELECT} where p.code = $1`, [code]);
    const row = rows[0];
    if (row === undefined) throw new PlanNotFoundError(code);
    return toDto(row);
  }
}
