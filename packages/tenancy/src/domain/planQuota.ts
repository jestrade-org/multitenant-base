import {
  DomainError,
  Money,
  ValidationError,
  type CurrencyCode,
} from '@multitenant-base/shared-kernel';

/**
 * Plans and their quotas (§4.2).
 *
 * The base plan limits one thing: active users. A project built on this base adds its own
 * limits here — records in force, storage, API calls — as a new `QuotaKind`, a column on
 * `control.plans` and `control.tenant_quota_usage`, and a count in `TenantQuotaCounter`.
 *
 * Limits are evaluated
 * here and in the application layer — deliberately **not** as database constraints. A
 * quota that fires as a check-constraint violation surfaces as a 500 with a driver
 * message, which tells a client nothing and tells the operator that the product broke.
 * The rule is the opposite: the service is never degraded in silence, so exceeding a
 * limit has to be a typed business outcome someone can render a sentence for.
 *
 * The warning threshold matters more than the ceiling. A client who discovers their limit
 * by being refused has already lost the morning; a client warned at 90% has a
 * week. So the interesting state modelled here is `warning`, not `exceeded`.
 */

/** What a plan limits. Adding a kind is a migration plus a decision. */
export const QUOTA_KINDS = ['users'] as const;

export type QuotaKind = (typeof QUOTA_KINDS)[number];

/**
 * The fraction of a quota at which the client is warned.
 *
 * 90%, and a constant rather than a literal at three call sites: the day it becomes 85%
 * it must move everywhere at once, or two screens disagree about whether a client is in
 * trouble.
 */
export const QUOTA_WARNING_RATIO = 0.9;

export type QuotaStatus = 'within' | 'warning' | 'exceeded';

export interface PlanQuotas {
  readonly users: number;
}

export interface Plan {
  readonly code: string;
  readonly name: string;
  readonly monthlyPrice: Money;
  readonly quotas: PlanQuotas;
}

/** One limit, measured. `ratio` is presentation-only; every decision reads the counts. */
export interface QuotaReading {
  readonly kind: QuotaKind;
  readonly used: number;
  readonly limit: number;
  /** `used / limit`, clamped to 2 so a wildly over-quota client renders as a bar, not a page. */
  readonly ratio: number;
  readonly status: QuotaStatus;
}

const PLAN_CODE = /^[a-z][a-z0-9_]{1,30}$/;

/**
 * A limit was reached.
 *
 * A typed refusal, not a silent clamp and not a database error. The parameters name the
 * quota and both numbers, so the client can be told which limit and by how much rather
 * than "no se pudo completar la operación".
 */
export class PlanQuotaExceededError extends DomainError {
  public override readonly name = 'PlanQuotaExceededError';
  public readonly code = 'PLAN_QUOTA_EXCEEDED';

  public constructor(
    public readonly kind: QuotaKind,
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`quota ${kind} exceeded: ${String(used)} of ${String(limit)}`, {
      quota: kind,
      used,
      limit,
    });
  }
}

/** A plan code that names nothing. Answered as 404 at the boundary. */
export class PlanNotFoundError extends DomainError {
  public override readonly name = 'PlanNotFoundError';
  public readonly code = 'PLAN_NOT_FOUND';

  public constructor(public readonly planCode: string) {
    super(`No plan with code ${planCode}`, { planCode });
  }
}

/** Two plans cannot share a code: the code is what a tenant row points at. */
export class PlanCodeAlreadyExistsError extends DomainError {
  public override readonly name = 'PlanCodeAlreadyExistsError';
  public readonly code = 'PLAN_CODE_ALREADY_EXISTS';

  public constructor(public readonly planCode: string) {
    super(`A plan with code ${planCode} already exists`, { planCode });
  }
}

export interface DefinePlanInput {
  readonly code: string;
  readonly name: string;
  /** Decimal string, as it crosses the wire. Never a JSON number. */
  readonly monthlyPrice: string;
  readonly currency: CurrencyCode;
  readonly quotas: PlanQuotas;
}

