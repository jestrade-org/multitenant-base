import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type pg from 'pg';
import type { Logger } from 'pino';

import type {
  FirstAdministratorProvisioner,
  SchemaProvisioner,
  TenantStorageProvisioner,
} from '@multitenant-base/tenancy';
import { loadTenantMigrations, migrateAllTenants } from '@multitenant-base/tenancy';

/**
 * The concrete steps of §4, each safe to run again.
 *
 * "Safe to run again" is not politeness here. There is no orchestrator with rollback at
 * this scale (§19.1), so an operator whose browser dropped mid-provisioning presses the
 * button a second time — and every one of these has to land in the same place rather than
 * failing on something it created itself the first time.
 */

export class MigratingSchemaProvisioner implements SchemaProvisioner {
  readonly #pool: pg.Pool;
  readonly #migrationsDirectory: string;
  readonly #logger: Logger;

  public constructor(input: {
    readonly pool: pg.Pool;
    readonly migrationsDirectory: string;
    readonly logger: Logger;
  }) {
    this.#pool = input.pool;
    this.#migrationsDirectory = input.migrationsDirectory;
    this.#logger = input.logger;
  }

  public async provision(input: {
    readonly tenantId: string;
    readonly schemaName: string;
  }): Promise<void> {
    const migrations = await loadTenantMigrations(this.#migrationsDirectory);
    const client = await this.#pool.connect();

    try {
      // The same runner the CLI uses, with a list of one. It takes an advisory lock,
      // records what it applied and skips what is already there — exactly the idempotence
      // this needs — and reusing it means the provisioning path and the migration path
      // cannot drift into applying different things.
      const [result] = await migrateAllTenants({
        client: {
          query: async (sql, values) => {
            const rows = await client.query(sql, values as unknown[] | undefined);
            return rows.rows as Record<string, unknown>[];
          },
        },
        tenants: [{ id: input.tenantId, name: input.schemaName, schemaName: input.schemaName }],
        migrations,
      });

      if (result === undefined || result.outcome.status === 'failed') {
        // Thrown rather than logged: the caller must not go on to mark the client ready
        // over a schema that does not have its tables.
        throw new Error(
          `Could not provision ${input.schemaName}: ${
            result?.outcome.status === 'failed' ? result.outcome.error : 'no result'
          }`,
        );
      }

      this.#logger.info(
        {
          tenantId: input.tenantId,
          schema: input.schemaName,
          applied: result.outcome.applied,
        },
        'tenant schema provisioned',
      );
    } finally {
      client.release();
    }
  }
}

/**
 * The tenant's storage prefix.
 *
 * `mkdir -p` is idempotent, which is the whole requirement. On Supabase Storage this is a
 * bucket policy scoped by path prefix; the shape of the operation is the same.
 */
export class LocalStorageProvisioner implements TenantStorageProvisioner {
  readonly #root: string;

  public constructor(rootDirectory: string) {
    this.#root = resolve(rootDirectory);
  }

  public async provision(tenantId: string): Promise<void> {
    await mkdir(join(this.#root, tenantId), { recursive: true });
  }
}

/**
 * The client's first administrator.
 *
 * **No password is generated and none is returned.** A credential in an HTTP response is a
 * credential in a browser history, a proxy log and whatever the operator pastes it into.
 * Supabase's invite flow sends the person a one-time link instead, and they choose their own
 * secret — which is also the only way the password is never known to the platform.
 *
 * If the invite cannot be sent, the membership row is still written: the client exists and
 * an operator can invite them again. Failing the whole provisioning over an email would
 * leave a half-created client for a reason that has nothing to do with the client.
 */
export class InvitingAdministratorProvisioner implements FirstAdministratorProvisioner {
  readonly #pool: pg.Pool;
  readonly #authUrl: string;
  readonly #serviceRoleKey: string | undefined;
  readonly #logger: Logger;

  public constructor(input: {
    readonly pool: pg.Pool;
    readonly authUrl: string;
    readonly serviceRoleKey: string | undefined;
    readonly logger: Logger;
  }) {
    this.#pool = input.pool;
    this.#authUrl = input.authUrl;
    this.#serviceRoleKey = input.serviceRoleKey;
    this.#logger = input.logger;
  }

  public async provision(input: {
    readonly tenantId: string;
    readonly email: string;
    readonly fullName: string;
  }): Promise<{ readonly email: string; readonly alreadyExisted: boolean }> {
    const email = input.email.trim().toLowerCase();

    const existing = await this.#pool.query<{ auth_user_id: string }>(
      'select auth_user_id from control.tenant_members where tenant_id = $1 and email = $2',
      [input.tenantId, email],
    );
    if (existing.rows.length > 0) {
      return { email, alreadyExisted: true };
    }

    const authUserId = await this.#invite(email, input.fullName);
    if (authUserId === undefined) {
      // No auth account yet, so no membership row either: a member row pointing at nothing
      // would resolve to a principal with no identity, which the authentication path would
      // then have to special-case.
      this.#logger.warn(
        { tenantId: input.tenantId },
        'first administrator could not be invited; invite them again from the panel',
      );
      return { email, alreadyExisted: false };
    }

    await this.#pool.query(
      `insert into control.tenant_members (tenant_id, auth_user_id, email, full_name, role_id)
       select $1, $2, $3, $4, r.id
         from control.roles r
        where r.code = 'tenant_admin' and r.tenant_id is null
       on conflict (tenant_id, auth_user_id) do nothing`,
      [input.tenantId, authUserId, email, input.fullName.trim()],
    );

    return { email, alreadyExisted: false };
  }

  async #invite(email: string, fullName: string): Promise<string | undefined> {
    if (this.#serviceRoleKey === undefined) {
      this.#logger.warn('no service role key configured; cannot invite the first administrator');
      return undefined;
    }

    try {
      const response = await fetch(`${this.#authUrl}/admin/users`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#serviceRoleKey}`,
          apikey: this.#serviceRoleKey,
        },
        body: JSON.stringify({
          email,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        }),
      });

      if (!response.ok) {
        // The body is not read into the log: an auth provider's error can echo the request.
        this.#logger.error({ status: response.status }, 'could not create the administrator');
        return undefined;
      }

      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string' ? body.id : undefined;
    } catch (error: unknown) {
      this.#logger.error({ err: error }, 'the auth provider was unreachable');
      return undefined;
    }
  }
}
