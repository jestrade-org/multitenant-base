import PgBoss from 'pg-boss';
import type { Logger } from 'pino';

import type { DomainEvent } from '@multitenant-base/shared-kernel';

import type { ReadinessCheck } from '../../http/routes/health.js';
import type { QueuePublisher } from '../outbox.js';
import {
  deadLetterQueue,
  QUEUE_NAMES,
  QUEUE_POLICIES,
  queuesForEvent,
  type QueueName,
} from './queueCatalogue.js';

/**
 * The job queue, on Postgres.
 *
 * pg-boss over the database we already run, rather than Redis (§7, principle 6). With
 * ≤100 users the job volume does not justify another piece of infrastructure to operate,
 * and pg-boss already offers retries, exponential backoff and dead-lettering over plain
 * SQL — the same guarantees a dedicated queue would be chosen for.
 *
 * Everything here sits behind `JobQueue`. Migrating to BullMQ/Redis when the signals in
 * §19.1 fire is then a new implementation of this interface: the use cases that enqueue
 * and the handlers that run do not change, because they never learn which queue they are
 * talking to.
 */

export type JobHandler = (job: {
  readonly id: string;
  readonly data: DomainEvent;
}) => Promise<void>;

export interface JobQueue extends QueuePublisher {
  start(): Promise<void>;
  stop(): Promise<void>;
  work(queue: QueueName, handler: JobHandler): Promise<void>;
  readinessCheck(): ReadinessCheck;
}

export interface PgBossQueueOptions {
  readonly connectionString: string;
  readonly logger: Logger;
  /** How many jobs one worker takes at a time. Bounded so a burst cannot starve the API. */
  readonly concurrency?: number;
}

export class PgBossQueue implements JobQueue {
  readonly #boss: PgBoss;
  readonly #logger: Logger;
  readonly #concurrency: number;
  #started = false;

