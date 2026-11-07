/**
 * Every domain event the system publishes, in one place.
 *
 * A registry, not a convenience. The outbox, the audit index and every consumer read
 * events they did not produce, so the set of names has to be a shared contract rather
 * than a string each producer types. A typo in `TenantProvisioned` at the producer is
 * an event nobody consumes and nobody notices — the queue drains, the job succeeds, and
 * the work that should have followed simply never happens.
 *
 * Names are past tense, because an event is a fact that already happened. Renaming one
 * is a breaking change for every consumer and for the audit history already recorded
 * under the old name; adding a field to a payload is not, which is why the version is
 * carried separately.
 *
 * Ref: Tech specs §3.2, §6.
 */

export type BoundedContext = 'tenancy' | 'iam' | 'integrations' | 'audit';

export interface EventDefinition {
  /** Past tense. Part of the wire contract. */
  readonly type: string;
  /** Bumped when a payload changes in a way a consumer cannot ignore. */
  readonly version: number;
  /** The context that publishes it. Only that context may. */
  readonly producedBy: BoundedContext;
  readonly describes: string;
}

/**
 * The base platform events. A project built on this base declares its own here, with the
 * context that produces them.
 */
export const EVENT_CATALOGUE = {
  TenantProvisioned: {
    type: 'TenantProvisioned',
    version: 1,
    producedBy: 'tenancy',
    describes: 'A company tenant has a schema, a storage root and a first administrator.',
  },
  QuotaThresholdReached: {
    type: 'QuotaThresholdReached',
    version: 1,
    producedBy: 'tenancy',
    describes: 'A tenant passed 90% of a plan quota. The service is never degraded silently.',
  },
} as const satisfies Record<string, EventDefinition>;

export type EventType = keyof typeof EVENT_CATALOGUE;

export const EVENT_TYPES = Object.keys(EVENT_CATALOGUE) as readonly EventType[];

export function isKnownEventType(type: string): type is EventType {
  return Object.hasOwn(EVENT_CATALOGUE, type);
}

export function eventDefinition(type: EventType): EventDefinition {
  return EVENT_CATALOGUE[type];
}
