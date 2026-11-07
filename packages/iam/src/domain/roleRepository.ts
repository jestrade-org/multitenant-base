import type { Role } from './role.js';

/**
 * Aggregate-oriented, and never takes a schema or a query builder.
 *
 * `findById` takes the tenant as well as the id on purpose (§8.3): looking a role up by id
 * alone is how one company edits another's. There is no overload that omits it.
 */
export interface RoleRepository {
  /** System roles plus the tenant's own, which is what an administration screen lists. */
  findAvailableTo(tenantId: string): Promise<readonly Role[]>;
  findById(roleId: string, tenantId: string): Promise<Role | undefined>;
  findByCode(code: string, tenantId: string): Promise<Role | undefined>;
  save(role: Role): Promise<void>;
  /** Refuses while any member still holds it, rather than silently unassigning people. */
  deleteRole(roleId: string, tenantId: string): Promise<void>;
  countMembersWithRole(roleId: string, tenantId: string): Promise<number>;
}

export interface PermissionCatalogueEntry {
  readonly code: string;
  readonly context: string;
  readonly description: string;
}

export interface PermissionCatalogue {
  list(): Promise<readonly PermissionCatalogueEntry[]>;
}
