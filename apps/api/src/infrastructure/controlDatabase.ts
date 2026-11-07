import pg from 'pg';
import type { Logger } from 'pino';

import type { ReadinessCheck } from '../http/routes/health.js';

/**
 * Connection pool for the control plane.
 *
 * One pool, one shared database (Option A, §4.1). Per-tenant isolation is not achieved by
 * having many pools — it is achieved by the resolver binding the tenant's schema on the
 * connection and by RLS validating it independently (§4.3). Repositories receive this
 * pool; nothing else constructs one.
 */

export interface ControlDatabaseOptions {
  readonly connectionString: string;
  readonly logger: Logger;
  /** Bounded so a slow database surfaces as a fast failure, not a hung request. */
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly maxConnections?: number;
}

export class ControlDatabase {
  readonly #pool: pg.Pool;
  readonly #logger: Logger;

  public constructor(options: ControlDatabaseOptions) {
    this.#logger = options.logger;
    this.#pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
      // A query that outlives this is a query nobody is still waiting for.
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      application_name: 'multitenant-base-api',
    });

    // An idle client erroring out is a lost connection, not a lost request: log it and
    // let the pool replace it rather than letting it take the process down.
    this.#pool.on('error', (error: Error) => {
      this.#logger.error({ err: error }, 'idle database client error');
    });
  }

  /**
   * Runs a parameterised query. There is no overload that takes raw SQL text built from
   * input: values always travel as parameters.
   */
  public async query<Row extends pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    const result = await this.#pool.query<Row>(text, [...values]);
    return result.rows;
  }

  /**
   * The underlying pool, for the tenant connection provider, which needs a *connection*
   * rather than a query: binding a tenant means holding one client for the whole unit of
   * work. Nothing else should reach for this.
   */
  public get pool(): pg.Pool {
    return this.#pool;
  }

  /** Readiness must actually reach the database, not merely assume the pool exists. */
  public readinessCheck(): ReadinessCheck {
    return {
      name: 'control-database',
      check: async () => {
        const rows = await this.query<{ ok: number }>('select 1 as ok');
        return rows[0]?.ok === 1;
      },
    };
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }
}
