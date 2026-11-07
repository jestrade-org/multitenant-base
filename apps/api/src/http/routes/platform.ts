import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import type { Actor } from '@multitenant-base/shared-kernel';
import type { TenantProvisioning } from '@multitenant-base/tenancy';

import type { PlatformPrincipal } from '../plugins/authentication.js';

/**
 * The platform panel's surface (§9, VC-27, VC-75).
 *
 * Every route here reads `request.platformPrincipal`, never `request.principal`. That is
 * the §8.1 rule expressed structurally: a tenant member reaching one of these gets a 401
 * because the decoration they carry is the other one, and a staff member reaching a
 * tenant route gets the same for the mirror reason. Neither can happen by forgetting a
 * check, because there is no check to forget.
 */

export interface PlatformContext {
  readonly actor: Actor;
  readonly provisioning: TenantProvisioning;
}

export interface PlatformRoutesOptions {
  readonly withPlatform: <T>(
    principal: PlatformPrincipal,
    work: (context: PlatformContext) => Promise<T>,
  ) => Promise<T>;
}

const provisionSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    // Accepted as the operator typed it, separators and all. The domain normalises and
    // validates it, so the same company typed twice is caught as a duplicate.
    taxId: z.string().trim().min(3).max(40),
    subdomain: z.string().trim().min(2).max(60).optional(),
    timezone: z.string().trim().min(3).max(60).optional(),
    planCode: z.string().trim().min(2).max(40),
    administratorEmail: z.string().trim().toLowerCase().email().max(320),
    administratorName: z.string().trim().min(2).max(160),
  })
  .strict();

const tenantIdSchema = z.object({ tenantId: z.string().uuid() }).strict();

export const platformRoutes: FastifyPluginCallback<PlatformRoutesOptions> = (
  app,
  options,
  ready,
) => {
  function staffOf(request: {
    platformPrincipal?: PlatformPrincipal;
  }): PlatformPrincipal | undefined {
    return request.platformPrincipal;
  }

  app.get('/api/v1/platform/tenants', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const tenants = await options.withPlatform(staff, (context) =>
      context.provisioning.listTenants(context.actor, {}),
    );
    return reply.send(tenants);
  });

  app.post(
    '/api/v1/platform/tenants',
    // Provisioning creates a schema and runs migrations. A burst of these is either a
    // mistake or an attack, and neither is worth serving quickly.
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const staff = staffOf(request);
      if (staff === undefined) {
        return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      }

      const parsed = provisionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_TENANT',
            params: { detail: parsed.error.issues[0]?.message ?? 'invalid tenant' },
          },
        });
      }

      const result = await options.withPlatform(staff, (context) =>
        context.provisioning.provisionTenant(context.actor, {
          name: parsed.data.name,
          taxId: parsed.data.taxId,
          ...(parsed.data.subdomain === undefined ? {} : { subdomain: parsed.data.subdomain }),
          ...(parsed.data.timezone === undefined ? {} : { timezone: parsed.data.timezone }),
          planCode: parsed.data.planCode,
          administratorEmail: parsed.data.administratorEmail,
          administratorName: parsed.data.administratorName,
        }),
      );

      // 200 when this finished a provisioning that had already been started, 201 when it
      // created one. The operator can tell whether their second attempt did something new.
      return reply
        .code(result.resumed ? 200 : 201)
        .header('location', `/api/v1/platform/tenants/${result.tenant.id}`)
        .send(result);
    },
  );

  app.post('/api/v1/platform/tenants/:tenantId/suspend', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = tenantIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_TENANT_ID' } });
    }

    await options.withPlatform(staff, (context) =>
      context.provisioning.suspendTenant(context.actor, { tenantId: params.data.tenantId }),
    );
    return reply.code(204).send();
  });

  app.post('/api/v1/platform/tenants/:tenantId/resume', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = tenantIdSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_TENANT_ID' } });
    }

    await options.withPlatform(staff, (context) =>
      context.provisioning.resumeTenant(context.actor, { tenantId: params.data.tenantId }),
    );
    return reply.code(204).send();
  });

  ready();
};
