import { describe, expect, it } from 'vitest';

import { createDomainEvent } from './domainEvent.js';
import { EVENT_CATALOGUE, EVENT_TYPES, isKnownEventType } from './eventCatalogue.js';
import { describeEnvelopeProblems, parseEventEnvelope } from './eventEnvelope.js';
import { FixedClock } from './ports.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT,
    tenantId: TENANT,
    type: 'QuotaThresholdReached',
    occurredAt: '2026-08-23T14:00:00.000Z',
    payload: { quota: 'users' },
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('event catalogue', () => {
  it.each(['TenantProvisioned', 'QuotaThresholdReached'])('declares %s', (type) => {
    expect(isKnownEventType(type)).toBe(true);
  });

  it('names every event in the past tense, because an event is a fact', () => {
    // A present-tense name is a command in disguise, and a command can be refused —
    // which is exactly what a consumer of an event must never try to do.
    const presentTense = EVENT_TYPES.filter((type) => !/(ed|Ready)$/.test(type));

    expect(presentTense).toEqual([]);
  });

  it('versions every event, so a payload can change without renaming the event', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_CATALOGUE[type].version).toBeGreaterThanOrEqual(1);
    }
  });

  it('names exactly one producing context per event', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_CATALOGUE[type].producedBy).toBeTruthy();
    }
  });

  it('rejects a type that is not in the catalogue', () => {
    expect(isKnownEventType('TenantProvisiond')).toBe(false);
    expect(isKnownEventType('InvoicePaid')).toBe(false);
  });
});

describe('parseEventEnvelope', () => {
  it('accepts an event this system produced', () => {
    const produced = createDomainEvent(
      { clock: new FixedClock('2026-08-23T14:00:00.000Z'), ids: { next: () => EVENT } },
      {
        tenantId: TENANT,
        type: 'QuotaThresholdReached',
        payload: { quota: 'users' },
        correlationId: 'corr-1',
      },
    );

    // Producer and consumer share one contract: whatever we write, we can read back.
    const result = parseEventEnvelope(JSON.parse(JSON.stringify(produced)));

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.type).toBe('QuotaThresholdReached');
  });

  it('accepts an optional causationId', () => {
    const result = parseEventEnvelope(envelope({ causationId: 'evt-0001' }));

    expect(result.ok && result.value.causationId).toBe('evt-0001');
  });

  it('omits causationId rather than carrying null through', () => {
    const result = parseEventEnvelope(envelope({ causationId: null }));

    expect(result.ok && 'causationId' in result.value).toBe(false);
  });

  it.each([
    ['eventId', 'missing'],
    ['tenantId', 'missing'],
    ['type', 'missing'],
    ['occurredAt', 'missing'],
    ['payload', 'missing'],
    ['correlationId', 'missing'],
  ])('rejects an envelope with no %s', (field) => {
    // Rebuilt without the field rather than deleted from a copy: a dynamic delete leaves
    // the key present-but-undefined on some shapes, which is a different test.
    const broken = Object.fromEntries(Object.entries(envelope()).filter(([key]) => key !== field));

    const result = parseEventEnvelope(broken);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.some((p) => p.field === field)).toBe(true);
  });

  it('reports every problem at once, not one per redeploy', () => {
    const result = parseEventEnvelope({ type: 'QuotaThresholdReached' });

    expect(!result.ok && result.error.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects a non-uuid tenantId, which would reach a query as a cast error', () => {
    const result = parseEventEnvelope(envelope({ tenantId: 'acme' }));

    expect(!result.ok && result.error[0]?.reason).toBe('malformed');
  });

  it('rejects a timestamp that is not an ISO instant in UTC', () => {
    const result = parseEventEnvelope(envelope({ occurredAt: '23/08/2026' }));

    expect(result.ok).toBe(false);
  });

  it('rejects a local-time timestamp: occurredAt is always UTC', () => {
    const result = parseEventEnvelope(envelope({ occurredAt: '2026-08-23T09:00:00-05:00' }));

    expect(result.ok).toBe(false);
  });

  it('flags an event type this build does not know, so a consumer can park it', () => {
    // Legitimate during a rolling deploy: a newer instance publishes something this one
    // has never heard of. Parking beats crashing, and beats silently dropping.
    const result = parseEventEnvelope(envelope({ type: 'SomethingFromTheFuture' }));

    expect(result.ok).toBe(false);
    expect(!result.ok && describeEnvelopeProblems(result.error)).toContain(
      'not in the event catalogue',
    );
  });

  it.each([
    ['a string', '"not an event"'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '42'],
  ])('rejects %s rather than assuming an object', (_name, json) => {
    expect(parseEventEnvelope(JSON.parse(json)).ok).toBe(false);
  });

  it('rejects a payload that is not an object', () => {
    expect(parseEventEnvelope(envelope({ payload: 'text' })).ok).toBe(false);
    expect(parseEventEnvelope(envelope({ payload: [] })).ok).toBe(false);
  });

  it('summarises problems without echoing the payload, which can carry debtor data', () => {
    const result = parseEventEnvelope(
      envelope({ eventId: undefined, payload: { debtorName: 'Juan Perez' } }),
    );

    const summary = !result.ok ? describeEnvelopeProblems(result.error) : '';
    expect(summary).toContain('eventId is missing');
    expect(summary).not.toContain('Juan Perez');
  });
});
