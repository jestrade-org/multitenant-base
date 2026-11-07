import type { Logger } from 'pino';

import {
  describeEnvelopeProblems,
  parseEventEnvelope,
  type DomainEvent,
} from '@multitenant-base/shared-kernel';
import type { ResolvedTenant } from '@multitenant-base/tenancy';

import type { TenantConnectionProvider, TenantUnitOfWork } from './tenantConnection.js';

/**
 * The transactional outbox (§6).
 *
 * Writing the event with the state change, and publishing from a separate poller, is what
 * removes the two failure modes of publishing inline. Both corrupt what a company sees:
 *
 *   - commit succeeds, publish fails → the follow-up work for a change never happens
 *   - publish succeeds, commit rolls back → someone is notified about a change that does
 *     not exist
 *
 * The cost is that delivery is at-least-once rather than exactly-once, which is a cost
 * the consumers pay by being idempotent (VC-41), not one the producer can avoid.
 */

/** Where the poller hands events once they are safely out of the outbox. */
export interface QueuePublisher {
  publish(event: DomainEvent): Promise<void>;
}

export interface OutboxWriter {
  /** Appends events inside the caller's transaction. Never opens one of its own. */
  append(uow: TenantUnitOfWork, events: readonly DomainEvent[]): Promise<void>;
}

export const outboxWriter: OutboxWriter = {
  async append(uow, events) {
    if (events.length === 0) return;

    for (const event of events) {
      // ON CONFLICT DO NOTHING makes a retried unit of work idempotent: the producer
      // reuses the same event_id, so replaying the transaction does not mint a second
      // event for one business fact.
      await uow.query(
        `insert into outbox_events
           (event_id, tenant_id, type, occurred_at, payload, correlation_id, causation_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (event_id) do nothing`,
        [
          event.eventId,
          event.tenantId,
          event.type,
          event.occurredAt,
          JSON.stringify(event.payload),
          event.correlationId,
          event.causationId ?? null,
        ],
      );
    }
  },
};

interface OutboxRow {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly type: string;
  readonly occurred_at: Date;
  readonly payload: unknown;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly attempts: number;
}

export interface OutboxPollerOptions {
  readonly connections: TenantConnectionProvider;
  readonly publisher: QueuePublisher;
  readonly logger: Logger;
  /** Rows claimed per tenant per pass. Bounded so one busy tenant cannot starve the rest. */
  readonly batchSize?: number;
  /** A claim older than this is assumed abandoned by a crashed poller and retried. */
  readonly claimTimeoutMs?: number;
  /** After this many failures an event is left for a human rather than retried forever. */
  readonly maxAttempts?: number;
}

export interface DrainResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly abandoned: number;
}

export class OutboxPoller {
  readonly #connections: TenantConnectionProvider;
  readonly #publisher: QueuePublisher;
  readonly #logger: Logger;
  readonly #batchSize: number;
  readonly #claimTimeoutMs: number;
  readonly #maxAttempts: number;

  public constructor(options: OutboxPollerOptions) {
    this.#connections = options.connections;
    this.#publisher = options.publisher;
    this.#logger = options.logger;
    this.#batchSize = options.batchSize ?? 100;
    this.#claimTimeoutMs = options.claimTimeoutMs ?? 60_000;
    this.#maxAttempts = options.maxAttempts ?? 10;
  }

  /**
   * Drains one batch for one tenant.
   *
   * Claiming and publishing are deliberately in separate transactions. Holding the
   * transaction open across the publish would mean network I/O inside a transaction —
   * one slow queue and the tenant's connection is pinned, which is how a background job
   * takes down the dashboard.
   */
  public async drainTenant(tenant: ResolvedTenant): Promise<DrainResult> {
    const rows = await this.#claim(tenant);
    let published = 0;
    let failed = 0;
    let abandoned = 0;

    for (const row of rows) {
      const parsed = parseEventEnvelope({
        eventId: row.event_id,
        tenantId: row.tenant_id,
        type: row.type,
        occurredAt: row.occurred_at.toISOString(),
        payload: row.payload,
        correlationId: row.correlation_id,
        ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
      });

      if (!parsed.ok) {
        // Unparseable after it was already written: a code change altered the contract.
        // Retrying will not fix it, so park it for a human rather than spin.
        abandoned += 1;
        await this.#park(tenant, row.event_id, describeEnvelopeProblems(parsed.error));
        this.#logger.error(
          { tenant: tenant.id, eventId: row.event_id, type: row.type },
          'outbox event does not satisfy the envelope contract; parked',
        );
        continue;
      }

      try {
        await this.#publisher.publish(parsed.value);
        await this.#markPublished(tenant, row.event_id);
        published += 1;
      } catch (error: unknown) {
        failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        if (row.attempts >= this.#maxAttempts) {
          abandoned += 1;
          await this.#park(tenant, row.event_id, reason);
          this.#logger.error(
            { tenant: tenant.id, eventId: row.event_id, attempts: row.attempts },
            'outbox event exceeded its attempt budget; parked for review',
          );
        } else {
          await this.#release(tenant, row.event_id, reason);
        }
      }
    }

    return { claimed: rows.length, published, failed, abandoned };
  }

  async #claim(tenant: ResolvedTenant): Promise<readonly OutboxRow[]> {
    return this.#connections.withTenant(tenant, async (uow) => {
      // FOR UPDATE SKIP LOCKED is what lets a second poller work the same tenant without
      // waiting on the first, and without two of them claiming the same row.
      return uow.query<OutboxRow>(
        `update outbox_events
            set claimed_at = now(), attempts = attempts + 1
          where event_id in (
            select event_id from outbox_events
             where published_at is null
               and attempts < $2
               and (claimed_at is null or claimed_at < now() - ($3 || ' milliseconds')::interval)
             order by occurred_at
             limit $1
             for update skip locked
          )
        returning event_id, tenant_id, type, occurred_at, payload, correlation_id,
                  causation_id, attempts`,
        [this.#batchSize, this.#maxAttempts + 1, String(this.#claimTimeoutMs)],
      );
    });
  }

  async #markPublished(tenant: ResolvedTenant, eventId: string): Promise<void> {
    await this.#connections.withTenant(tenant, async (uow) => {
      await uow.query(
        `update outbox_events
            set published_at = now(), claimed_at = null, last_error = null
          where event_id = $1`,
        [eventId],
      );
    });
  }

  async #release(tenant: ResolvedTenant, eventId: string, reason: string): Promise<void> {
    await this.#connections.withTenant(tenant, async (uow) => {
      // Truncated: last_error is operational context, not a place to accumulate a
      // provider's stack trace, which can carry request bodies.
      await uow.query(
        'update outbox_events set claimed_at = null, last_error = left($2, 500) where event_id = $1',
        [eventId, reason],
      );
    });
  }

  /** Leaves the claim in place so the row stops being picked up, and records why. */
  async #park(tenant: ResolvedTenant, eventId: string, reason: string): Promise<void> {
    await this.#connections.withTenant(tenant, async (uow) => {
      await uow.query(
        `update outbox_events
            set attempts = greatest(attempts, $3), last_error = left($2, 500), claimed_at = now()
          where event_id = $1`,
        [eventId, reason, this.#maxAttempts + 1],
      );
    });
  }
}
