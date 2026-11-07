import type { Logger } from 'pino';

/**
 * Graceful shutdown.
 *
 * The orchestrator sends SIGTERM and then kills the process after a grace period. If
 * the process ignores it, it dies mid-write — which in this product means a job that
 * moved money or filed with a tax authority stopped halfway. So the order matters:
 *
 *   1. fail readiness, so the load balancer stops sending new requests
 *   2. stop accepting connections and drain in-flight HTTP requests
 *   3. stop the workers, letting in-flight jobs finish
 *   4. close the database pool
 *
 * A hard timeout bounds the whole sequence: a shutdown that hangs forever is worse
 * than one that gives up loudly, because the orchestrator kills it without a trace.
 */

export interface ShutdownStep {
  readonly name: string;
  run(): Promise<void>;
}

export interface ShutdownOptions {
  readonly logger: Logger;
  readonly timeoutMs: number;
  readonly steps: readonly ShutdownStep[];
  /** Flips readiness to failing before anything is torn down. */
  readonly beginDraining: () => void;
  /** Injected so tests can assert the exit code without killing the runner. */
  readonly exit?: (code: number) => void;
}

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export function installShutdownHandlers(options: ShutdownOptions): () => Promise<void> {
  const { logger, timeoutMs, steps, beginDraining } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let shuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ reason }, 'shutdown already in progress; ignoring signal');
      return;
    }
    shuttingDown = true;

    logger.info({ reason, timeoutMs }, 'graceful shutdown started');
    beginDraining();

    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`shutdown exceeded ${String(timeoutMs)}ms`));
      }, timeoutMs);
      // Do not keep the event loop alive just for the deadline timer.
      timer.unref();
    });

    const sequence = (async () => {
      for (const step of steps) {
        logger.info({ step: step.name }, 'shutdown step started');
        await step.run();
        logger.info({ step: step.name }, 'shutdown step finished');
      }
    })();

    try {
      await Promise.race([sequence, deadline]);
      logger.info({ reason }, 'graceful shutdown complete');
      exit(0);
    } catch (error: unknown) {
      logger.error({ err: error, reason }, 'graceful shutdown failed');
      exit(1);
    }
  };

  for (const signal of SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  // An unhandled rejection or uncaught exception leaves the process in an unknown
  // state. Log it in full, then shut down rather than serving from a broken process.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error: Error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });

  return () => shutdown('programmatic');
}
