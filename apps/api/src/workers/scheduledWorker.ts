import type { Logger } from 'pino';

/**
 * The consumer for the `scheduled` queue.
 *
 * It did not exist. The scheduler enqueued a job every pass and nothing ever worked one —
 * fourteen of them were sitting in `pgboss.job` in state `created` when this was written.
 * Nothing failed, no error was logged, and no test noticed: an unconsumed queue is a
 * silence, and silence is what this file exists to end.
 *
 * A job whose feature is not built yet is completed and logged at warn level with the
 * ticket that owes it. That is deliberate. Failing it would retry forever and fill the
 * dead-letter queue; leaving it unconsumed is what we already had. A warning names the gap
 * where an operator can see it.
 */

export interface ScheduledJobPayload {
  readonly job: string;
  readonly tenantId: string;
  readonly slot: string;
}

/** Jobs the scheduler produces that nothing implements yet, and who owes them. */
const NOT_IMPLEMENTED: Readonly<Record<string, string>> = {};

export interface ScheduledWorkerOptions {
  readonly logger: Logger;
  /**
   * Recomputes one client's plan usage and raises `QuotaThresholdReached` on a crossing.
   *
   * A callback because counting a client's usage may mean binding their connection, and
   * the composition root is the only place allowed to do it.
   */
  readonly verifyQuota: (
    tenantId: string,
  ) => Promise<{ readonly status: string; readonly alerted: boolean } | undefined>;
}

export function createScheduledHandler(options: ScheduledWorkerOptions) {
  return async function handle(payload: unknown): Promise<void> {
    const job = payload as Partial<ScheduledJobPayload>;

    if (
      typeof job.job !== 'string' ||
      typeof job.tenantId !== 'string' ||
      typeof job.slot !== 'string'
    ) {
      // A malformed job is a bug in whoever enqueued it, not something to retry forever.
      options.logger.error({ payload }, 'scheduled job without a name, a tenant or a slot');
      return;
    }

    if (job.job === 'plan-quota-verification') {
      const outcome = await options.verifyQuota(job.tenantId);

      if (outcome === undefined) {
        // Suspended or half-provisioned since the job was enqueued. Nothing is wrong, so
        // this completes rather than failing into the dead-letter queue.
        options.logger.info(
          { tenantId: job.tenantId, slot: job.slot },
          'quota verification skipped: client is not measurable',
        );
        return;
      }

      options.logger.info(
        {
          tenantId: job.tenantId,
          slot: job.slot,
          status: outcome.status,
          alerted: outcome.alerted,
        },
        'plan usage verified',
      );
      return;
    }

    const owed = NOT_IMPLEMENTED[job.job];
    if (owed !== undefined) {
      options.logger.warn(
        { job: job.job, tenantId: job.tenantId, slot: job.slot, ticket: owed },
        'scheduled job has no handler yet',
      );
      return;
    }

    options.logger.error({ job: job.job }, 'unknown scheduled job');
  };
}
