import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReadinessRegistry } from './health.js';
import { buildContainer } from '../../composition/container.js';
import { loadConfig } from '../../config/environment.js';
import { buildServer } from '../server.js';

/**
 * Support access, against a real database (§8.1, §8.4, VC-101).
 *
 * Four claims here are about behaviour nothing but Postgres and the real route stack can
 * demonstrate, and each is the reason a piece of this feature exists:
 *
 *   1. **A grant changes who the session is.** The point of the overlay is that the same
 *      cookies resolve to a different principal afterwards. A fake would prove only that
 *      the code intends to.
 *   2. **It does not hand over both sets of powers.** For as long as a grant is live the
 *      request carries the client's principal and no platform one, so the platform panel
 *      refuses its own administrator. That is structural, and "structural" is a claim
 *      until something sends the request.
 *   3. **The audit row names the staff member, not the client's user.** The whole design
 *      rests on this; a test that only read the response would pass with the attribution
 *      inverted.
 *   4. **The exit works from inside.** The request that ends a grant no longer holds any
 *      platform capability — if the endpoint were gated on one, the staff member would be
 *      trapped in somebody else's account.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

const A_GOOD_REASON = 'El cliente reporta que su resumen no carga desde ayer por la tarde';

let pool: pg.Pool;
let container: ReturnType<typeof buildContainer>;
let app: Awaited<ReturnType<typeof buildServer>>;

interface Session {
  readonly cookies: string;
  readonly csrf: string;
}

/** Signed in once per principal: authentication is rate limited per account (§8.2). */
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

let staff: Session;
let tenantAdmin: Session;
/** A live member of Acme Logistics, read from the database rather than assumed. */
let target: { memberId: string; fullName: string; tenantId: string; tenantName: string };
let staffAuthUserId: string;

/** Removes the support-access rows the trail has collected, for a focused assertion. */
async function clearSupportAccessEvents(): Promise<void> {
  const client = await pool.connect();
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  await client.query(
    `delete from control.audit_events where action like 'platform.support_access_%'`,
  );
  await client.query('commit');
  client.release();
}

async function endAnyGrant(): Promise<void> {
  await app.inject({
    method: 'DELETE',
    url: '/api/v1/platform/support-access',
    headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
  });
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
    supportAccess: { withSupportAccess: container.platform.withSupportAccess },
  });

  staff = await signIn('platform@example.test', 'local-demo-platform');
  tenantAdmin = await signIn('admin@acme.test', 'local-demo-acme-admin');

  const members = await pool.query<{
    id: string;
    full_name: string;
    tenant_id: string;
    name: string;
  }>(
    `select m.id, m.full_name, m.tenant_id, t.name
       from control.tenant_members m
       join control.tenants t on t.id = m.tenant_id
      where m.is_active and t.subdomain = 'acme'
      order by m.full_name
      limit 1`,
  );
  const row = members.rows[0];
  if (row === undefined) throw new Error('the local seed has no active member of Acme');
  target = {
    memberId: row.id,
    fullName: row.full_name,
    tenantId: row.tenant_id,
    tenantName: row.name,
  };

  const staffRow = await pool.query<{ auth_user_id: string }>(
    `select auth_user_id from control.platform_users where email = 'platform@example.test'`,
  );
  staffAuthUserId = staffRow.rows[0]?.auth_user_id ?? '';
});

afterAll(async () => {
  await endAnyGrant();

  // Signing in and granting leave rows in shared tables, and other files count those rows.
  // The grant table is append-only by trigger, so cleaning it needs the replica role —
  // which is exactly the guard this suite proved is there.
  const client = await pool.connect();
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  await client.query('delete from control.support_access_grants');
  await client.query(
    `delete from control.audit_events
      where action like 'authentication.%' or action like 'platform.support_access_%'`,
  );
  await client.query('commit');
  client.release();

  await app.close();
  await container.dispose();
  await pool.end();
});

