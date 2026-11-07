import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  deduplicatingEmitter,
  idempotentConsumer,
  FixedClock,
} from '@multitenant-base/shared-kernel';

import { PostgresProcessedEventLedger, PostgresSuppressionWindow } from './idempotency.js';

/**
 * Double delivery, against the real tables (VC-41).
 *
 * The claim is an `on conflict do nothing` and the suppression window is one statement
 * with a conditional re-arm. Neither can be trusted from reading it: both are exactly the
 * kind of SQL that looks right and behaves differently under a race or a clock boundary.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

let pool: pg.Pool;
let tenantId: string;
let schemaName: string;

async function inTenant<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role tenant_app');
    await client.query(`set local search_path = ${schemaName}`);
    await client.query('select set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function wrap(client: pg.PoolClient) {
  return {
    query: async (sql: string, values?: readonly unknown[]) => {
      const result = await client.query(sql, values as unknown[] | undefined);
      return result.rows as Record<string, unknown>[];
    },
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONNECTION, max: 6 });
  const tenants = await pool.query<{ id: string; schema_name: string }>(
    'select id, schema_name from control.tenants order by created_at limit 1',
  );
  const first = tenants.rows[0];
  if (first === undefined) throw new Error('the seed must provide a tenant');
  tenantId = first.id;
  schemaName = first.schema_name;
});

beforeEach(async () => {
  await pool.query(`delete from ${schemaName}.processed_events`);
  await pool.query(`delete from ${schemaName}.suppressed_duplicates`);
});

afterAll(async () => {
  await pool.end();
});

describe('processing the same event twice', () => {
  it('produces one effect, not two', async () => {
    let effects = 0;
    const duplicates: string[] = [];

    const consume = (client: pg.PoolClient) =>
      idempotentConsumer<{ eventId: string; type: string }>({
        consumer: 'quota-alerts',
        ledger: new PostgresProcessedEventLedger(wrap(client), tenantId),
        handle: () => {
          effects += 1;
          return Promise.resolve();
        },
        onDuplicate: (event) => duplicates.push(event.eventId),
      });

    const event = { eventId: '99999999-0000-0000-0000-000000000001', type: 'TenantProvisioned' };
    await inTenant((client) => consume(client)(event));
    await inTenant((client) => consume(client)(event));

    expect(effects).toBe(1);
    expect(duplicates).toEqual([event.eventId]);
  });

  it('lets a different consumer handle the same event', async () => {
    // The ledger keys on (consumer, event), not on the event alone. Otherwise the first
    // consumer to see an event would silently starve every other subscriber.
    const handled: string[] = [];
    const event = { eventId: '99999999-0000-0000-0000-000000000002', type: 'TenantProvisioned' };

    for (const consumer of ['quota-alerts', 'notifications']) {
      await inTenant((client) =>
        idempotentConsumer<{ eventId: string; type: string }>({
          consumer,
          ledger: new PostgresProcessedEventLedger(wrap(client), tenantId),
          handle: () => {
            handled.push(consumer);
            return Promise.resolve();
          },
        })(event),
      );
    }

    expect(handled).toEqual(['quota-alerts', 'notifications']);
  });

  it('leaves no claim behind when the handler fails, so a retry can still run', async () => {
    // The claim commits with the work. If the work rolls back the claim must roll back
    // too, or a transient failure becomes an event that is never processed at all.
    const event = { eventId: '99999999-0000-0000-0000-000000000003', type: 'TenantProvisioned' };

    await expect(
      inTenant((client) =>
        idempotentConsumer<{ eventId: string; type: string }>({
          consumer: 'quota-alerts',
          ledger: new PostgresProcessedEventLedger(wrap(client), tenantId),
          handle: () => Promise.reject(new Error('the projection blew up')),
        })(event),
      ),
    ).rejects.toThrow('the projection blew up');

    let ranOnRetry = false;
    await inTenant((client) =>
      idempotentConsumer<{ eventId: string; type: string }>({
        consumer: 'quota-alerts',
        ledger: new PostgresProcessedEventLedger(wrap(client), tenantId),
        handle: () => {
          ranOnRetry = true;
          return Promise.resolve();
        },
      })(event),
    );

    expect(ranOnRetry).toBe(true);
  });
});

describe('suppressing equivalent alerts (RF-43)', () => {
  const clock = new FixedClock('2026-08-23T15:00:00.000Z');

  function emitter(client: pg.PoolClient, sent: string[], suppressed: string[]) {
    return deduplicatingEmitter<{ kind: string; subject: string }>({
      window: new PostgresSuppressionWindow(wrap(client), tenantId),
      clock,
      rule: {
        // Deliberately excludes any timestamp or event id: two alerts are "the same
        // thing" when they would read identically to the person receiving them.
        key: (alert) => `${alert.kind}:${alert.subject}`,
        windowMs: 24 * 60 * 60 * 1000,
      },
      emit: (alert) => {
        sent.push(alert.subject);
        return Promise.resolve();
      },
      onSuppressed: (alert) => suppressed.push(alert.subject),
    });
  }

  it('judges the window by the injected clock, not the database clock', async () => {
    // The regression: `first_seen_at` defaulted to the database's `now()` while
    // `expires_at` came from the injected clock. The two agreed only while the two clocks
    // did — so a suite that passed on the day it was written started violating a check
    // constraint the next morning, and in production a drifting clock would have made the
    // window an unknown length.
    const past = new FixedClock('2020-01-01T00:00:00.000Z');
    const sent: string[] = [];
    const suppressed: string[] = [];
    const alert = { kind: 'quota_warning', subject: 'acme' };

    const emitInPast = (client: pg.PoolClient) =>
      deduplicatingEmitter<{ kind: string; subject: string }>({
        window: new PostgresSuppressionWindow(wrap(client), tenantId),
        clock: past,
        rule: { key: (a) => `${a.kind}:${a.subject}`, windowMs: 24 * 60 * 60 * 1000 },
        emit: (a) => {
          sent.push(a.subject);
          return Promise.resolve();
        },
        onSuppressed: (a) => suppressed.push(a.subject),
      });

    await inTenant((client) => emitInPast(client)(alert));
    await inTenant((client) => emitInPast(client)(alert));

    expect(sent).toEqual(['acme']);
    expect(suppressed).toEqual(['acme']);
  });

  it('sends the first one and swallows the identical repeat', async () => {
    const sent: string[] = [];
    const suppressed: string[] = [];
    const alert = { kind: 'quota_warning', subject: 'globex' };

    await inTenant((client) => emitter(client, sent, suppressed)(alert));
    await inTenant((client) => emitter(client, sent, suppressed)(alert));
    await inTenant((client) => emitter(client, sent, suppressed)(alert));

    // Twenty identical warnings in a morning is how someone learns to ignore all of them.
    expect(sent).toEqual(['globex']);
    expect(suppressed).toHaveLength(2);
  });

  it('still sends a different alert about the same subject', async () => {
    const sent: string[] = [];
    const suppressed: string[] = [];

    await inTenant((client) =>
      emitter(client, sent, suppressed)({ kind: 'quota_warning', subject: 'initech' }),
    );
    await inTenant((client) =>
      emitter(client, sent, suppressed)({ kind: 'quota_exceeded', subject: 'initech' }),
    );

    expect(sent).toHaveLength(2);
  });

  it('counts what it suppressed, so the volume is visible rather than lost', async () => {
    const sent: string[] = [];
    const suppressed: string[] = [];
    const alert = { kind: 'quota_warning', subject: 'initech' };

    await inTenant((client) => emitter(client, sent, suppressed)(alert));
    await inTenant((client) => emitter(client, sent, suppressed)(alert));

    const rows = await pool.query<{ occurrences: number }>(
      `select occurrences from ${schemaName}.suppressed_duplicates where suppression_key = $1`,
      ['quota_warning:initech'],
    );
    expect(rows.rows[0]?.occurrences).toBe(2);
  });

  it('sends again once the window has closed', async () => {
    const sent: string[] = [];
    const suppressed: string[] = [];
    const alert = { kind: 'quota_warning', subject: 'initech' };

    await inTenant((client) => emitter(client, sent, suppressed)(alert));

    // The window is aged rather than waited out: no sleeps, and this asserts the re-arm
    // branch directly. An alert suppressed permanently is an alert that was deleted, so
    // the branch that reopens the window is the one that matters most here.
    await pool.query(
      // Aged against the *injected* clock, not the database's: the window is judged by
      // the clock the caller passes, so ageing it by `now()` would make this test pass or
      // fail depending on the day it runs.
      `update ${schemaName}.suppressed_duplicates
          set first_seen_at = $2::timestamptz - interval '2 hours',
              expires_at    = $2::timestamptz - interval '1 minute'
        where suppression_key = $1`,
      ['quota_warning:initech', clock.now()],
    );

    await inTenant((client) => emitter(client, sent, suppressed)(alert));

    expect(sent).toEqual(['initech', 'initech']);
    expect(suppressed).toEqual([]);
  });
});
