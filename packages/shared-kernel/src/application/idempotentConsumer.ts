import type { Clock } from '../domain/ports.js';

/**
 * Exactly-once *effect* on top of at-least-once delivery (§6, VC-41).
 *
 * The queue will hand the same event to a consumer twice — after a crash between handling
 * and acknowledging, after a visibility timeout, after an operator replays a dead letter.
 * That is a property of any durable transport, not a defect to be fixed inside it.
 *
 * So the consumer is the place that has to be safe, and "safe" has a precise meaning here:
 * the mark that says "I handled this" commits in the same transaction as the handling. A
 * mark written afterwards leaves a window in which the work committed and the mark did
 * not — which is the crash that sends a second collection notice to a client who already
 * paid.
 */

export interface ProcessedEventLedger {
  /**
   * Claims the event for this consumer.
   *
   * Returns false when it was already claimed. Implemented as an insert with `on conflict
   * do nothing`, so two workers racing on the same event resolve in the database rather
   * than in a check-then-act that both pass.
   */
  claim(input: {
    readonly consumer: string;
    readonly eventId: string;
    readonly eventType: string;
  }): Promise<boolean>;
}

export interface ConsumedEvent {
  readonly eventId: string;
  readonly type: string;
}

/**
 * Wraps a handler so it cannot run twice for the same event.
 *
 * The handler is unreachable except through the returned function, for the same reason the
 * authorization requirement is unavoidable: a consumer that has to remember to check is a
 * consumer that will forget on the day someone adds the fifth one.
 */
export function idempotentConsumer<Event extends ConsumedEvent>(input: {
  readonly consumer: string;
  readonly ledger: ProcessedEventLedger;
  readonly handle: (event: Event) => Promise<void>;
  /** Called when an event is skipped, so a redelivery storm is visible rather than silent. */
  readonly onDuplicate?: (event: Event) => void;
}): (event: Event) => Promise<void> {
  return async (event) => {
    const claimed = await input.ledger.claim({
      consumer: input.consumer,
      eventId: event.eventId,
      eventType: event.type,
    });

    if (!claimed) {
      input.onDuplicate?.(event);
      return;
    }

    await input.handle(event);
  };
}

/**
 * Suppression of *equivalent* events (RF-43).
 *
 * Distinct from the ledger above, and the distinction matters. The ledger answers "have I
 * already handled this exact event". This answers "have I already told someone this exact
 * thing recently" — a cash shortfall recomputed every hour is a new event each time and
 * the same sentence to a human being.
 *
 * Twenty identical warnings in one morning is how a person learns to ignore all of them,
 * including the one that mattered. Alert fatigue is not a UX complaint; it is the
 * mechanism by which monitoring stops working.
 */
export interface SuppressionWindow {
  /**
   * Records that this thing is being said at `at`.
   *
   * Returns true when it should be said — the first time, or after the window expired.
   * Returns false when an equivalent has already gone out and the window is still open.
   *
   * `at` is passed rather than read from the store's own clock, and that is the point: a
   * window opened by one clock and judged expired by another is a window of unknown
   * length. One clock decides, and it is the injected one, so the behaviour is the same in
   * a test as in production.
   */
  shouldEmit(key: string, at: Date, expiresAt: Date): Promise<boolean>;
}

export interface DeduplicatedAlert<Alert> {
  /** What makes two alerts "the same thing". Never includes a timestamp or an event id. */
  readonly key: (alert: Alert) => string;
  readonly windowMs: number;
}

export function deduplicatingEmitter<Alert>(input: {
  readonly window: SuppressionWindow;
  readonly clock: Clock;
  readonly rule: DeduplicatedAlert<Alert>;
  readonly emit: (alert: Alert) => Promise<void>;
  readonly onSuppressed?: (alert: Alert) => void;
}): (alert: Alert) => Promise<void> {
  return async (alert) => {
    const at = input.clock.now();
    const expiresAt = new Date(at.getTime() + input.rule.windowMs);
    const shouldEmit = await input.window.shouldEmit(input.rule.key(alert), at, expiresAt);

    if (!shouldEmit) {
      input.onSuppressed?.(alert);
      return;
    }

    await input.emit(alert);
  };
}
