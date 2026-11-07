import type pg from 'pg';

import type { DeadLetterJobDto, QueueInspector, QueueSnapshotDto } from '@multitenant-base/tenancy';

import type { PgBossQueue } from './pgBossQueue.js';
import { deadLetterQueue, QUEUE_NAMES, QUEUE_POLICIES, type QueueName } from './queueCatalogue.js';

/**
 * What the platform panel is allowed to know about the queues (§7, §9, §14, VC-75).
 *
 * Reads `pgboss.job` directly rather than through pg-boss' own API, because the API
 * answers one number at a time — `getQueueSize(name)` — and this screen needs counts by
 * state, the age of the oldest waiting job, and the dead-letter contents. Fifteen round
 * trips per page view to assemble what one grouped query already knows is not a trade
 * worth making.
 *
 * The queue names are the closed set in the catalogue, never a request parameter, so
 * nothing here interpolates a caller's string into SQL.
 *
 * ## What a dead-lettered job is not allowed to show
 *
 * `data` and `output` are never read into a DTO. A job's payload is a domain event about
 * a company's data, and a Postgres error message quotes the row that failed — so
 * "duplicate key value violates unique constraint … (ana@acme.test, ORD-1042)" is a
 * person's email and a record number wearing a diagnostic's clothes. §8.1 gives platform
 * staff no read path into a company's data, and a queue screen is not an audited
 * elevation. What leaves this file is the failure's *class* and the correlation id, which
 * is the join key to the log that does hold the detail.
 */

/**
 * Whether the failure is "pg-boss has never run here".
 *
 * `42P01` is `undefined_table`. On an environment where no job has ever been enqueued the
 * `pgboss` schema does not exist yet — pg-boss creates it when a worker first starts — and
 * a monitoring screen that answers 500 on a brand-new deployment is reporting an outage
 * where the truth is "nothing has happened yet". Every other database error still
 * propagates: a screen that swallowed them would report empty queues while the database
 * was on fire, which is the worse failure of the two.
 */
function isQueueSchemaMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '42P01'
  );
}

/** Every queue's dead-letter twin, so a name from the database can be mapped back. */
const ORIGIN_OF_DEAD_LETTER = new Map<string, QueueName>(
  QUEUE_NAMES.map((name) => [deadLetterQueue(name), name]),
);

interface QueueCountsRow {
  readonly name: string;
  readonly pending: string;
  readonly active: string;
  readonly completed_last_day: string;
  readonly failed_last_day: string;
  readonly oldest_pending_age_seconds: string | null;
}

interface DeadLetterRow {
  readonly id: string;
  readonly name: string;
  readonly created_on: Date;
  readonly retry_count: number;
  readonly job_name: string | null;
  readonly tenant_id: string | null;
  readonly correlation_id: string | null;
  readonly failure_class: string | null;
}

/**
 * The failure's class, from whatever pg-boss put in `output`.
 *
 * Extracted in SQL rather than here so the message never crosses into the process at all —
 * a value that is never selected cannot be logged by accident later. The fallbacks matter
 * because `output` is untyped: a handler that threw a string, or a job expired by the
 * queue itself, both produce something that is not an `Error`.
 */
const FAILURE_CLASS = `
  coalesce(
    j.output #>> '{value,name}',
    j.output #>> '{name}',
    case when j.output is null then 'unknown' else 'Error' end
  )
`;

/**
 * The job's own name, as a classification.
 *
 * `type` for a domain event, `job` for a scheduled pass, and the queue itself for anything
 * else. All three are closed vocabularies defined in this repository — an event type from
 * the catalogue, a scheduled job name from the scheduler — so none of them is client data.
 */
const JOB_NAME = `coalesce(j.data ->> 'type', j.data ->> 'job', j.name)`;

export interface PgBossQueueInspectorOptions {
  readonly pool: pg.Pool;
  readonly queue: PgBossQueue;
}

