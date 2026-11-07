import { describe, expect, it } from 'vitest';

import {
  authorizedUseCase,
  openToEveryMember,
  PolicyEnforcementPoint,
  requireAll,
  requireAny,
  type AuthorizationAttempt,
  type AuthorizationAuditSink,
} from './authorization.js';
import type { Actor } from '../domain/actor.js';
import { NotAuthorizedError } from '../domain/errors.js';
import { permission } from '../domain/permission.js';
import { FixedClock } from '../domain/ports.js';

const NOW = new FixedClock('2026-08-23T15:00:00.000Z');

class RecordingAuditSink implements AuthorizationAuditSink {
  public readonly attempts: AuthorizationAttempt[] = [];

  public record(attempt: AuthorizationAttempt): Promise<void> {
    this.attempts.push(attempt);
    return Promise.resolve();
  }
}

class FailingAuditSink implements AuthorizationAuditSink {
  public record(): Promise<void> {
    return Promise.reject(new Error('audit store unreachable'));
  }
}

function anActor(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: 'user-1',
    actorType: 'user',
    tenantId: 'tenant-acme',
    roleCode: 'accountant',
    permissions: [permission('tenancy:read'), permission('audit:read')],
    ...overrides,
  };
}

function aPep(sink: AuthorizationAuditSink = new RecordingAuditSink()) {
  return new PolicyEnforcementPoint({ clock: NOW, auditSink: sink });
}

describe('PolicyEnforcementPoint', () => {
  it('allows an actor holding every required capability', async () => {
    const sink = new RecordingAuditSink();

    await aPep(sink).authorize(
      'ReadCollections',
      requireAll(permission('tenancy:read')),
      anActor(),
    );

    expect(sink.attempts[0]?.outcome).toBe('granted');
  });

  it('refuses an actor missing one of several required capabilities', async () => {
    const requirement = requireAll(permission('tenancy:read'), permission('iam:user_manage'));

    await expect(aPep().authorize('ApproveDunning', requirement, anActor())).rejects.toThrow(
      NotAuthorizedError,
    );
  });

  it('allows an actor holding any one of the alternatives', async () => {
    const requirement = requireAny(permission('iam:role_manage'), permission('audit:read'));

    await expect(aPep().authorize('ViewSummary', requirement, anActor())).resolves.toBeUndefined();
  });

  it('records every denial with the capabilities that were missing', async () => {
    const sink = new RecordingAuditSink();

    await expect(
      aPep(sink).authorize('ApproveDunning', requireAll(permission('iam:user_manage')), anActor()),
    ).rejects.toThrow(NotAuthorizedError);

    expect(sink.attempts[0]).toMatchObject({
      useCase: 'ApproveDunning',
      outcome: 'denied',
      actorId: 'user-1',
      tenantId: 'tenant-acme',
      missingPermissions: ['iam:user_manage'],
      occurredAt: new Date('2026-08-23T15:00:00.000Z'),
    });
  });

  it('refuses an actor acting on another tenant even with every capability', async () => {
    const sink = new RecordingAuditSink();
    const owner = anActor({
      roleCode: 'owner',
      permissions: [permission('tenancy:read'), permission('iam:user_manage')],
    });

    await expect(
      aPep(sink).authorize(
        'ApproveDunning',
        requireAll(permission('iam:user_manage')),
        owner,
        'tenant-otra-empresa',
      ),
    ).rejects.toThrow(NotAuthorizedError);

    expect(sink.attempts[0]).toMatchObject({
      outcome: 'denied',
      tenantId: 'tenant-acme',
      attemptedTenantId: 'tenant-otra-empresa',
    });
  });

  it('answers a cross-tenant attempt exactly as it answers a missing capability', async () => {
    const pep = aPep();
    const owner = anActor({ permissions: [permission('iam:user_manage')] });

    const crossTenant = await pep
      .authorize('X', requireAll(permission('iam:user_manage')), owner, 'tenant-other')
      .catch((error: unknown) => error);
    const missingCapability = await pep
      .authorize('X', requireAll(permission('iam:user_manage')), anActor())
      .catch((error: unknown) => error);

    // Distinguishable answers would confirm that the other tenant's record exists.
    expect((crossTenant as NotAuthorizedError).code).toBe(
      (missingCapability as NotAuthorizedError).code,
    );
  });

  it('denies when the attempt cannot be recorded, rather than acting unaudited', async () => {
    await expect(
      aPep(new FailingAuditSink()).authorize(
        'ReadCollections',
        requireAll(permission('tenancy:read')),
        anActor(),
      ),
    ).rejects.toThrow('audit store unreachable');
  });
});

describe('declaring a requirement', () => {
  it('rejects an empty list, which would read as requiring nothing', () => {
    expect(() => requireAll()).toThrow(TypeError);
    expect(() => requireAny()).toThrow(TypeError);
  });

  it('rejects a bypass with no justification a reviewer could weigh', () => {
    expect(() => openToEveryMember('n/a')).toThrow(TypeError);
  });

  it('allows a justified bypass for any authenticated member', async () => {
    const requirement = openToEveryMember('Every member may read the tenant they belong to.');

    await expect(
      aPep().authorize('ReadOwnTenant', requirement, anActor({ permissions: [] })),
    ).resolves.toBeUndefined();
  });
});

describe('authorizedUseCase', () => {
  it('runs the handler only after the decision is made', async () => {
    const order: string[] = [];
    const sink = new RecordingAuditSink();
    const useCase = authorizedUseCase(aPep(sink), {
      name: 'ReadCollections',
      requirement: requireAll(permission('tenancy:read')),
      handler: () => {
        order.push('handler');
        return Promise.resolve('done');
      },
    });

    await useCase(anActor(), {});

    expect(order).toEqual(['handler']);
    expect(sink.attempts[0]?.outcome).toBe('granted');
  });

  it('never reaches the handler when the actor is refused', async () => {
    let reached = false;
    const useCase = authorizedUseCase(aPep(), {
      name: 'ApproveDunning',
      requirement: requireAll(permission('iam:user_manage')),
      handler: () => {
        reached = true;
        return Promise.resolve('done');
      },
    });

    await expect(useCase(anActor(), {})).rejects.toThrow(NotAuthorizedError);
    expect(reached).toBe(false);
  });

  it('checks the tenant of the resource the command names', async () => {
    const useCase = authorizedUseCase<{ readonly tenantId: string }, string>(aPep(), {
      name: 'ReadInvoice',
      requirement: requireAll(permission('tenancy:read')),
      handler: () => Promise.resolve('invoice'),
      resourceTenantId: (command) => command.tenantId,
    });

    await expect(useCase(anActor(), { tenantId: 'tenant-acme' })).resolves.toBe('invoice');
    await expect(useCase(anActor(), { tenantId: 'tenant-other' })).rejects.toThrow(
      NotAuthorizedError,
    );
  });
});
