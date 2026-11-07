import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReadinessRegistry } from './health.js';
import { buildContainer } from '../../composition/container.js';
import { loadConfig } from '../../config/environment.js';
import { buildServer } from '../server.js';

/**
 * The rest of the platform panel: plans, quotas, queues and the cross-tenant audit query
 * (§4.2, §7, §8.1, §8.4, §9, VC-28, VC-75).
 *
 * Three claims are worth a real database rather than a fake, and each is one this file
 * exists to check rather than assert in prose:
 *
 *   1. **A client's administrator cannot reach any of it.** The routes read
 *      `platformPrincipal`, so the refusal is structural — but "structural" is a claim
 *      until a test sends `admin@acme.test` at every one of these endpoints.
 *   2. **A dead-lettered job discloses no payload and no error message.** That is a
 *      property of the SQL, not of a type, so only a query against a real failed job
 *      proves it.
 *   3. **The cross-tenant audit search writes its own audit row.** The whole control is
 *      the row; a test that only checks the response would pass with the recording
 *      removed.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

let pool: pg.Pool;
let container: ReturnType<typeof buildContainer>;
let app: Awaited<ReturnType<typeof buildServer>>;

interface Session {
  readonly cookies: string;
  readonly csrf: string;
}

/**
 * Signed in once per principal, in `beforeAll`, and reused.
 *
 * Not a shortcut: authentication is rate limited per account, deliberately and tightly
 * (§8.2, brute force). A file that signs in before each of twenty tests trips that limit
 * and reports a 429 as a feature failure — the limiter working is what it was measuring.
 */
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
    plans: { withPlans: container.platform.withPlans },
    queues: { withQueues: container.platform.withQueues },
    auditTrail: { withAuditTrail: container.platform.withAuditTrail },
  });

  staff = await signIn('platform@example.test', 'local-demo-platform');
  tenantAdmin = await signIn('admin@acme.test', 'local-demo-acme-admin');
});

afterAll(async () => {
  // Signing in leaves rows in a shared table, and another file counts those rows. Cleaning
  // up is not tidiness — it is the difference between a suite that can be trusted and one
  // where the last file to run decides.
  const client = await pool.connect();
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  await client.query(
    `delete from control.audit_events
      where (action like 'authentication.%' or action = 'audit.searched'
             or action like 'platform.plan_%')
        and (actor_id in (
              select id::text from auth.users
               where email in ('platform@example.test', 'admin@acme.test')
            ))`,
  );
  await client.query("delete from control.plans where code like 'test_%'");
  await client.query('commit');
  client.release();

  await app.close();
  await container.dispose();
  await pool.end();
});

describe('a client administrator against the platform panel (§8.1)', () => {
  // `admin@acme.test` runs Acme Logistics. Nothing about being the most senior user
  // inside their own company grants a view of the platform's plans, queues or other clients — and
  // the refusal is structural: the decoration this request carries is `principal`, and
  // every one of these routes reads `platformPrincipal`.
  const forbidden = [
    { method: 'GET' as const, url: '/api/v1/platform/plans' },
    { method: 'GET' as const, url: '/api/v1/platform/quota-usage' },
    { method: 'GET' as const, url: '/api/v1/platform/queues' },
    { method: 'GET' as const, url: '/api/v1/platform/queues/dead-letter' },
    { method: 'GET' as const, url: '/api/v1/platform/audit-events' },
  ];

  it.each(forbidden)('refuses a tenant administrator at $method $url', async ({ method, url }) => {
    const response = await app.inject({ method, url, headers: { cookie: tenantAdmin.cookies } });

    expect(response.statusCode).toBe(401);
  });

  it.each(forbidden)(
    'refuses an unauthenticated caller at $method $url',
    async ({ method, url }) => {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    },
  );
});

