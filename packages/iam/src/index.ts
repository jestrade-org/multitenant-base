/**
 * Identity and access management — roles, permissions and membership (§8.1–§8.3).
 *
 * This file is the package's entire public API; each symbol is listed explicitly.
 */
export { Role, type RoleSnapshot } from './domain/role.js';

export {
  PermissionNotGrantableError,
  RoleImmutableError,
  RoleNotFoundError,
  RoleStillAssignedError,
} from './domain/errors.js';

export type {
  PermissionCatalogue,
  PermissionCatalogueEntry,
  RoleRepository,
} from './domain/roleRepository.js';

export {
  buildRoleAdministration,
  type CreateRoleCommand,
  type ManageRolesDependencies,
  type RedefineRoleCommand,
  type RoleAdministration,
  type RoleDto,
} from './application/manageRoles.js';

export {
  PostgresPermissionCatalogue,
  PostgresRoleRepository,
  type SqlClient,
} from './infrastructure/postgresRoleRepository.js';

export type { RoleAudit } from './application/manageRoles.js';

export {
  buildMemberAdministration,
  CannotDeactivateSelfError,
  LastAdministratorError,
  MemberAlreadyInvitedError,
  MemberNotFoundError,
  RoleNotAssignableError,
  UnknownRoleError,
  type MemberAdministration,
  type MemberAudit,
  type MemberDirectory,
  type MemberDto,
} from './application/manageMembers.js';
