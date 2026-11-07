import { beforeEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  NotAuthorizedError,
  permission,
  PolicyEnforcementPoint,
  type Actor,
  type AuthorizationAuditSink,
} from '@multitenant-base/shared-kernel';

import {
  buildMemberAdministration,
  CannotDeactivateSelfError,
  LastAdministratorError,
  MemberAlreadyInvitedError,
  MemberNotFoundError,
  RoleNotAssignableError,
  UnknownRoleError,
  type MemberAdministration,
  type MemberDirectory,
  type MemberDto,
} from './manageMembers.js';

/**
 * Managing a company's own users.
 *
 * Most of these tests are about the two ways to lock a company out of its own account.
 * They are not exotic: they are what happens when somebody tidies a user list on a Tuesday.
 */

const CLOCK = new FixedClock('2026-08-24T15:00:00.000Z');
const silentAudit: AuthorizationAuditSink = { record: () => Promise.resolve() };

const ADMIN_AUTH_ID = 'auth-admin';

/** The roles this company has. `platform_admin` exists and belongs to the platform, not to them. */
const KNOWN_ROLES: Readonly<Record<string, true>> = {
  tenant_admin: true,
  member: true,
  viewer: true,
  platform_admin: true,
};

function aMember(overrides: Partial<MemberDto> = {}): MemberDto {
  return {
    memberId: 'member-admin',
    authUserId: ADMIN_AUTH_ID,
    email: 'admin@acme.test',
    fullName: 'Claudia Restrepo',
    roleCode: 'tenant_admin',
    roleName: 'Administrador',
    isActive: true,
    canManageUsers: true,
    lastSeenAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

class InMemoryMembers implements MemberDirectory {
  public readonly stored = new Map<string, MemberDto>();

  public list(): Promise<readonly MemberDto[]> {
    return Promise.resolve([...this.stored.values()]);
  }

  public findByEmail(email: string): Promise<MemberDto | undefined> {
    return Promise.resolve([...this.stored.values()].find((one) => one.email === email));
  }

  public findById(memberId: string): Promise<MemberDto | undefined> {
    return Promise.resolve(this.stored.get(memberId));
  }

  public invite(input: {
    readonly email: string;
    readonly fullName: string;
    readonly roleCode: string;
  }): Promise<MemberDto> {
    const member = aMember({
      memberId: `member-${input.email}`,
      authUserId: `auth-${input.email}`,
      email: input.email,
      fullName: input.fullName,
      roleCode: input.roleCode,
      canManageUsers: input.roleCode === 'tenant_admin',
    });
    this.stored.set(member.memberId, member);
    return Promise.resolve(member);
  }

  public changeRole(memberId: string, roleCode: string): Promise<MemberDto | undefined> {
    const member = this.stored.get(memberId);
    if (member === undefined) return Promise.resolve(undefined);

    const updated = { ...member, roleCode, canManageUsers: roleCode === 'tenant_admin' };
    this.stored.set(memberId, updated);
    return Promise.resolve(updated);
  }

  public setActive(memberId: string, isActive: boolean): Promise<MemberDto | undefined> {
    const member = this.stored.get(memberId);
    if (member === undefined) return Promise.resolve(undefined);

    const updated = { ...member, isActive };
    this.stored.set(memberId, updated);
    return Promise.resolve(updated);
  }
}

let members: InMemoryMembers;
let administration: MemberAdministration;
let audited: { action: string; memberId: string; changes: Record<string, string> }[];

function anActor(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: ADMIN_AUTH_ID,
    actorType: 'user',
    tenantId: 'tenant-1',
    roleCode: 'tenant_admin',
    permissions: [permission('iam:user_manage')],
    ...overrides,
  };
}

beforeEach(() => {
  members = new InMemoryMembers();
  members.stored.set('member-admin', aMember());
  audited = [];
  administration = buildMemberAdministration({
    pep: new PolicyEnforcementPoint({ clock: CLOCK, auditSink: silentAudit }),
    members,
    audit: (input) => {
      audited.push(input);
      return Promise.resolve();
    },
    describeRole: (roleCode: string) =>
      Promise.resolve(
        KNOWN_ROLES[roleCode] === undefined
          ? undefined
          : {
              canManageUsers: roleCode === 'tenant_admin',
              isPlatformRole: roleCode === 'platform_admin',
            },
      ),
  });
});

describe('inviting someone', () => {
  it('records the membership and the invitation', async () => {
    const member = await administration.inviteMember(anActor(), {
      email: 'new@acme.test',
      fullName: 'Nueva Persona',
      roleCode: 'viewer',
    });

    expect(member.email).toBe('new@acme.test');
    expect(audited[0]).toMatchObject({ action: 'iam.member_invited' });
  });

  it('normalises the address, so two spellings are not two people', async () => {
    await administration.inviteMember(anActor(), {
      email: '  New@Acme.TEST ',
      fullName: 'Nueva Persona',
      roleCode: 'viewer',
    });

    expect(await members.findByEmail('new@acme.test')).toBeDefined();
  });

  it('refuses somebody who is already a member', async () => {
    // A second invitation reads to the person as an account reset, and to the
    // administrator as though the first one had failed.
    await expect(
      administration.inviteMember(anActor(), {
        email: 'admin@acme.test',
        fullName: 'Claudia Restrepo',
        roleCode: 'viewer',
      }),
    ).rejects.toBeInstanceOf(MemberAlreadyInvitedError);
  });

  it('refuses someone without the capability', async () => {
    const reader = anActor({ permissions: [permission('tenancy:read')] });

    await expect(
      administration.inviteMember(reader, {
        email: 'otra@acme.test',
        fullName: 'Otra Persona',
        roleCode: 'viewer',
      }),
    ).rejects.toBeInstanceOf(NotAuthorizedError);
  });
});

describe('not locking the company out', () => {
  it('refuses to deactivate the last administrator', async () => {
    // The account survives, nobody can administer it, and the fix is a support ticket into
    // our database.
    members.stored.set(
      'member-analyst',
      aMember({
        memberId: 'member-analyst',
        authUserId: 'auth-analyst',
        email: 'cobranza@acme.test',
        roleCode: 'viewer',
        canManageUsers: false,
      }),
    );

    await expect(
      administration.setMemberActive(anActor({ actorId: 'auth-analyst' }), {
        memberId: 'member-admin',
        isActive: false,
      }),
    ).rejects.toBeInstanceOf(LastAdministratorError);

    expect(members.stored.get('member-admin')?.isActive).toBe(true);
  });

  it('refuses to move the last administrator to a role that cannot administer', async () => {
    // The same lock-out by another route: a demotion removes the capability exactly as
    // thoroughly as a deactivation.
    await expect(
      administration.changeMemberRole(anActor(), {
        memberId: 'member-admin',
        roleCode: 'viewer',
      }),
    ).rejects.toBeInstanceOf(LastAdministratorError);
  });

  it('allows it once a second administrator exists', async () => {
    members.stored.set(
      'member-second',
      aMember({ memberId: 'member-second', authUserId: 'auth-second', email: 'otro@acme.test' }),
    );

    await expect(
      administration.setMemberActive(anActor({ actorId: 'auth-second' }), {
        memberId: 'member-admin',
        isActive: false,
      }),
    ).resolves.toMatchObject({ isActive: false });
  });

  it('does not count an inactive administrator as one who remains', async () => {
    members.stored.set(
      'member-second',
      aMember({
        memberId: 'member-second',
        authUserId: 'auth-second',
        email: 'otro@acme.test',
        isActive: false,
      }),
    );

    await expect(
      administration.setMemberActive(anActor({ actorId: 'auth-second' }), {
        memberId: 'member-admin',
        isActive: false,
      }),
    ).rejects.toBeInstanceOf(LastAdministratorError);
  });

  it('refuses to deactivate yourself', async () => {
    // Compared against the auth user id the token carries. Comparing the member id or the
    // address instead gives a guard that never fires and looks like it does.
    members.stored.set(
      'member-second',
      aMember({ memberId: 'member-second', authUserId: 'auth-second', email: 'otro@acme.test' }),
    );

    await expect(
      administration.setMemberActive(anActor(), { memberId: 'member-admin', isActive: false }),
    ).rejects.toBeInstanceOf(CannotDeactivateSelfError);
  });
});

describe('roles a company may not hand out', () => {
  it('refuses a platform role, which would let a client see every other client', async () => {
    // the platform's staff roles carry `platform:` capabilities — provisioning tenants, reading
    // another company's audit trail (§8.1). A tenant administrator must not be able to
    // give one to their own user, and the rule is derived from the capabilities rather
    // than from a list of role names that would go stale.
    await expect(
      administration.inviteMember(anActor(), {
        email: 'new@acme.test',
        fullName: 'Nueva Persona',
        roleCode: 'platform_admin',
      }),
    ).rejects.toBeInstanceOf(RoleNotAssignableError);
  });

  it('refuses to promote an existing member into a platform role', async () => {
    members.stored.set(
      'member-analyst',
      aMember({
        memberId: 'member-analyst',
        authUserId: 'auth-analyst',
        email: 'cobranza@acme.test',
        roleCode: 'viewer',
        canManageUsers: false,
      }),
    );

    await expect(
      administration.changeMemberRole(anActor(), {
        memberId: 'member-analyst',
        roleCode: 'platform_admin',
      }),
    ).rejects.toBeInstanceOf(RoleNotAssignableError);
  });

  it('refuses a role this company does not have', async () => {
    // Without this the update matches no rows, the member comes back carrying their old
    // role, and the interface reports a change that never happened.
    members.stored.set(
      'member-analyst',
      aMember({
        memberId: 'member-analyst',
        authUserId: 'auth-analyst',
        email: 'cobranza@acme.test',
        roleCode: 'viewer',
        canManageUsers: false,
      }),
    );

    await expect(
      administration.changeMemberRole(anActor(), {
        memberId: 'member-analyst',
        roleCode: 'rol_inventado',
      }),
    ).rejects.toBeInstanceOf(UnknownRoleError);

    expect(members.stored.get('member-analyst')?.roleCode).toBe('viewer');
  });
});

describe('changing a role', () => {
  it('records what it was and what it became', async () => {
    members.stored.set(
      'member-analyst',
      aMember({
        memberId: 'member-analyst',
        authUserId: 'auth-analyst',
        email: 'cobranza@acme.test',
        roleCode: 'viewer',
        canManageUsers: false,
      }),
    );

    await administration.changeMemberRole(anActor(), {
      memberId: 'member-analyst',
      roleCode: 'member',
    });

    expect(audited[0]).toMatchObject({
      action: 'iam.member_role_changed',
      changes: { from: 'viewer', to: 'member' },
    });
  });

  it('refuses a member who is not there', async () => {
    await expect(
      administration.changeMemberRole(anActor(), { memberId: 'no-existe', roleCode: 'member' }),
    ).rejects.toBeInstanceOf(MemberNotFoundError);
  });
});
