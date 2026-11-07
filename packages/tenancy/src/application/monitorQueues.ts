import {
  authorizedUseCase,
  permission,
  requireAll,
  ValidationError,
  type Actor,
  type AuthorizedUseCase,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

/**
 * Watching the queues, including the dead-letter queue (§7, §9, §14, VC-75).
 *
 * The failure this exists to end is a silence. A job that exhausts its retries lands in a
 * dead-letter queue and stops; nothing errors, nothing alerts, and the only visible
 * symptom is a client who never received the reminder that was drafted for them. The queue
 * catalogue already dead-letters every queue (§7); this is the surface that makes the
 * result *visible*, which is the half that turns a mechanism into a control.
 *
 * ## What a dead-lettered job is allowed to show
 *
 * Not its payload, and not its error message. Both are tenant data:
 *
 *   - the payload of a job carries a domain event about that company's data;
 *   - a Postgres error message quotes the row that violated a constraint, so
 *     "duplicate key value violates unique constraint … (ana@acme.test, ORD-1042)" is a
 *     person's email and a record number, sitting inside what looks like a diagnostic.
 *
 * §8.1 says platform staff reach no company's data without an audited elevation,
 * and a queue screen is not an elevation. So this returns what identifies a failure and
 * nothing that describes it: queue, job id, tenant id, job name, attempt count, the
 * failure's *class*, and the correlation id. The correlation id is the point — it joins
 * straight to the log line that does hold the detail, and logs are access-controlled on
 * their own terms (§14). An operator loses nothing; the panel gains no read path.
 */

const QUEUE_MONITOR = permission('platform:queue_monitor');
const QUEUE_MANAGE = permission('platform:queue_manage');

export interface QueueSnapshotDto {
  readonly name: string;
  readonly describes: string;
  /** Waiting to be worked. Growing while `active` stays flat means nothing is consuming. */
  readonly pending: number;
  readonly active: number;
  readonly completedLastDay: number;
  readonly failedLastDay: number;
  readonly deadLettered: number;
  /**
   * Age of the oldest job still waiting, in seconds.
   *
   * Depth alone does not distinguish a busy queue from a stopped one — both show a number.
   * Age does: a queue whose oldest job is four seconds old is working, and one whose
   * oldest job is nine hours old has no consumer, whatever its depth.
   */
  readonly oldestPendingAgeSeconds: number | undefined;
  readonly retryLimit: number;
}

export interface DeadLetterJobDto {
  readonly jobId: string;
  readonly queue: string;
  /** The event type or scheduled job name. A classification, not a payload. */
  readonly jobName: string;
  readonly tenantId: string | undefined;
  /** Joins to the log line that holds the detail this deliberately does not. */
  readonly correlationId: string | undefined;
  readonly failedAt: string;
  /** How many times the original job ran before its retries were exhausted. */
  readonly attempts: number;
  /**
   * What kind of failure, never what it said.
   *
   * An error's class or SQLSTATE is a category; its message quotes the data. See the note
   * at the top of this file.
   */
  readonly failureClass: string;
}

export interface QueueInspector {
  snapshot(): Promise<readonly QueueSnapshotDto[]>;
  listDeadLettered(input: {
    readonly queue?: string;
    readonly limit: number;
  }): Promise<readonly DeadLetterJobDto[]>;
  /**
   * Puts one dead-lettered job back on the queue it came from.
   *
   * Returns the job as re-enqueued, or `undefined` when the id names nothing — an id that
   * has already been replayed by a colleague is the common case, not an error.
   */
  replay(jobId: string): Promise<DeadLetterJobDto | undefined>;
  /** Removes one dead-lettered job. Returns `undefined` when the id names nothing. */
  discard(jobId: string): Promise<DeadLetterJobDto | undefined>;
}

/** Who acted on a job, for the trail (§8.4). Written by the adapter, in the same work. */
export interface QueueAudit {
  record(input: {
    readonly actorId: string;
    readonly action: 'platform.job_replayed' | 'platform.job_discarded';
    readonly jobId: string;
    readonly tenantId: string | undefined;
    readonly changes: Readonly<Record<string, string>>;
  }): Promise<void>;
}

/**
 * The dead-letter page size.
 *
 * Bounded because an unbounded read of a queue that has been failing for a week is a
 * request nobody is still waiting for (api-design.md, API4).
 */
const MAX_DEAD_LETTER_PAGE = 100;
const DEFAULT_DEAD_LETTER_PAGE = 25;

export interface ListDeadLetteredCommand {
  readonly queue?: string | undefined;
  readonly limit?: number | undefined;
}

export interface JobActionCommand {
  readonly jobId: string;
  /** Why. Required for a discard, because a job thrown away without a reason is a gap. */
  readonly reason?: string | undefined;
}

export interface QueueMonitoring {
  readonly listQueues: AuthorizedUseCase<Record<string, never>, readonly QueueSnapshotDto[]>;
  readonly listDeadLettered: AuthorizedUseCase<
    ListDeadLetteredCommand,
    readonly DeadLetterJobDto[]
  >;
  readonly replayJob: AuthorizedUseCase<JobActionCommand, DeadLetterJobDto | undefined>;
  readonly discardJob: AuthorizedUseCase<JobActionCommand, DeadLetterJobDto | undefined>;
}

export interface QueueMonitoringDependencies {
  readonly pep: PolicyEnforcementPoint;
  readonly queues: QueueInspector;
  readonly audit: QueueAudit;
}

export function buildQueueMonitoring(dependencies: QueueMonitoringDependencies): QueueMonitoring {
  const { pep, queues, audit } = dependencies;

  return {
    listQueues: authorizedUseCase(pep, {
      name: 'ListQueues',
      requirement: requireAll(QUEUE_MONITOR),
      handler: () => queues.snapshot(),
    }),

    listDeadLettered: authorizedUseCase(pep, {
      name: 'ListDeadLetteredJobs',
      requirement: requireAll(QUEUE_MONITOR),
      handler: (_actor: Actor, command) =>
        queues.listDeadLettered({
          ...(command.queue === undefined ? {} : { queue: command.queue }),
          limit: Math.min(command.limit ?? DEFAULT_DEAD_LETTER_PAGE, MAX_DEAD_LETTER_PAGE),
        }),
    }),

    replayJob: authorizedUseCase(pep, {
      name: 'ReplayDeadLetteredJob',
      // Monitoring is a read; replaying is a side effect on a client's account. A
      // `notifications` job put back on the queue sends a real message to a real person,
      // so this needs the capability that only a platform administrator holds — the platform
      // analyst who watches the queues cannot re-send anything.
      requirement: requireAll(QUEUE_MONITOR, QUEUE_MANAGE),
      handler: async (actor: Actor, command) => {
        const job = await queues.replay(command.jobId);
        // Nothing replayed means nothing to record. Writing an audit row for a job that
        // did not move would put a fiction in a six-year record.
        if (job === undefined) return undefined;

        await audit.record({
          actorId: actor.actorId,
          action: 'platform.job_replayed',
          jobId: job.jobId,
          tenantId: job.tenantId,
          changes: {
            queue: job.queue,
            jobName: job.jobName,
            attempts: String(job.attempts),
            failureClass: job.failureClass,
            ...(command.reason === undefined ? {} : { reason: command.reason }),
          },
        });

        return job;
      },
    }),

    discardJob: authorizedUseCase(pep, {
      name: 'DiscardDeadLetteredJob',
      requirement: requireAll(QUEUE_MONITOR, QUEUE_MANAGE),
      handler: async (actor: Actor, command) => {
        const reason = command.reason?.trim() ?? '';
        // Deciding a client's job will never run is a decision, and a decision with no
        // stated reason is indistinguishable from a mis-click when it is read back.
        if (reason.length < 10) {
          throw new ValidationError(
            'reason',
            'discarding a job needs a reason a reviewer can weigh',
          );
        }

        const job = await queues.discard(command.jobId);
        if (job === undefined) return undefined;

        await audit.record({
          actorId: actor.actorId,
          action: 'platform.job_discarded',
          jobId: job.jobId,
          tenantId: job.tenantId,
          changes: {
            queue: job.queue,
            jobName: job.jobName,
            attempts: String(job.attempts),
            failureClass: job.failureClass,
            reason,
          },
        });

        return job;
      },
    }),
  };
}
