import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { Actor } from '@multitenant-base/shared-kernel';
import type { QueueMonitoring } from '@multitenant-base/tenancy';

import type { PlatformPrincipal } from '../plugins/authentication.js';

/**
 * The queue and job monitor (§7, §9, §14, VC-75).
 *
 * Platform-only, by the same structural rule as the rest of the panel: these read
 * `platformPrincipal`, so a tenant's session cannot reach them at all.
 *
 * What a dead-lettered job discloses is decided in the application layer, not here — see
 * `monitorQueues.ts`. This file's job is to validate the request and map the result.
 */

export interface QueueContext {
  readonly actor: Actor;
  readonly queues: QueueMonitoring;
}

export interface QueueRoutesOptions {
  readonly withQueues: <T>(
    principal: PlatformPrincipal,
    work: (context: QueueContext) => Promise<T>,
  ) => Promise<T>;
}

const deadLetterQuerySchema = z
  .object({
    queue: z.string().trim().min(2).max(40).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

const jobIdSchema = z.object({ jobId: z.string().uuid() }).strict();

const discardSchema = z
  .object({
    // Long enough to be a sentence. The use case enforces the same floor; the schema says
    // it here too so the operator is refused before a round trip to the database.
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const queueRoutes: FastifyPluginCallback<QueueRoutesOptions> = (app, options, ready) => {
  function staffOf(request: {
    platformPrincipal?: PlatformPrincipal;
  }): PlatformPrincipal | undefined {
    return request.platformPrincipal;
  }

  app.get('/api/v1/platform/queues', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const queues = await options.withQueues(staff, (context) =>
      context.queues.listQueues(context.actor, {}),
    );
    return reply.send(queues);
  });

  app.get('/api/v1/platform/queues/dead-letter', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const parsed = deadLetterQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_QUEUE_FILTER' } });
    }

    const jobs = await options.withQueues(staff, (context) =>
      context.queues.listDeadLettered(context.actor, parsed.data),
    );
    return reply.send(jobs);
  });

  app.post('/api/v1/platform/queues/dead-letter/:jobId/replay', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = jobIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_JOB_ID' } });
    }

    const job = await options.withQueues(staff, (context) =>
      context.queues.replayJob(context.actor, { jobId: params.data.jobId }),
    );

    // 404 when the id names nothing — usually because a colleague replayed it a moment
    // ago. Answering 200 would tell the operator they did something they did not.
    if (job === undefined) {
      return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND' } });
    }

    return reply.send(job);
  });

  app.post('/api/v1/platform/queues/dead-letter/:jobId/discard', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = jobIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_JOB_ID' } });
    }

    const body = discardSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'DISCARD_NEEDS_REASON', params: { field: 'reason' } },
      });
    }

    const job = await options.withQueues(staff, (context) =>
      context.queues.discardJob(context.actor, {
        jobId: params.data.jobId,
        reason: body.data.reason,
      }),
    );

    if (job === undefined) {
      return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND' } });
    }

    return reply.send(job);
  });

  ready();
};
