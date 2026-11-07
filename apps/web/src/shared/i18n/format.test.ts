import { describe, expect, it } from 'vitest';

import { formatCalendarDate, formatInstantAsDate } from './format.js';

/**
 * Dates, and the day they land on.
 *
 * America/Bogota is UTC-5 all year, with no daylight saving to blur the cases. Every one
 * of these is a real off-by-one that changes which day — and on a month boundary, which
 * month — a record belongs to.
 */

describe('rendering the date of an instant', () => {
  it('uses the company timezone, so an early-morning UTC timestamp is not tomorrow', () => {
    // 02:30 on the 25th in UTC is still the 24th in Bogotá.
    expect(formatInstantAsDate('2026-08-25T02:30:00.000Z', 'America/Bogota')).toContain('24');
  });

  it('does not shift a mid-day instant', () => {
    expect(formatInstantAsDate('2026-08-24T15:45:00.000Z', 'America/Bogota')).toContain('24');
  });
});

describe('rendering a calendar date', () => {
  it('renders the day as written, in any zone', () => {
    // The regression: `new Date('2026-08-24')` is UTC midnight, and rendering *that* in
    // Bogotá produced the 23rd — a date one day early on every screen.
    expect(formatCalendarDate('2026-08-24')).toContain('24');
  });

  it('keeps the first of the month on the first', () => {
    expect(formatCalendarDate('2026-09-01')).toContain('1');
    expect(formatCalendarDate('2026-09-01')).not.toContain('31');
  });
});
