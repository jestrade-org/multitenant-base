import { z } from 'zod';

import { permissionsFrom } from '@multitenant-base/shared-kernel';

import { Role } from '../domain/role.js';
import type {
  PermissionCatalogue,
  PermissionCatalogueEntry,
  RoleRepository,
} from '../domain/roleRepository.js';

/**
 * Roles and the permission catalogue, from the control plane.
 *
 * Every query is scoped by the tenant the caller passes, which the caller derives from the
 * verified token (§8.3). There is no method here that takes a role id alone.
 */

export interface SqlClient {
  query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

/**
 * A row is untrusted input until it is parsed, exactly like a request body.
 *
 * Not ceremony: a migration that renames a column or changes a nullability turns every
 * cast into a lie the compiler agrees with, and the failure surfaces later as a role
 * silently missing its permissions. Parsing fails at the boundary instead, where the
 * message still names the column.
 */
const roleRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  is_system: z.boolean(),
  permissions: z.array(z.string()).nullable(),
});

type RoleRow = z.infer<typeof roleRowSchema>;

const catalogueRowSchema = z.object({
  code: z.string(),
  context: z.string(),
  description: z.string(),
});

const SELECT_ROLES = `
  select r.id, r.tenant_id, r.code, r.name, r.description, r.is_system,
         coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null),
                  '{}') as permissions
    from control.roles r
    left join control.role_permissions rp on rp.role_id = r.id
`;

function toRole(row: RoleRow): Role {
  return Role.reconstitute({
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    // Codes the running instance does not know are dropped rather than rejected: during a
    // deploy the database may be ahead, and refusing every role in that window would be an
    // outage. Dropping can only ever fail to grant, never over-grant.
    permissions: permissionsFrom(row.permissions ?? []),
  });
}

export class PostgresRoleRepository implements RoleRepository {
  readonly #client: SqlClient;

  public constructor(client: SqlClient) {
    this.#client = client;
  }

  public async findAvailableTo(tenantId: string): Promise<readonly Role[]> {
    const rows = await this.#client.query(
      `${SELECT_ROLES}
        where r.tenant_id is null or r.tenant_id = $1
        group by r.id
        order by r.is_system desc, r.code`,
      [tenantId],
    );
    return rows.map((row) => toRole(roleRowSchema.parse(row)));
  }

  public async findById(roleId: string, tenantId: string): Promise<Role | undefined> {
    const rows = await this.#client.query(
      `${SELECT_ROLES}
        where r.id = $1 and (r.tenant_id is null or r.tenant_id = $2)
        group by r.id`,
      [roleId, tenantId],
    );
    const row = rows[0];
    return row === undefined ? undefined : toRole(roleRowSchema.parse(row));
  }

  public async findByCode(code: string, tenantId: string): Promise<Role | undefined> {
    const rows = await this.#client.query(
      `${SELECT_ROLES}
        where r.code = $1 and (r.tenant_id is null or r.tenant_id = $2)
        group by r.id
        order by r.tenant_id nulls last
        limit 1`,
      [code, tenantId],
    );
    const row = rows[0];
    return row === undefined ? undefined : toRole(roleRowSchema.parse(row));
  }

  /**
   * Upserts the role and replaces its grants.
   *
   * The caller owns the transaction, so this is not wrapped in one: a role change that is
   * audited must commit with its audit row, and opening a second transaction here would
   * make that impossible.
   */
  public async save(role: Role): Promise<void> {
    const snapshot = role.toSnapshot();

    await this.#client.query(
      `insert into control.roles (id, tenant_id, code, name, description, is_system)
            values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update
              set name = excluded.name,
                  description = excluded.description,
                  updated_at = now()`,
      [
        snapshot.id,
        snapshot.tenantId ?? null,
        snapshot.code,
        snapshot.name,
        snapshot.description,
        snapshot.isSystem,
      ],
    );

    await this.#client.query('delete from control.role_permissions where role_id = $1', [
      snapshot.id,
    ]);

    if (snapshot.permissions.length > 0) {
      await this.#client.query(
        `insert into control.role_permissions (role_id, permission_code)
         select $1, unnest($2::text[])`,
        [snapshot.id, snapshot.permissions],
      );
    }
  }

  public async deleteRole(roleId: string, tenantId: string): Promise<void> {
    // `tenant_id = $2` and not `is null or`: a system role is never deletable, and the
    // where clause is the last place that can still be true when the domain check is not.
    await this.#client.query(
      'delete from control.roles where id = $1 and tenant_id = $2 and is_system = false',
      [roleId, tenantId],
    );
  }

  public async countMembersWithRole(roleId: string, tenantId: string): Promise<number> {
    const rows = await this.#client.query(
      `select count(*)::int as holders
         from control.tenant_members
        where role_id = $1 and tenant_id = $2 and is_active`,
      [roleId, tenantId],
    );
    const holders = rows[0]?.holders;
    return typeof holders === 'number' ? holders : 0;
  }
}

export class PostgresPermissionCatalogue implements PermissionCatalogue {
  readonly #client: SqlClient;

  public constructor(client: SqlClient) {
    this.#client = client;
  }

  public async list(): Promise<readonly PermissionCatalogueEntry[]> {
    const rows = await this.#client.query(
      'select code, context, description from control.permissions order by context, code',
    );
    return rows.map((row) => catalogueRowSchema.parse(row));
  }
}
