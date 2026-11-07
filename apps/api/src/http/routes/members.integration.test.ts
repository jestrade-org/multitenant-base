import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer } from '../../composition/container.js';
import { loadConfig } from '../../config/environment.js';
import { ReadinessRegistry } from '../routes/health.js';
import { buildServer } from '../server.js';

/**
 * A company's user list, through the real stack (§9, VC-77).
 *
 * The case that needs a database is the one a unit test cannot reach: an administrator of
 * one company addressing another company's member **by id**. The tenant is part of every
 * predicate rather than a filter applied afterwards, so the row is not there at all — and
 * the answer is 404, which does not confirm that the id exists somewhere else (§8.3).
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

let pool: pg.Pool;
let container: ReturnType<typeof buildContainer>;
let app: Awaited<ReturnType<typeof buildServer>>;
let otherTenantMemberId: string;

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
  const logger = pino({ level: 'silent' });
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

  // Somebody else's employee. Written directly: the point is to address them as the wrong
  // company, not to exercise the invitation path twice.
  const inserted = await pool.query<{ id: string }>(
    `insert into control.tenant_members (tenant_id, auth_user_id, email, full_name, role_id)
     select t.id, gen_random_uuid(), 'outsider@globex.test', 'Persona Ajena', r.id
       from control.tenants t, control.roles r
      where t.subdomain = 'globex' and r.code = 'member'
     returning id`,
  );
  otherTenantMemberId = inserted.rows[0]?.id ?? '';
});

afterAll(async () => {
  await pool.query("delete from control.tenant_members where email = 'outsider@globex.test'");

  const client = await pool.connect();
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  await client.query(
    `delete from control.audit_events
      where action like 'authentication.%'
        and actor_id in (select id::text from auth.users where email = 'admin@acme.test')`,
  );
  await client.query('commit');
  client.release();

  await app.close();
  await container.dispose();
  await pool.end();
});

describe('a company sees only its own people', () => {
  it('lists nobody from another company', async () => {
    const session = await signIn('admin@acme.test', 'local-demo-acme-admin');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/members',
      headers: { cookie: session.cookies },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: readonly { email: string }[] }>();
    expect(body.items.map((item) => item.email)).not.toContain('outsider@globex.test');
  });

  it('answers 404 for another company’s member, not 403', async () => {
    const session = await signIn('admin@acme.test', 'local-demo-acme-admin');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/members/${otherTenantMemberId}/role`,
      headers: { cookie: session.cookies, 'x-csrf-token': session.csrf },
      payload: { roleCode: 'tenant_admin' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('leaves that member’s role untouched', async () => {
    const session = await signIn('admin@acme.test', 'local-demo-acme-admin');

    await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/members/${otherTenantMemberId}/role`,
      headers: { cookie: session.cookies, 'x-csrf-token': session.csrf },
      payload: { roleCode: 'tenant_admin' },
    });

    const rows = await pool.query<{ code: string }>(
      `select r.code from control.tenant_members m
         join control.roles r on r.id = m.role_id
        where m.id = $1`,
      [otherTenantMemberId],
    );

    expect(rows.rows[0]?.code).toBe('member');
  });
});

describe('who may administer users', () => {
  it('refuses a member, whose role does not include user administration', async () => {
    const session = await signIn('member@acme.test', 'local-demo-acme-member');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/members',
      headers: { cookie: session.cookies },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses an invitation without a CSRF token, however valid the session', async () => {
    const session = await signIn('admin@acme.test', 'local-demo-acme-admin');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/members',
      headers: { cookie: session.cookies },
      payload: { email: 'nadie@acme.test', fullName: 'Nadie', roleCode: 'member' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a platform role, which would reach every other client', async () => {
    // §8.1 as a request rather than as a dropdown: the interface does not offer it, and
    // this is what happens when something bypasses the interface.
    const session = await signIn('admin@acme.test', 'local-demo-acme-admin');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/members',
      headers: { cookie: session.cookies, 'x-csrf-token': session.csrf },
      payload: {
        email: 'escalada@acme.test',
        fullName: 'Intento De Escalada',
        roleCode: 'platform_admin',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('ROLE_NOT_ASSIGNABLE');

    const created = await pool.query("select 1 from auth.users where email = 'escalada@acme.test'");
    expect(created.rowCount).toBe(0);
  });
});
