import type pg from 'pg';

import { AuthorizationAuditTrail, PostgresAuditTrail } from '@multitenant-base/audit';
import type { AuthorizationAttempt, AuthorizationAuditSink } from '@multitenant-base/shared-kernel';

/**
 * Records an authorization decision on its own short transaction.
 *
 * §8.4 wants the audit row and the change it describes to commit together, and a use case
 * that changes state will pass its own transaction here. A *denial* has no such
 * transaction — nothing happened, which is exactly what has to be recorded — so this
 * opens one.
 *
 * The write runs as `tenant_app` with the actor's tenant bound, not as the pool's owner.
 * That is deliberate: it means the row is subject to the same policy as everything else,
 * so an event can only be filed against the tenant it belongs to, and the append-only
 * grant applies to us as much as to anyone.
 */
export class TransactionalAuthorizationAudit implements AuthorizationAuditSink {
  readonly #pool: pg.Pool;
  readonly #context: () => { readonly correlationId?: string; readonly ipAddress?: string };

  public constructor(
    pool: pg.Pool,
    context: () => { readonly correlationId?: string; readonly ipAddress?: string } = () => ({}),
  ) {
    this.#pool = pool;
    this.#context = context;
  }

  public async record(attempt: AuthorizationAttempt): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role tenant_app');
      // Empty string for a platform action: `app.current_tenant_id()` reads that as null,
      // and the insert policy allows a platform_admin row with no tenant.
      await client.query('select set_config($1, $2, true)', [
        'app.tenant_id',
        attempt.tenantId ?? '',
      ]);

      const sink = new AuthorizationAuditTrail(
        new PostgresAuditTrail({
          query: async (sql, values) => {
            const result = await client.query(sql, values as unknown[] | undefined);
            return result.rows as Record<string, unknown>[];
          },
        }),
        this.#context,
      );
      await sink.record(attempt);

      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      // Rethrown, never swallowed: the enforcement point denies when the attempt cannot be
      // recorded, and that only works if the failure reaches it.
      throw error;
    } finally {
      client.release();
    }
  }
}
