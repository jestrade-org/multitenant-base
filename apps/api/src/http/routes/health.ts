import type { FastifyPluginCallback } from 'fastify';

/**
 * Liveness and readiness.
 *
 * `/health/live` answers "is this process running" — Kubernetes/Fly restarts the
 * container when it stops answering.
 *
 * `/health/ready` answers "can this process serve traffic", and it must actually check
 * its dependencies rather than returning a cheerful constant. Dependencies register
 * themselves here as they are wired in the composition root, so readiness can never
 * silently drift out of date with what the process really needs.
 */

export type ReadinessStatus = 'ok' | 'failed';

export interface ReadinessCheck {
  /** English, stable, used as a log and metric label: `control-database`, `job-queue`. */
  readonly name: string;
  /** Resolves when the dependency is reachable; rejects or returns false when not. */
  check(): Promise<boolean>;
}

export class ReadinessRegistry {
  readonly #checks: ReadinessCheck[] = [];

  public register(check: ReadinessCheck): void {
    this.#checks.push(check);
  }

  public get registered(): readonly string[] {
    return this.#checks.map((c) => c.name);
  }

  public async run(): Promise<{
    readonly ready: boolean;
    readonly checks: readonly { readonly name: string; readonly status: ReadinessStatus }[];
  }> {
    const results = await Promise.all(
      this.#checks.map(async (dependency) => {
        try {
          const healthy = await dependency.check();
          const status: ReadinessStatus = healthy ? 'ok' : 'failed';
          return { name: dependency.name, status };
        } catch {
          // The reason belongs in the dependency's own error log, not in a public
          // health response: this endpoint is reachable without authentication.
          const status: ReadinessStatus = 'failed';
          return { name: dependency.name, status };
        }
      }),
    );

    return { ready: results.every((r) => r.status === 'ok'), checks: results };
  }
}

export interface HealthRoutesOptions {
  readonly readiness: ReadinessRegistry;
  /** Set false during shutdown so the load balancer drains this instance first. */
  readonly isAcceptingTraffic: () => boolean;
}

export const healthRoutes: FastifyPluginCallback<HealthRoutesOptions> = (app, options, ready) => {
  app.get('/health/live', (_request, reply) => reply.code(200).send({ status: 'live' }));

  app.get('/health/ready', async (_request, reply) => {
    if (!options.isAcceptingTraffic()) {
      return reply.code(503).send({ status: 'draining', checks: [] });
    }

    const result = await options.readiness.run();
    return reply
      .code(result.ready ? 200 : 503)
      .send({ status: result.ready ? 'ready' : 'not-ready', checks: result.checks });
  });

  ready();
};
