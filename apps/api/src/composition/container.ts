import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { PolicyEnforcementPoint } from '@multitenant-base/shared-kernel';
import { TenantDirectory } from '@multitenant-base/tenancy';

import { buildPlatformContext } from './platformContext.js';
import type { AppConfig } from '../config/environment.js';
import { ReadinessRegistry } from '../http/routes/health.js';
import { TransactionalAuthorizationAudit } from '../infrastructure/auditConnection.js';
import { AuditRecorder } from '../infrastructure/auditRecorder.js';
import { SupabaseAuth } from '../infrastructure/auth/supabaseAuth.js';
import { ControlDatabase } from '../infrastructure/controlDatabase.js';
import { OutboxPoller } from '../infrastructure/outbox.js';
import { PgBossQueue } from '../infrastructure/queue/pgBossQueue.js';
import { SharedSchemaConnectionProvider } from '../infrastructure/tenantConnection.js';
import { createOutboxWorker, createQueueWorker } from '../workers/outboxWorker.js';
import { WorkerRuntime } from '../workers/runtime.js';
import { createScheduledHandler } from '../workers/scheduledWorker.js';
import { createScheduler } from '../workers/scheduler.js';

/**
 * The composition root — the one place where concrete adapters are constructed and
 * injected. No service locator, no singleton imported across modules, no
 * `new SupabaseClient()` scattered through handlers.
 *
 * Every use case is assembled here from ports and adapters, which is what keeps the
 migrations that matter later (pg-boss → BullMQ, one process → two) a change confined
 * to this file and `infrastructure/`.
 */

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly readiness: ReadinessRegistry;
  readonly controlDatabase: ControlDatabase;
  /** Resolves which tenant a request is about (§4.1). */
  readonly auth: SupabaseAuth;
  readonly tenantDirectory: TenantDirectory;
  /** Binds a connection to one tenant for one unit of work (§4.3, defence 1). */
  readonly tenantConnections: SharedSchemaConnectionProvider;
  /**
   * Decides what an actor may do, and records the decision (§8.3 layer 3, §8.4).
   *
   * Every use case is built with this. It is on the container rather than constructed
   * per use case so there is exactly one place that could ever be swapped for one that
   * does not audit — and swapping it would be a visible change to this file.
   */
  readonly policyEnforcement: PolicyEnforcementPoint;
  /** Records authentication and administration events (§8.4). */
  readonly audit: AuditRecorder;
  /** Companies, users, roles, API keys, plans, queues, audit and support access. */
  readonly platform: ReturnType<typeof buildPlatformContext>;
  /** The logical job queues, on Postgres (pg-boss). */
  readonly queue: PgBossQueue;
  /** Drains each tenant's outbox into the queue (§6). */
  readonly outboxPoller: OutboxPoller;
  readonly workers: WorkerRuntime;
  /** Releases infrastructure resources: connection pools, clients, sockets. */
  dispose(): Promise<void>;
}

export interface BuildContainerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
}

export function buildContainer(options: BuildContainerOptions): Container {
  const { config, logger } = options;

  const readiness = new ReadinessRegistry();
  const workers = new WorkerRuntime({ logger, enabled: config.workers.enabled });

  const controlDatabase = new ControlDatabase({
    connectionString: config.controlDatabase.connectionString,
    logger,
  });
  readiness.register(controlDatabase.readinessCheck());

  const auth = new SupabaseAuth({
    authUrl: config.auth.authUrl,
    anonKey: config.auth.anonKey,
    logger,
  });

  const tenantDirectory = new TenantDirectory({ client: controlDatabase });
  const tenantConnections = new SharedSchemaConnectionProvider(controlDatabase.pool);

  const audit = new AuditRecorder({ pool: controlDatabase.pool, logger });

  const policyEnforcement = new PolicyEnforcementPoint({
    clock: { now: () => new Date() },
    auditSink: new TransactionalAuthorizationAudit(controlDatabase.pool),
  });

  const queue = new PgBossQueue({
    connectionString: config.controlDatabase.connectionString,
    logger,
  });
  readiness.register(queue.readinessCheck());

  const platform = buildPlatformContext({
    config,
    logger,
    controlDatabase,
    connections: tenantConnections,
    queue,
    policyEnforcement,
    ids: { next: () => randomUUID() },
    controlTransactions: {
      transaction: async (work) => {
        const client = await controlDatabase.pool.connect();
        try {
          await client.query('begin');
          const result = await work({
            query: async (sql, values) => {
              const executed = await client.query<Record<string, unknown>>(
                sql,
                values === undefined ? [] : [...values],
              );
              return executed.rows;
            },
          });
          await client.query('commit');
          return result;
        } catch (error: unknown) {
          await client.query('rollback');
          throw error;
        } finally {
          client.release();
        }
      },
    },
  });

  const outboxPoller = new OutboxPoller({
    connections: tenantConnections,
    publisher: queue,
    logger,
  });

  // Registration order is start order, and stop runs in reverse: the queue comes up
  // before anything enqueues to it, and goes down after the drain that feeds it.
  workers.register(createQueueWorker(queue));

  workers.register(createOutboxWorker({ poller: outboxPoller, controlDatabase, logger }));

  // The consumer for what the scheduler enqueues. Without it the queue filled up in
  // silence: fourteen jobs were sitting unworked when this was written.
  const scheduled = createScheduledHandler({
    logger,
    verifyQuota: (tenantId) => platform.verifyQuota(tenantId),
  });

  workers.register({
    name: 'scheduled-subscription',
    start: () => queue.work('scheduled', (job) => scheduled(job.data)),
    stop: () => Promise.resolve(),
  });

  workers.register(
    createScheduler({
      controlDatabase,
      // The queue itself is the publisher: the slot becomes pg-boss' singleton key, so
      // two instances ticking at once still produce one job.
      publisher: { enqueue: (input) => queue.enqueueScheduled(input) },
      logger,
    }),
  );

  // Readiness reports the checks it actually has; it never claims a dependency is
  // healthy because nobody asked.

  return {
    config,
    logger,
    readiness,
    controlDatabase,
    auth,
    tenantDirectory,
    tenantConnections,
    policyEnforcement,
    audit,
    platform,
    queue,
    outboxPoller,
    workers,
    dispose: async (): Promise<void> => {
      // The worker runtime already stopped the queue — it owns that lifecycle. Disposal
      // only releases what nothing else does: the connection pool, last, because the
      // draining workers needed it right up to the moment they finished.
      await controlDatabase.close();
    },
  };
}
