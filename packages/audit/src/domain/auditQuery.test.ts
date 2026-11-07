import { describe, expect, it } from 'vitest';

import { ValidationError } from '@multitenant-base/shared-kernel';

import {
  assertActionFilter,
  AuditWindowTooWideError,
  boundedWindow,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
} from './auditQuery.js';

const NOW = new Date('2026-08-24T15:00:00.000Z');

describe('the window an audit query covers', () => {
  it('defaults to the last thirty days when the caller names none', () => {
    const window = boundedWindow({}, NOW);

    expect(window.to).toEqual(NOW);
    expect(window.from).toEqual(new Date('2026-07-25T15:00:00.000Z'));
    expect(Math.round((window.to.getTime() - window.from.getTime()) / 86_400_000)).toBe(
      DEFAULT_WINDOW_DAYS,
    );
  });

  it('ends at the caller’s instant when they name one', () => {
    const window = boundedWindow({ to: '2026-03-31T23:59:59.000Z' }, NOW);

    expect(window.to.toISOString()).toBe('2026-03-31T23:59:59.000Z');
  });

  it('accepts a whole fiscal year in one query', () => {
    const window = boundedWindow(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.000Z' },
      NOW,
    );

    expect(window.from.getUTCFullYear()).toBe(2026);
  });

  it('refuses a window wider than the maximum, naming both numbers', () => {
    try {
      boundedWindow({ from: '2020-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }, NOW);
      expect.unreachable('a six-year window should have been refused');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AuditWindowTooWideError);
      expect((error as AuditWindowTooWideError).maximumDays).toBe(MAX_WINDOW_DAYS);
      expect((error as AuditWindowTooWideError).requestedDays).toBeGreaterThan(MAX_WINDOW_DAYS);
    }
  });

  it('refuses a backwards window rather than swapping the ends', () => {
    // Swapping would answer a different question than the one asked, and the caller would
    // never learn their filter was wrong.
    expect(() =>
      boundedWindow({ from: '2026-08-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }, NOW),
    ).toThrow(ValidationError);
  });

  it('refuses an instant it cannot parse rather than silently defaulting', () => {
    expect(() => boundedWindow({ from: '01/08/2026' }, NOW)).toThrow(ValidationError);
  });
});

describe('the action filter', () => {
  it('accepts a whole action code', () => {
    expect(assertActionFilter('invoice.approved')).toBe('invoice.approved');
  });

  it('accepts a family prefix, which is how a reviewer asks for every sign-in attempt', () => {
    expect(assertActionFilter('authentication.')).toBe('authentication.');
  });

  it('refuses a wildcard, so a filter can never become a like pattern the caller did not write', () => {
    expect(() => assertActionFilter('authentication.%')).toThrow(ValidationError);
    expect(() => assertActionFilter('%')).toThrow(ValidationError);
  });

  it('refuses anything the action column could not hold anyway', () => {
    expect(() => assertActionFilter('Invoice.Approved')).toThrow(ValidationError);
    expect(() => assertActionFilter("x' or '1'='1")).toThrow(ValidationError);
  });
});
