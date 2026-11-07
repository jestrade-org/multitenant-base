import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PgBossQueue } from './pgBossQueue.js';

/**
 * Deduplication at the queue, verified against pg-boss rather than against its docs.
 *
 * The queues were declared with the `standard` policy and every send passed a
 * `singletonKey`. That reads as deduplicated and is not: pg-boss enforces the key with a
 * partial unique index on `state = 'created' and policy = 'short'`, so under `standard` the
 * key was stored and ignored. Every "deduplicated" publish produced a second job — which
 * on the notifications queue is a second collection message to a client who already paid.
 *
 * Nothing about that is visible in the TypeScript. Only the database can answer it, which
 * is why this test exists.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

let pool: pg.Pool;
let queue: PgBossQueue;

function anEvent(eventId: string) {
  return {
    eventId,
    type: 'QuotaThresholdReached' as const,
    tenantId: '00000000-0000-0000-0000-000000000001',
    occurredAt: new Date('2026-08-23T15:00:00.000Z').toISOString(),
    correlationId: '01HRZTESTCORRELATION',
    payload: { quota: 'users' },
  };
}

async function jobsOn(queueName: string): Promise<number> {
  const rows = await pool.query<{ count: string }>(
    'select count(*)::text as count from pgboss.job where name = $1',
    [queueName],
  );
  return Number(rows.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  queue = new PgBossQueue({ connectionString: CONNECTION, logger: pino({ level: 'silent' }) });
  await queue.start();
});

beforeEach(async () => {
  await pool.query('truncate pgboss.job');
});

afterAll(async () => {
  await queue.stop();
  await pool.end();
});

describe('queue declaration', () => {
  it('declares every queue with the policy under which singletonKey is enforced', async () => {
    const rows = await pool.query<{ name: string; policy: string }>(
      'select name, policy from pgboss.queue order by name',
    );
    // pg-boss keeps its own internal queue in the same table; only ours are asserted.
    const working = rows.rows.filter(
      (row) => !row.name.endsWith('-dead-letter') && !row.name.startsWith('__pgboss__'),
    );

    expect(working.length).toBeGreaterThan(0);
    for (const row of working) {
      expect({ queue: row.name, policy: row.policy }).toEqual({
        queue: row.name,
        policy: 'short',
      });
    }
  });
});

describe('publishing the same event twice', () => {
  it('leaves one queued job, not two', async () => {
    const event = anEvent('88888888-0000-0000-0000-000000000001');

    await queue.publish(event);
    await queue.publish(event);

    const total = await pool.query<{ count: string }>(
      `select count(*)::text as count from pgboss.job
        where not name like '%-dead-letter' and not name like '\\_\\_pgboss\\_\\_%'`,
    );
    // One per subscribed queue, not two.
    const perQueue = await pool.query<{ name: string; count: string }>(
      `select name, count(*)::text as count from pgboss.job
        where not name like '%-dead-letter' and not name like '\\_\\_pgboss\\_\\_%'
        group by name`,
    );

    expect(Number(total.rows[0]?.count)).toBe(perQueue.rows.length);
    for (const row of perQueue.rows) {
      expect({ queue: row.name, jobs: Number(row.count) }).toEqual({ queue: row.name, jobs: 1 });
    }
  });

  it('still queues a genuinely different event', async () => {
    await queue.publish(anEvent('88888888-0000-0000-0000-000000000002'));
    const afterFirst = await jobsOn('notifications');

    await queue.publish(anEvent('88888888-0000-0000-0000-000000000003'));

    expect(await jobsOn('notifications')).toBe(afterFirst + 1);
  });
});

describe('scheduling the same slot twice', () => {
  const tenant = {
    id: '00000000-0000-0000-0000-0000000000aa',
    name: 'Acme Logistics Inc.',
    timezone: 'America/Bogota',
  };

  it('reports the second attempt as already scheduled and queues nothing', async () => {
    const first = await queue.enqueueScheduled({
      job: 'plan-quota-verification',
      tenant,
      slot: '2026-08-23',
    });
    const second = await queue.enqueueScheduled({
      job: 'plan-quota-verification',
      tenant,
      slot: '2026-08-23',
    });

    expect([first, second]).toEqual([true, false]);
    expect(await jobsOn('scheduled')).toBe(1);
  });

  it('queues the next day separately', async () => {
    await queue.enqueueScheduled({ job: 'plan-quota-verification', tenant, slot: '2026-08-23' });
    await queue.enqueueScheduled({ job: 'plan-quota-verification', tenant, slot: '2026-08-24' });

    expect(await jobsOn('scheduled')).toBe(2);
  });

  it('keeps tenants apart on the same slot', async () => {
    await queue.enqueueScheduled({ job: 'plan-quota-verification', tenant, slot: '2026-08-23' });
    await queue.enqueueScheduled({
      job: 'plan-quota-verification',
      tenant: { ...tenant, id: '00000000-0000-0000-0000-0000000000bb' },
      slot: '2026-08-23',
    });

    // One client's reminder must never satisfy another's.
    expect(await jobsOn('scheduled')).toBe(2);
  });
});
