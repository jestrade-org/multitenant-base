import { randomUUID } from 'node:crypto';

import type { FastifyPluginCallback } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

/**
 * A correlation id joins one request across the API log, the domain events it produces,
 * the background jobs it enqueues and the audit record it writes. Without it, an
 * incident report is a pile of unrelated lines.
 *
 * It is generated at the edge, or taken from an inbound header when a trusted caller
 * already has one. The value is echoed back so a user can quote it in support.
 */

export const CORRELATION_HEADER = 'x-correlation-id';

/** A caller-supplied id is used as a label and joined into logs, so bound it hard. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Accepts a caller's correlation id only when it is safe to put in a log line and a
 * metric label; otherwise mints a new one. A hostile value must never reach a log
 * verbatim, and an unbounded one must never become a high-cardinality label.
 *
 * Used as Fastify's `genReqId` so that pino's `reqId` and our `correlationId` are the
 * same value — two different ids for one request is how a trace goes cold.
 */
export function resolveCorrelationId(inbound: string | string[] | undefined): string {
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  return candidate !== undefined && SAFE_CORRELATION_ID.test(candidate) ? candidate : randomUUID();
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

const plugin: FastifyPluginCallback = (app, _options, ready) => {
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', (request, reply, done) => {
    // request.id was already produced by genReqId from the same inbound header.
    request.correlationId = request.id;
    void reply.header(CORRELATION_HEADER, request.correlationId);
    done();
  });

  ready();
};

/**
 * Wrapped with fastify-plugin deliberately. A plain `register` creates an encapsulated
 * context, so the hook would apply only to routes declared inside this plugin — every
 * other route would answer with no correlation id at all, and every log line and audit
 * record downstream would quietly lose the one field that joins them.
 */
export const correlationIdPlugin = fastifyPlugin(plugin, {
  name: 'correlation-id',
  fastify: '5.x',
});
