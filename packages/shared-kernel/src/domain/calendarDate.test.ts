import { describe, expect, it } from 'vitest';

import { CalendarDate } from './calendarDate.js';
import { ValidationError } from './errors.js';

describe('constructing a calendar date', () => {
  it.each([
    [2026, 2, 29],
    [2026, 4, 31],
    [2026, 13, 1],
    [2026, 1, 0],
  ])('rejects %i-%i-%i rather than rolling it over', (year, month, day) => {
    // `new Date(2026, 1, 29)` silently becomes 1 March. A due date that moved on its own
    // is a due date nobody can audit.
    expect(() => CalendarDate.of(year, month, day)).toThrow(ValidationError);
  });

  it('accepts 29 February in a leap year', () => {
    expect(CalendarDate.of(2028, 2, 29).toString()).toBe('2028-02-29');
  });

  it.each([['2026-8-5'], ['26-08-05'], ['2026/08/05'], ['2026-08-05T00:00:00Z']])(
    'refuses to parse %s',
    (value) => {
      expect(() => CalendarDate.parse(value)).toThrow(ValidationError);
    },
  );
});

describe('the date an instant falls on', () => {
  it.each([
    ['2026-09-01T02:00:00.000Z', 'America/Bogota', '2026-08-31'],
    ['2026-09-01T02:00:00.000Z', 'UTC', '2026-09-01'],
    ['2026-09-01T05:00:00.000Z', 'America/Bogota', '2026-09-01'],
  ])('places %s in %s on %s', (instant, timezone, expected) => {
    // A payment received at 21:00 on the 31st in Bogotá belongs to the 31st, not the 1st.
    expect(CalendarDate.inTimezone(new Date(instant), timezone).toString()).toBe(expected);
  });
});

describe('date arithmetic', () => {
  it.each([
    ['2026-08-30', 1, '2026-08-31'],
    ['2026-08-31', 1, '2026-09-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-08-15', 30, '2026-09-14'],
  ])('%s plus %i days is %s', (from, days, expected) => {
    expect(CalendarDate.parse(from).plusDays(days).toString()).toBe(expected);
  });

  it.each([
    ['2026-08-01', '2026-08-31', 30],
    ['2026-08-31', '2026-09-01', 1],
    ['2026-01-01', '2027-01-01', 365],
    ['2028-01-01', '2029-01-01', 366],
    ['2026-09-01', '2026-08-01', -31],
    ['2026-08-15', '2026-08-15', 0],
  ])('counts %s to %s as %i days', (from, to, expected) => {
    expect(CalendarDate.parse(from).daysUntil(CalendarDate.parse(to))).toBe(expected);
  });

  it('orders dates across a year boundary', () => {
    expect(CalendarDate.parse('2025-12-31').isBefore(CalendarDate.parse('2026-01-01'))).toBe(true);
    expect(CalendarDate.parse('2026-01-01').isAfter(CalendarDate.parse('2025-12-31'))).toBe(true);
    expect(CalendarDate.parse('2026-08-05').equals(CalendarDate.of(2026, 8, 5))).toBe(true);
  });

  it('reports the calendar month it belongs to', () => {
    expect(CalendarDate.parse('2026-08-31').monthOf()).toBe('2026-08');
  });
});
