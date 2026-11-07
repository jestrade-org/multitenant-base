import { describe, expect, it } from 'vitest';

import { ValidationError } from '@multitenant-base/shared-kernel';

import {
  assertWithinQuota,
  definePlan,
  limitFor,
  PlanQuotaExceededError,
  QUOTA_WARNING_RATIO,
  readAllQuotas,
  readQuota,
  validateQuotas,
  worstStatus,
  type PlanQuotas,
} from './planQuota.js';

const QUOTAS: PlanQuotas = { users: 50 };

describe('defining a plan', () => {
  it('carries the monthly price as Money, never as a number', () => {
    const plan = definePlan({
      code: 'starter',
      name: 'Starter',
      monthlyPrice: '49.0000',
      currency: 'USD',
      quotas: QUOTAS,
    });

    expect(plan.monthlyPrice.toDecimalString()).toBe('49.0000');
    expect(plan.monthlyPrice.currency).toBe('USD');
  });

  it('normalises the code to the slug the database constrains', () => {
    const plan = definePlan({
      code: '  Enterprise_2027 ',
      name: 'Enterprise',
      monthlyPrice: '0',
      currency: 'USD',
      quotas: QUOTAS,
    });

    expect(plan.code).toBe('enterprise_2027');
  });

  it('accepts a plan that costs nothing, because a pilot plan is a real plan', () => {
    const plan = definePlan({
      code: 'pilot',
      name: 'Pilot',
      monthlyPrice: '0',
      currency: 'USD',
      quotas: QUOTAS,
    });

    expect(plan.monthlyPrice.isZero()).toBe(true);
  });

  it('rejects a negative price', () => {
    expect(() =>
      definePlan({
        code: 'starter',
        name: 'Starter',
        monthlyPrice: '-1',
        currency: 'USD',
        quotas: QUOTAS,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a code the plans table would refuse', () => {
    expect(() =>
      definePlan({
        code: '2027-plan',
        name: 'Plan',
        monthlyPrice: '100',
        currency: 'USD',
        quotas: QUOTAS,
      }),
    ).toThrow(ValidationError);
  });
});

describe('a plan quota', () => {
  it('rejects zero, which would otherwise read as "unlimited" and refuse everything', () => {
    expect(() => validateQuotas({ ...QUOTAS, users: 0 })).toThrow(ValidationError);
  });

  it('rejects a fractional limit', () => {
    expect(() => validateQuotas({ ...QUOTAS, users: 12.5 })).toThrow(ValidationError);
  });

  it('reads the limit for each kind', () => {
    expect(limitFor(QUOTAS, 'users')).toBe(50);
  });
});

describe('measuring usage against a limit', () => {
  it('is within while below the warning ratio: 1799 of 2000 is 89.95%', () => {
    const reading = readQuota('users', 1799, 2000);

    expect(reading.status).toBe('within');
    expect(reading.ratio).toBeLessThan(QUOTA_WARNING_RATIO);
  });

  it('warns exactly at the threshold: 1800 of 2000 is 90%', () => {
    expect(readQuota('users', 1800, 2000).status).toBe('warning');
  });

  it('counts sitting exactly on the limit as exceeded: 5 users of 5 cannot add a sixth', () => {
    // The off-by-one that would otherwise let every plan hold one more than it sells.
    expect(readQuota('users', 5, 5).status).toBe('exceeded');
  });

  it('is exceeded above the limit', () => {
    expect(readQuota('users', 9, 5).status).toBe('exceeded');
  });

  it('caps the ratio so a wildly over-quota tenant still renders as a bar', () => {
    expect(readQuota('users', 500, 5).ratio).toBe(2);
  });

  it('treats no usage at all as within, not as a missing measurement', () => {
    const reading = readQuota('users', 0, 200);

    expect(reading.status).toBe('within');
    expect(reading.ratio).toBe(0);
  });

  it('refuses a negative measurement rather than clamping it to zero', () => {
    expect(() => readQuota('users', -1, 5)).toThrow(ValidationError);
  });
});

describe('a tenant against their whole plan', () => {
  it('reports the worst limit, not the average', () => {
    const readings = readAllQuotas(QUOTAS, { users: 60 });

    expect(worstStatus(readings)).toBe('exceeded');
  });

  it('reports a warning when a limit is strained: 45 of 50 users is 90%', () => {
    const readings = readAllQuotas(QUOTAS, { users: 45 });

    expect(worstStatus(readings)).toBe('warning');
  });

  it('reports within when every limit is', () => {
    const readings = readAllQuotas(QUOTAS, { users: 1 });

    expect(worstStatus(readings)).toBe('within');
  });
});

describe('refusing the operation that would cross a limit', () => {
  it('allows the write that lands exactly on the limit', () => {
    expect(() => {
      assertWithinQuota('users', 5, 5);
    }).not.toThrow();
  });

  it('refuses the one after it, with both numbers so the client can be told which', () => {
    try {
      assertWithinQuota('users', 6, 5);
      expect.unreachable('the sixth user should have been refused');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PlanQuotaExceededError);
      expect((error as PlanQuotaExceededError).code).toBe('PLAN_QUOTA_EXCEEDED');
      expect((error as PlanQuotaExceededError).params).toMatchObject({
        quota: 'users',
        used: 6,
        limit: 5,
      });
    }
  });
});
