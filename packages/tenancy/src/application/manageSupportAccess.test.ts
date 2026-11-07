import { beforeEach, describe, expect, it } from 'vitest';

import {
  NotAuthorizedError,
  permission,
  PolicyEnforcementPoint,
  ValidationError,
  type Actor,
} from '@multitenant-base/shared-kernel';

import {
  buildSupportAccessAdministration,
  MemberNotReachableError,
  type EndedGrantDto,
  type SupportAccessAdministration,
  type SupportAccessDirectory,
  type SupportAccessGrantDto,
  type TenantMemberDto,
} from './manageSupportAccess.js';

/**
 * Support access (§8.1, VC-101).
 *
 * The assertions here are about the two properties the feature stands on: nobody enters a
 * client's account without the capability and a stated reason, and nobody leaves one
 * without the trail saying so. Everything else about this use case is plumbing; those two
 * are the reason it is allowed to exist.
 */

const CLOCK = { now: () => new Date('2026-08-25T14:00:00.000Z') };
const silentAudit = { record: () => Promise.resolve() };

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';

const A_GOOD_REASON = 'El cliente reporta que su resumen no carga desde ayer';

class InMemoryDirectory implements SupportAccessDirectory {
  public readonly members: TenantMemberDto[] = [
    {
      memberId: MEMBER_ID,
      fullName: 'Luis Henríquez',
      email: 'luis@servipormac.co',
      roleCode: 'member',
      tenantId: TENANT_ID,
      tenantName: 'Servipormac S.A.S.',
    },
  ];

  /** Live grants by staff id, so `close` can answer the way the database would. */
  public readonly live = new Map<string, SupportAccessGrantDto>();
  public reachable = true;
  public readonly searches: { query: string | undefined; tenantId: string | undefined }[] = [];

  public searchMembers(input: {
    readonly query: string | undefined;
    readonly tenantId: string | undefined;
    readonly limit: number;
  }): Promise<readonly TenantMemberDto[]> {
    this.searches.push({ query: input.query, tenantId: input.tenantId });
    return Promise.resolve(
      this.members.filter(
        (member) => input.tenantId === undefined || member.tenantId === input.tenantId,
      ),
    );
  }

  public open(input: {
    readonly staffAuthUserId: string;
    readonly memberId: string;
    readonly durationMinutes: number;
  }): Promise<SupportAccessGrantDto | undefined> {
    if (!this.reachable) return Promise.resolve(undefined);

    const granted: SupportAccessGrantDto = {
      grantId: `grant-${String(this.live.size + 1)}`,
      tenantId: TENANT_ID,
      tenantName: 'Servipormac S.A.S.',
      memberId: input.memberId,
      memberName: 'Luis Henríquez',
      memberEmail: 'luis@servipormac.co',
      roleCode: 'member',
      expiresAt: new Date(CLOCK.now().getTime() + input.durationMinutes * 60_000).toISOString(),
    };
    this.live.set(input.staffAuthUserId, granted);
    return Promise.resolve(granted);
  }

  public close(staffAuthUserId: string): Promise<EndedGrantDto | undefined> {
    const open = this.live.get(staffAuthUserId);
    if (open === undefined) return Promise.resolve(undefined);

    this.live.delete(staffAuthUserId);
    return Promise.resolve({
      grantId: open.grantId,
      tenantId: open.tenantId,
      memberId: open.memberId,
    });
  }
}

let directory: InMemoryDirectory;
let administration: SupportAccessAdministration;
let audited: {
  action: string;
  tenantId: string;
  memberId: string;
  changes: Record<string, string>;
}[];

function aStaffActor(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: STAFF_ID,
    actorType: 'platform_admin',
    tenantId: undefined,
    roleCode: 'platform_admin',
    permissions: [permission('platform:support_access')],
    ...overrides,
  };
}

beforeEach(() => {
  directory = new InMemoryDirectory();
  audited = [];
  administration = buildSupportAccessAdministration({
    pep: new PolicyEnforcementPoint({ clock: CLOCK, auditSink: silentAudit }),
    directory,
    audit: {
      record: (input) => {
        audited.push({
          action: input.action,
          tenantId: input.tenantId,
          memberId: input.memberId,
          changes: { ...input.changes },
        });
        return Promise.resolve();
      },
    },
  });
});