  public constructor(options: PgBossQueueOptions) {
    this.#logger = options.logger;
    this.#concurrency = options.concurrency ?? 5;
    this.#boss = new PgBoss({
      connectionString: options.connectionString,
      // pg-boss owns its own schema; it never touches a tenant schema or the control
      // plane, so a queue problem cannot become a data problem.
      schema: 'pgboss',
      application_name: 'multitenant-base-queue',
    });

    // An error on the boss itself is a lost connection or a failed maintenance pass.
    // Logging it here keeps it from becoming an unhandled rejection that kills the
    // process mid-job.
    this.#boss.on('error', (error: Error) => {
      this.#logger.error({ err: error }, 'job queue error');
    });
  }

  public async start(): Promise<void> {
    if (this.#started) return;
    await this.#boss.start();

    // Queues are declared up front rather than created on first send, so a typo in a
    // queue name fails at boot instead of silently creating an eighth queue nobody works.
    for (const name of QUEUE_NAMES) {
      const policy = QUEUE_POLICIES[name];
      await this.#boss.createQueue(deadLetterQueue(name));
      await this.#boss.createQueue(name, {
        name,
        // `short`, not `standard`. This is the policy under which pg-boss actually
        // enforces `singletonKey`: its unique index is partial on
        // `state = 'created' and policy = 'short'`. Under `standard` the key is stored and
        // ignored, so every "deduplicated" send below quietly produced a second job —
        // a second collection message, a second reminder — while the code read as safe.
        // Verified against pgboss' own indexes, not against the documentation.
        policy: 'short',
        retryLimit: policy.retryLimit,
        retryDelay: policy.retryDelaySeconds,
        retryBackoff: policy.retryBackoff,
        expireInSeconds: policy.expireInSeconds,
        // Without this a job that exhausts its retries simply vanishes. Operational
        // staff review the dead-letter queue; nothing is allowed to fail invisibly.
        deadLetter: deadLetterQueue(name),
      });
    }

    this.#started = true;
    this.#logger.info({ queues: QUEUE_NAMES.length }, 'job queue started');
  }

  public async stop(): Promise<void> {
    if (!this.#started) return;
    // Lets in-flight handlers finish rather than cutting them off mid-job.
    await this.#boss.stop({ graceful: true, wait: true });
    this.#started = false;
  }

  /**
   * Routes a domain event to every queue that reacts to it.
   *
   * The event id is the job's singleton key, so the same event arriving twice from the
   * at-least-once outbox produces one job per queue rather than two.
   */
  public async publish(event: DomainEvent): Promise<void> {
    const queues = queuesForEvent(event.type);

    if (queues.length === 0) {
      this.#logger.debug(
        { type: event.type, eventId: event.eventId },
        'event is recorded and audited but routed to no queue',
      );
      return;
    }

    for (const queue of queues) {
      // The event id is the singleton key. It suppresses a duplicate only while the first
      // job is still queued, which is the common case for an outbox redelivery — and it is
      // deliberately not the only defence. Once a job completes, the same event can be
      // enqueued again, and the consumer's own ledger (§6, VC-41) is what makes the
      // *effect* happen once.
      await this.#boss.send(queue, event, {
        singletonKey: `${event.type}:${event.eventId}`,
      });
    }
  }

  /**
   * Enqueues a scheduled job for one tenant and one slot (§7, VC-42).
   *
   * The slot is the singleton key, so a second tick inside the same tenant day is a no-op
   * rather than a duplicate reminder. pg-boss answers `null` when the key is taken, which
   * is how this reports "already scheduled" without a read-then-write that two instances
   * would both pass.
   */
  public async enqueueScheduled(input: {
    readonly job: string;
    readonly tenant: { readonly id: string; readonly name: string; readonly timezone: string };
    readonly slot: string;
  }): Promise<boolean> {
    const jobId = await this.#boss.send(
      'scheduled',
      { job: input.job, tenantId: input.tenant.id, slot: input.slot },
      { singletonKey: `${input.job}:${input.tenant.id}:${input.slot}` },
    );

    return jobId !== null;
  }

  /**
   * Puts a dead-lettered job's payload back on the queue it came from (§9, VC-75).
   *
   * Sent as a *new* job rather than by flipping the old row's state, so it picks up the
   * queue's current retry policy and expiry instead of the ones it failed under — a job
   * dead-lettered before a policy change should be retried under today's rules.
   *
   * The original job id is the singleton key. Two operators clicking "reintentar" on the
   * same row produce one job, which matters most on `notifications`: the second would be a
   * second message to a real person.
   */
  public async resend(queue: QueueName, originalJobId: string, data: unknown): Promise<void> {
    await this.#boss.send(queue, data as object, { singletonKey: `replay:${originalJobId}` });
  }

  /** Removes one job. Used only for a dead-lettered job an operator replayed or discarded. */
  public async removeJob(queue: string, jobId: string): Promise<void> {
    await this.#boss.deleteJob(queue, jobId);
  }

  public async work(queue: QueueName, handler: JobHandler): Promise<void> {
    await this.#boss.work<DomainEvent>(queue, { batchSize: this.#concurrency }, async (jobs) => {
      for (const job of jobs) {
        await handler({ id: job.id, data: job.data });
      }
    });
  }

  /**
   * Readiness reaches the queue rather than assuming it.
   *
   * A process that cannot enqueue is a process that will accept work and never process
   * it, which is worse than refusing the work.
   */
  public readinessCheck(): ReadinessCheck {
    return {
      name: 'job-queue',
      check: async () => {
        if (!this.#started) return false;
        // Any real round trip to the queue's own schema proves the connection works.
        const size = await this.#boss.getQueueSize('scheduled');
        return typeof size === 'number';
      },
    };
  }

  /** Queue depth per queue, for the §14 metrics and the §19.1 migration signals. */
  public async depths(): Promise<Readonly<Record<string, number>>> {
    const entries = await Promise.all(
      QUEUE_NAMES.flatMap((name) => [
        this.#boss.getQueueSize(name).then((size) => [name, size] as const),
        this.#boss
          .getQueueSize(deadLetterQueue(name))
          .then((size) => [deadLetterQueue(name), size] as const),
      ]),
    );
    return Object.fromEntries(entries);
  }
}
