import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { AuditTrailQueries } from '@multitenant-base/audit';
import type { Actor } from '@multitenant-base/shared-kernel';

import type { PlatformPrincipal } from '../plugins/authentication.js';

/**
 * The cross-tenant audit query (§8.4, §9, VC-75).
 *
 * Platform-only and rate limited more tightly than the rest of the panel. This is the one
 * endpoint that can read what every client has been doing, so it is both the most useful
 * compliance tool in the product and the thing an insider would reach for — and a search
 * that is audited but unbounded is still a search somebody can run four hundred times
 * before anyone reads the trail.
 *
 * The filters go in the **query string**, which needs saying out loud because the rule is
 * normally the opposite: never put personal data in a URL. What travels here is a tenant
 * id, an actor id, an action code and two instants — identifiers, not personal data — and
 * making the search a `GET` is what lets a compliance reviewer bookmark and share the
 * exact query they ran. The rows that come back are the sensitive part, and they travel in
 * the body.
 */

export interface AuditTrailContext {
  readonly actor: Actor;
  readonly audit: AuditTrailQueries;
}

export interface AuditTrailRoutesOptions {
  readonly withAuditTrail: <T>(
    principal: PlatformPrincipal,
    work: (context: AuditTrailContext) => Promise<T>,
  ) => Promise<T>;
}

const searchSchema = z
  .object({
    tenantId: z.string().uuid().optional(),
    actorId: z.string().trim().min(1).max(200).optional(),
    // Validated again in the domain against the character set the column constrains; this
    // is the cheap refusal, that is the authoritative one.
    action: z
      .string()
      .trim()
      .regex(/^[a-z_]+(\.[a-z_]*)?$/)
      .max(80)
      .optional(),
    result: z.enum(['success', 'denied', 'error']).optional(),
    from: z.string().trim().max(40).optional(),
    to: z.string().trim().max(40).optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
    cursor: z.string().trim().max(200).optional(),
  })
  .strict();

export const auditTrailRoutes: FastifyPluginCallback<AuditTrailRoutesOptions> = (
  app,
  options,
  ready,
) => {
  function staffOf(request: {
    platformPrincipal?: PlatformPrincipal;
  }): PlatformPrincipal | undefined {
    return request.platformPrincipal;
  }

  app.get(
    '/api/v1/platform/audit-events',
    // Tighter than the global limit. A reviewer reads pages; a script enumerates the
    // history of every client, and thirty a minute is the difference between the two.
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const staff = staffOf(request);
      if (staff === undefined) {
        return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      }

      const parsed = searchSchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_AUDIT_FILTER',
            params: { field: parsed.error.issues[0]?.path.join('.') ?? 'filter' },
          },
        });
      }

      const page = await options.withAuditTrail(staff, (context) =>
        context.audit.searchAuditTrail(context.actor, parsed.data),
      );

      return reply.send(page);
    },
  );

  ready();
};
