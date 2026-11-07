import type { ProcessedEventLedger, SuppressionWindow } from '@multitenant-base/shared-kernel';

/**
 * The deduplication ledger and the suppression window, in the tenant's own schema.
 *
 * Both take a client rather than a pool: the claim has to commit in the same transaction
 * as the work it protects. A separate connection would leave the window this whole
 * mechanism exists to close.
 */

export interface SqlClient {
  query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export class PostgresProcessedEventLedger implements ProcessedEventLedger {
  readonly #client: SqlClient;
  readonly #tenantId: string;

  public constructor(client: SqlClient, tenantId: string) {
    this.#client = client;
    this.#tenantId = tenantId;
  }

  public async claim(input: {
    readonly consumer: string;
    readonly eventId: string;
    readonly eventType: string;
  }): Promise<boolean> {
    // `on conflict do nothing` and not a select-then-insert: two workers handed the same
    // event would both pass a check-then-act, and both would act. The database is the only
    // place that can settle the race, so it settles it.
    const rows = await this.#client.query(
      `insert into processed_events (tenant_id, consumer, event_id, event_type)
            values ($1, $2, $3, $4)
       on conflict (consumer, event_id) do nothing
         returning event_id`,
      [this.#tenantId, input.consumer, input.eventId, input.eventType],
    );

    return rows.length === 1;
  }
}

export class PostgresSuppressionWindow implements SuppressionWindow {
  readonly #client: SqlClient;
  readonly #tenantId: string;

  public constructor(client: SqlClient, tenantId: string) {
    this.#client = client;
    this.#tenantId = tenantId;
  }

  public async shouldEmit(key: string, at: Date, expiresAt: Date): Promise<boolean> {
    // One statement, so the decision and the record of it cannot disagree. The update
    // branch fires only for an expired window, which re-arms it; an open window falls
    // through to the counter and returns nothing.
    const rows = await this.#client.query(
      `with previous as (
         select expires_at from suppressed_duplicates where suppression_key = $2
       )
       insert into suppressed_duplicates
              (tenant_id, suppression_key, first_seen_at, last_seen_at, expires_at)
            values ($1, $2, $4, $4, $3)
       on conflict (suppression_key) do update
              set occurrences  = suppressed_duplicates.occurrences + 1,
                  last_seen_at = $4,
                  first_seen_at = case
                    when suppressed_duplicates.expires_at <= $4 then $4
                    else suppressed_duplicates.first_seen_at end,
                  expires_at   = case
                    when suppressed_duplicates.expires_at <= $4 then excluded.expires_at
                    else suppressed_duplicates.expires_at end
         returning (xmax = 0) as inserted,
                   -- Read from the CTE, which sees the row as it was *before* this
                   -- statement touched it. Comparing the post-update row instead would
                   -- report a re-arm every time whenever the caller's clock does not move
                   -- between two alerts.
                   (select previous.expires_at <= $4 from previous) as rearmed`,
      [this.#tenantId, key, expiresAt, at],
    );

    const row = rows[0];
    if (row === undefined) return false;
    // `xmax = 0` is Postgres' way of saying this row was inserted, not updated.
    return row.inserted === true || row.rearmed === true;
  }
}
