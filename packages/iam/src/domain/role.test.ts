import { describe, expect, it } from 'vitest';

import { permission, ValidationError, type Permission } from '@multitenant-base/shared-kernel';

import { PermissionNotGrantableError, RoleImmutableError } from './errors.js';
import { Role } from './role.js';

/**
 * Roles are configurable, which is only safe because of what they refuse.
 */

const MEMBER_CAPABILITIES: readonly Permission[] = [
  permission('tenancy:read'),
  permission('audit:read'),
  permission('iam:user_manage'),
];

function aTenantRole(overrides: Partial<Parameters<typeof Role.createForTenant>[0]> = {}) {
  return Role.createForTenant({
    id: 'role-1',
    tenantId: 'tenant-acme',
    code: 'support_agent',
    name: 'Agente de soporte',
    permissions: ['tenancy:read'],
    grantable: MEMBER_CAPABILITIES,
    ...overrides,
  });
}

describe('creating a tenant role', () => {
  it('carries the capabilities it was given', () => {
    const role = aTenantRole({ permissions: ['tenancy:read', 'audit:read'] });

    expect(role.permissions).toEqual(['tenancy:read', 'audit:read']);
    expect(role.isSystem).toBe(false);
  });

  it('is never a system role, whatever the caller asks for', () => {
    expect(aTenantRole().isSystem).toBe(false);
  });

  it('drops a duplicated capability rather than storing it twice', () => {
    const role = aTenantRole({ permissions: ['tenancy:read', 'tenancy:read'] });

    expect(role.permissions).toEqual(['tenancy:read']);
  });

  it.each([['Support'], ['1support'], ['a'], ['support-agent']])(
    'rejects %s as a role code',
    (code) => {
      expect(() => aTenantRole({ code })).toThrow(ValidationError);
    },
  );

  it('rejects a capability that is not in the catalogue', () => {
    // Dropping it silently would create a role that looks right on screen and grants less
    // than it claims — nobody sees it until someone is refused something they were shown.
    expect(() => aTenantRole({ permissions: ['tenancy:raed'] })).toThrow(/not in the catalogue/);
  });
});

describe('refusing to escalate', () => {
  it('refuses a capability the actor does not hold', () => {
    // Otherwise a tenant admin mints a role with a capability they lack, assigns it to
    // their own account, and has escalated without touching the database.
    expect(() =>
      aTenantRole({ permissions: ['iam:role_manage'], grantable: MEMBER_CAPABILITIES }),
    ).toThrow(PermissionNotGrantableError);
  });

  it('refuses a platform capability even to an actor who somehow holds it', () => {
    expect(() =>
      aTenantRole({
        permissions: ['platform:tenant_manage'],
        grantable: [...MEMBER_CAPABILITIES, permission('platform:tenant_manage')],
      }),
    ).toThrow(/platform-scoped/);
  });

  it('applies the same rule when the capabilities are redefined later', () => {
    const role = aTenantRole();

    expect(() => {
      role.redefinePermissions(['iam:role_manage'], MEMBER_CAPABILITIES);
    }).toThrow(PermissionNotGrantableError);
    expect(role.permissions).toEqual(['tenancy:read']);
  });
});

describe('system roles', () => {
  const systemRole = Role.reconstitute({
    id: 'role-member',
    tenantId: undefined,
    code: 'member',
    name: 'Miembro',
    description: '',
    isSystem: true,
    permissions: MEMBER_CAPABILITIES,
  });

  it('cannot have its capabilities redefined', () => {
    // Editing `member` for one client would change it for every client that has it.
    expect(() => {
      systemRole.redefinePermissions(['tenancy:read'], MEMBER_CAPABILITIES);
    }).toThrow(RoleImmutableError);
  });

  it('cannot be renamed', () => {
    expect(() => {
      systemRole.rename('Gerencia general');
    }).toThrow(RoleImmutableError);
  });
});
