import { ValidationError } from './errors.js';

/**
 * A date on a calendar — no time, no offset.
 *
 * A deadline is *on the 15th*, not at an instant. Modelling that as a `Date` means
 * carrying a time nobody chose and a zone nobody meant, and then comparing it to another
 * one: `dueOn < now` is off by up to a day depending on where the server is, and a day is
 * the difference between on time and late — a fact someone will act on.
 *
 * Held as three integers rather than a string so comparison and arithmetic are total, and
 * so `2026-8-5` cannot exist alongside `2026-08-05`.
 */
export class CalendarDate {
  readonly #year: number;
  readonly #month: number;
  readonly #day: number;

  private constructor(year: number, month: number, day: number) {
    this.#year = year;
    this.#month = month;
    this.#day = day;
  }

  public static of(year: number, month: number, day: number): CalendarDate {
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw new ValidationError('year', 'must be between 1900 and 2200');
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new ValidationError('month', 'must be between 1 and 12');
    }
    if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
      // Rejects 31 February rather than rolling it into March, which is what `new Date`
      // does silently — and a due date that silently moved is a due date nobody can audit.
      throw new ValidationError(
        'day',
        `must be between 1 and ${String(daysInMonth(year, month))} for ${String(year)}-${String(month)}`,
      );
    }
    return new CalendarDate(year, month, day);
  }

  /** Parses the canonical `YYYY-MM-DD`. Strict: a lenient parser accepts `2026-8-5` today and `08/05/2026` tomorrow. */
  public static parse(value: string): CalendarDate {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (match === null) {
      throw new ValidationError('date', 'must be written as YYYY-MM-DD');
    }
    return CalendarDate.of(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  /**
   * The calendar date an instant falls on, in a named timezone.
   *
   * The timezone is required. "Today" is a question that cannot be answered without one,
   * and answering it with the server's zone is how a payment received on the 31st gets
   * recorded on the 1st.
   */
  public static inTimezone(instant: Date, timezone: string): CalendarDate {
    // `en-CA` gives ISO-ordered parts; that is the only reason for the locale.
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
    return CalendarDate.parse(formatted);
  }

  public get year(): number {
    return this.#year;
  }

  public get month(): number {
    return this.#month;
  }

  public get day(): number {
    return this.#day;
  }

  /** Days since the Unix epoch. Computed in UTC purely as a stable counting frame. */
  get #epochDay(): number {
    return Math.floor(Date.UTC(this.#year, this.#month - 1, this.#day) / 86_400_000);
  }

  public plusDays(days: number): CalendarDate {
    if (!Number.isInteger(days)) {
      throw new ValidationError('days', 'must be a whole number of days');
    }
    const shifted = new Date((this.#epochDay + days) * 86_400_000);
    return CalendarDate.of(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate(),
    );
  }

  /** Whole days from this date to another. Negative when the other is earlier. */
  public daysUntil(other: CalendarDate): number {
    return other.#epochDay - this.#epochDay;
  }

  public isBefore(other: CalendarDate): boolean {
    return this.#epochDay < other.#epochDay;
  }

  public isAfter(other: CalendarDate): boolean {
    return this.#epochDay > other.#epochDay;
  }

  public equals(other: CalendarDate): boolean {
    return this.#epochDay === other.#epochDay;
  }

  /** The calendar month it belongs to, as `YYYY-MM`. */
  public monthOf(): string {
    return `${String(this.#year)}-${String(this.#month).padStart(2, '0')}`;
  }

  public toString(): string {
    return `${String(this.#year)}-${String(this.#month).padStart(2, '0')}-${String(this.#day).padStart(2, '0')}`;
  }
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
