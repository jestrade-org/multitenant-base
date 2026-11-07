import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@multitenant-base/shared-kernel';
import type { ResolvedTenant } from '@multitenant-base/tenancy';

import { OutboxPoller, outboxWriter, type QueuePublisher } from './outbox.js';
import type { TenantConnectionProvider, TenantUnitOfWork } from './tenantConnection.js';

const silent = pino({ level: 'silent' });

const tenant: ResolvedTenant = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme Logistics Inc.',
  schemaName: 'tenant_acme',
  subdomain: 'acme',
  isolationMode: 'shared_schema',
  lifecycleStatus: 'active',
  timezone: 'America/Bogota',
};

interface StoredRow {
  event_id: string;
  tenant_id: string;
  type: string;
  occurred_at: Date;
  payload: unknown;
  correlation_id: string;
  causation_id: string | null;
  attempts: number;
  published_at: Date | null;
  last_error: string | null;
}

/**
 * Stands in for the tenant connection: enough of the outbox table's behaviour to assert
 * what the poller does with each outcome. The SQL itself is exercised against the local
 * Supabase stack; what is worth isolating here is the decision-making.
 */
class FakeOutbox implements TenantConnectionProvider {
  public rows: StoredRow[] = [];
  public transactions = 0;

  public constructor(rows: Partial<StoredRow>[] = []) {
    this.rows = rows.map((row, index) => ({
      event_id: `0000000${String(index)}-1111-4111-8111-111111111111`,
      tenant_id: tenant.id,
      type: 'QuotaThresholdReached',
      occurred_at: new Date('2026-08-23T14:00:00.000Z'),
      payload: {},
      correlation_id: 'corr-1',
      causation_id: null,
      attempts: 0,
      published_at: null,
      last_error: null,
      ...row,
    }));
  }

