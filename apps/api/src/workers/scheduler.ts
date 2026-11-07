import type { Logger } from 'pino';

import type { Worker } from './runtime.js';
import type { ControlDatabase } from '../infrastructure/controlDatabase.js';

/**
 * The internal cron that feeds the `scheduled` queue.
 *
 * Three properties this has to have, in the order they matter.
 *
 * **Idempotent.** Every enqueue carries a key built from the job, the tenant and the slot
 * it belongs to — `daily-quota-check:acme:2026-08-23`. Two instances ticking at the same
 * moment, a restart mid-pass, a clock that steps backwards over a leap second: all of them
 * produce one job for that slot. This is not defensive coding, it is the only correct
 * design for a scheduler, because there is no arrangement of timers that guarantees a tick
 * happens exactly once.
 *
 * **Anchored to the tenant's calendar, not the server's.** A reminder due "every weekday
 * at 08:00" means 08:00 where the company is. Computing the slot from the server's clock
 * would send Monday's reminder on Sunday evening for anyone west of it, and would put a
 * month-end job in the wrong month. The slot is derived with the
 * tenant's timezone explicitly, never the process default.
 *
 * **Loud when it fails.** A scheduler that stops silently is indistinguishable from a
 * scheduler with nothing to do, and the difference only shows up as a client who never got
 * their reminder. Every pass records its outcome; a failing pass logs at error level, which
 * is the level alerting reads.
 */

/**
 * Every job the scheduler can produce. A project built on this base adds its own here —
 * a recurring reminder, a month-end close — and a branch for it in `scheduledWorker.ts`.
 */
export type ScheduledJobName = 'plan-quota-verification';

export interface ScheduledJob {
  readonly name: ScheduledJobName;
  readonly describes: string;
  /**
   * The slot this instant belongs to, in the tenant's timezone.
   *
   * Returning the same string for two ticks is what makes them one job. Returning
   * `undefined` means "not due now" — a weekday-only job on a Sunday.
   */
  slotFor(now: Date, timezone: string): string | undefined;
}

/** Formats an instant as `YYYY-MM-DD` in a named timezone, with no dependency on the host. */
export function calendarDayIn(now: Date, timezone: string): string {
  // `en-CA` yields ISO-ordered parts, which is the only reason it is used here.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The weekday in a named timezone, 1 = Monday … 7 = Sunday. */
export function isoWeekdayIn(now: Date, timezone: string): number {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
    now,
  );
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(day);
  if (index === -1) throw new RangeError(`unrecognised weekday ${day} for timezone ${timezone}`);
  return index + 1;
}

/**
 * The month just ended, in a named timezone, as `YYYY-MM`.
 *
 * The slot a monthly report belongs to. Using the *previous* month rather than the current
 * one is what makes the job land after the period it describes: a report for August
 * generated on the 1st of August would be a report about nothing. Unused by the base jobs;
 * kept because it is the helper a project's first monthly job needs.
 */
export function previousMonthIn(now: Date, timezone: string): string {
  const [year, month] = calendarDayIn(now, timezone).split('-').map(Number);
  if (year === undefined || month === undefined) {
    throw new RangeError(`could not read a month for timezone ${timezone}`);
  }

  return month === 1
    ? `${String(year - 1)}-12`
    : `${String(year)}-${String(month - 1).padStart(2, '0')}`;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    name: 'plan-quota-verification',
    describes: 'Recomputes plan usage so a tenant learns of a limit before it stops them.',
    slotFor: (now, timezone) => calendarDayIn(now, timezone),
  },
];

export interface SchedulerTenant {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
}

export interface ScheduledJobPublisher {
  /**
   * Enqueues the job for one tenant and one slot.
   *
   * Returns false when the slot was already taken, which is the normal outcome of a second
   * tick inside the same day and must not read as a failure in the logs.
   */
  enqueue(input: {
    readonly job: ScheduledJobName;
    readonly tenant: SchedulerTenant;
    readonly slot: string;
  }): Promise<boolean>;
}

export interface SchedulerOptions {
  readonly controlDatabase: ControlDatabase;
  readonly publisher: ScheduledJobPublisher;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly jobs?: readonly ScheduledJob[];
}

/**
 * Advisory lock namespace for the scheduler pass.
 *
 * Two API instances both ticking would both enqueue; the singleton key makes that
 * harmless, but doing the work twice every minute for no reason is still waste. The lock
 * is `try`-acquired and never waited on: a pass that cannot get it simply skips, because
 * another instance is already doing exactly this.
 */
const SCHEDULER_LOCK = 4_120_260_824;

export function createScheduler(options: SchedulerOptions): Worker {
  const { controlDatabase, publisher, logger } = options;
  const intervalMs = options.intervalMs ?? 60_000;
  const jobs = options.jobs ?? SCHEDULED_JOBS;
  const now = options.now ?? (() => new Date());

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopping = false;

  async function pass(): Promise<void> {
    if (running || stopping) return;
    running = true;

    const client = await controlDatabase.pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock($1) as acquired',
        [SCHEDULER_LOCK],
      );
      if (lock.rows[0]?.acquired !== true) {
        logger.debug('another instance is running the scheduler pass');
        return;
      }

      try {
        const tenants = await client.query<SchedulerTenant>(
          // An explicit allowlist, not `not in ('suspended', 'terminated')`. A lifecycle
          // status added later should have to be considered rather than silently inherit
          // reminders and escalations aimed at someone else's clients.
          `select id, name, timezone
             from control.tenants
            where lifecycle_status in ('onboarding', 'active')
            order by created_at`,
        );

        let enqueued = 0;
        const instant = now();

        for (const tenant of tenants.rows) {
          for (const job of jobs) {
            const slot = job.slotFor(instant, tenant.timezone);
            if (slot === undefined) continue;

            if (await publisher.enqueue({ job: job.name, tenant, slot })) {
              enqueued += 1;
              logger.info({ job: job.name, tenant: tenant.id, slot }, 'scheduled job enqueued');
            }
          }
        }

        logger.debug({ tenants: tenants.rowCount, enqueued }, 'scheduler pass finished');
      } finally {
        await client.query('select pg_advisory_unlock($1)', [SCHEDULER_LOCK]);
      }
    } catch (error: unknown) {
      // Error level on purpose: a scheduler that stops silently looks exactly like a
      // scheduler with nothing to do, and the difference only surfaces as a client who
      // never received their reminder (§14).
      logger.error({ err: error }, 'scheduler pass failed');
    } finally {
      client.release();
      running = false;
    }
  }

  return {
    name: 'scheduled',
    start: () => {
      stopping = false;
      timer = setInterval(() => void pass(), intervalMs);
      // Not on the first tick: a deploy should not wait a full interval to catch up on a
      // slot it missed while restarting.
      void pass();
      return Promise.resolve();
    },
    stop: async () => {
      stopping = true;
      if (timer !== undefined) clearInterval(timer);
      // Let an in-flight pass finish rather than tearing its connection out from under it.
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}
