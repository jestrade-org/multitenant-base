import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer } from '../../composition/container.js';
import { loadConfig } from '../../config/environment.js';
import { ReadinessRegistry } from '../routes/health.js';
import { buildServer } from '../server.js';

/**
 * One row, with the right result, for each administrative action (§8.4, VC-35).
 *
 * The registry in `packages/audit` says which events are required; this file proves the
 * reachable ones are actually written — against the real table, through the real route.
 * A unit test asserting that a function was called proves the call, not the row, and the
 * row is what an auditor reads.
 *
 * "Exactly one" matters as much as "at least one": an action recorded twice makes a trail
 * that cannot be counted, and a retry that duplicates the record is indistinguishable from
 * the operation happening twice.
 *
 * Authentication events are proved in their own file; this one covers the IAM actions.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

let pool: pg.Pool;
let container: ReturnType<typeof buildContainer>;
let app: Awaited<ReturnType<typeof buildServer>>;

interface Session {
  readonly cookies: string;
  readonly csrf: string;
}

async function signIn(email: string, password: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(201);
  return {
    cookies: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrf: response.cookies.find((cookie) => cookie.name === 'mtb_csrf')?.value ?? '',
  };
}

async function rowsFor(action: string): Promise<readonly { result: string }[]> {
  const rows = await pool.query<{ result: string }>(
    'select result from control.audit_events where action = $1',
    [action],
  );
  return rows.rows;
}

/** A role this file may have left behind when an assertion failed before the delete. */
async function clearOwnRoles(): Promise<void> {
  await pool.query("delete from control.roles where code = 'auditoria_temporal'");
}

/** Clears only the actions this file produces, so another file's counts are untouched. */
async function clearOwnEvents(): Promise<void> {
  const client = await pool.connect();
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  await client.query(
    `delete from control.audit_events
      where action like 'iam.%' or action like 'authentication.%'`,
  );
  await client.query('commit');
  client.release();
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  const config = loadConfig({
    NODE_ENV: 'test',
    CONTROL_DATABASE_URL: CONNECTION,
    SUPABASE_AUTH_URL: 'http://127.0.0.1:55321/auth/v1',
    SUPABASE_ANON_KEY: 'local-anon-key-for-tests-only',
    WORKERS_ENABLED: 'false',
    TENANT_MIGRATIONS_DIRECTORY: './supabase/tenant-migrations',
  });
  // Silent by default; `AUDIT_TEST_LOG=1` surfaces the cause when one of these fails,
  // which is how the duplicate-code 500 below was found.
  const logger = pino({ level: process.env.AUDIT_TEST_LOG === '1' ? 'error' : 'silent' });
  container = buildContainer({ config, logger });
  app = await buildServer({
    config,
    logger,
    readiness: new ReadinessRegistry(),
    isAcceptingTraffic: () => true,
    tenantDirectory: container.tenantDirectory,
    auth: container.auth,
    controlDatabase: container.controlDatabase,
    audit: container.audit,
    roles: { withRoles: container.platform.withRoles },
  });

  await clearOwnEvents();
  await clearOwnRoles();
});

afterAll(async () => {
  await clearOwnEvents();
  await clearOwnRoles();
  await app.close();
  await container.dispose();
  await pool.end();
});

describe('changing what a role may do', () => {
  it('records exactly one creation and one redefinition, with what changed', async () => {
    const session = await signIn('admin@acme.test', 'local-demo-acme-admin');
    const headers = { cookie: session.cookies, 'x-csrf-token': session.csrf };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/iam/roles',
      headers,
      payload: {
        code: 'auditoria_temporal',
        name: 'Auditoría temporal',
        // Capabilities the tenant administrator actually holds: the domain refuses to
        // grant one the actor does not have, which is what stops role editing being an
        // escalation.
        permissions: ['tenancy:read'],
      },
    });
    expect(created.statusCode).toBe(201);
    const roleId = created.json<{ id: string }>().id;

    const redefined = await app.inject({
      method: 'PATCH',
      url: `/api/v1/iam/roles/${roleId}`,
      headers,
      payload: { permissions: ['tenancy:read', 'audit:read'] },
    });
    expect(redefined.statusCode).toBe(200);

    expect(await rowsFor('iam.role_created')).toHaveLength(1);
    expect(await rowsFor('iam.role_redefined')).toHaveLength(1);

    const changes = await pool.query<{ changes: { from: string; to: string } }>(
      "select changes from control.audit_events where action = 'iam.role_redefined'",
    );
    // Before and after. "Permissions changed" answers nothing an auditor asks.
    expect(changes.rows[0]?.changes.from).toBe('tenancy:read');
    expect(changes.rows[0]?.changes.to).toContain('audit:read');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/iam/roles/${roleId}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    expect(await rowsFor('iam.role_deleted')).toHaveLength(1);
  });
});

describe('a role code somebody already used', () => {
  it('is refused by name rather than as an internal error', async () => {
    // It answered 500: a unique-index violation reaching the error handler. The
    // administrator was told something broke when in fact they chose a code that exists,
    // which is a decision they can fix in five seconds if we say so.
    const session = await signIn('admin@acme.test', 'local-demo-acme-admin');
    const headers = { cookie: session.cookies, 'x-csrf-token': session.csrf };
    const payload = {
      code: 'auditoria_temporal',
      name: 'Auditoría temporal',
      permissions: ['tenancy:read'],
    };

    const first = await app.inject({ method: 'POST', url: '/api/v1/iam/roles', headers, payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: '/api/v1/iam/roles', headers, payload });

    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('ROLE_CODE_ALREADY_EXISTS');

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/iam/roles/${first.json<{ id: string }>().id}`,
      headers,
    });
  });
});

describe('a refusal', () => {
  it('is recorded as denied, not merely dropped', async () => {
    // The event §8.4 asks for by name: "todo intento de acceso denegado por autorización".
    // A refusal nobody records is a probe nobody can count.
    await clearOwnEvents();
    const session = await signIn('member@acme.test', 'local-demo-acme-member');

    const refused = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/members',
      headers: { cookie: session.cookies },
    });
    expect(refused.statusCode).toBe(403);

    const denials = await pool.query<{ action: string }>(
      `select action from control.audit_events
        where action = 'authorization.denied' and actor_id in (
          select id::text from auth.users where email = 'member@acme.test'
        )`,
    );
    expect(denials.rows.length).toBeGreaterThan(0);
  });
});
