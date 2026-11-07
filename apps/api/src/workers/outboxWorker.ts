import type { Logger } from 'pino';

import type { ResolvedTenant } from '@multitenant-base/tenancy';

import type { Worker } from './runtime.js';
import type { ControlDatabase } from '../infrastructure/controlDatabase.js';
import type { OutboxPoller } from '../infrastructure/outbox.js';

/**
 * Drains every tenant's outbox on a loop.
 *
 * Polling rather than listening: `LISTEN/NOTIFY` would be lower latency, but a missed
 * notification is a silently stranded event, and this is the path an approved collection
 * message travels on. A poll that runs a second late is recoverable; an event nobody
 * ever picks up is not.
 *
 * One pass covers all tenants in sequence. With ≤15 clients that is a handful of small
 * queries; when it stops being, the fix is a worker per tenant shard, which is the same
 * §19.1 conversation as everything else here.
 */

export interface OutboxWorkerOptions {
  readonly poller: OutboxPoller;
  readonly controlDatabase: ControlDatabase;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly schema_name: string;
  readonly subdomain: string;
  readonly isolation_mode: string;
  readonly lifecycle_status: string;
  readonly timezone: string;
}

export function createOutboxWorker(options: OutboxWorkerOptions): Worker {
  const { poller, controlDatabase, logger } = options;
  const intervalMs = options.intervalMs ?? 2_000;

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopping = false;
  /** Resolves when a pass that was in flight at stop() time has finished. */
  let inFlight: Promise<void> = Promise.resolve();

  async function activeTenants(): Promise<readonly ResolvedTenant[]> {
    const rows = await controlDatabase.query<TenantRow>(
      `select id, name, schema_name, subdomain, isolation_mode, lifecycle_status, timezone
         from control.tenants
        where lifecycle_status not in ('terminated', 'suspended')
          and isolation_mode = 'shared_schema'
        order by created_at`,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      schemaName: row.schema_name,
      subdomain: row.subdomain,
      isolationMode: row.isolation_mode as ResolvedTenant['isolationMode'],
      lifecycleStatus: row.lifecycle_status as ResolvedTenant['lifecycleStatus'],
      timezone: row.timezone,
    }));
  }

  async function pass(): Promise<void> {
    // Overlapping passes would claim each other's rows and inflate attempt counts for
    // no reason. A slow pass simply skips the next tick.
    if (running || stopping) return;
    running = true;

    try {
      for (const tenant of await activeTenants()) {
        const result = await poller.drainTenant(tenant);
        if (result.claimed > 0) {
          logger.info(
            { tenant: tenant.id, ...result },
            result.failed > 0 || result.abandoned > 0
              ? 'outbox drained with failures'
              : 'outbox drained',
          );
        }
      }
    } catch (error: unknown) {
      // One bad pass must not kill the loop: the next tick retries, and the events are
      // still in the outbox where they are safe.
      logger.error({ err: error }, 'outbox drain pass failed');
    } finally {
      running = false;
    }
  }

  return {
    name: 'outbox-drain',

    start: () => {
      stopping = false;
      timer = setInterval(() => {
        inFlight = pass();
        void inFlight;
      }, intervalMs);
      // The loop must not be what keeps the process alive at shutdown.
      timer.unref();
      return Promise.resolve();
    },

    stop: async () => {
      stopping = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      // Let a pass that is mid-publish finish, so an event is not left claimed with
      // nothing having been sent.
      await inFlight;
    },
  };
}

/** Starts and stops the queue itself, so the runtime owns its lifecycle like any worker. */
export function createQueueWorker(queue: {
  start(): Promise<void>;
  stop(): Promise<void>;
}): Worker {
  return {
    name: 'job-queue',
    start: () => queue.start(),
    stop: () => queue.stop(),
  };
}
