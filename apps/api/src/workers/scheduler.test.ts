import { describe, expect, it } from 'vitest';

import { calendarDayIn, isoWeekdayIn, SCHEDULED_JOBS } from './scheduler.js';

/**
 * The scheduler's calendar arithmetic, which is where the bugs live.
 *
 * Every case here is a real instant in Bogotá that falls on a different day in UTC. A
 * scheduler that computes its slot from the server's clock sends Monday's reminder on
 * Sunday evening — and, worse for this product, files a month-end job in the wrong
 * accounting period.
 */

const BOGOTA = 'America/Bogota';

function jobNamed(name: string) {
  const job = SCHEDULED_JOBS.find((candidate) => candidate.name === name);
  if (job === undefined) throw new Error(`no scheduled job named ${name}`);
  return job;
}

describe('the tenant calendar', () => {
  it.each([
    // 00:30 UTC on the 24th is still the evening of the 23rd in Bogotá (UTC-5).
    ['2026-08-24T00:30:00.000Z', '2026-08-23'],
    ['2026-08-24T04:59:59.000Z', '2026-08-23'],
    ['2026-08-24T05:00:00.000Z', '2026-08-24'],
    // Month end: the instant that decides which accounting period a job belongs to.
    ['2026-09-01T02:00:00.000Z', '2026-08-31'],
    // Leap day, which exists in 2028.
    ['2028-02-29T18:00:00.000Z', '2028-02-29'],
  ])('resolves %s to %s in Bogotá', (instant, expected) => {
    expect(calendarDayIn(new Date(instant), BOGOTA)).toBe(expected);
  });

  it('differs from the server day exactly when the offset says it should', () => {
    const instant = new Date('2026-08-24T03:00:00.000Z');

    expect(calendarDayIn(instant, BOGOTA)).toBe('2026-08-23');
    expect(calendarDayIn(instant, 'UTC')).toBe('2026-08-24');
  });

  it.each([
    ['2026-08-24T12:00:00.000Z', 1],
    ['2026-08-28T12:00:00.000Z', 5],
    ['2026-08-29T12:00:00.000Z', 6],
    ['2026-08-30T12:00:00.000Z', 7],
    // Sunday 19:00 in Bogotá is Monday 00:00 UTC. The tenant's week is what counts.
    ['2026-08-31T00:00:00.000Z', 7],
  ])('resolves %s to ISO weekday %i in Bogotá', (instant, expected) => {
    expect(isoWeekdayIn(new Date(instant), BOGOTA)).toBe(expected);
  });
});

describe('when each job is due', () => {
  it('gives the same slot for two ticks inside one tenant day', () => {
    const job = jobNamed('plan-quota-verification');

    // This is what makes a restart, a duplicated instance and a clock stepping backwards
    // all produce one job rather than three.
    const morning = job.slotFor(new Date('2026-08-24T13:00:00.000Z'), BOGOTA);
    const evening = job.slotFor(new Date('2026-08-24T22:00:00.000Z'), BOGOTA);

    expect(morning).toBe(evening);
    expect(morning).toBe('2026-08-24');
  });

  it('gives different slots on consecutive tenant days', () => {
    const job = jobNamed('plan-quota-verification');

    expect(job.slotFor(new Date('2026-08-24T22:00:00.000Z'), BOGOTA)).toBe('2026-08-24');
    expect(job.slotFor(new Date('2026-08-25T22:00:00.000Z'), BOGOTA)).toBe('2026-08-25');
  });

  it('reads the weekday in the tenant timezone, not the server one', () => {
    // Saturday 02:00 UTC is still Friday evening in Bogotá: a weekday-only job is due.
    const instant = new Date('2026-08-29T02:00:00.000Z');

    expect([isoWeekdayIn(instant, BOGOTA), isoWeekdayIn(instant, 'UTC')]).toEqual([5, 6]);
  });

  it('verifies quotas every day, including weekends', () => {
    const job = jobNamed('plan-quota-verification');

    expect(job.slotFor(new Date('2026-08-30T15:00:00.000Z'), BOGOTA)).toBe('2026-08-30');
  });
});
