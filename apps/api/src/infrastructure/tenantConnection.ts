import type pg from 'pg';

import type { ResolvedTenant } from '@multitenant-base/tenancy';
import { quoteIdentifier } from '@multitenant-base/tenancy';

/**
 * Binds a borrowed connection to exactly one tenant, for the duration of one unit of
 * work.
 *
 * This is the first of the three defences in §4.3. Two design choices carry it:
 *
 * **Everything happens inside a transaction, using `SET LOCAL`.** Postgres resets a
 * `LOCAL` setting when the transaction ends, whether it commits, rolls back, or the
 * client dies. The alternative — `SET` plus a `RESET` on release — is one missed reset
 * away from handing the next borrower a connection still pointed at the previous
 * tenant's schema. That failure would be silent, intermittent, and catastrophic, so the
 * design removes the possibility rather than remembering to avoid it.
 *
 * **Tenant work runs as `tenant_app`, not as the connecting role.** The Supabase role the
 * API connects with has BYPASSRLS — necessary to read the control plane, fatal for tenant
 * data, because every policy would be skipped and defence 2 would never once evaluate.
 * `SET LOCAL ROLE` switches for the transaction and reverts with it.
 *
 * **`search_path` excludes `public` and `control`.** An unqualified table name inside a
 * tenant unit of work resolves in the tenant's schema or not at all: it can never
 * silently fall through to a shared table, and never to the control plane.
 *
 * Option B (a dedicated Supabase project per tenant, VC-96) plugs in here as a different
 * implementation of the same interface — the application layer never learns which one it
 * is talking to.
 */

export interface TenantUnitOfWork {
  /** Runs a parameterised query bound to this tenant's schema. */
  query<Row extends pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]>;
}

export interface TenantConnectionProvider {
  withTenant<T>(tenant: ResolvedTenant, work: (uow: TenantUnitOfWork) => Promise<T>): Promise<T>;
}

export class SharedSchemaConnectionProvider implements TenantConnectionProvider {
  readonly #pool: pg.Pool;

  public constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  public async withTenant<T>(
    tenant: ResolvedTenant,
    work: (uow: TenantUnitOfWork) => Promise<T>,
  ): Promise<T> {
    if (tenant.isolationMode !== 'shared_schema') {
      throw new Error(
        `Tenant ${tenant.id} is on isolation mode "${tenant.isolationMode}", which this ` +
          'provider does not serve. Route it to the provider for that mode.',
      );
    }

    const client = await this.#pool.connect();
    try {
      await client.query('begin');

      // Drop BYPASSRLS for the duration. Everything after this line is subject to the
      // tenant policies, which is the only way defence 2 is worth anything.
      await client.query('set local role tenant_app');

      // The schema name came from the control plane and passed a check constraint on the
      // way in; quoteIdentifier re-validates it here because this is where it becomes SQL.
      await client.query(`set local search_path to ${quoteIdentifier(tenant.schemaName)}`);

      // The second defence reads this: every tenant-scoped RLS policy compares against
      // app.current_tenant_id(). Set as a parameter, never interpolated.
      await client.query('select set_config($1, $2, true)', ['app.tenant_id', tenant.id]);

      const result = await work({
        query: async <Row extends pg.QueryResultRow>(
          text: string,
          values: readonly unknown[] = [],
        ): Promise<readonly Row[]> => (await client.query<Row>(text, [...values])).rows,
      });

      await client.query('commit');
      return result;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => {
        // The connection is already broken; the pool will discard it. Losing the
        // rollback error here would hide the original failure, which matters more.
      });
      throw error;
    } finally {
      client.release();
    }
  }
}
