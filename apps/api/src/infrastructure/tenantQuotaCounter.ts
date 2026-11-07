import type { MeasuredUsage, TenantToMeasure, TenantUsageCounter } from '@multitenant-base/tenancy';

import type { ControlDatabase } from './controlDatabase.js';

/**
 * Counting what a company is using, without acquiring a way to read it (§4.2, §8.1).
 *
 * Integers come out of this class and nothing else. That is the point rather than a
 * coincidence: the platform panel consumes the result, and platform staff reach no
 * company's data without an audited elevation. `count(*)` is metadata about an account —
 * it is what a plan sells — and the port's return type has nowhere to put a record.
 *
 * The base plan limits users only, which live in the control plane. A project that adds a
 * tenant-scoped quota counts it here through the tenant connection provider, so the count
 * is bound by `search_path` and evaluated under RLS exactly like every other tenant read
 * (§4.3) — never through a shortcut that names a schema by hand.
 */
export interface TenantQuotaCounterOptions {
  readonly controlDatabase: ControlDatabase;
}

export class TenantQuotaCounter implements TenantUsageCounter {
  readonly #controlDatabase: ControlDatabase;

  public constructor(options: TenantQuotaCounterOptions) {
    this.#controlDatabase = options.controlDatabase;
  }

  public async count(tenant: TenantToMeasure): Promise<MeasuredUsage> {
    const members = await this.#controlDatabase.query<{ users: string }>(
      `select count(*) as users
         from control.tenant_members
        where tenant_id = $1 and is_active`,
      [tenant.id],
    );

    return { users: Number(members[0]?.users ?? 0) };
  }
}