describe('plans and quotas', () => {
  it('lists the seeded plans with their price as a string amount', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/plans',
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(200);
    const plans = response.json<
      readonly {
        code: string;
        monthlyPrice: { amount: unknown; currency: string };
        quotas: { users: number };
      }[]
    >();

    const business = plans.find((plan) => plan.code === 'business');
    expect(business).toBeDefined();
    // A string, never a JSON number: a price through an IEEE-754 double can come back a
    // fraction of a cent different, and a plan is what a company is billed.
    expect(typeof business?.monthlyPrice.amount).toBe('string');
    expect(business?.monthlyPrice.currency).toBe('USD');
    expect(business?.quotas.users).toBe(15);
  });

  it('creates a plan and records who created it, with its limits', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/plans',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: {
        code: 'test_pilot',
        name: 'Test pilot',
        monthlyPrice: '0',
        currency: 'USD',
        quotas: { users: 2 },
      },
    });

    expect(response.statusCode).toBe(201);

    const audited = await pool.query<{ changes: Record<string, string> }>(
      `select changes from control.audit_events
        where action = 'platform.plan_created' and resource_id = 'test_pilot'`,
    );
    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0]?.changes).toMatchObject({ code: 'test_pilot', users: '2' });
  });

  it('refuses a second plan with the same code by name, not by a driver error', async () => {
    const payload = {
      code: 'test_pilot',
      name: 'Duplicate pilot',
      monthlyPrice: '0',
      currency: 'USD',
      quotas: { users: 2 },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/plans',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'PLAN_CODE_ALREADY_EXISTS',
    );
  });

  it('refuses to reprice a plan whose code in the path and the body disagree', async () => {
    // Accepting a differing code would let a `PUT /plans/starter` reprice `enterprise`,
    // which no reviewer of the access log would ever spot.
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/platform/plans/test_pilot',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: {
        code: 'enterprise',
        name: 'Enterprise',
        monthlyPrice: '1',
        currency: 'USD',
        quotas: { users: 2 },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PLAN_CODE_MISMATCH');
  });

  it('refuses a quota of zero, which would read as unlimited and refuse everything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/plans',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: {
        code: 'test_zero',
        name: 'Cero',
        monthlyPrice: '0',
        currency: 'USD',
        quotas: { users: 0 },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('reports usage for every provisioned client, including ones never measured', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/quota-usage',
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(200);
    const usage =
      response.json<readonly { tenantName: string; readings: readonly { kind: string }[] }[]>();

    // A client missing from the quota screen looks like a client who is fine, so every
    // provisioned tenant appears — measured or not — with every limit.
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]?.readings.map((reading) => reading.kind)).toEqual(['users']);
  });
});

describe('the queue monitor', () => {
  it('reports every queue in the catalogue, even the ones with nothing in them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/queues',
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(200);
    const queues = response.json<readonly { name: string; deadLettered: number }[]>();

    // A queue absent from the screen reads as a queue that is fine.
    expect(queues.map((queue) => queue.name)).toEqual(['notifications', 'scheduled']);
  });

  it('never returns a dead-lettered job’s payload or its error message (§8.1)', async () => {
    // pg-boss creates its own schema the first time a worker starts, so on a database
    // nobody has run one against — CI's, every time — it does not exist yet. This test
    // writes a job directly, so it has to make sure there is somewhere to write it rather
    // than inherit one from whichever file happened to run first (testing.md: no
    // dependence on test order). The queue screen itself no longer needs this: it reports
    // empty queues on a database where nothing has ever been enqueued.
    await container.queue.start();

    // A dead-lettered job carrying exactly the two things that must not escape: a person's
    // email in the payload, and a record number inside a driver-shaped error message.
    const jobId = '3f8d6a1e-5c2b-4d7e-9a1f-2b3c4d5e6f70';
    await pool.query(
      `insert into pgboss.job (id, name, data, state, output, created_on, keep_until)
       values ($1::uuid, 'notifications--dead-letter', $2::jsonb, 'created', $3::jsonb,
               now(), now() + interval '1 day')`,
      [
        jobId,
        JSON.stringify({
          type: 'QuotaThresholdReached',
          tenantId: '00000000-0000-4000-8000-000000000001',
          correlationId: '01HRZQUEUETESTCORRELATION',
          payload: { recipientEmail: 'ana@acme.test', orderNumber: 'ORD-1042' },
        }),
        JSON.stringify({
          value: {
            name: 'DatabaseError',
            message:
              'duplicate key value violates unique constraint "orders_tenant_number_idx" ' +
              'Key (tenant_id, number)=(…, ORD-1042) already exists.',
          },
        }),
      ],
    );

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/platform/queues/dead-letter?queue=notifications',
        headers: { cookie: staff.cookies },
      });

      expect(response.statusCode).toBe(200);

      const body = response.body;
      // The two values that identify a real person and a real record. Neither may appear
      // anywhere in the response, in any field, however it is nested.
      expect(body).not.toContain('ana@acme.test');
      expect(body).not.toContain('ORD-1042');
      expect(body).not.toContain('duplicate key');

      const jobs = response.json<
        readonly {
          jobId: string;
          jobName: string;
          failureClass: string;
          correlationId: string | undefined;
          attempts: number;
        }[]
      >();
      const job = jobs.find((candidate) => candidate.jobId === jobId);

      // What it does return: a classification and the join key to the log that holds the
      // detail this deliberately withholds.
      expect(job).toBeDefined();
      expect(job?.jobName).toBe('QuotaThresholdReached');
      expect(job?.failureClass).toBe('DatabaseError');
      expect(job?.correlationId).toBe('01HRZQUEUETESTCORRELATION');
      // notifications retries six times, so the original ran seven.
      expect(job?.attempts).toBe(7);
    } finally {
      await pool.query(`delete from pgboss.job where id = $1::uuid`, [jobId]);
    }
  });

  it('answers 404 for a job id that names nothing, rather than reporting success', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/queues/dead-letter/3f8d6a1e-5c2b-4d7e-9a1f-2b3c4d5e6f7f/replay',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses to discard a job without a reason a reviewer can weigh', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/platform/queues/dead-letter/3f8d6a1e-5c2b-4d7e-9a1f-2b3c4d5e6f7f/discard',
      headers: { cookie: staff.cookies, 'x-csrf-token': staff.csrf },
      payload: { reason: 'no' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('DISCARD_NEEDS_REASON');
  });
});

