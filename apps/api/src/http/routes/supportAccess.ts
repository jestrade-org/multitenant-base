import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { Actor } from '@multitenant-base/shared-kernel';
import type { SupportAccessAdministration } from '@multitenant-base/tenancy';

import type { PlatformPrincipal, SupportAccess } from '../plugins/authentication.js';

/**
 * Entering and leaving a client's account (§8.1, VC-101).
 *
 * Three routes, and the asymmetry between them is the design. Searching and entering read
 * `request.platformPrincipal`, so only a staff member who is *not* currently inside a
 * client can reach them. Leaving reads `request.supportAccess`, which is the decoration a
 * request carries only while a grant is live — so the exit is reachable exactly when there
 * is something to exit, and from nowhere else.
 *
 * Neither can be reached by forgetting a check, because there is no check to forget: the
 * decoration a request happens to carry decides which door it can open.
 */

export interface SupportAccessContext {
  readonly actor: Actor;
  readonly supportAccess: SupportAccessAdministration;
}

export interface SupportAccessRoutesOptions {
  readonly withSupportAccess: <T>(
    /** The staff identity, whether it arrived as a platform principal or inside a grant. */
    staffAuthUserId: string,
    roleCode: string,
    permissions: readonly string[],
    work: (context: SupportAccessContext) => Promise<T>,
  ) => Promise<T>;
}

const searchSchema = z
  .object({
    q: z.string().trim().max(160).optional(),
    // The platform panel opens a client and lists its people; the same endpoint serves
    // the free-text search across every client.
    tenantId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const beginSchema = z
  .object({
    memberId: z.string().uuid(),
    // Bounded and required. The domain applies the minimum length, so the message a person
    // sees comes from the rule rather than from a schema that happens to agree with it.
    reason: z.string().trim().min(1).max(500),
    durationMinutes: z.number().int().min(1).max(120).optional(),
  })
  .strict();

export const supportAccessRoutes: FastifyPluginCallback<SupportAccessRoutesOptions> = (
  app,
  options,
  ready,
) => {
  app.get('/api/v1/platform/support-access/members', async (request, reply) => {
    const staff = request.platformPrincipal;
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const query = searchSchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: { code: 'INVALID_QUERY' } });
    }

    const members = await runAs(options, staff, (context) =>
      context.supportAccess.searchMembers(context.actor, {
        query: query.data.q,
        tenantId: query.data.tenantId,
        limit: query.data.limit,
      }),
    );

    return reply.send({ items: members });
  });

  app.post('/api/v1/platform/support-access', async (request, reply) => {
    const staff = request.platformPrincipal;
    if (staff === undefined) {
      // Deliberately the same answer whether the caller is a client's user or a staff
      // member already inside a grant. Neither may open one from here, and distinguishing
      // them would tell a tenant user that this endpoint exists for someone.
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const body = beginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    }

    const granted = await runAs(options, staff, (context) =>
      context.supportAccess.begin(context.actor, {
        memberId: body.data.memberId,
        reason: body.data.reason,
        durationMinutes: body.data.durationMinutes,
        ipAddress: request.ip,
        correlationId: request.id,
      }),
    );

    // 201 and a Location: the grant is a resource, and the client's next move is to reload
    // its own session rather than to read this body back.
    return reply
      .code(201)
      .header('Location', '/api/v1/auth/me')
      .send({
        grantId: granted.grantId,
        tenant: { id: granted.tenantId, name: granted.tenantName },
        member: {
          id: granted.memberId,
          fullName: granted.memberName,
          email: granted.memberEmail,
          roleCode: granted.roleCode,
        },
        expiresAt: granted.expiresAt,
      });
  });

  /**
   * Return to my own profile.
   *
   * Reachable only from inside a grant, and idempotent: a second press, or a retry after a
   * dropped connection, is not an error. It never touches the staff member's own session,
   * so handing the account back cannot fail into being signed out.
   */
  app.delete('/api/v1/platform/support-access', async (request, reply) => {
    const access: SupportAccess | undefined = request.supportAccess;
    if (access === undefined) {
      return reply.code(404).send({ error: { code: 'NO_SUPPORT_ACCESS' } });
    }

    const principal = request.principal;
    await options.withSupportAccess(
      access.staffAuthUserId,
      principal?.roleCode ?? '',
      principal?.permissions ?? [],
      (context) => context.supportAccess.end(context.actor, {}),
    );

    return reply.code(204).send();
  });

  ready();
};

function runAs<T>(
  options: SupportAccessRoutesOptions,
  staff: PlatformPrincipal,
  work: (context: SupportAccessContext) => Promise<T>,
): Promise<T> {
  return options.withSupportAccess(staff.authUserId, staff.roleCode, staff.permissions, work);
}
