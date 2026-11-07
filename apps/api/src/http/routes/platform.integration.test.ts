import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer } from '../../composition/container.js';
import { loadConfig } from '../../config/environment.js';
import { ReadinessRegistry } from '../routes/health.js';
import { buildServer } from '../server.js';

/**
 * Who may reach the platform panel (§8.1, §8.3).
 *
 * The rule is that platform staff and a client's users are different principals, and that a
 * client's most senior user is still not staff. That is only worth as much as a test that
 * actually sends a tenant administrator's session at these routes — the strongest argument
 * for the design is that it *cannot* be forgotten, and this is what checks the claim.
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
    platform: { withPlatform: container.platform.withPlatform },
  });
});

afterAll(async () => {
  // Signing in five times leaves five rows in a shared table. Another file counts those
  // rows, so cleaning up is not tidiness — it is the difference between a suite that can
  // be trusted and one where the last file to run decides.
  const client = await pool.connect();
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  await client.query(
    `delete from control.audit_events
      where action like 'authentication.%'
        and actor_id in (
          select id::text from auth.users
           where email in ('platform@example.test', 'admin@acme.test')
        )`,
  );
  await client.query('commit');
  client.release();

  await app.close();
  await container.dispose();
  await pool.end();
});

describe('the platform roster', () => {
  it('lists the clients for platform staff', async () => {
    const session = await signIn('platform@example.test', 'local-demo-platform');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/tenants',
      headers: { cookie: session.cookies },
    });

    expect(response.statusCode).toBe(200);
    const tenants = response.json<readonly { subdomain: string }[]>();
    expect(tenants.map((tenant) => tenant.subdomain)).toContain('acme');
  });

  it('refuses a client administrator, senior though they are inside their own company', async () => {
    // `admin@acme.test` runs Acme Logistics. Nothing about that grants a view of
    // the platform's other clients — and the refusal is structural: the decoration this request
    // carries is `principal`, and these routes read `platformPrincipal`.
    const session = await signIn('admin@acme.test', 'local-demo-acme-admin');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/tenants',
      headers: { cookie: session.cookies },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/platform/tenants' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses to provision without a CSRF token, however valid the session', async () => {
    const session = await signIn('platform@example.test', 'local-demo-platform');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/tenants',
      headers: { cookie: session.cookies },
      payload: {
        name: 'Constructora Sin Csrf S.A.S.',
        taxId: '901237654-3',
        planCode: 'essential',
        administratorEmail: 'nadie@example.com',
        administratorName: 'Nadie',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('answers an invalid tax identifier with 400 and the field, not a 500', async () => {
    // The whole error contract in one request: a stable code, the parameter a Spanish
    // screen interpolates, and a status that says "your input", not "our fault".
    const session = await signIn('platform@example.test', 'local-demo-platform');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/tenants',
      headers: { cookie: session.cookies, 'x-csrf-token': session.csrf },
      payload: {
        name: 'Initech LLC',
        taxId: '12#34',
        planCode: 'starter',
        administratorEmail: 'admin@initech.test',
        administratorName: 'Bill Lumbergh',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { code: string; params: Record<string, string> } }>(),
    ).toMatchObject({ error: { code: 'VALIDATION_FAILED', params: { field: 'taxId' } } });
  });
});
