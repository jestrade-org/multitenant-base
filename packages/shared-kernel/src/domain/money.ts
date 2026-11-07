import { currencyOf, type Currency, type CurrencyCode } from './currency.js';

/**
 * An amount of money.
 *
 * Held as a `bigint` count of ten-thousandths of a unit — the same scale as the
 * `numeric(19,4)` columns it is stored in — so arithmetic is exact. A `number` is an
 * IEEE-754 double: `0.1 + 0.2 !== 0.3`, and a receivables ledger built on that will not
 * reconcile. There is deliberately no constructor taking a `number`.
 *
 * Three rules this type enforces rather than documents:
 *   - mixing currencies throws; there is no implicit conversion
 *   - division goes through `allocate`, which distributes remainders so the parts always
 *     sum back to the whole
 *   - rounding is explicit at the call site, never a default
 *
 * Ref: financial-domain.md; tech spec §5.
 */

/** Decimals carried through every calculation, matching `numeric(19,4)`. */
export const MONEY_SCALE = 4;
const SCALE_FACTOR = 10_000n;

const DECIMAL_PATTERN = /^(?<sign>-)?(?<whole>\d+)(?:\.(?<fraction>\d+))?$/;

export const RoundingMode = {
  /** Ties away from zero. What most tax authorities specify, including the DIAN. */
  HALF_UP: 'HALF_UP',
  /** Ties to the even neighbour. Removes the upward bias of HALF_UP over many rows. */
  HALF_EVEN: 'HALF_EVEN',
  /** Toward zero. */
  DOWN: 'DOWN',
  /** Toward negative infinity. */
  FLOOR: 'FLOOR',
  /** Toward positive infinity. */
  CEILING: 'CEILING',
} as const;

export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

export class CurrencyMismatchError extends Error {
  public override readonly name = 'CurrencyMismatchError';
  public readonly code = 'CURRENCY_MISMATCH';

  public constructor(
    public readonly left: CurrencyCode,
    public readonly right: CurrencyCode,
  ) {
    super(
      `Cannot combine ${left} with ${right}. Convert explicitly, recording the rate, its ` +
        'source and its timestamp — an amount converted without a recorded rate is not auditable.',
    );
  }
}

export class InvalidAmountError extends Error {
  public override readonly name = 'InvalidAmountError';
  public readonly code = 'INVALID_AMOUNT';
}

export class Money {
  readonly #tenThousandths: bigint;
  readonly #currency: Currency;

  private constructor(tenThousandths: bigint, currency: Currency) {
    this.#tenThousandths = tenThousandths;
    this.#currency = currency;
  }

  /**
   * Parses a decimal string: `"1234.5600"`, `"-90"`, `"0.0001"`.
   *
   * A string, not a number, because JSON numbers go through a double on the way in and
   * the loss happens before this code ever sees the value. More than four decimals is
   * rejected rather than truncated: silently dropping a digit of someone's money is
   * exactly the class of bug this type exists to prevent.
   */
  public static parse(amount: string, currency: CurrencyCode): Money {
    const match = DECIMAL_PATTERN.exec(amount.trim());
    if (!match?.groups) {
      throw new InvalidAmountError(
        `"${amount}" is not a decimal amount. Expected digits with at most ${String(MONEY_SCALE)} decimals.`,
      );
    }

    const {
      sign,
      whole,
      fraction = '',
    } = match.groups as {
      sign?: string;
      whole: string;
      fraction?: string;
    };

    if (fraction.length > MONEY_SCALE) {
      throw new InvalidAmountError(
        `"${amount}" carries ${String(fraction.length)} decimals; amounts are held to ` +
          `${String(MONEY_SCALE)}. Round explicitly rather than losing a digit here.`,
      );
    }

    const padded = fraction.padEnd(MONEY_SCALE, '0');
    const magnitude = BigInt(whole) * SCALE_FACTOR + BigInt(padded);
    return new Money(sign === '-' ? -magnitude : magnitude, currencyOf(currency));
  }

  /** Builds from a whole number of currency units: `Money.ofUnits(1500n, 'COP')`. */
  public static ofUnits(units: bigint, currency: CurrencyCode): Money {
    return new Money(units * SCALE_FACTOR, currencyOf(currency));
  }

