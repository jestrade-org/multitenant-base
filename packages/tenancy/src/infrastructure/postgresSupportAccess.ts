import { z } from 'zod';

import type { SqlClient } from './postgresTenantRegistry.js';
import type {
  EndedGrantDto,
  SupportAccessDirectory,
  SupportAccessGrantDto,
  TenantMemberDto,
} from '../application/manageSupportAccess.js';

/**
 * Support access grants, in the control plane (§4.2, VC-101).
 *
 * Every statement here goes through a `security definer` function rather than touching the
 * table directly. That is not indirection for its own sake: the grant table is
 * append-only and its `ended_at` is the single mutable column, and putting the rules in
 * SQL means a second caller — a future job, a console session — meets the same ones.
 *
 * Expiry in particular lives in the resolver, not here. A grant has to stop working at the
 * moment it expires whether or not anything swept the table.
 */

const memberRow = z.object({
  member_id: z.string().uuid(),
  full_name: z.string(),
  email: z.string(),
  role_code: z.string(),
  tenant_id: z.string().uuid(),
  tenant_name: z.string(),
});

const grantRow = z.object({
  grant_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  tenant_name: z.string(),
  member_id: z.string().uuid(),
  member_name: z.string(),
  member_email: z.string(),
  role_code: z.string(),
  expires_at: z.coerce.date(),
});

const endedRow = z.object({
  grant_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  member_id: z.string().uuid(),
});

export interface PostgresSupportAccessOptions {
  readonly client: SqlClient;
}

export class PostgresSupportAccessDirectory implements SupportAccessDirectory {
  readonly #client: SqlClient;

  public constructor(options: PostgresSupportAccessOptions) {
    this.#client = options.client;
  }

  public async searchMembers(input: {
    readonly query: string | undefined;
    readonly tenantId: string | undefined;
    readonly limit: number;
  }): Promise<readonly TenantMemberDto[]> {
    const rows = await this.#client.query(
      `select member_id, full_name, email, role_code, tenant_id, tenant_name
         from control.search_tenant_members($1, $2, $3)`,
      [input.query ?? null, input.tenantId ?? null, input.limit],
    );

    return rows.map((row) => {
      const parsed = memberRow.parse(row);
      return {
        memberId: parsed.member_id,
        fullName: parsed.full_name,
        email: parsed.email,
        roleCode: parsed.role_code,
        tenantId: parsed.tenant_id,
        tenantName: parsed.tenant_name,
      };
    });
  }

  public async open(input: {
    readonly staffAuthUserId: string;
    readonly memberId: string;
    readonly reason: string;
    readonly durationMinutes: number;
    readonly ipAddress: string | undefined;
    readonly correlationId: string | undefined;
  }): Promise<SupportAccessGrantDto | undefined> {
    const rows = await this.#client.query(
      `select grant_id, tenant_id, tenant_name, member_id, member_name, member_email,
              role_code, expires_at
         from control.grant_support_access($1, $2, $3, make_interval(mins => $4), $5, $6)`,
      [
        input.staffAuthUserId,
        input.memberId,
        input.reason,
        input.durationMinutes,
        input.ipAddress ?? null,
        input.correlationId ?? null,
      ],
    );

    const row = rows[0];
    if (row === undefined) return undefined;

    const parsed = grantRow.parse(row);
    return {
      grantId: parsed.grant_id,
      tenantId: parsed.tenant_id,
      tenantName: parsed.tenant_name,
      memberId: parsed.member_id,
      memberName: parsed.member_name,
      memberEmail: parsed.member_email,
      roleCode: parsed.role_code,
      expiresAt: parsed.expires_at.toISOString(),
    };
  }

  public async close(staffAuthUserId: string): Promise<EndedGrantDto | undefined> {
    const rows = await this.#client.query(
      `select grant_id, tenant_id, member_id from control.end_support_access($1)`,
      [staffAuthUserId],
    );

    const row = rows[0];
    if (row === undefined) return undefined;

    const parsed = endedRow.parse(row);
    return {
      grantId: parsed.grant_id,
      tenantId: parsed.tenant_id,
      memberId: parsed.member_id,
    };
  }
}
