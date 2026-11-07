import { beforeEach, describe, expect, it } from 'vitest';

import {
  NotAuthorizedError,
  permission,
  PolicyEnforcementPoint,
  SequentialIdGenerator,
  type Actor,
  type AuthorizationAuditSink,
  type Permission,
} from '@multitenant-base/shared-kernel';

import { buildRoleAdministration, type RoleAdministration } from './manageRoles.js';
import { RoleImmutableError, RoleNotFoundError, RoleStillAssignedError } from '../domain/errors.js';
import { Role } from '../domain/role.js';
import type { PermissionCatalogue, RoleRepository } from '../domain/roleRepository.js';

/**
 * Fakes for the ports we own, never `vi.mock`. A fake that behaves like the real thing
 * keeps the test about the use case; a mock would only assert that we called ourselves.
 */

class InMemoryRoleRepository implements RoleRepository {
  public readonly roles = new Map<string, Role>();
  public holders = 0;

  public findAvailableTo(tenantId: string): Promise<readonly Role[]> {
    return Promise.resolve(
      [...this.roles.values()].filter(
        (role) => role.tenantId === undefined || role.tenantId === tenantId,
      ),
    );
  }

  public findById(roleId: string, tenantId: string): Promise<Role | undefined> {
    const role = this.roles.get(roleId);
    if (role === undefined) return Promise.resolve(undefined);
    // A role belonging to another tenant is invisible, exactly as in SQL.
    if (role.tenantId !== undefined && role.tenantId !== tenantId)
      return Promise.resolve(undefined);
    return Promise.resolve(role);
  }

  public findByCode(code: string, tenantId: string): Promise<Role | undefined> {
    return Promise.resolve(
      [...this.roles.values()].find(
        (role) => role.code === code && (role.tenantId === undefined || role.tenantId === tenantId),
      ),
    );
  }

  public save(role: Role): Promise<void> {
    this.roles.set(role.id, role);
    return Promise.resolve();
  }

  public deleteRole(roleId: string): Promise<void> {
    this.roles.delete(roleId);
    return Promise.resolve();
  }

  public countMembersWithRole(): Promise<number> {
    return Promise.resolve(this.holders);
  }
}

const CATALOGUE: PermissionCatalogue = {
  list: () =>
    Promise.resolve([{ code: 'tenancy:read', context: 'tenancy', description: 'Ver la empresa' }]),
};

const TENANT_ADMIN_CAPABILITIES: readonly Permission[] = [
  permission('iam:role_manage'),
  permission('iam:user_manage'),
  permission('tenancy:read'),
  permission('audit:read'),
];

function anActor(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: 'user-admin',
    actorType: 'user',
    tenantId: 'tenant-acme',
    roleCode: 'tenant_admin',
    permissions: TENANT_ADMIN_CAPABILITIES,
    ...overrides,
  };
}

const silentAudit: AuthorizationAuditSink = { record: () => Promise.resolve() };

let repository: InMemoryRoleRepository;
let administration: RoleAdministration;

/** What the real adapter would have written to the trail, in the same transaction. */
let audited: { action: string; roleId: string; changes: Record<string, string> }[];

beforeEach(() => {
  audited = [];
  repository = new InMemoryRoleRepository();
  administration = buildRoleAdministration({
    pep: new PolicyEnforcementPoint({
      clock: { now: () => new Date('2026-08-23T15:00:00.000Z') },
      auditSink: silentAudit,
    }),
    roles: repository,
    catalogue: CATALOGUE,
    audit: (input) => {
      audited.push(input);
      return Promise.resolve();
    },
    ids: new SequentialIdGenerator('role'),
  });
});

describe('creating a role', () => {
  it('adds one without a deployment', async () => {
    const created = await administration.createRole(anActor(), {
      code: 'support_agent',
      name: 'Agente de soporte',
      permissions: ['tenancy:read'],
    });

    expect(created.code).toBe('support_agent');
    expect(await repository.findById(created.id, 'tenant-acme')).toBeDefined();
  });

  it('refuses an actor without iam:role_manage', async () => {
    const analyst = anActor({
      roleCode: 'analyst',
      permissions: [permission('tenancy:read')],
    });

    await expect(
      administration.createRole(analyst, {
        code: 'auxiliar',
        name: 'Auxiliar',
        permissions: ['tenancy:read'],
      }),
    ).rejects.toThrow(NotAuthorizedError);
  });
});

describe('changing a role', () => {
  it('refuses to edit a role belonging to another tenant', async () => {
    const foreign = Role.createForTenant({
      id: 'role-foreign',
      tenantId: 'tenant-globex',
      code: 'auxiliar',
      name: 'Auxiliar',
      permissions: ['tenancy:read'],
      grantable: TENANT_ADMIN_CAPABILITIES,
    });
    await repository.save(foreign);

    // Answered as absent, not as forbidden: a distinct error would confirm the id exists.
    await expect(
      administration.redefineRole(anActor(), { roleId: 'role-foreign', name: 'Otro' }),
    ).rejects.toThrow(RoleNotFoundError);
  });

  it('refuses to edit a system role', async () => {
    await repository.save(
      Role.reconstitute({
        id: 'role-member',
        tenantId: undefined,
        code: 'member',
        name: 'Miembro',
        description: '',
        isSystem: true,
        permissions: [permission('tenancy:read')],
      }),
    );

    await expect(
      administration.redefineRole(anActor(), { roleId: 'role-member', name: 'Gerencia' }),
    ).rejects.toThrow(RoleImmutableError);
  });
});

describe('deleting a role', () => {
  it('refuses while people still hold it', async () => {
    const created = await administration.createRole(anActor(), {
      code: 'auxiliar',
      name: 'Auxiliar',
      permissions: ['tenancy:read'],
    });
    repository.holders = 3;

    // Deleting would strip three people of every capability with no explanation.
    await expect(administration.deleteRole(anActor(), { roleId: created.id })).rejects.toThrow(
      RoleStillAssignedError,
    );
  });

  it('removes a role nobody holds', async () => {
    const created = await administration.createRole(anActor(), {
      code: 'auxiliar',
      name: 'Auxiliar',
      permissions: ['tenancy:read'],
    });

    await administration.deleteRole(anActor(), { roleId: created.id });

    expect(await repository.findById(created.id, 'tenant-acme')).toBeUndefined();
  });
});

describe('reading the catalogue', () => {
  it('refuses an actor who cannot manage roles', async () => {
    await expect(
      administration.listPermissionCatalogue(
        anActor({ permissions: [permission('tenancy:read')] }),
        {},
      ),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it('lists the catalogue for an administrator', async () => {
    const entries = await administration.listPermissionCatalogue(anActor(), {});

    expect(entries).toHaveLength(1);
  });
});