describe('finding someone to help', () => {
  it('refuses an operator who does not hold the capability', async () => {
    const analyst = aStaffActor({ permissions: [permission('platform:queue_monitor')] });

    await expect(administration.searchMembers(analyst, {})).rejects.toBeInstanceOf(
      NotAuthorizedError,
    );
  });

  it('narrows to one client when the panel opened one', async () => {
    await administration.searchMembers(aStaffActor(), { tenantId: TENANT_ID });

    expect(directory.searches).toEqual([{ query: undefined, tenantId: TENANT_ID }]);
  });

  it('treats a blank search box as no search at all', async () => {
    await administration.searchMembers(aStaffActor(), { query: '   ' });

    expect(directory.searches[0]?.query).toBeUndefined();
  });
});

describe('entering a client account', () => {
  it('refuses an operator who does not hold the capability', async () => {
    const analyst = aStaffActor({ permissions: [permission('platform:tenant_manage')] });

    await expect(
      administration.begin(analyst, { memberId: MEMBER_ID, reason: A_GOOD_REASON }),
    ).rejects.toBeInstanceOf(NotAuthorizedError);
    expect(directory.live.size).toBe(0);
  });

  it('refuses a reason too short for a reviewer to weigh', async () => {
    await expect(
      administration.begin(aStaffActor(), { memberId: MEMBER_ID, reason: 'soporte' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(directory.live.size).toBe(0);
    expect(audited).toEqual([]);
  });

  it('refuses a grant that would outlive the afternoon it was opened for', async () => {
    await expect(
      administration.begin(aStaffActor(), {
        memberId: MEMBER_ID,
        reason: A_GOOD_REASON,
        durationMinutes: 480,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(directory.live.size).toBe(0);
  });

  it('records who entered, whose account, and why', async () => {
    const granted = await administration.begin(aStaffActor(), {
      memberId: MEMBER_ID,
      reason: A_GOOD_REASON,
    });

    expect(granted.tenantId).toBe(TENANT_ID);
    expect(audited).toEqual([
      {
        action: 'platform.support_access_granted',
        tenantId: TENANT_ID,
        memberId: MEMBER_ID,
        changes: {
          grantId: granted.grantId,
          roleCode: 'member',
          expiresAt: granted.expiresAt,
          reason: A_GOOD_REASON,
        },
      },
    ]);
  });

  it('closes the previous session in the trail rather than letting it trail off', async () => {
    await administration.begin(aStaffActor(), { memberId: MEMBER_ID, reason: A_GOOD_REASON });
    audited.length = 0;

    await administration.begin(aStaffActor(), { memberId: MEMBER_ID, reason: A_GOOD_REASON });

    expect(audited.map((entry) => entry.action)).toEqual([
      'platform.support_access_ended',
      'platform.support_access_granted',
    ]);
    expect(audited[0]?.changes.endedBecause).toBe('superseded');
  });

  it('writes no record when the member cannot be reached', async () => {
    directory.reachable = false;

    await expect(
      administration.begin(aStaffActor(), { memberId: MEMBER_ID, reason: A_GOOD_REASON }),
    ).rejects.toBeInstanceOf(MemberNotReachableError);
    expect(audited).toEqual([]);
  });
});

describe('handing the account back', () => {
  /**
   * The case this endpoint exists for.
   *
   * While a grant is live the request carries the *client's* permissions and none of the
   * staff member's own — so an exit gated on a platform capability would trap them inside
   * somebody else's account with no way out but signing off entirely.
   */
  it('lets someone out who no longer holds any platform capability', async () => {
    await administration.begin(aStaffActor(), { memberId: MEMBER_ID, reason: A_GOOD_REASON });
    audited.length = 0;

    const insideTheClient = aStaffActor({
      tenantId: TENANT_ID,
      roleCode: 'member',
      permissions: [permission('tenancy:read')],
    });

    await administration.end(insideTheClient, {});

    expect(directory.live.size).toBe(0);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.action).toBe('platform.support_access_ended');
    expect(audited[0]?.changes.endedBecause).toBe('returned');
  });

  it('is idempotent: leaving twice is not an error and writes one record', async () => {
    await administration.begin(aStaffActor(), { memberId: MEMBER_ID, reason: A_GOOD_REASON });
    audited.length = 0;

    await administration.end(aStaffActor(), {});
    const second = await administration.end(aStaffActor(), {});

    expect(second).toBeUndefined();
    expect(audited).toHaveLength(1);
  });

  it('records nothing for someone who never left their own profile', async () => {
    const ordinary = aStaffActor({ permissions: [] });

    await expect(administration.end(ordinary, {})).resolves.toBeUndefined();
    expect(audited).toEqual([]);
  });
});