export class PgBossQueueInspector implements QueueInspector {
  readonly #pool: pg.Pool;
  readonly #queue: PgBossQueue;

  public constructor(options: PgBossQueueInspectorOptions) {
    this.#pool = options.pool;
    this.#queue = options.queue;
  }

  public async snapshot(): Promise<readonly QueueSnapshotDto[]> {
    const result = await this.#countRows(
      `select j.name,
              count(*) filter (where j.state = 'created' or j.state = 'retry')   as pending,
              count(*) filter (where j.state = 'active')                          as active,
              count(*) filter (
                where j.state = 'completed' and j.completed_on > now() - interval '1 day'
              ) as completed_last_day,
              count(*) filter (
                where j.state in ('failed', 'cancelled')
                  and j.completed_on > now() - interval '1 day'
              ) as failed_last_day,
              -- Age, not just depth. A queue with 400 jobs whose oldest is four seconds
              -- old is busy; one with 3 jobs whose oldest is nine hours old has no
              -- consumer, and only the second is an incident.
              extract(epoch from now() - min(j.created_on) filter (
                where j.state = 'created' or j.state = 'retry'
              )) as oldest_pending_age_seconds
         from pgboss.job j
        where j.name = any($1::text[])
        group by j.name`,
      [[...QUEUE_NAMES, ...QUEUE_NAMES.map((name) => deadLetterQueue(name))]],
    );

    // No rows and no schema look the same from here, and they should: both mean nothing
    // has been enqueued. Every queue in the catalogue is still listed, at zero, because a
    // queue missing from the screen reads as a queue nobody is watching.
    const byName = new Map(result.map((row) => [row.name, row]));

