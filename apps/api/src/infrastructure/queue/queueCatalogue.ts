import { EVENT_CATALOGUE, type EventType } from '@multitenant-base/shared-kernel';

/**
 * The logical queues, and which events feed them.
 *
 * Separate queues even though everything runs in one process on one database, because the
 * point of the separation is *priority*, not deployment: a burst of one kind of job must
 * not delay another. Splitting them later is then a configuration change rather than a
 * redesign.
 *
 * Retry policy per queue rather than one global default, because the failures differ. A
 * malformed payload will fail identically on every attempt; a provider timing out usually
 * will not. Retrying the first ten times only fills the log.
 *
 * A project built on this base adds its own queues here, each with its policy and the
 * events routed to it.
 */

export const QUEUE_NAMES = ['notifications', 'scheduled'] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueuePolicy {
  readonly name: QueueName;
  readonly describes: string;
  /** Attempts after the first. Exhausting them moves the job to the dead-letter queue. */
  readonly retryLimit: number;
  /** Seconds before the first retry; doubles from there when `retryBackoff` is on. */
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  /** Seconds a handler may run before the job is considered lost and retried. */
  readonly expireInSeconds: number;
}

/** Every queue has one, so `deadLetter` is never accidentally left unset. */
export function deadLetterQueue(queue: QueueName): string {
  return `${queue}--dead-letter`;
}

export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = {
  notifications: {
    name: 'notifications',
    describes: 'Delivers alerts and messages raised by domain events, such as quota warnings.',
    retryLimit: 6,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 120,
  },
  scheduled: {
    name: 'scheduled',
    describes: 'Recurring per-tenant jobs produced by the scheduler, such as quota checks.',
    retryLimit: 3,
    retryDelaySeconds: 120,
    retryBackoff: true,
    expireInSeconds: 300,
  },
};

/**
 * Which queues an event fans out to.
 *
 * An event may feed several queues: independent consumers react to the same fact on their
 * own. Chaining them instead — one consumer triggering the next — would couple contexts
 * that have no business knowing about each other, and a failure in one would silently
 * stop the other.
 */
export const EVENT_ROUTING: Readonly<Partial<Record<EventType, readonly QueueName[]>>> = {
  QuotaThresholdReached: ['notifications'],
  TenantProvisioned: [],
};

export function queuesForEvent(type: string): readonly QueueName[] {
  if (!Object.hasOwn(EVENT_CATALOGUE, type)) return [];
  return EVENT_ROUTING[type as EventType] ?? [];
}