  public async withTenant<T>(
    _tenant: ResolvedTenant,
    work: (uow: TenantUnitOfWork) => Promise<T>,
  ): Promise<T> {
    this.transactions += 1;
    return work({
      query: <Row>(text: string, values: readonly unknown[] = []): Promise<readonly Row[]> => {
        if (text.includes('set claimed_at = now(), attempts = attempts + 1')) {
          const maxAttempts = Number(values[1]);
          const claimable = this.rows.filter(
            (row) => row.published_at === null && row.attempts < maxAttempts,
          );
          for (const row of claimable) row.attempts += 1;
          return Promise.resolve(claimable as unknown as Row[]);
        }
        if (text.includes('set published_at = now()')) {
          const row = this.rows.find((r) => r.event_id === values[0]);
          if (row) row.published_at = new Date();
          return Promise.resolve([]);
        }
        if (text.includes('set claimed_at = null, last_error')) {
          const row = this.rows.find((r) => r.event_id === values[0]);
          if (row) row.last_error = String(values[1]);
          return Promise.resolve([]);
        }
        if (text.includes('set attempts = greatest')) {
          const row = this.rows.find((r) => r.event_id === values[0]);
          if (row) {
            row.attempts = Math.max(row.attempts, Number(values[2]));
            row.last_error = String(values[1]);
          }
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    });
  }
}

const publisherThat = (behaviour: (event: DomainEvent) => void): QueuePublisher => ({
  publish: (event) => {
    behaviour(event);
    return Promise.resolve();
  },
});

describe('outboxWriter', () => {
  it('writes nothing, and opens nothing, for an empty batch', async () => {
    const queries: string[] = [];
    const uow: TenantUnitOfWork = {
      query: <Row>(text: string): Promise<readonly Row[]> => {
        queries.push(text);
        return Promise.resolve([]);
      },
    };

    await outboxWriter.append(uow, []);

    expect(queries).toEqual([]);
  });

  it('inserts on conflict do nothing, so a retried unit of work does not double-publish', async () => {
    const queries: string[] = [];
    const uow: TenantUnitOfWork = {
      query: <Row>(text: string): Promise<readonly Row[]> => {
        queries.push(text);
        return Promise.resolve([]);
      },
    };

    await outboxWriter.append(uow, [
      {
        eventId: 'e1',
        tenantId: tenant.id,
        type: 'QuotaThresholdReached',
        occurredAt: '2026-08-23T14:00:00.000Z',
        payload: {},
        correlationId: 'c',
      },
    ]);

    expect(queries[0]).toContain('on conflict (event_id) do nothing');
  });
});

describe('OutboxPoller', () => {
  it('publishes every claimed event and marks it published', async () => {
    const outbox = new FakeOutbox([{}, {}]);
    const seen: string[] = [];
    const poller = new OutboxPoller({
      connections: outbox,
      logger: silent,
      publisher: publisherThat((e) => seen.push(e.eventId)),
    });

    const result = await poller.drainTenant(tenant);

    expect(result).toEqual({ claimed: 2, published: 2, failed: 0, abandoned: 0 });
    expect(seen).toHaveLength(2);
    expect(outbox.rows.every((row) => row.published_at !== null)).toBe(true);
  });

  it('claims nothing on a second pass, so an event is not published twice', async () => {
    const outbox = new FakeOutbox([{}]);
    const poller = new OutboxPoller({
      connections: outbox,
      logger: silent,
      publisher: publisherThat(() => undefined),
    });

    await poller.drainTenant(tenant);
    const second = await poller.drainTenant(tenant);

    expect(second.claimed).toBe(0);
  });

  it('leaves an event unpublished when the queue is unreachable', async () => {
    const outbox = new FakeOutbox([{}]);
    const poller = new OutboxPoller({
      connections: outbox,
      logger: silent,
      publisher: { publish: () => Promise.reject(new Error('queue unreachable')) },
    });

    const result = await poller.drainTenant(tenant);

    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    // The whole point: a failed publish must not look like a delivered one.
    expect(outbox.rows[0]?.published_at).toBeNull();
    expect(outbox.rows[0]?.last_error).toBe('queue unreachable');
  });

  it('publishes on a retry after the queue recovers', async () => {
    const outbox = new FakeOutbox([{}]);
    const failing = new OutboxPoller({
      connections: outbox,
      logger: silent,
      publisher: { publish: () => Promise.reject(new Error('queue unreachable')) },
    });
    await failing.drainTenant(tenant);

    const working = new OutboxPoller({
      connections: outbox,
      logger: silent,
      publisher: publisherThat(() => undefined),
    });
    const result = await working.drainTenant(tenant);

    expect(result.published).toBe(1);
  });

  it('parks an event that exhausted its attempt budget instead of retrying forever', async () => {
    const outbox = new FakeOutbox([{ attempts: 10 }]);
    const poller = new OutboxPoller({
      connections: outbox,
      logger: silent,
      maxAttempts: 10,
      publisher: { publish: () => Promise.reject(new Error('permanently broken')) },
    });

    const result = await poller.drainTenant(tenant);

    expect(result.abandoned).toBe(1);
    // Parked above the budget, so the next pass will not claim it.
    expect(outbox.rows[0]?.attempts).toBeGreaterThan(10);
  });

  it('parks an event whose envelope no longer satisfies the contract', async () => {
    // A code change altered the shape after this row was written. Retrying cannot fix
    // it, so spinning on it would only fill the log.
    const outbox = new FakeOutbox([{ type: 'AnEventTypeThatNoLongerExists' }]);
    const poller = new OutboxPoller({
      connections: outbox,
      logger: silent,
      publisher: publisherThat(() => {
        throw new Error('should never be called');
      }),
    });

    const result = await poller.drainTenant(tenant);

    expect(result).toMatchObject({ claimed: 1, published: 0, abandoned: 1 });
    expect(outbox.rows[0]?.last_error).toContain('not in the event catalogue');
  });

  it('does not hold a transaction open across the publish', async () => {
    // Network I/O inside a transaction pins a connection; one slow queue then takes the
    // dashboard down with it.
    const outbox = new FakeOutbox([{}]);
    let transactionsDuringPublish = -1;
    const poller = new OutboxPoller({
      connections: outbox,
      logger: silent,
      publisher: publisherThat(() => {
        transactionsDuringPublish = outbox.transactions;
      }),
    });

    await poller.drainTenant(tenant);

    // The claim transaction closed before publishing, and marking published opened a new
    // one afterwards.
    expect(transactionsDuringPublish).toBe(1);
    expect(outbox.transactions).toBe(2);
  });
});
