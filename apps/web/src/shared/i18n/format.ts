/**
 * Formatting at the edge, with Intl. Never by hand.
 *
 * Hardcoding `.` and `,` or a `DD/MM/YYYY` pattern is how a reader is shown a figure in
 * the wrong grouping and misreads it by three orders of magnitude.
 *
 * The UI is Spanish; a project serving one country narrows this to its regional locale
 * (`es-CO`, `es-MX`, `es-ES`) so grouping and date order match what its users expect.
 */

const LOCALE = 'es';

/**
 * The timezone platform screens render in.
 *
 * Platform staff belong to no company, so there is no company timezone to borrow. UTC is
 * the one zone every log line, audit row and support conversation can agree on.
 */
export const PLATFORM_TIMEZONE = 'UTC';

/**
 * Formats a money amount that arrived as a string.
 *
 * The string is passed straight to Intl rather than through `Number`. Intl accepts a
 * decimal string and formats it exactly; going via a double reintroduces, at the very
 * last step, the precision loss that the whole `Money` type exists to avoid.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['COP', 'CLP', 'JPY', 'KRW']);

export function formatMoney(amount: string, currency: string): string {
  const formatter = new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    // Currencies quoted in whole units (COP, JPY…) show none; the four decimals the amount
    // carries are for arithmetic, not for a person.
    maximumFractionDigits: ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2,
  });

  // Intl.NumberFormat V3 accepts a string and avoids the double entirely. Older engines
  // do not, and a wrong number on screen is worse than an unformatted one, so the
  // fallback is explicit rather than silent.
  try {
    return formatter.format(amount as unknown as number);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * A timestamp, rendered in the company's timezone.
 *
 * Not the browser's. A person travelling sees the same day boundaries as the company
 * does, because an off-by-one day moves a record into the wrong day or month.
 */
export function formatDateTime(isoInstant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(isoInstant));
}

/**
 * The date part of a timestamp, in the company's timezone.
 *
 * Takes the whole instant on purpose. Slicing an ISO string to `YYYY-MM-DD` first and
 * formatting *that* shifts the result a day backwards for any timezone west of UTC — in
 * UTC-5, everything created before 05:00 local would be dated the day before.
 */
export function formatInstantAsDate(isoInstant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone }).format(
    new Date(isoInstant),
  );
}

/**
 * A calendar date — a due date, a month boundary — rendered as written.
 *
 * A calendar date is not an instant: the 15th of the month is the 15th everywhere, and
 * converting it to one timezone or another is what produces a deadline that falls the day
 * before it was set. So it is formatted in UTC, which is the zone it was built in.
 */
export function formatCalendarDate(isoDate: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${isoDate}T00:00:00.000Z`),
  );
}
