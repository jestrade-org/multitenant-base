import {
  authorizedUseCase,
  permission,
  requireAll,
  ApplicationError,
  DomainError,
  type Actor,
  type AuthorizedUseCase,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

/**
 * Who works at the client, and what each of them may do (§9, VC-77).
 *
 * The two failures worth designing against are both ways of locking a company out of its
 * own account, and neither is hypothetical — they are what happens on an ordinary Tuesday
 * when somebody tidies up a user list:
 *
 * - An administrator deactivates **themselves**, and is signed out mid-click.
 * - An administrator removes the **last** person who can manage users, and now nobody can
 *   add one. The account is intact, nobody can administer it, and the fix is a support
 *   ticket into our database.
 *
 * Both are refused by the use case rather than by a disabled button, because the button is
 * not what a script or a second tab obeys.
 */

const USER_MANAGE = permission('iam:user_manage');

export interface MemberDto {
  readonly memberId: string;
  /**
   * The identity the token carries.
   *
   * Present so "is this me?" can be answered against the actor, which carries the auth
   * user id and neither the member id nor the address. Comparing the wrong one gives a
   * guard that never fires and looks like it does.
   */
  readonly authUserId: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly isActive: boolean;
  /** Whether this member's role can administer users. Drives the last-administrator rule. */
  readonly canManageUsers: boolean;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
}

export class MemberNotFoundError extends ApplicationError {
  public override readonly name = 'MemberNotFoundError';
  public readonly code = 'MEMBER_NOT_FOUND';

  public constructor(public readonly memberId: string) {
    super(`No member ${memberId}`, { memberId });
  }
}

export class CannotDeactivateSelfError extends DomainError {
  public override readonly name = 'CannotDeactivateSelfError';
  public readonly code = 'CANNOT_DEACTIVATE_SELF';

  public constructor() {
    super('An administrator cannot deactivate their own account');
  }
}

export class LastAdministratorError extends DomainError {
  public override readonly name = 'LastAdministratorError';
  public readonly code = 'LAST_ADMINISTRATOR';

  public constructor() {
    super('A company must keep at least one member who can manage users');
  }
}

/**
 * A role that exists but must not be handed to a client's user.
 *
 * the platform's own staff roles carry platform capabilities — seeing every client, provisioning
 * one, reading another company's audit trail (§8.1). A tenant administrator offering one
 * of those from their own user list is a privilege escalation waiting for someone to
 * notice it, and the rule is derived rather than a list of names: a role carrying any
 * `platform:` capability is not a role inside a company.
 */
export class RoleNotAssignableError extends DomainError {
  public override readonly name = 'RoleNotAssignableError';
  public readonly code = 'ROLE_NOT_ASSIGNABLE';

  public constructor(public readonly roleCode: string) {
    super(`${roleCode} is a platform role and cannot be given to a company's user`, { roleCode });
  }
}

export class UnknownRoleError extends ApplicationError {
  public override readonly name = 'UnknownRoleError';
  public readonly code = 'ROLE_NOT_FOUND';

  public constructor(public readonly roleCode: string) {
    super(`No role ${roleCode} for this company`, { roleCode });
  }
}

export class MemberAlreadyInvitedError extends DomainError {
  public override readonly name = 'MemberAlreadyInvitedError';
  public readonly code = 'MEMBER_ALREADY_INVITED';

  public constructor(public readonly email: string) {
    super(`${email} is already a member of this company`, { email });
  }
}

export interface MemberDirectory {
  list(): Promise<readonly MemberDto[]>;
  findByEmail(email: string): Promise<MemberDto | undefined>;
  findById(memberId: string): Promise<MemberDto | undefined>;
  /** Invites the person and records the membership. Returns the member as stored. */
  invite(input: {
    readonly email: string;
    readonly fullName: string;
    readonly roleCode: string;
  }): Promise<MemberDto>;
  changeRole(memberId: string, roleCode: string): Promise<MemberDto | undefined>;
  setActive(memberId: string, isActive: boolean): Promise<MemberDto | undefined>;
}

export type MemberAudit = (input: {
  readonly action:
    | 'iam.member_invited'
    | 'iam.member_role_changed'
    | 'iam.member_deactivated'
    | 'iam.member_reactivated';
  readonly memberId: string;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, string>>;
}) => Promise<void>;

export interface MemberAdministration {
  readonly listMembers: AuthorizedUseCase<Record<string, never>, readonly MemberDto[]>;
  readonly inviteMember: AuthorizedUseCase<
    { readonly email: string; readonly fullName: string; readonly roleCode: string },
    MemberDto
  >;
  readonly changeMemberRole: AuthorizedUseCase<
    { readonly memberId: string; readonly roleCode: string },
    MemberDto
  >;
  readonly setMemberActive: AuthorizedUseCase<
    { readonly memberId: string; readonly isActive: boolean },
    MemberDto
  >;
}

export function buildMemberAdministration(dependencies: {
  readonly pep: PolicyEnforcementPoint;
  readonly members: MemberDirectory;
  readonly audit: MemberAudit;
  /**
   * What a role is, by code, or nothing when this company has no such role.
   *
   * Returning `undefined` matters: without it an unknown code updates no rows, the member
   * comes back carrying their old role, and the use case reports success for a change that
   * never happened.
   */
  readonly describeRole: (
    roleCode: string,
  ) => Promise<{ readonly canManageUsers: boolean; readonly isPlatformRole: boolean } | undefined>;
}): MemberAdministration {
  const { pep, members, audit } = dependencies;

  /**
   * Refuses a change that would leave nobody able to administer the company.
   *
   * Counted over *active* members only, and excluding the one being changed: an
   * administrator who is about to lose the capability does not count towards keeping it.
   */
  async function assertAnotherAdministratorRemains(memberId: string): Promise<void> {
    const others = (await members.list()).filter(
      (member) => member.memberId !== memberId && member.isActive && member.canManageUsers,
    );

    if (others.length === 0) throw new LastAdministratorError();
  }

  /** Every path that hands somebody a role goes through here. */
  async function assertAssignable(roleCode: string): Promise<{ canManageUsers: boolean }> {
    const role = await dependencies.describeRole(roleCode);
    if (role === undefined) throw new UnknownRoleError(roleCode);
    if (role.isPlatformRole) throw new RoleNotAssignableError(roleCode);
    return { canManageUsers: role.canManageUsers };
  }

  return {
    listMembers: authorizedUseCase(pep, {
      name: 'ListTenantMembers',
      requirement: requireAll(USER_MANAGE),
      handler: () => members.list(),
    }),

    inviteMember: authorizedUseCase(pep, {
      name: 'InviteTenantMember',
      requirement: requireAll(USER_MANAGE),
      handler: async (actor: Actor, command) => {
        const email = command.email.trim().toLowerCase();

        // Refused rather than silently re-invited: a second invitation to an existing
        // member reads to them as an account reset, and to the administrator as though the
        // first one failed.
        const existing = await members.findByEmail(email);
        if (existing !== undefined) throw new MemberAlreadyInvitedError(email);

        await assertAssignable(command.roleCode);

        const member = await members.invite({
          email,
          fullName: command.fullName.trim(),
          roleCode: command.roleCode,
        });

        await audit({
          action: 'iam.member_invited',
          memberId: member.memberId,
          actorId: actor.actorId,
          changes: { email, roleCode: command.roleCode },
        });

        return member;
      },
    }),

    changeMemberRole: authorizedUseCase(pep, {
      name: 'ChangeTenantMemberRole',
      requirement: requireAll(USER_MANAGE),
      handler: async (actor: Actor, command) => {
        const before = await members.findById(command.memberId);
        if (before === undefined) throw new MemberNotFoundError(command.memberId);

        // Losing the capability is the same danger as being deactivated, so it is checked
        // the same way: moving the last administrator to an analyst role locks the company
        // out exactly as thoroughly as deleting them.
        const willManage = (await assertAssignable(command.roleCode)).canManageUsers;
        if (before.canManageUsers && !willManage) {
          await assertAnotherAdministratorRemains(command.memberId);
        }

        const member = await members.changeRole(command.memberId, command.roleCode);
        if (member === undefined) throw new MemberNotFoundError(command.memberId);

        await audit({
          action: 'iam.member_role_changed',
          memberId: command.memberId,
          actorId: actor.actorId,
          // Before and after: "changed a role" answers nothing an auditor asks.
          changes: { from: before.roleCode, to: command.roleCode },
        });

        return member;
      },
    }),

    setMemberActive: authorizedUseCase(pep, {
      name: 'SetTenantMemberActive',
      requirement: requireAll(USER_MANAGE),
      handler: async (actor: Actor, command) => {
        const before = await members.findById(command.memberId);
        if (before === undefined) throw new MemberNotFoundError(command.memberId);

        if (!command.isActive) {
          // Deactivating yourself signs you out mid-click, and if you were the only
          // administrator it also ends the company's ability to fix it.
          if (before.authUserId === actor.actorId) throw new CannotDeactivateSelfError();
          if (before.canManageUsers) await assertAnotherAdministratorRemains(command.memberId);
        }

        const member = await members.setActive(command.memberId, command.isActive);
        if (member === undefined) throw new MemberNotFoundError(command.memberId);

        await audit({
          action: command.isActive ? 'iam.member_reactivated' : 'iam.member_deactivated',
          memberId: command.memberId,
          actorId: actor.actorId,
          changes: { email: before.email, roleCode: before.roleCode },
        });

        return member;
      },
    }),
  };
}
