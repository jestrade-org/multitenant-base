import type pg from 'pg';
import type { Logger } from 'pino';

import { PostgresAuditTrail, type AuditEvent } from '@multitenant-base/audit';

/**
 * Records an audit event on its own short transaction (§8.4, VC-35).
 *
 * Authentication events have no business transaction to join: a failed sign-in changes
 * nothing, which is exactly what has to be recorded. A successful one has not resolved a
 * tenant yet at the moment the attempt happens.
 *
 * Failures are handled differently here than in the authorization path, and deliberately.
 * Refusing to authorize when the trail is unavailable is right — the alternative is acting
 * unaudited. Refusing to *log in* when the trail is unavailable would lock every customer
 * out of their accounts because of a database hiccup on one table. So this logs at error
 * level and lets the request proceed, and the missing rows are visible as a gap in a trail
 * that is otherwise continuous.
 */

/**
 * What the HTTP layer needs from the trail.
 *
 * A port rather than the class, so a test can supply one that fails loudly if used —
 * which is how a health probe proves it writes no audit events.
 */
export interface AuditWriter {
  record(event: AuditEvent): Promise<void>;
  recordInBackground(event: AuditEvent): void;
}

export interface AuditRecorderOptions {
  readonly pool: pg.Pool;
  readonly logger: Logger;
}

export class AuditRecorder implements AuditWriter {
  readonly #pool: pg.Pool;
  readonly #logger: Logger;

  public constructor(options: AuditRecorderOptions) {
    this.#pool = options.pool;
    this.#logger = options.logger;
  }

  public async record(event: AuditEvent): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role tenant_app');
      await client.query('select set_config($1, $2, true)', [
        'app.tenant_id',
        event.tenantId ?? '',
      ]);

      await new PostgresAuditTrail({
        query: async (sql, values) => {
          const result = await client.query(sql, values as unknown[] | undefined);
          return result.rows as Record<string, unknown>[];
        },
      }).record(event);

      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      this.#logger.error(
        { err: error, action: event.action, tenantId: event.tenantId },
        'audit event could not be recorded',
      );
    } finally {
      client.release();
    }
  }

  /** Fire-and-forget for a path that must not wait on the trail. Never left unhandled. */
  public recordInBackground(event: AuditEvent): void {
    void this.record(event);
  }
}
