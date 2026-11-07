import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAuditTrail } from './postgresAuditTrail.js';

/**
 * The append-only guarantee, proved against the database rather than asserted in a comment.
 *
 * Every claim here is about Postgres' behaviour — a grant, a policy, a trigger — so a unit
 * test with a fake client would prove nothing at all. It would pass just as happily against
 * a table anyone can rewrite.
 *
 * Requires the local stack: `pnpm supabase start && pnpm supabase db reset`.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

let pool: pg.Pool;
let tenantId: string;
let otherTenantId: string;

/** Runs as the application role, with a tenant bound, exactly as a request does. */
async function asApplication<T>(
  boundTenantId: string | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role tenant_app');
    await client.query('select set_config($1, $2, true)', ['app.tenant_id', boundTenantId ?? '']);
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

function anEvent(overrides: Record<string, unknown> = {}) {
  return {
    occurredAt: new Date('2026-08-23T15:00:00.000Z'),
    tenantId,
    actorType: 'user' as const,
    actorId: 'user-1',
    action: 'authorization.denied',
    result: 'denied' as const,
    ...overrides,
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });

  const tenants = await pool.query<{ id: string }>(
    'select id from control.tenants order by created_at limit 2',
  );
  const [first, second] = tenants.rows;
  if (first === undefined || second === undefined) {
    throw new Error('the seed must provide at least two tenants for an isolation test');
  }
  tenantId = first.id;
  otherTenantId = second.id;
});

afterAll(async () => {
  // Cleaning up needs DDL, which is the guarantee working rather than an inconvenience:
  // nothing short of a deliberate, privileged schema change can remove an audit row. In
  // production that path is the documented archive procedure, not a query.
  // `session_replication_role` suppresses the trigger for this session only. `alter table
  // ... disable trigger` is global: it leaked across test files and made the very test
  // that proves the trigger works pass against a table where it was switched off.
  const client = await pool.connect();
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  await client.query('delete from control.audit_events where actor_id = any($1)', [
    ['user-1', 'user-of-other-tenant', 'nadie@example.com'],
  ]);
  await client.query('commit');
  client.release();
  await pool.end();
});

describe('control.audit_events', () => {
  it('records an event for the tenant bound to the connection', async () => {
    const eventId = await asApplication(tenantId, (client) =>
      new PostgresAuditTrail(wrap(client)).record(anEvent()),
    );

    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses an event filed against a tenant the connection is not acting for', async () => {
    await expect(
      asApplication(tenantId, (client) =>
        new PostgresAuditTrail(wrap(client)).record(anEvent({ tenantId: otherTenantId })),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('shows a tenant only its own events', async () => {
    await asApplication(otherTenantId, (client) =>
      new PostgresAuditTrail(wrap(client)).record(
        anEvent({ tenantId: otherTenantId, actorId: 'user-of-other-tenant' }),
      ),
    );

    const visible = await asApplication(tenantId, async (client) => {
      const rows = await client.query<{ actor_id: string }>(
        'select actor_id from control.audit_events',
      );
      return rows.rows.map((row) => row.actor_id);
    });

    expect(visible).not.toContain('user-of-other-tenant');
  });

  it('refuses to let the application rewrite history', async () => {
    await expect(
      asApplication(tenantId, (client) =>
        client.query("update control.audit_events set action = 'invoice.approved'"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to let the application delete history', async () => {
    await expect(
      asApplication(tenantId, (client) => client.query('delete from control.audit_events')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses an update even from the table owner, which the grant alone would allow', async () => {
    // The grant protects the application; the trigger protects against a future migration
    // that widens the grant by accident. Both, because one of them is a single line away
    // from being undone.
    await expect(
      pool.query("update control.audit_events set action = 'invoice.approved'"),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses a delete even from the table owner', async () => {
    await expect(
      pool.query('delete from control.audit_events where actor_id = $1', ['user-1']),
    ).rejects.toThrow(/append-only/i);
  });

  it('accepts an authentication attempt that belongs to no tenant', async () => {
    // Regression: the adapter used `returning`, which made the statement read the row back
    // and so applied the tenant-scoped *select* policy. A failed sign-in by an unknown
    // address has no tenant, so the single most security-relevant event was the one event
    // this table refused to store.
    const eventId = await asApplication(null, (client) =>
      new PostgresAuditTrail(wrap(client)).record({
        occurredAt: new Date('2026-08-23T15:00:00.000Z'),
        actorType: 'user',
        actorId: 'nadie@example.com',
        action: 'authentication.sign_in_failed',
        result: 'denied',
      }),
    );

    const stored = await pool.query(
      'select event_id from control.audit_events where event_id = $1',
      [eventId],
    );
    expect(stored.rowCount).toBe(1);
  });

  it('refuses an action code that no compliance query could filter on', async () => {
    await expect(
      asApplication(tenantId, (client) =>
        new PostgresAuditTrail(wrap(client)).record(anEvent({ action: 'NotAnActionCode' })),
      ),
    ).rejects.toThrow(/action code/i);
  });
});

/** Adapts pg's result shape to the narrow client the adapter asks for. */
function wrap(client: pg.PoolClient) {
  return {
    query: async (sql: string, values?: readonly unknown[]) => {
      const result = await client.query(sql, values as unknown[] | undefined);
      return result.rows as Record<string, unknown>[];
    },
  };
}
