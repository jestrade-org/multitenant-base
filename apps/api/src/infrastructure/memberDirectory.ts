import type { Logger } from 'pino';
import { z } from 'zod';

import type { MemberDirectory, MemberDto } from '@multitenant-base/iam';

import type { ControlDatabase } from './controlDatabase.js';

/**
 * The company's own users, in the control plane (§9, VC-77).
 *
 * Every statement is scoped by the tenant the constructor was given, and that tenant comes
 * from the verified token — never from the request. An administrator of one company
 * enumerating another's staff is the same failure as reading their data, and staff
 * lists are what phishing campaigns are built from.
 */

const memberRowSchema = z.object({
  member_id: z.string().uuid(),
  auth_user_id: z.string().uuid(),
  email: z.string(),
  full_name: z.string(),
  role_code: z.string(),
  role_name: z.string(),
  is_active: z.boolean(),
  can_manage_users: z.boolean(),
  last_seen_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
});

const SELECT = `
  select m.id as member_id, m.auth_user_id, m.email, m.full_name,
         r.code as role_code, r.name as role_name, m.is_active,
         exists (
           select 1 from control.role_permissions rp
            where rp.role_id = r.id and rp.permission_code = 'iam:user_manage'
         ) as can_manage_users,
         m.last_seen_at, m.created_at
    from control.tenant_members m
    join control.roles r on r.id = m.role_id
`;

function toDto(row: Record<string, unknown>): MemberDto {
  const parsed = memberRowSchema.parse(row);
  return {
    memberId: parsed.member_id,
    authUserId: parsed.auth_user_id,
    email: parsed.email,
    fullName: parsed.full_name,
    roleCode: parsed.role_code,
    roleName: parsed.role_name,
    isActive: parsed.is_active,
    canManageUsers: parsed.can_manage_users,
    lastSeenAt: parsed.last_seen_at?.toISOString() ?? null,
    createdAt: parsed.created_at.toISOString(),
  };
}

export interface PostgresMemberDirectoryOptions {
  readonly controlDatabase: ControlDatabase;
  readonly tenantId: string;
  readonly authUrl: string;
  readonly serviceRoleKey: string | undefined;
  readonly logger: Logger;
}

export class InvitationFailedError extends Error {
  public readonly code = 'INVITATION_FAILED';

  public constructor() {
    super('The identity provider did not create the account');
    this.name = 'InvitationFailedError';
  }
}

export class PostgresMemberDirectory implements MemberDirectory {
  readonly #options: PostgresMemberDirectoryOptions;

  public constructor(options: PostgresMemberDirectoryOptions) {
    this.#options = options;
  }

  public async list(): Promise<readonly MemberDto[]> {
    const rows = await this.#options.controlDatabase.query<Record<string, unknown>>(
      // Deterministic: active first, then by name. A list that reorders itself between
      // refreshes makes an administrator lose their place mid-task.
      `${SELECT} where m.tenant_id = $1 order by m.is_active desc, m.full_name, m.id`,
      [this.#options.tenantId],
    );
    return rows.map(toDto);
  }

  public async findByEmail(email: string): Promise<MemberDto | undefined> {
    const rows = await this.#options.controlDatabase.query<Record<string, unknown>>(
      `${SELECT} where m.tenant_id = $1 and lower(m.email) = lower($2)`,
      [this.#options.tenantId, email],
    );
    const row = rows[0];
    return row === undefined ? undefined : toDto(row);
  }

  public async findById(memberId: string): Promise<MemberDto | undefined> {
    const rows = await this.#options.controlDatabase.query<Record<string, unknown>>(
      // The tenant is part of the predicate, not a filter applied afterwards: this is the
      // query that would otherwise let one company address another's member by id (§8.3).
      `${SELECT} where m.tenant_id = $1 and m.id = $2`,
      [this.#options.tenantId, memberId],
    );
    const row = rows[0];
    return row === undefined ? undefined : toDto(row);
  }

  public async invite(input: {
    readonly email: string;
    readonly fullName: string;
    readonly roleCode: string;
  }): Promise<MemberDto> {
    const authUserId = await this.#invite(input.email, input.fullName);
    if (authUserId === undefined) throw new InvitationFailedError();

    const inserted = await this.#options.controlDatabase.query<{ id: string }>(
      `insert into control.tenant_members (tenant_id, auth_user_id, email, full_name, role_id)
       select $1, $2, $3, $4, r.id
         from control.roles r
        where r.code = $5 and (r.tenant_id is null or r.tenant_id = $1)
       returning id`,
      [this.#options.tenantId, authUserId, input.email, input.fullName, input.roleCode],
    );

    const memberId = inserted[0]?.id;
    // No row means the role did not exist for this tenant. The account was created at the
    // provider, so this is reported rather than swallowed: a person with a login and no
    // membership cannot sign in and nobody knows why.
    if (memberId === undefined) throw new InvitationFailedError();

    const member = await this.findById(memberId);
    if (member === undefined) throw new InvitationFailedError();
    return member;
  }

  public async changeRole(memberId: string, roleCode: string): Promise<MemberDto | undefined> {
    await this.#options.controlDatabase.query(
      `update control.tenant_members m
          set role_id = r.id
         from control.roles r
        where m.id = $2 and m.tenant_id = $1
          and r.code = $3 and (r.tenant_id is null or r.tenant_id = $1)`,
      [this.#options.tenantId, memberId, roleCode],
    );
    return this.findById(memberId);
  }

  public async setActive(memberId: string, isActive: boolean): Promise<MemberDto | undefined> {
    await this.#options.controlDatabase.query(
      `update control.tenant_members set is_active = $3 where id = $2 and tenant_id = $1`,
      [this.#options.tenantId, memberId, isActive],
    );
    return this.findById(memberId);
  }

  /** Creates the account at the identity provider. Never hand-rolls authentication. */
  async #invite(email: string, fullName: string): Promise<string | undefined> {
    const key = this.#options.serviceRoleKey;
    if (key === undefined) {
      this.#options.logger.warn('no service role key configured; cannot invite a member');
      return undefined;
    }

    try {
      const response = await fetch(`${this.#options.authUrl}/admin/users`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          apikey: key,
        },
        body: JSON.stringify({
          email,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        }),
      });

      if (!response.ok) {
        // The body is not logged: an auth provider's error can echo the request, and the
        // request carries an address.
        this.#options.logger.error({ status: response.status }, 'could not invite the member');
        return undefined;
      }

      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string' ? body.id : undefined;
    } catch (error: unknown) {
      this.#options.logger.error({ err: error }, 'the identity provider was unreachable');
      return undefined;
    }
  }
}
