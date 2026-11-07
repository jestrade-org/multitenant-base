import { describe, expect, it } from 'vitest';

import { createDomainEvent, DomainEventRecorder, type DomainEvent } from './domainEvent.js';
import { ConcurrencyConflictError, NotAuthorizedError, ValidationError } from './errors.js';
import { FixedClock, SequentialIdGenerator } from './ports.js';
import { allResults, err, isErr, isOk, mapResult, ok, partitionResults } from './result.js';

describe('Result', () => {
  it('carries a value on success and an error on failure', () => {
    expect(isOk(ok(42))).toBe(true);
    expect(isErr(err('nope'))).toBe(true);
  });

  it('maps a success and leaves a failure untouched', () => {
    expect(mapResult(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(mapResult(err<string>('boom'), (n: number) => n * 2)).toEqual(err('boom'));
  });

  it('collects successes, stopping at the first failure', () => {
    expect(allResults([ok(1), ok(2)])).toEqual(ok([1, 2]));
    expect(allResults([ok(1), err('bad'), err('worse')])).toEqual(err('bad'));
  });

  it('partitions so a caller can report every failure, not only the first', () => {
    const { values, errors } = partitionResults([ok(1), err('a'), ok(2), err('b')]);

    // A batch of invoice lines should report all four bad rows in one response.
    expect(values).toEqual([1, 2]);
    expect(errors).toEqual(['a', 'b']);
  });
});

describe('typed errors', () => {
  it('carries a stable code that the client maps to Spanish', () => {
    expect(new NotAuthorizedError('iam:role_manage').code).toBe('NOT_AUTHORIZED');
    expect(new ValidationError('taxId', 'check digit does not match').code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('carries params for client-side interpolation rather than a formatted sentence', () => {
    const error = new ConcurrencyConflictError('Invoice', 3, 5);

    expect(error.params).toEqual({ resourceType: 'Invoice', expectedVersion: 3, actualVersion: 5 });
  });

  it('is still an Error, so it survives a throw and a stack trace', () => {
    expect(new NotAuthorizedError('audit:read_all')).toBeInstanceOf(Error);
  });
});

describe('injected time and identity', () => {
  it('freezes time so a calculation sees one consistent now', () => {
    const clock = new FixedClock('2026-08-23T14:00:00.000Z');

    expect(clock.now().toISOString()).toBe('2026-08-23T14:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-08-23T14:00:00.000Z');
  });

  it('hands out a fresh Date each call, so a caller cannot advance everyone else clock', () => {
    const clock = new FixedClock('2026-08-23T14:00:00.000Z');
    const first = clock.now();
    first.setFullYear(1999);

    expect(clock.now().getFullYear()).toBe(2026);
  });

  it('refuses an invalid instant instead of producing an Invalid Date', () => {
    expect(() => new FixedClock('not-a-date')).toThrow(TypeError);
  });

  it('generates predictable ids for tests to assert on', () => {
    const ids = new SequentialIdGenerator('evt');

    expect([ids.next(), ids.next()]).toEqual(['evt-0001', 'evt-0002']);
  });
});

describe('domain events', () => {
  const deps = {
    clock: new FixedClock('2026-08-23T14:00:00.000Z'),
    ids: new SequentialIdGenerator('evt'),
  };

  it('fills the envelope from injected time and identity', () => {
    const event = createDomainEvent(deps, {
      tenantId: 'tenant-1',
      type: 'QuotaThresholdReached',
      payload: { quota: 'users' },
      correlationId: 'corr-1',
    });

    expect(event).toEqual({
      eventId: 'evt-0001',
      tenantId: 'tenant-1',
      type: 'QuotaThresholdReached',
      occurredAt: '2026-08-23T14:00:00.000Z',
      payload: { quota: 'users' },
      correlationId: 'corr-1',
    });
  });

  it('omits causationId rather than emitting an undefined field', () => {
    const event = createDomainEvent(deps, {
      tenantId: 'tenant-1',
      type: 'TenantProvisioned',
      payload: {},
      correlationId: 'corr-1',
    });

    expect('causationId' in event).toBe(false);
  });

  it('records the causing event so a chain can be traced back to its request', () => {
    const event = createDomainEvent(deps, {
      tenantId: 'tenant-1',
      type: 'DraftAdvisoryReady',
      payload: {},
      correlationId: 'corr-1',
      causationId: 'evt-0001',
    });

    expect(event.causationId).toBe('evt-0001');
  });
});

describe('DomainEventRecorder', () => {
  const event = (id: string): DomainEvent => ({
    eventId: id,
    tenantId: 't',
    type: 'Something',
    occurredAt: '2026-08-23T14:00:00.000Z',
    payload: {},
    correlationId: 'c',
  });

  it('holds events until the use case drains them after commit', () => {
    const recorder = new DomainEventRecorder();
    recorder.record(event('a'));
    recorder.record(event('b'));

    expect(recorder.pending).toBe(2);
    expect(recorder.drain().map((e) => e.eventId)).toEqual(['a', 'b']);
  });

  it('cannot be drained twice, so a retry does not re-publish', () => {
    const recorder = new DomainEventRecorder();
    recorder.record(event('a'));
    recorder.drain();

    expect(recorder.drain()).toEqual([]);
    expect(recorder.pending).toBe(0);
  });
});