    return QUEUE_NAMES.map((name) => {
      const row = byName.get(name);
      const dead = byName.get(deadLetterQueue(name));
      const policy = QUEUE_POLICIES[name];
      const age = row?.oldest_pending_age_seconds;

      return {
        name,
        describes: policy.describes,
        pending: Number(row?.pending ?? 0),
        active: Number(row?.active ?? 0),
        completedLastDay: Number(row?.completed_last_day ?? 0),
        failedLastDay: Number(row?.failed_last_day ?? 0),
        // A dead-lettered job sits in its own queue as `created` — it is waiting for a
        // human, not for a worker, which is why it is counted separately from `pending`.
        deadLettered: Number(dead?.pending ?? 0),
        oldestPendingAgeSeconds:
          age === null || age === undefined ? undefined : Math.round(Number(age)),
        retryLimit: policy.retryLimit,
      } satisfies QueueSnapshotDto;
    });
  }

  public async listDeadLettered(input: {
    readonly queue?: string;
    readonly limit: number;
  }): Promise<readonly DeadLetterJobDto[]> {
    // The filter is matched against the closed catalogue rather than passed through: an
    // unknown queue name yields the whole set, never a query shaped by a caller's string.
    const wanted =
      input.queue !== undefined && (QUEUE_NAMES as readonly string[]).includes(input.queue)
        ? [deadLetterQueue(input.queue as QueueName)]
        : QUEUE_NAMES.map((name) => deadLetterQueue(name));

    const rows = await this.#deadLetterRows(
      `select j.id, j.name, j.created_on, j.retry_count,
              ${JOB_NAME}                as job_name,
              j.data ->> 'tenantId'      as tenant_id,
              j.data ->> 'correlationId' as correlation_id,
              ${FAILURE_CLASS}           as failure_class
         from pgboss.job j
        where j.name = any($1::text[])
          and j.state = 'created'
        order by j.created_on desc, j.id desc
        limit $2`,
      [wanted, input.limit],
    );

    return rows.map((row) => this.#toDto(row));
  }

  public async replay(jobId: string): Promise<DeadLetterJobDto | undefined> {
    const job = await this.#findDeadLettered(jobId);
    if (job === undefined) return undefined;

    const origin = ORIGIN_OF_DEAD_LETTER.get(job.row.name);
    // A dead-letter queue whose origin is not in the catalogue is a queue this build does
    // not know about — a rename mid-deploy, most likely. Refusing beats guessing where to
    // put someone's job.
    if (origin === undefined) return undefined;

    // Re-sent through pg-boss rather than by an insert, so the job picks up the queue's
    // current retry policy and expiry instead of the ones it was dead-lettered under.
    await this.#queue.resend(origin, job.row.id, job.data);
    await this.#queue.removeJob(job.row.name, job.row.id);

    return job.dto;
  }

  public async discard(jobId: string): Promise<DeadLetterJobDto | undefined> {
    const job = await this.#findDeadLettered(jobId);
    if (job === undefined) return undefined;

    await this.#queue.removeJob(job.row.name, job.row.id);
    return job.dto;
  }

  /**
   * Finds one dead-lettered job by id.
   *
   * `data` is selected here and nowhere else, because replaying needs the payload to put
   * back on the queue. It goes straight to pg-boss and never into a DTO, a log line or a
   * response body.
   */
  async #findDeadLettered(
    jobId: string,
  ): Promise<{ row: DeadLetterRow; data: unknown; dto: DeadLetterJobDto } | undefined> {
    // Same guard as the list: on a database where nothing has ever been enqueued, "no
    // such job" is the truthful answer and 404 is the right status for it.
    let result: { rows: (DeadLetterRow & { data: unknown })[] };
    try {
      result = await this.#pool.query<DeadLetterRow & { data: unknown }>(
        `select j.id, j.name, j.created_on, j.retry_count, j.data,
              ${JOB_NAME}                as job_name,
              j.data ->> 'tenantId'      as tenant_id,
              j.data ->> 'correlationId' as correlation_id,
              ${FAILURE_CLASS}           as failure_class
         from pgboss.job j
        where j.id = $1::uuid
          and j.name = any($2::text[])
          and j.state = 'created'`,
        [jobId, [...ORIGIN_OF_DEAD_LETTER.keys()]],
      );
    } catch (error: unknown) {
      if (isQueueSchemaMissing(error)) return undefined;
      throw error;
    }

    const row = result.rows[0];
    if (row === undefined) return undefined;

    return { row, data: row.data, dto: this.#toDto(row) };
  }

  /**
   * Reads that answer "nothing yet" instead of failing on a database where pg-boss has
   * never started. Only that one condition is swallowed — see `isQueueSchemaMissing`.
   */
  async #countRows(text: string, values: readonly unknown[]): Promise<readonly QueueCountsRow[]> {
    try {
      const result = await this.#pool.query<QueueCountsRow>(text, [...values]);
      return result.rows;
    } catch (error: unknown) {
      if (isQueueSchemaMissing(error)) return [];
      throw error;
    }
  }

  async #deadLetterRows(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly DeadLetterRow[]> {
    try {
      const result = await this.#pool.query<DeadLetterRow>(text, [...values]);
      return result.rows;
    } catch (error: unknown) {
      if (isQueueSchemaMissing(error)) return [];
      throw error;
    }
  }

  #toDto(row: DeadLetterRow): DeadLetterJobDto {
    const origin = ORIGIN_OF_DEAD_LETTER.get(row.name);

    return {
      jobId: row.id,
      queue: origin ?? row.name,
      jobName: row.job_name ?? row.name,
      tenantId: row.tenant_id ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      failedAt: row.created_on.toISOString(),
      // Derived from the policy, not read from the row.
      //
      // pg-boss inserts the dead-letter copy as a *new* job, so its own `retry_count` is
      // zero — reading it would report every exhausted job as having been tried once.
      // What is actually known is the rule: a job only reaches this queue after using up
      // its retries, so the original made `retryLimit + 1` attempts.
      attempts: origin === undefined ? row.retry_count + 1 : QUEUE_POLICIES[origin].retryLimit + 1,
      failureClass: row.failure_class ?? 'unknown',
    };
  }
}
