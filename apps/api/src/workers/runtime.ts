import type { Logger } from 'pino';

/**
 * The worker runtime.
 *
 * In Fase 1 the workers run inside the API process (§2, principle 6): with ≤100 users
 * the job volume does not justify a second deployable. `WORKERS_ENABLED` is the seam
 * that keeps VC-93 cheap — the same image boots as API-only or worker-only, and no
 * domain code knows the difference.
 *
 * Workers register themselves here; the queues themselves (pg-boss, the seven logical
 * queues of §7) arrive with VC-40. Starting zero workers is a legitimate state and is
 * logged as such, so an operator can tell "no workers configured" from "workers
 * silently died".
 */

export interface Worker {
  /** English, stable, matches a queue name from §7: `scheduled`, `outbox`. */
  readonly name: string;
  start(): Promise<void>;
  /** Must stop accepting new jobs and let in-flight ones finish. */
  stop(): Promise<void>;
}

export class WorkerRuntime {
  readonly #workers: Worker[] = [];
  readonly #logger: Logger;
  readonly #enabled: boolean;
  #running: Worker[] = [];

  public constructor(options: { readonly logger: Logger; readonly enabled: boolean }) {
    this.#logger = options.logger;
    this.#enabled = options.enabled;
  }

  public register(worker: Worker): void {
    this.#workers.push(worker);
  }

  public async start(): Promise<void> {
    if (!this.#enabled) {
      this.#logger.info(
        { registered: this.#workers.length },
        'workers disabled by configuration; this process serves HTTP only',
      );
      return;
    }

    for (const worker of this.#workers) {
      await worker.start();
      this.#running.push(worker);
      this.#logger.info({ worker: worker.name }, 'worker started');
    }

    this.#logger.info({ started: this.#running.length }, 'worker runtime ready');
  }

  /**
   * Stops every running worker, draining in-flight jobs.
   *
   * One worker failing to stop must not prevent the others from draining, so failures
   * are collected rather than thrown on the first one: a job left half-done because a
   * sibling worker threw is exactly the corruption this is meant to avoid.
   */
  public async stop(): Promise<void> {
    const failures: { readonly worker: string; readonly error: unknown }[] = [];

    for (const worker of [...this.#running].reverse()) {
      try {
        await worker.stop();
        this.#logger.info({ worker: worker.name }, 'worker stopped');
      } catch (error: unknown) {
        failures.push({ worker: worker.name, error });
        this.#logger.error({ worker: worker.name, err: error }, 'worker failed to stop cleanly');
      }
    }

    this.#running = [];

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ error }) => (error instanceof Error ? error : new Error(String(error)))),
        `${String(failures.length)} worker(s) failed to stop cleanly`,
      );
    }
  }
}
