import {
  authorizedUseCase,
  permission,
  requireAll,
  type Actor,
  type AuthorizedUseCase,
  type CurrencyCode,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

import { TenantNotFoundError } from './provisionTenant.js';
import {
  definePlan,
  PlanCodeAlreadyExistsError,
  PlanNotFoundError,
  type PlanQuotas,
} from '../domain/planQuota.js';

/**
 * Managing plans and their quotas (§4.2, §9, VC-28, VC-75).
 *
 * A plan is priced and it is a set of limits, and both are data rather than code: adding
 * a fourth plan must be an insert an operator makes, not a deployment. That is the same
 * rule the permission catalogue follows (§8.3), for the same reason — the commercial team
 * changes an offer faster than we ship.
 *
 * Everything here is `platform:plan_manage`, which no tenant role holds. A client's most
 * senior user cannot reprice their own plan, and cannot raise their own quota, because the
 * capability does not exist inside their company at all.
 */

const PLAN_MANAGE = permission('platform:plan_manage');
const TENANT_MANAGE = permission('platform:tenant_manage');

/** A plan on the wire. The price is a **string** amount — a JSON number loses precision. */
export interface PlanDto {
  readonly code: string;
  readonly name: string;
  readonly monthlyPrice: { readonly amount: string; readonly currency: string };
  readonly quotas: PlanQuotas;
  /** How many clients are on it. A plan with tenants cannot be repriced carelessly. */
  readonly tenantCount: number;
  readonly updatedAt: string;
}

/**
 * Who changed a plan, for the trail (§8.4).
 *
 * Part of the write's signature, as with the tenant lifecycle: an implementation that
 * cannot write the audit row in the same transaction as the change cannot satisfy this
 * interface. Plans carry no `tenantId` — a plan belongs to the platform, and the audit
 * table's check constraint allows a null tenant precisely for a platform action.
 */
export interface PlanAudit {
  readonly actorId: string;
  readonly action: 'platform.plan_created' | 'platform.plan_redefined';
  readonly changes: Readonly<Record<string, string>>;
}

/** Who moved a client onto another plan. This one *is* about a tenant, so it names one. */
export interface PlanAssignmentAudit {
  readonly actorId: string;
  readonly tenantId: string;
  readonly action: 'tenant.plan_changed';
  readonly changes: Readonly<Record<string, string>>;
}

export interface PlanCatalogue {
  list(): Promise<readonly PlanDto[]>;
  findByCode(code: string): Promise<PlanDto | undefined>;
  /** Writes the plan and its audit row in one transaction. */
  create(
    plan: {
      readonly code: string;
      readonly name: string;
      readonly monthlyPrice: string;
      readonly currency: string;
      readonly quotas: PlanQuotas;
    },
    audit: PlanAudit,
  ): Promise<PlanDto>;
  /** Updates price and quotas of an existing plan, with its audit row, in one transaction. */
  redefine(
    plan: {
      readonly code: string;
      readonly name: string;
      readonly monthlyPrice: string;
      readonly currency: string;
      readonly quotas: PlanQuotas;
    },
    audit: PlanAudit,
  ): Promise<PlanDto>;
  /** Moves one client onto another plan, with its audit row, in one transaction. */
  assignToTenant(
    input: { readonly tenantId: string; readonly planCode: string },
    audit: PlanAssignmentAudit,
  ): Promise<void>;
  /** The plan a client is on today, so the trail records what it changed *from*. */
  planCodeOfTenant(tenantId: string): Promise<string | undefined>;
}

export interface DefinePlanCommand {
  readonly code: string;
  readonly name: string;
  readonly monthlyPrice: string;
  readonly currency: CurrencyCode;
  readonly quotas: PlanQuotas;
}

export interface AssignPlanCommand {
  readonly tenantId: string;
  readonly planCode: string;
}

export interface PlanAdministration {
  readonly listPlans: AuthorizedUseCase<Record<string, never>, readonly PlanDto[]>;
  readonly createPlan: AuthorizedUseCase<DefinePlanCommand, PlanDto>;
  readonly redefinePlan: AuthorizedUseCase<DefinePlanCommand, PlanDto>;
  readonly assignPlan: AuthorizedUseCase<AssignPlanCommand, void>;
}

export interface PlanAdministrationDependencies {
  readonly pep: PolicyEnforcementPoint;
  readonly plans: PlanCatalogue;
}

/**
 * Renders a plan's limits for the trail.
 *
 * Strings, because the audit `changes` column is read by a human years later and a
 * structured diff of three integers is no more legible than the three integers.
 */
function describeQuotas(quotas: PlanQuotas): Readonly<Record<string, string>> {
  return {
    users: String(quotas.users),
  };
}

export function buildPlanAdministration(
  dependencies: PlanAdministrationDependencies,
): PlanAdministration {
  const { pep, plans } = dependencies;

  return {
    listPlans: authorizedUseCase(pep, {
      name: 'ListPlans',
      // Read as well as write: a plan carries the commercial price of the product, and
      // the roster of who is on which plan. Neither is a client's business.
      requirement: requireAll(PLAN_MANAGE),
      handler: () => plans.list(),
    }),

    createPlan: authorizedUseCase(pep, {
      name: 'CreatePlan',
      requirement: requireAll(PLAN_MANAGE),
      handler: async (actor: Actor, command) => {
        // Validated in the domain first, so an invalid plan never reaches SQL and the
        // refusal is a typed error rather than a constraint violation.
        const plan = definePlan(command);

        const existing = await plans.findByCode(plan.code);
        // Refused by name rather than by a unique-index error: a second "essential" would
        // otherwise be reported to the operator as a driver message about an index.
        if (existing !== undefined) throw new PlanCodeAlreadyExistsError(plan.code);

        return plans.create(
          {
            code: plan.code,
            name: plan.name,
            monthlyPrice: plan.monthlyPrice.toDecimalString(),
            currency: plan.monthlyPrice.currency,
            quotas: plan.quotas,
          },
          {
            actorId: actor.actorId,
            action: 'platform.plan_created',
            changes: {
              code: plan.code,
              name: plan.name,
              monthlyPrice: plan.monthlyPrice.toString(),
              ...describeQuotas(plan.quotas),
            },
          },
        );
      },
    }),

    redefinePlan: authorizedUseCase(pep, {
      name: 'RedefinePlan',
      requirement: requireAll(PLAN_MANAGE),
      handler: async (actor: Actor, command) => {
        const plan = definePlan(command);

        const existing = await plans.findByCode(plan.code);
        if (existing === undefined) throw new PlanNotFoundError(plan.code);

        // Both values, not just the new one. "The Business plan was repriced" is not an
        // answer an auditor can use; "from 2 900 000 to 3 400 000 COP" is.
        return plans.redefine(
          {
            code: plan.code,
            name: plan.name,
            monthlyPrice: plan.monthlyPrice.toDecimalString(),
            currency: plan.monthlyPrice.currency,
            quotas: plan.quotas,
          },
          {
            actorId: actor.actorId,
            action: 'platform.plan_redefined',
            changes: {
              code: plan.code,
              name: plan.name,
              monthlyPriceBefore: `${existing.monthlyPrice.amount} ${existing.monthlyPrice.currency}`,
              monthlyPriceAfter: plan.monthlyPrice.toString(),
              usersBefore: String(existing.quotas.users),
              ...describeQuotas(plan.quotas),
              // Repricing a plan nobody is on is routine; repricing one with eleven
              // clients on it is a commercial decision, and the trail should say which
              // this was without a second query.
              tenantsAffected: String(existing.tenantCount),
            },
          },
        );
      },
    }),

    assignPlan: authorizedUseCase(pep, {
      name: 'AssignPlan',
      // Both capabilities: this changes what a client pays *and* what they may do. The
      // platform admin holds both; nobody else holds either.
      requirement: requireAll(PLAN_MANAGE, TENANT_MANAGE),
      handler: async (actor: Actor, command) => {
        const plan = await plans.findByCode(command.planCode);
        if (plan === undefined) throw new PlanNotFoundError(command.planCode);

        const before = await plans.planCodeOfTenant(command.tenantId);
        // Undefined means no such client. Recording a plan change for a tenant that does
        // not exist would put a fiction in a six-year record.
        if (before === undefined) throw new TenantNotFoundError(command.tenantId);

        await plans.assignToTenant(
          { tenantId: command.tenantId, planCode: plan.code },
          {
            actorId: actor.actorId,
            tenantId: command.tenantId,
            action: 'tenant.plan_changed',
            changes: { planBefore: before, planAfter: plan.code },
          },
        );
      },
    }),
  };
}
