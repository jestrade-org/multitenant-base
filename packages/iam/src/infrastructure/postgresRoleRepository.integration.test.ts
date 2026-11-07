import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresPermissionCatalogue, PostgresRoleRepository } from './postgresRoleRepository.js';
import { Role } from '../domain/role.js';

/**
 * The seeded roles, checked against the requirements that named them.
 *
 * RF-76 and RF-77 are scope rules a client can be shown, so they are worth asserting
 * against the actual seed rather than the intention behind it. A grant that drifts out of
 * the seed is invisible in code review — the row simply exists.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

let pool: pg.Pool;
let repository: PostgresRoleRepository;
let catalogue: PostgresPermissionCatalogue;
let tenantId: string;

function client(): {
  query: (sql: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]>;
} {
  return {
    query: async (sql, values) => {
      const result = await pool.query(sql, values as unknown[] | undefined);
      return result.rows as Record<string, unknown>[];
    },
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  repository = new PostgresRoleRepository(client());
  catalogue = new PostgresPermissionCatalogue(client());

  const tenants = await pool.query<{ id: string }>('select id from control.tenants limit 1');
  const first = tenants.rows[0];
  if (first === undefined) throw new Error('the seed must provide a tenant');
  tenantId = first.id;
});

afterAll(async () => {
  await pool.query("delete from control.roles where code like 'test_%'");
  await pool.end();
});

describe('the seeded roles', () => {
  it('gives a member the company profile and nothing administrative', async () => {
    const member = await repository.findByCode('member', tenantId);

    expect(member?.permissions).toEqual(['tenancy:read']);
  });

  it('gives the tenant administrator user and role management', async () => {
    const admin = await repository.findByCode('tenant_admin', tenantId);

    expect(admin?.permissions).toContain('iam:user_manage');
    expect(admin?.permissions).toContain('iam:role_manage');
  });

  // Named rather than derived by exclusion: `platform_admin` and `platform_operator` are
  // platform staff and legitimately operate the platform. Listing the client-facing roles instead
  // means a new staff role cannot quietly widen what this test considers acceptable.
  it.each([['tenant_admin'], ['member']])(
    'keeps platform capabilities out of %s, a role a client holds',
    async (code) => {
      const role = await repository.findByCode(code, tenantId);

      expect(role?.permissions.filter((held) => held.startsWith('platform:'))).toEqual([]);
    },
  );

  it.each([['platform_admin'], ['platform_operator'], ['tenant_admin'], ['member']])(
    'marks %s as a system role, so no tenant can redefine it',
    async (code) => {
      // Named rather than "every role available": a tenant that has created one of its own
      // makes that assertion false, which is the feature working, not a regression.
      const role = await repository.findByCode(code, tenantId);

      expect(role?.isSystem).toBe(true);
    },
  );
});

describe('adding a role', () => {
  it('takes an insert, not a deployment', async () => {
    const role = Role.createForTenant({
      id: '11111111-2222-3333-4444-555555555555',
      tenantId,
      code: 'test_support_agent',
      name: 'Agente de soporte',
      permissions: ['tenancy:read', 'audit:read'],
      grantable: [...(await repository.findByCode('tenant_admin', tenantId))!.permissions],
    });

    await repository.save(role);
    const reloaded = await repository.findById(role.id, tenantId);

    expect(reloaded?.permissions).toEqual(['tenancy:read', 'audit:read']);
    expect(reloaded?.isSystem).toBe(false);
  });

  it('is invisible to another tenant', async () => {
    const otherTenant = await pool.query<{ id: string }>(
      'select id from control.tenants where id <> $1 limit 1',
      [tenantId],
    );
    const other = otherTenant.rows[0];
    if (other === undefined) throw new Error('the seed must provide a second tenant');

    const found = await repository.findById('11111111-2222-3333-4444-555555555555', other.id);

    expect(found).toBeUndefined();
  });
});

describe('the permission catalogue', () => {
  it('is data in the database, not a constant in the code', async () => {
    const entries = await catalogue.list();

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.description.length > 0)).toBe(true);
  });
});
