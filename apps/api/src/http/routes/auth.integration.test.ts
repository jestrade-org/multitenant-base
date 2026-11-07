import pg from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer } from '../../composition/container.js';
import { loadConfig } from '../../config/environment.js';
import { ReadinessRegistry } from '../routes/health.js';
import { buildServer } from '../server.js';

/**
 * The minimum audit events of §8.4, checked where they are actually produced (VC-35).
 *
 * "Exactly one record with the right result" is the criterion, and it can only be checked
 * against the table. A unit test asserting that a function was called proves the call, not
 * the row — and the row is what an auditor reads.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';
const PASSWORD = 'local-demo-acme-member';

let pool: pg.Pool;
let container: ReturnType<typeof buildContainer>;
let app: Awaited<ReturnType<typeof buildServer>>;

async function eventsFor(action: string): Promise<readonly { result: string; actor_id: string }[]> {
  const rows = await pool.query<{ result: string; actor_id: string }>(
    'select result, actor_id from control.audit_events where action = $1 order by occurred_at',
    [action],
  );
  return rows.rows;
}

/** The recorder writes off the request path, so the row may land a beat after the reply. */
async function waitForEvents(
  action: string,
  expected: number,
): Promise<readonly { result: string; actor_id: string }[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const events = await eventsFor(action);
    if (events.length >= expected) return events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return eventsFor(action);
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
  });

  await clearAuthenticationEvents();
});

/** Its own data, and only its own: a count is meaningless over rows somebody else wrote. */
async function clearAuthenticationEvents(): Promise<void> {
  const client = await pool.connect();
  await client.query('begin');
  // `session_replication_role` suppresses the trigger for this session only. `alter table
  // ... disable trigger` is global: it leaked across test files and made the very test
  // that proves the trigger works pass against a table where it was switched off.
  await client.query("set local session_replication_role = 'replica'");
  await client.query("delete from control.audit_events where action like 'authentication.%'");
  await client.query('commit');
  client.release();
}

afterEach(clearAuthenticationEvents);

afterAll(async () => {
  await app.close();
  await container.dispose();
  await pool.end();
});

describe('authentication events reach the audit trail', () => {
  it('records exactly one success for a valid sign-in', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { email: 'member@acme.test', password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);

    const events = await waitForEvents('authentication.signed_in', 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe('success');
  });

  it('records a denial for a wrong password, naming the address that was tried', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { email: 'member@acme.test', password: 'not-the-password' },
    });
    expect(response.statusCode).toBe(401);

    const events = await waitForEvents('authentication.sign_in_failed', 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'denied', actor_id: 'member@acme.test' });
  });

  it('records a denial for an address that belongs to nobody', async () => {
    // The event with no tenant to be filed under — and the one a credential-stuffing run
    // generates by the thousand.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { email: 'nadie@example.com', password: PASSWORD },
    });
    expect(response.statusCode).toBe(401);

    const events = await waitForEvents('authentication.sign_in_failed', 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'denied', actor_id: 'nadie@example.com' });
  });

  it('records a sign-out', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { email: 'member@acme.test', password: PASSWORD },
    });
    const cookies = signIn.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const csrf = signIn.cookies.find((cookie) => cookie.name === 'mtb_csrf')?.value ?? '';

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/session',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
    });
    expect(response.statusCode).toBe(204);

    const events = await waitForEvents('authentication.signed_out', 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe('success');
  });

  it('writes no record at all for a request that never reached authentication', async () => {
    await app.inject({ method: 'GET', url: '/health/live' });

    expect(await eventsFor('authentication.signed_in')).toHaveLength(0);
  });
});
