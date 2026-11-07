import {
  authorizedUseCase,
  permission,
  requireAll,
  requireTenant,
  type Actor,
  type AuthorizedUseCase,
  type IdGenerator,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

import {
  RoleCodeAlreadyExistsError,
  RoleNotFoundError,
  RoleStillAssignedError,
} from '../domain/errors.js';
import { Role, type RoleSnapshot } from '../domain/role.js';
import type {
  PermissionCatalogue,
  PermissionCatalogueEntry,
  RoleRepository,
} from '../domain/roleRepository.js';

/**
 * Role administration (§8.3, VC-31).
 *
 * Adding a role is an insert, not a deploy. Every use case here declares the capability it
 * needs, so none of them can run without the enforcement point having decided first and
 * written the decision to the audit trail.
 *
 * `iam:role_manage` is required to change roles. Note what that means: the person who can
 * edit roles can, in principle, widen their own. The domain refuses to grant a capability
 * the actor does not already hold, which is what keeps that from being an escalation.
 */

/**
 * Records what changed about a role (§8.4).
 *
 * Separate from the authorization trail the enforcement point writes: that one says the
 * administrator was *allowed* to redefine a role, which is not the same as saying which
 * capabilities the role gained. "Who granted the capability that let this happen" is a
 * question only the second can answer, and it is the question asked after an incident.
 */
export type RoleAudit = (input: {
  readonly action: 'iam.role_created' | 'iam.role_redefined' | 'iam.role_deleted';
  readonly roleId: string;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, string>>;
}) => Promise<void>;

const ROLE_MANAGE = permission('iam:role_manage');
const USER_MANAGE = permission('iam:user_manage');

export interface RoleDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
}

function toDto(snapshot: RoleSnapshot): RoleDto {
  return {
    id: snapshot.id,
    code: snapshot.code,
    name: snapshot.name,
    description: snapshot.description,
    isSystem: snapshot.isSystem,
    permissions: snapshot.permissions,
  };
}

export interface ManageRolesDependencies {
  readonly pep: PolicyEnforcementPoint;
  readonly roles: RoleRepository;
  readonly catalogue: PermissionCatalogue;
  readonly ids: IdGenerator;
  /** Writes the §8.4 record of what changed, in the caller's transaction. */
  readonly audit: RoleAudit;
}

export interface CreateRoleCommand {
  readonly code: string;
  readonly name: string;
  readonly description?: string;
  readonly permissions: readonly string[];
}

export interface RedefineRoleCommand {
  readonly roleId: string;
  readonly name?: string;
  readonly description?: string;
  readonly permissions?: readonly string[];
}

export interface RoleAdministration {
  readonly listPermissionCatalogue: AuthorizedUseCase<
    Record<string, never>,
    readonly PermissionCatalogueEntry[]
  >;
  readonly listRoles: AuthorizedUseCase<Record<string, never>, readonly RoleDto[]>;
  readonly createRole: AuthorizedUseCase<CreateRoleCommand, RoleDto>;
  readonly redefineRole: AuthorizedUseCase<RedefineRoleCommand, RoleDto>;
  readonly deleteRole: AuthorizedUseCase<{ readonly roleId: string }, void>;
}

export function buildRoleAdministration(dependencies: ManageRolesDependencies): RoleAdministration {
  const { pep, roles, catalogue, ids, audit } = dependencies;

  /** Reads a role the actor's tenant may see, or answers as if it did not exist. */
  async function loadOwn(actor: Actor, roleId: string): Promise<Role> {
    const role = await roles.findById(roleId, requireTenant(actor));
    // Another tenant's role and a nonexistent one answer identically: a distinct error
    // would let someone probe for which role ids exist elsewhere.
    if (role === undefined) throw new RoleNotFoundError(roleId);
    return role;
  }

  return {
    listPermissionCatalogue: authorizedUseCase(pep, {
      name: 'ListPermissionCatalogue',
      requirement: requireAll(ROLE_MANAGE),
      handler: () => catalogue.list(),
    }),

    listRoles: authorizedUseCase(pep, {
      name: 'ListRoles',
      // Assigning a person to a role needs to see the roles, so either capability reads.
      requirement: requireAll(USER_MANAGE),
      handler: async (actor) => {
        const available = await roles.findAvailableTo(requireTenant(actor));
        return available.map((role) => toDto(role.toSnapshot()));
      },
    }),

    createRole: authorizedUseCase(pep, {
      name: 'CreateRole',
      requirement: requireAll(ROLE_MANAGE),
      handler: async (actor, command) => {
        const taken = await roles.findByCode(command.code, requireTenant(actor));
        if (taken !== undefined) throw new RoleCodeAlreadyExistsError(command.code);

        const role = Role.createForTenant({
          id: ids.next(),
          tenantId: requireTenant(actor),
          code: command.code,
          name: command.name,
          ...(command.description === undefined ? {} : { description: command.description }),
          permissions: command.permissions,
          grantable: actor.permissions,
        });
        await roles.save(role);

        await audit({
          action: 'iam.role_created',
          roleId: role.id,
          actorId: actor.actorId,
          changes: { code: command.code, permissions: [...command.permissions].sort().join(' ') },
        });

        return toDto(role.toSnapshot());
      },
    }),

    redefineRole: authorizedUseCase(pep, {
      name: 'RedefineRole',
      requirement: requireAll(ROLE_MANAGE),
      handler: async (actor, command) => {
        const role = await loadOwn(actor, command.roleId);
        const before = [...role.permissions].sort().join(' ');

        if (command.name !== undefined) {
          role.rename(command.name, command.description);
        }
        if (command.permissions !== undefined) {
          role.redefinePermissions(command.permissions, actor.permissions);
        }

        await roles.save(role);

        await audit({
          action: 'iam.role_redefined',
          roleId: role.id,
          actorId: actor.actorId,
          // Before and after. A trail that records "permissions changed" answers nothing.
          changes: { code: role.code, from: before, to: [...role.permissions].sort().join(' ') },
        });

        return toDto(role.toSnapshot());
      },
    }),

    deleteRole: authorizedUseCase(pep, {
      name: 'DeleteRole',
      requirement: requireAll(ROLE_MANAGE),
      handler: async (actor, command) => {
        const role = await loadOwn(actor, command.roleId);
        const holders = await roles.countMembersWithRole(role.id, requireTenant(actor));
        if (holders > 0) {
          // Deleting would leave people with no capabilities and no explanation. Refusing
          // makes the administrator move them first, which is the decision they should make.
          throw new RoleStillAssignedError(role.code, holders);
        }
        await roles.deleteRole(role.id, requireTenant(actor));

        await audit({
          action: 'iam.role_deleted',
          roleId: role.id,
          actorId: actor.actorId,
          changes: { code: role.code },
        });
      },
    }),
  };
}