describe('the cross-tenant audit query', () => {
  it('records the search itself, with the filters and the number of rows returned', async () => {
    const before = await pool.query<{ total: number }>(
      `select count(*)::int as total from control.audit_events where action = 'audit.searched'`,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/audit-events?action=authentication.&pageSize=5',
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(200);

    const after = await pool.query<{ changes: Record<string, string> }>(
      `select changes from control.audit_events
        where action = 'audit.searched'
        order by occurred_at desc
        limit 1`,
    );
    const total = await pool.query<{ total: number }>(
      `select count(*)::int as total from control.audit_events where action = 'audit.searched'`,
    );

    expect(total.rows[0]?.total).toBe((before.rows[0]?.total ?? 0) + 1);
    expect(after.rows[0]?.changes).toMatchObject({
      action: 'authentication.',
      // "They searched every client" is the finding; a missing key would read as a filter
      // nobody thought about.
      tenantId: 'all',
      actorId: 'all',
      pageSize: '5',
    });
  });

  it('filters by action family, which is how a reviewer asks for every sign-in attempt', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/audit-events?action=authentication.',
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(200);
    const page = response.json<{ items: readonly { action: string }[] }>();

    expect(page.items.length).toBeGreaterThan(0);
    for (const event of page.items) {
      expect(event.action.startsWith('authentication.')).toBe(true);
    }
  });

  it('refuses a window wider than a year, naming both numbers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/audit-events?from=2020-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; params: Record<string, string> } }>();
    expect(body.error.code).toBe('AUDIT_WINDOW_TOO_WIDE');
    expect(body.error.params.maximumDays).toBe('366');
  });

  it('refuses a filter that is not an action code, so it can never become a like pattern', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/audit-events?action=%25',
      headers: { cookie: staff.cookies },
    });

    expect(response.statusCode).toBe(400);
  });

  it('pages with a keyset cursor, so a row written mid-review cannot shift the pages', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/platform/audit-events?pageSize=2',
      headers: { cookie: staff.cookies },
    });
    const firstPage = first.json<{
      items: readonly { eventId: string }[];
      nextCursor: string | undefined;
    }>();

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeDefined();

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/platform/audit-events?pageSize=2&cursor=${encodeURIComponent(
        firstPage.nextCursor ?? '',
      )}`,
      headers: { cookie: staff.cookies },
    });
    const secondPage = second.json<{ items: readonly { eventId: string }[] }>();

    // No overlap: an offset would have repeated or skipped rows as the table was written
    // to between the two requests, and this table is written to on every request.
    const firstIds = new Set(firstPage.items.map((item) => item.eventId));
    for (const item of secondPage.items) {
      expect(firstIds.has(item.eventId)).toBe(false);
    }
  });
});
