/**
 * The envelope every domain event travels in (§6).
 *
 * One shape for every context, because the audit index, the outbox and every consumer
 * read the same fields. Delivery is at-least-once, so `eventId` is the deduplication key
 * every consumer must honour — a consumer that is not idempotent is a consumer that will
 * double-send a message to a person.
 *
 * `causationId` is the event or command that produced this one; `correlationId` is the
 * request that started the whole chain. Together they turn "why did this client get that
 * message" from an investigation into a query.
 */

export interface DomainEvent<TPayload = unknown> {
  /** Unique per event. The deduplication key for at-least-once delivery. */
  readonly eventId: string;
  readonly tenantId: string;
  /** Past tense, versioned: `TenantProvisioned`, `QuotaThresholdReached`. */
  readonly type: string;
  readonly occurredAt: string;
  /** IDs and primitives only — never an entity reference, which would not survive the wire. */
  readonly payload: TPayload;
  /** What directly caused this event. */
  readonly causationId?: string | undefined;
  /** The request that started the chain, shared by every event in it. */
  readonly correlationId: string;
}

export interface NewDomainEvent<TPayload> {
  readonly tenantId: string;
  readonly type: string;
  readonly payload: TPayload;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
}

export interface DomainEventFactoryDeps {
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
}

/**
 * Builds an event with the envelope filled in.
 *
 * Time and identity come from injected ports, so an event stream is reproducible in a
 * test and a replay produces the same ids it did the first time.
 */
export function createDomainEvent<TPayload>(
  deps: DomainEventFactoryDeps,
  event: NewDomainEvent<TPayload>,
): DomainEvent<TPayload> {
  return {
    eventId: deps.ids.next(),
    tenantId: event.tenantId,
    type: event.type,
    occurredAt: deps.clock.now().toISOString(),
    payload: event.payload,
    correlationId: event.correlationId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
  };
}

/**
 * Records events an aggregate produced, for the use case to dispatch after commit.
 *
 * Publishing inside the aggregate would send an event for a transaction that then rolled
 * back — telling the world about something that did not happen.
 */
export class DomainEventRecorder {
  readonly #events: DomainEvent[] = [];

  public record(event: DomainEvent): void {
    this.#events.push(event);
  }

  /** Returns the events and clears them, so a second drain cannot re-publish. */
  public drain(): readonly DomainEvent[] {
    return this.#events.splice(0);
  }

  public get pending(): number {
    return this.#events.length;
  }
}
