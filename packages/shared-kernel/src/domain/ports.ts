/**
 * The two things the domain is not allowed to reach for itself.
 *
 * `Date.now()` and `Math.random()` are banned in domain/ by the architecture lint, and
 * these are what replace them. That is not purism: a cash flow projection that reads the
 * system clock cannot be re-run to reproduce what a client was shown last Tuesday, and a
 * period boundary computed from the server's clock instead of the company's timezone
 * moves revenue between accounting periods.
 */

/** Time, injected. Always UTC; the company's timezone is applied at the edges. */
export interface Clock {
  now(): Date;
}

/** Identity, injected. Never `Math.random()`, which is not safe for anything. */
export interface IdGenerator {
  next(): string;
}

/**
 * A clock frozen at one instant, for tests and for a calculation that must see a single
 * consistent "now" across many steps.
 */
export class FixedClock implements Clock {
  readonly #instant: Date;

  public constructor(instant: Date | string) {
    this.#instant = typeof instant === 'string' ? new Date(instant) : instant;
    if (Number.isNaN(this.#instant.getTime())) {
      throw new TypeError(`FixedClock was given an invalid instant: ${String(instant)}`);
    }
  }

  public now(): Date {
    // A new Date each call: handing out the same mutable instance lets a caller advance
    // everyone else's clock by accident.
    return new Date(this.#instant.getTime());
  }
}

/** Predictable ids, for tests that assert on them. */
export class SequentialIdGenerator implements IdGenerator {
  #counter = 0;
  readonly #prefix: string;

  public constructor(prefix = 'id') {
    this.#prefix = prefix;
  }

  public next(): string {
    this.#counter += 1;
    return `${this.#prefix}-${String(this.#counter).padStart(4, '0')}`;
  }
}
