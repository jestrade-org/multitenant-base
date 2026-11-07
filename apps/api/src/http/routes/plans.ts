import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import { CURRENCY_CODES, type Actor } from '@multitenant-base/shared-kernel';
import type { PlanAdministration, QuotaUsageQueries } from '@multitenant-base/tenancy';

import type { PlatformPrincipal } from '../plugins/authentication.js';

/**
 * Plans, quotas and what each client is using (§4.2, §9, VC-28, VC-75).
 *
 * Reads `request.platformPrincipal`, never `request.principal` — the same structural rule
 * the tenant roster follows. A client's administrator carries the other decoration, so
 * they cannot reach these routes by any request they can construct, and the refusal is not
 * a check anybody has to remember to write.
 */

export interface PlanContext {
  readonly actor: Actor;
  readonly plans: PlanAdministration;
  readonly quotas: QuotaUsageQueries;
}

export interface PlanRoutesOptions {
  readonly withPlans: <T>(
    principal: PlatformPrincipal,
    work: (context: PlanContext) => Promise<T>,
  ) => Promise<T>;
}

/**
 * A price as a **decimal string**, never a JSON number.
 *
 * `149.0000` through an IEEE-754 double is a price that can come back a fraction of a cent
 * different, and a plan is what a company is billed. Bounded to four decimals
 * because that is the scale of the column.
 */
const moneyAmount = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, 'an amount is a decimal string with at most four decimals');

const quotaSchema = z
  .object({
    users: z.number().int().positive().max(10_000),
  })
  .strict();

const planSchema = z
  .object({
    code: z.string().trim().min(2).max(30),
    name: z.string().trim().min(2).max(80),
    monthlyPrice: moneyAmount,
    // An allowlist rather than any three-letter string, so a typo cannot create a plan
    // denominated in nothing.
    currency: z.enum(CURRENCY_CODES),
    quotas: quotaSchema,
  })
  .strict();

const assignSchema = z
  .object({ tenantId: z.string().uuid(), planCode: z.string().trim().min(2).max(30) })
  .strict();

const planCodeSchema = z.object({ planCode: z.string().trim().min(2).max(30) }).strict();

export const planRoutes: FastifyPluginCallback<PlanRoutesOptions> = (app, options, ready) => {
  function staffOf(request: {
    platformPrincipal?: PlatformPrincipal;
  }): PlatformPrincipal | undefined {
    return request.platformPrincipal;
  }

  app.get('/api/v1/platform/plans', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const plans = await options.withPlans(staff, (context) =>
      context.plans.listPlans(context.actor, {}),
    );
    return reply.send(plans);
  });

  app.post('/api/v1/platform/plans', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_PLAN',
          params: {
            field: parsed.error.issues[0]?.path.join('.') ?? 'plan',
            detail: parsed.error.issues[0]?.message ?? 'invalid plan',
          },
        },
      });
    }

    const plan = await options.withPlans(staff, (context) =>
      context.plans.createPlan(context.actor, parsed.data),
    );

    return reply.code(201).header('location', `/api/v1/platform/plans/${plan.code}`).send(plan);
  });

  app.put('/api/v1/platform/plans/:planCode', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const params = planCodeSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PLAN_CODE' } });
    }

    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_PLAN',
          params: {
            field: parsed.error.issues[0]?.path.join('.') ?? 'plan',
            detail: parsed.error.issues[0]?.message ?? 'invalid plan',
          },
        },
      });
    }

    // The path names the plan; the body may not rename it. Accepting a differing code
    // would let a `PUT /plans/essential` reprice `premium`, which no reviewer of the
    // access log would ever spot.
    if (parsed.data.code.toLowerCase() !== params.data.planCode.toLowerCase()) {
      return reply.code(400).send({
        error: { code: 'PLAN_CODE_MISMATCH', params: { path: params.data.planCode } },
      });
    }

    const plan = await options.withPlans(staff, (context) =>
      context.plans.redefinePlan(context.actor, parsed.data),
    );
    return reply.send(plan);
  });

  app.post('/api/v1/platform/tenants/:tenantId/plan', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const parsed = assignSchema.safeParse({
      ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
      // The tenant comes from the path, not the body: two places to say the same thing is
      // two places that will one day disagree, and here the disagreement moves a client
      // onto a plan nobody chose for them.
      tenantId: (request.params as { tenantId?: string }).tenantId,
    });

    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PLAN_ASSIGNMENT' } });
    }

    await options.withPlans(staff, (context) =>
      context.plans.assignPlan(context.actor, parsed.data),
    );
    return reply.code(204).send();
  });

  app.get('/api/v1/platform/quota-usage', async (request, reply) => {
    const staff = staffOf(request);
    if (staff === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }

    const usage = await options.withPlans(staff, (context) =>
      context.quotas.listQuotaUsage(context.actor, {}),
    );
    return reply.send(usage);
  });

  ready();
};
