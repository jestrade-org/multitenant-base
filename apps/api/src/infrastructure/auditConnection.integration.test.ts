import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authorizedUseCase,
  permission,
  PolicyEnforcementPoint,
  requireAll,
  type Actor,
} from '@multitenant-base/shared-kernel';

import { TransactionalAuthorizationAudit } from './auditConnection.js';

/**
 * The enforcement point and the trail, wired as the container wires them.
 *
 * Each half is unit-tested on its own, which proves neither of the things that matter
 * here: that a refusal actually reaches the table, and that a refusal the table rejects
 * still refuses. Those only show up when the real adapter meets the real database.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

let pool: pg.Pool;
let tenantId: string;

function anActor(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: 'user-under-test',
    actorType: 'user',
    tenantId,
    roleCode: 'analyst',
    permissions: [permission('tenancy:read')],
    ...overrides,
  };
}

interface AuditRow {
  readonly action: string;
  readonly result: string;
  readonly actor_id: string;
  readonly resource_id: string | null;
  readonly changes: { readonly missingPermissions: readonly string[] } | null;
}

async function deniedEvents(): Promise<readonly AuditRow[]> {
  const rows = await pool.query<AuditRow>(
    `select action, result, actor_id, resource_id, changes
       from control.audit_events
      where actor_id = 'user-under-test'
      order by occurred_at`,
  );
  return rows.rows;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  const tenants = await pool.query<{ id: string }>('select id from control.tenants limit 1');
  const first = tenants.rows[0];
  if (first === undefined) throw new Error('the seed must provide a tenant');
  tenantId = first.id;
});

afterAll(async () => {
  // `session_replication_role` suppresses the trigger for this session only. `alter table
  // ... disable trigger` is global: it leaked across test files and made the very test
  // that proves the trigger works pass against a table where it was switched off.
  const client = await pool.connect();
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  await client.query('delete from control.audit_events where actor_id = $1', ['user-under-test']);
  await client.query('commit');
  client.release();
  await pool.end();
});

describe('authorization decisions reaching the audit trail', () => {
  it('writes a denial that a compliance query can find', async () => {
    const pep = new PolicyEnforcementPoint({
      clock: { now: () => new Date() },
      auditSink: new TransactionalAuthorizationAudit(pool, () => ({
        correlationId: '01HRZTESTCORRELATION',
        ipAddress: '190.85.10.20',
      })),
    });

    await expect(
      pep.authorize('InviteMember', requireAll(permission('iam:user_manage')), anActor()),
    ).rejects.toThrow();

    const [event] = await deniedEvents();
    expect(event).toMatchObject({
      action: 'authorization.denied',
      result: 'denied',
      resource_id: 'InviteMember',
    });
    expect(event?.changes?.missingPermissions).toEqual(['iam:user_manage']);
  });

  it('refuses the use case when the denial itself cannot be recorded', async () => {
    // A pool pointed at a database that will not accept the write. If the enforcement
    // point were to shrug this off, an action would proceed with no record that it was
    // ever questioned — and the trail would be quietly incomplete rather than loudly broken.
    const brokenPool = new pg.Pool({
      connectionString: 'postgresql://postgres:postgres@127.0.0.1:59999/postgres',
      connectionTimeoutMillis: 1_000,
    });

    const pep = new PolicyEnforcementPoint({
      clock: { now: () => new Date() },
      auditSink: new TransactionalAuthorizationAudit(brokenPool),
    });

    let handlerRan = false;
    const useCase = authorizedUseCase(pep, {
      name: 'ReadSummary',
      requirement: requireAll(permission('tenancy:read')),
      handler: () => {
        handlerRan = true;
        return Promise.resolve('summary');
      },
    });

    // The actor holds the capability: the only reason this fails is the unrecordable audit.
    await expect(useCase(anActor(), {})).rejects.toThrow();
    expect(handlerRan).toBe(false);

    await brokenPool.end();
  });
});