describe('who may reach the door at all (§8.1)', () => {
  const guarded = [
    { method: 'GET' as const, url: '/api/v1/platform/support-access/members' },
    { method: 'POST' as const, url: '/api/v1/platform/support-access' },
  ];

  it.each(guarded)('refuses a tenant administrator at $method $url', async ({ method, url }) => {
    const response = await app.inject({
      method,
      url,
      headers: { cookie: tenantAdmin.cookies, 'x-csrf-token': tenantAdmin.csrf },
      ...(method === 'POST'
        ? { payload: { memberId: target.memberId, reason: A_GOOD_REASON } }
        : {}),
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an unauthenticated read', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/support-access/members',
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * 403 rather than 401, and deliberately.
   *
   * CSRF is checked before authentication on a state-changing request: a forged request
   * that gets as far as being authenticated has already cost us the assumption that only
   * our own client can reach the endpoint. A caller with no cookies has no token to echo,
   * so it is refused there first.
   */
  it('refuses an unauthenticated attempt to open a grant, at the CSRF gate', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support-access',
      payload: { memberId: target.memberId, reason: A_GOOD_REASON },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a state-changing request with no CSRF token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies },
      payload: { memberId: target.memberId, reason: A_GOOD_REASON },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('finding someone to help', () => {
  it('lists the people of one client when the panel opened one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/platform/support-access/members?tenantId=${target.tenantId}`,
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: readonly { tenantId: string; email: string }[] }>();
    expect(body.items.length).toBeGreaterThan(0);
    // Every row belongs to the company that was opened, and none carries a figure.
    for (const member of body.items) expect(member.tenantId).toBe(target.tenantId);
  });

  it('rejects a tenant filter that is not an id rather than ignoring it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/support-access/members?tenantId=not-a-uuid',
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('entering, and coming back', () => {
  it('refuses a reason too short for a reviewer to weigh, and opens nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: { memberId: target.memberId, reason: 'soporte' },
    });

    expect(response.statusCode).toBe(400);

    const live = await pool.query<{ count: string }>(
      'select count(*) from control.support_access_grants where ended_at is null',
    );
    expect(live.rows[0]?.count).toBe('0');
  });

  it('refuses a member that belongs to nobody we serve', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: {
        memberId: '00000000-0000-4000-8000-000000000000',
        reason: 'Un usuario que no existe en ningún cliente nuestro',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('turns the staff session into the client’s user, and back again', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: staff.cookies },
    });
    expect(before.json<{ tenant: unknown }>().tenant).toBeNull();

    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: { memberId: target.memberId, reason: A_GOOD_REASON },
    });
    expect(opened.statusCode).toBe(201);

    // The same cookies now resolve to somebody else — which is the whole feature.
    const inside = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: staff.cookies },
    });
    const session = inside.json<{
      user: { fullName: string };
      tenant: { name: string } | null;
      permissions: readonly string[];
      supportAccess: { staffEmail: string; reason: string } | null;
    }>();

    expect(session.user.fullName).toBe(target.fullName);
    expect(session.tenant?.name).toBe(target.tenantName);
    // And it says so: the client's user is on screen, the staff member is named beside it.
    expect(session.supportAccess?.staffEmail).toBe('platform@example.test');
    expect(session.supportAccess?.reason).toBe(A_GOOD_REASON);

    // Handing it back restores the staff session without touching their cookies.
    const returned = await app.inject({
      method: 'DELETE',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
    });
    expect(returned.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: staff.cookies },
    });
    expect(after.json<{ tenant: unknown; supportAccess: unknown }>()).toMatchObject({
      tenant: null,
      supportAccess: null,
    });
  });

  it('does not hand over both sets of powers at once', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: { memberId: target.memberId, reason: A_GOOD_REASON },
    });

    // Inside the client, the platform panel is exactly what they stepped out of.
    const roster = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/tenants',
      headers: { cookie: staff.cookies },
    });
    expect(roster.statusCode).toBe(401);

    // And a second grant cannot be opened from inside the first.
    const nested = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: { memberId: target.memberId, reason: A_GOOD_REASON },
    });
    expect(nested.statusCode).toBe(401);

    // The exit still opens, from the inside, with no platform capability in hand.
    const returned = await app.inject({
      method: 'DELETE',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
    });
    expect(returned.statusCode).toBe(204);
  });

  it('is idempotent on the way out, and refuses the exit to someone who never left', async () => {
    const again = await app.inject({
      method: 'DELETE',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('what the client can read about it afterwards (§8.4)', () => {
  it('files both ends under the client, naming the staff member and not their user', async () => {
    // Earlier tests in this file opened and closed grants of their own. Clearing first
    // keeps the assertion about *these* two events rather than about the file's history.
    await clearSupportAccessEvents();

    await app.inject({
      method: 'POST',
      url: '/api/v1/platform/support-access',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: { memberId: target.memberId, reason: A_GOOD_REASON },
    });
    await endAnyGrant();

    const events = await pool.query<{
      action: string;
      actor_id: string;
      actor_type: string;
      tenant_id: string;
      resource_id: string;
      changes: Record<string, string>;
    }>(
      `select action, actor_id, actor_type, tenant_id, resource_id, changes
         from control.audit_events
        where action like 'platform.support_access_%'
        order by occurred_at`,
    );

    expect(events.rows.map((row) => row.action)).toEqual([
      'platform.support_access_granted',
      'platform.support_access_ended',
    ]);

    for (const row of events.rows) {
      // Filed under the client, so their own audit view shows we were inside.
      expect(row.tenant_id).toBe(target.tenantId);
      expect(row.resource_id).toBe(target.memberId);
      // The human, not the account they borrowed. This is the property the design rests on.
      expect(row.actor_id).toBe(staffAuthUserId);
      expect(row.actor_type).toBe('platform_admin');
    }

    expect(events.rows[0]?.changes.reason).toBe(A_GOOD_REASON);
    expect(events.rows[1]?.changes.endedBecause).toBe('returned');
  });

  it('keeps the grant as a record: it cannot be rewritten or deleted', async () => {
    const rewrite = pool.query(`update control.support_access_grants set reason = 'otra cosa'`);
    await expect(rewrite).rejects.toThrow(/only ended_at may be changed/);

    const remove = pool.query('delete from control.support_access_grants');
    await expect(remove).rejects.toThrow(/append-only/);
  });
});
