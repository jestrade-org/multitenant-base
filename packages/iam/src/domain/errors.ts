import { DomainError } from '@multitenant-base/shared-kernel';

/** A system role is shared by every tenant; one client cannot redefine it for the rest. */
export class RoleImmutableError extends DomainError {
  public override readonly name = 'RoleImmutableError';
  public readonly code = 'ROLE_IS_SYSTEM_DEFINED';

  public constructor(public readonly roleCode: string) {
    super(`${roleCode} is a system role and cannot be modified`, { roleCode });
  }
}

/**
 * Refuses to hand out a capability the actor does not hold, or one that operates the
 * platform itself. Without this, "roles are configurable" is a self-service escalation.
 */
export class PermissionNotGrantableError extends DomainError {
  public override readonly name = 'PermissionNotGrantableError';
  public readonly code = 'PERMISSION_NOT_GRANTABLE';

  public constructor(
    public readonly permissionCode: string,
    public readonly reason: string,
  ) {
    super(`${permissionCode} cannot be granted: ${reason}`, { permissionCode, reason });
  }
}

/** The role is absent, or belongs to another tenant. Deliberately the same answer. */
export class RoleNotFoundError extends DomainError {
  public override readonly name = 'RoleNotFoundError';
  public readonly code = 'ROLE_NOT_FOUND';

  public constructor(public readonly roleId: string) {
    super(`No role ${roleId} is visible here`, { roleId });
  }
}

/** Deleting a role people still hold would strip them silently. */
export class RoleStillAssignedError extends DomainError {
  public override readonly name = 'RoleStillAssignedError';
  public readonly code = 'ROLE_STILL_ASSIGNED';

  public constructor(
    public readonly roleCode: string,
    public readonly memberCount: number,
  ) {
    super(`${roleCode} is still assigned to ${String(memberCount)} member(s)`, {
      roleCode,
      memberCount,
    });
  }
}

/**
 * A role with that code already exists for this company.
 *
 * Refused by name rather than by a unique-index violation. The constraint catches it
 * either way, but a 500 tells an administrator that something broke when in fact they
 * chose a code somebody already used — and the second message is one they can act on.
 */
export class RoleCodeAlreadyExistsError extends DomainError {
  public override readonly name = 'RoleCodeAlreadyExistsError';
  public readonly code = 'ROLE_CODE_ALREADY_EXISTS';

  public constructor(public readonly roleCode: string) {
    super(`A role with code ${roleCode} already exists for this company`, { roleCode });
  }
}