/**
 * Validates a plan before it can exist.
 *
 * The price becomes `Money` here rather than at the database boundary, so a plan is never
 * carried around as a float that happens to be a price. A zero price is allowed — an
 * internal or pilot plan is a real thing — but a negative one is not.
 */
export function definePlan(input: DefinePlanInput): Plan {
  const code = input.code.trim().toLowerCase();
  if (!PLAN_CODE.test(code)) {
    throw new ValidationError(
      'code',
      'a plan code is lowercase letters, digits and underscores, starting with a letter',
    );
  }

  const name = input.name.trim();
  if (name.length < 2) {
    throw new ValidationError('name', 'a plan needs a name an operator can recognise');
  }

  const monthlyPrice = Money.parse(input.monthlyPrice, input.currency);
  if (monthlyPrice.isNegative()) {
    throw new ValidationError('monthlyPrice', 'a plan price may not be negative');
  }

  return { code, name, monthlyPrice, quotas: validateQuotas(input.quotas) };
}

/**
 * Every limit is a positive whole number.
 *
 * Zero is rejected rather than treated as "unlimited". An unlimited plan expressed as `0`
 * is one comparison away from being read as a limit of zero, which would refuse the
 * company's first user — and the mistake would look like a quota working correctly.
 */
export function validateQuotas(quotas: PlanQuotas): PlanQuotas {
  const entries: readonly (readonly [keyof PlanQuotas, number])[] = [['users', quotas.users]];

  for (const [field, value] of entries) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ValidationError(field, 'a quota is a whole number greater than zero');
    }
  }

  return { users: quotas.users };
}

/** Which field of `PlanQuotas` holds each kind's limit. Total, so a new kind cannot be missed. */
const QUOTA_FIELD: Readonly<Record<QuotaKind, keyof PlanQuotas>> = { users: 'users' };

export function limitFor(quotas: PlanQuotas, kind: QuotaKind): number {
  return quotas[QUOTA_FIELD[kind]];
}

/**
 * Measures one limit.
 *
 * `used === limit` is already `exceeded`, not `warning`: the limit is the number of things
 * allowed, so a client sitting exactly on it cannot add the next one. Reading it as "still
 * within" is the off-by-one that lets a plan hold one more user than it sells.
 */
export function readQuota(kind: QuotaKind, used: number, limit: number): QuotaReading {
  if (!Number.isInteger(used) || used < 0) {
    throw new ValidationError('used', 'a measured usage is a whole number, zero or more');
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ValidationError('limit', 'a quota is a whole number greater than zero');
  }

  const ratio = Math.min(used / limit, 2);

  return {
    kind,
    used,
    limit,
    ratio,
    status: used >= limit ? 'exceeded' : ratio >= QUOTA_WARNING_RATIO ? 'warning' : 'within',
  };
}

export interface MeasuredUsage {
  readonly users: number;
}

/** Every limit of a plan, measured against one tenant's usage. */
export function readAllQuotas(quotas: PlanQuotas, usage: MeasuredUsage): readonly QuotaReading[] {
  return [readQuota('users', usage.users, quotas.users)];
}

/**
 * The worst of a set of readings.
 *
 * A tenant is in whatever state their most strained limit is in. Averaging, or reporting
 * the first, would let a client sitting at 130% of one quota show as healthy because
 * another is low.
 */
export function worstStatus(readings: readonly QuotaReading[]): QuotaStatus {
  if (readings.some((reading) => reading.status === 'exceeded')) return 'exceeded';
  if (readings.some((reading) => reading.status === 'warning')) return 'warning';
  return 'within';
}

/**
 * Refuses the operation that would cross a limit, or returns.
 *
 * Called *before* the write, with the count the write would produce. Checking afterwards
 * would mean the row already exists when the refusal is raised, and the promise is
 * that the client is told, not that the product quietly rolls back.
 */
export function assertWithinQuota(kind: QuotaKind, wouldBe: number, limit: number): void {
  if (wouldBe > limit) throw new PlanQuotaExceededError(kind, wouldBe, limit);
}
