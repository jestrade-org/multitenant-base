import { describe, expect, it } from 'vitest';

import { EVENT_TYPES } from '@multitenant-base/shared-kernel';

import {
  deadLetterQueue,
  EVENT_ROUTING,
  QUEUE_NAMES,
  QUEUE_POLICIES,
  queuesForEvent,
} from './queueCatalogue.js';

describe('queue catalogue', () => {
  it('declares the base logical queues', () => {
    expect([...QUEUE_NAMES]).toEqual(['notifications', 'scheduled']);
  });

  it('gives every queue a retry policy, so none silently inherits a default', () => {
    for (const name of QUEUE_NAMES) {
      const policy = QUEUE_POLICIES[name];
      expect(policy.retryLimit).toBeGreaterThan(0);
      expect(policy.retryDelaySeconds).toBeGreaterThan(0);
      expect(policy.expireInSeconds).toBeGreaterThan(0);
      expect(policy.retryBackoff).toBe(true);
    }
  });

  it('gives every queue a dead-letter queue', () => {
    for (const name of QUEUE_NAMES) {
      expect(deadLetterQueue(name)).toBe(`${name}--dead-letter`);
    }
  });
});

describe('event routing', () => {
  it('routes every event in the catalogue, even if the route is empty', () => {
    for (const type of EVENT_TYPES) {
      expect(Object.hasOwn(EVENT_ROUTING, type)).toBe(true);
    }
  });

  it('sends a quota warning to notifications', () => {
    expect(queuesForEvent('QuotaThresholdReached')).toEqual(['notifications']);
  });

  it('routes an unknown event nowhere instead of guessing', () => {
    expect(queuesForEvent('SomethingFromTheFuture')).toEqual([]);
  });

  it('only ever names queues that exist', () => {
    for (const type of EVENT_TYPES) {
      for (const queue of queuesForEvent(type)) {
        expect(QUEUE_NAMES).toContain(queue);
      }
    }
  });
});