  public static zero(currency: CurrencyCode): Money {
    return new Money(0n, currencyOf(currency));
  }

  /** Sums amounts of one currency. An empty list has no currency, so it must be given. */
  public static sum(amounts: readonly Money[], currency: CurrencyCode): Money {
    return amounts.reduce<Money>((total, amount) => total.add(amount), Money.zero(currency));
  }

  public get currency(): CurrencyCode {
    return this.#currency.code;
  }

  /** The raw scaled integer. For persistence and tests, not for arithmetic. */
  public get tenThousandths(): bigint {
    return this.#tenThousandths;
  }

  public add(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#tenThousandths + other.#tenThousandths, this.#currency);
  }

  public subtract(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#tenThousandths - other.#tenThousandths, this.#currency);
  }

  public negated(): Money {
    return new Money(-this.#tenThousandths, this.#currency);
  }

  public absolute(): Money {
    return this.#tenThousandths < 0n ? this.negated() : this;
  }

  /** Multiplies by a whole number: three units of the same line. */
  public times(factor: bigint): Money {
    return new Money(this.#tenThousandths * factor, this.#currency);
  }

  /**
   * Multiplies by an exact rational, rounding once at the end.
   *
   * Rates are rationals, not floats: 19% is 19/100, and `0.19` is not 19/100 in binary.
   * A tax rate applied as a float is wrong in the fourth decimal, which is the decimal
   * that reaches a tax return.
   */
  public multiplyByRatio(numerator: bigint, denominator: bigint, mode: RoundingMode): Money {
    if (denominator === 0n) {
      throw new InvalidAmountError('Cannot multiply by a ratio with a zero denominator.');
    }
    const scaled = this.#tenThousandths * numerator;
    return new Money(divideRounded(scaled, denominator, mode), this.#currency);
  }

  /**
   * Splits an amount across weights so that the parts sum exactly back to the whole.
   *
   * Dividing and rounding each part independently loses or invents money — a hundred
   * lines each off by a hundredth is a peso that does not exist. The remainder is
   * distributed one unit at a time, largest fractional part first, which is the
   * allocation auditors expect to see.
   */
  public allocate(weights: readonly bigint[]): Money[] {
    if (weights.length === 0) {
      throw new InvalidAmountError('Cannot allocate across zero weights.');
    }
    if (weights.some((weight) => weight < 0n)) {
      throw new InvalidAmountError('Allocation weights cannot be negative.');
    }

    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
    if (totalWeight === 0n) {
      throw new InvalidAmountError('Allocation weights cannot all be zero.');
    }

    // Allocate on the magnitude and re-apply the sign, so a credit note splits the same
    // way its invoice did rather than rounding in the opposite direction.
    const isNegative = this.#tenThousandths < 0n;
    const magnitude = isNegative ? -this.#tenThousandths : this.#tenThousandths;

    const shares = weights.map((weight) => (magnitude * weight) / totalWeight);
    const remainders = weights.map((weight, index) => ({
      index,
      remainder: magnitude * weight - (shares[index] ?? 0n) * totalWeight,
    }));

    let leftover = magnitude - shares.reduce((sum, share) => sum + share, 0n);
    for (const { index } of remainders.toSorted((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    )) {
      if (leftover === 0n) break;
      shares[index] = (shares[index] ?? 0n) + 1n;
      leftover -= 1n;
    }

    return shares.map((share) => new Money(isNegative ? -share : share, this.#currency));
  }

  /**
   * Rounds to a given number of decimals.
   *
   * Never a default: the caller states the mode, because the right one depends on the
   * statute the number will be filed under, not on the language's convenience.
   * Round once, at the end of a chain — never intermediate values.
   */
  public round(mode: RoundingMode, scale: number = this.#currency.presentationScale): Money {
    if (!Number.isInteger(scale) || scale < 0 || scale > MONEY_SCALE) {
      throw new InvalidAmountError(
        `Cannot round to ${String(scale)} decimals; amounts carry ${String(MONEY_SCALE)}.`,
      );
    }
    const step = 10n ** BigInt(MONEY_SCALE - scale);
    return new Money(divideRounded(this.#tenThousandths, step, mode) * step, this.#currency);
  }

  public equals(other: Money): boolean {
    return (
      this.#currency.code === other.#currency.code && this.#tenThousandths === other.#tenThousandths
    );
  }

  /** -1, 0 or 1. Throws on mixed currencies rather than ordering the incomparable. */
  public compare(other: Money): -1 | 0 | 1 {
    this.#assertSameCurrency(other);
    if (this.#tenThousandths < other.#tenThousandths) return -1;
    return this.#tenThousandths > other.#tenThousandths ? 1 : 0;
  }

  public isZero(): boolean {
    return this.#tenThousandths === 0n;
  }

  public isNegative(): boolean {
    return this.#tenThousandths < 0n;
  }

  public isPositive(): boolean {
    return this.#tenThousandths > 0n;
  }

  /** Full precision, for persistence into `numeric(19,4)`. */
  /**
   * This amount as a proportion of another — a ratio, not money.
   *
   * Ratios are where money legitimately becomes a `number`: a share of a portfolio or a
   * DSO is dimensionless, and forcing it back into `Money` would imply a currency it does
   * not have. The division happens on the raw ten-thousandths so nothing is rounded before
   * it, which matters because these feed threshold comparisons (RN-09, RN-10) where a
   * rounding step could flip an alert.
   *
   * Both sides must share a currency: the ratio of pesos to dollars is not a number, it is
   * a mistake.
   */
  public ratioTo(other: Money): number {
    this.#assertSameCurrency(other);
    if (other.#tenThousandths === 0n) {
      // Not Infinity and not zero. Either would be rendered to a client as a real figure.
      throw new InvalidAmountError('a ratio to zero is undefined');
    }
    return Number(this.#tenThousandths) / Number(other.#tenThousandths);
  }

  public toDecimalString(): string {
    const negative = this.#tenThousandths < 0n;
    const magnitude = negative ? -this.#tenThousandths : this.#tenThousandths;
    const whole = magnitude / SCALE_FACTOR;
    const fraction = (magnitude % SCALE_FACTOR).toString().padStart(MONEY_SCALE, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
  }

  /**
   * The wire shape: a string amount, never a JSON number.
   *
   * `JSON.parse` turns a number into a double, so the precision is gone before the
   * client reads it — the loss happens outside our code and cannot be corrected there.
   */
  public toJSON(): { readonly amount: string; readonly currency: CurrencyCode } {
    return { amount: this.toDecimalString(), currency: this.#currency.code };
  }

  public toString(): string {
    return `${this.toDecimalString()} ${this.#currency.code}`;
  }

  #assertSameCurrency(other: Money): void {
    if (this.#currency.code !== other.#currency.code) {
      throw new CurrencyMismatchError(this.#currency.code, other.#currency.code);
    }
  }
}

/**
 * Integer division with an explicit rounding mode.
 *
 * BigInt division truncates toward zero, which is only one of the five modes and is the
 * wrong one for money most of the time.
 */
function divideRounded(dividend: bigint, divisor: bigint, mode: RoundingMode): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  if (remainder === 0n) return quotient;

  const negative = dividend < 0n !== divisor < 0n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  const absDivisor = divisor < 0n ? -divisor : divisor;

  switch (mode) {
    case RoundingMode.DOWN:
      return quotient;
    case RoundingMode.FLOOR:
      return negative ? quotient - 1n : quotient;
    case RoundingMode.CEILING:
      return negative ? quotient : quotient + 1n;
    case RoundingMode.HALF_UP:
      return twiceRemainder >= absDivisor ? awayFromZero(quotient, negative) : quotient;
    case RoundingMode.HALF_EVEN: {
      if (twiceRemainder > absDivisor) return awayFromZero(quotient, negative);
      if (twiceRemainder < absDivisor) return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero(quotient, negative);
    }
  }
}

function awayFromZero(quotient: bigint, negative: boolean): bigint {
  return negative ? quotient - 1n : quotient + 1n;
}
