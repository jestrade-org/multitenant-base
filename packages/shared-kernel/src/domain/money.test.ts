import { describe, expect, it } from 'vitest';

import { CurrencyMismatchError, InvalidAmountError, Money, RoundingMode } from './money.js';

const cop = (amount: string): Money => Money.parse(amount, 'COP');

describe('Money.parse', () => {
  it('parses 1234.5600 COP as 12345600 ten-thousandths', () => {
    expect(cop('1234.5600').tenThousandths).toBe(12_345_600n);
  });

  it('pads a short fraction: 0.5 COP is 5000 ten-thousandths, not 5', () => {
    expect(cop('0.5').tenThousandths).toBe(5_000n);
  });

  it('parses a whole amount with no decimal point', () => {
    expect(cop('90').tenThousandths).toBe(900_000n);
  });

  it('parses a negative amount', () => {
    expect(cop('-1234.5600').tenThousandths).toBe(-12_345_600n);
  });

  it('rejects a fifth decimal rather than silently dropping it', () => {
    expect(() => cop('1.00001')).toThrow(InvalidAmountError);
  });

  it.each(['', 'abc', '1,234.56', '1.2.3', '1e5', 'NaN', 'Infinity', '  ', '+5'])(
    'rejects %j as an amount',
    (bad) => {
      expect(() => cop(bad)).toThrow(InvalidAmountError);
    },
  );

  it('survives an amount larger than Number.MAX_SAFE_INTEGER', () => {
    // A double loses integers past 2^53. Annual receivables in COP pass that easily.
    const huge = cop('92233720368547.7580');
    expect(huge.toDecimalString()).toBe('92233720368547.7580');
  });
});

describe('Money arithmetic', () => {
  it('adds 1000.0000 + 234.5600 = 1234.5600', () => {
    expect(cop('1000').add(cop('234.56')).toDecimalString()).toBe('1234.5600');
  });

  it('subtracts to a negative balance', () => {
    expect(cop('100').subtract(cop('250.75')).toDecimalString()).toBe('-150.7500');
  });

  it('does not lose a cent where floats would: 0.1 + 0.2 = 0.3', () => {
    expect(cop('0.1').add(cop('0.2')).equals(cop('0.3'))).toBe(true);
  });

  it('multiplies a line by a quantity: 15000.0000 x 7', () => {
    expect(cop('15000').times(7n).toDecimalString()).toBe('105000.0000');
  });

  it('sums a list', () => {
    const total = Money.sum([cop('100'), cop('200.50'), cop('0.25')], 'COP');
    expect(total.toDecimalString()).toBe('300.7500');
  });

  it('sums an empty list to zero of the stated currency', () => {
    expect(Money.sum([], 'COP').isZero()).toBe(true);
  });

  it.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['compare', (a: Money, b: Money) => a.compare(b)],
  ])('refuses to %s across currencies rather than converting silently', (_name, operation) => {
    expect(() => operation(cop('100'), Money.parse('100', 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('treats equal amounts in different currencies as unequal', () => {
    expect(cop('100').equals(Money.parse('100', 'USD'))).toBe(false);
  });
});

describe('Money.multiplyByRatio — IVA at 19%', () => {
  it('computes IVA on 1.000.000 COP as 190.000,0000', () => {
    const iva = cop('1000000').multiplyByRatio(19n, 100n, RoundingMode.HALF_UP);
    expect(iva.toDecimalString()).toBe('190000.0000');
  });

  it('computes IVA on 33.333 COP as 6.333,2700 before presentation rounding', () => {
    const iva = cop('33333').multiplyByRatio(19n, 100n, RoundingMode.HALF_UP);
    expect(iva.toDecimalString()).toBe('6333.2700');
  });

  it('applies the rate as an exact rational, not as the float 0.19', () => {
    // 0.19 is not 19/100 in binary. 8150.00 * 0.19 in doubles gives 1548.4999999999998,
    // which rounds to 1548 instead of 1549 — a peso wrong on a filed return.
    const iva = cop('8150').multiplyByRatio(19n, 100n, RoundingMode.HALF_UP);
    expect(iva.toDecimalString()).toBe('1548.5000');
    expect(iva.round(RoundingMode.HALF_UP, 0).toDecimalString()).toBe('1549.0000');
  });

  it('refuses a zero denominator instead of producing Infinity', () => {
    expect(() => cop('100').multiplyByRatio(1n, 0n, RoundingMode.HALF_UP)).toThrow(
      InvalidAmountError,
    );
  });
});

describe('Money.round', () => {
  it('rounds COP to whole pesos by default, because that is its presentation scale', () => {
    expect(cop('1234.5600').round(RoundingMode.HALF_UP).toDecimalString()).toBe('1235.0000');
  });

  it.each([
    ['HALF_UP', RoundingMode.HALF_UP, '0.5', '1.0000'],
    ['HALF_UP on a tie away from zero', RoundingMode.HALF_UP, '-0.5', '-1.0000'],
    ['HALF_EVEN to the even neighbour', RoundingMode.HALF_EVEN, '0.5', '0.0000'],
    ['HALF_EVEN on 1.5', RoundingMode.HALF_EVEN, '1.5', '2.0000'],
    ['DOWN toward zero', RoundingMode.DOWN, '-1.9', '-1.0000'],
    ['FLOOR toward negative infinity', RoundingMode.FLOOR, '-1.1', '-2.0000'],
    ['CEILING toward positive infinity', RoundingMode.CEILING, '1.1', '2.0000'],
  ])('rounds %s', (_name, mode, input, expected) => {
    expect(cop(input).round(mode, 0).toDecimalString()).toBe(expected);
  });

  it('leaves an already-round amount alone', () => {
    expect(cop('1235').round(RoundingMode.HALF_UP, 0).toDecimalString()).toBe('1235.0000');
  });

  it('refuses a scale beyond the four decimals it carries', () => {
    expect(() => cop('1').round(RoundingMode.HALF_UP, 5)).toThrow(InvalidAmountError);
    expect(() => cop('1').round(RoundingMode.HALF_UP, -1)).toThrow(InvalidAmountError);
  });

  it('HALF_EVEN removes the upward drift HALF_UP accumulates over many rows', () => {
    const ties = ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5'];
    const halfUp = ties.map((t) => cop(t).round(RoundingMode.HALF_UP, 0));
    const halfEven = ties.map((t) => cop(t).round(RoundingMode.HALF_EVEN, 0));

    expect(Money.sum(halfUp, 'COP').toDecimalString()).toBe('21.0000');
    expect(Money.sum(halfEven, 'COP').toDecimalString()).toBe('18.0000');
  });
});

describe('Money.allocate', () => {
  it('splits 100 COP three ways as 33.34 / 33.33 / 33.33, summing back to 100', () => {
    const parts = cop('100').allocate([1n, 1n, 1n]);

    expect(parts.map((p) => p.toDecimalString())).toEqual(['33.3334', '33.3333', '33.3333']);
    expect(Money.sum(parts, 'COP').equals(cop('100'))).toBe(true);
  });

  it('splits by weight: 1.000.000 COP across 70/30', () => {
    const parts = cop('1000000').allocate([70n, 30n]);

    expect(parts.map((p) => p.toDecimalString())).toEqual(['700000.0000', '300000.0000']);
  });

  it('never invents or loses money, for any split of an awkward amount', () => {
    const total = cop('0.0007');
    for (const weights of [
      [1n, 1n],
      [1n, 1n, 1n],
      [2n, 3n, 5n],
      [1n, 0n, 1n],
    ]) {
      const parts = total.allocate(weights);
      expect(Money.sum(parts, 'COP').equals(total)).toBe(true);
    }
  });

  it('allocates a credit note the same way its invoice was allocated', () => {
    const invoice = cop('100')
      .allocate([1n, 1n, 1n])
      .map((p) => p.toDecimalString());
    const creditNote = cop('-100')
      .allocate([1n, 1n, 1n])
      .map((p) => p.negated().toDecimalString());

    expect(creditNote).toEqual(invoice);
  });

  it('gives a zero weight nothing', () => {
    const parts = cop('90').allocate([1n, 0n, 2n]);

    expect(parts.map((p) => p.toDecimalString())).toEqual(['30.0000', '0.0000', '60.0000']);
  });

  it.each([
    ['no weights', []],
    ['all-zero weights', [0n, 0n]],
    ['a negative weight', [1n, -1n]],
  ])('refuses to allocate across %s', (_name, weights) => {
    expect(() => cop('100').allocate(weights)).toThrow(InvalidAmountError);
  });
});

describe('Money on the wire and in storage', () => {
  it('serialises the amount as a string, never as a JSON number', () => {
    expect(cop('1234.56').toJSON()).toEqual({ amount: '1234.5600', currency: 'COP' });
  });

  it('survives a JSON round trip without losing precision', () => {
    const original = cop('92233720368547.7580');
    const wire = JSON.parse(JSON.stringify(original)) as { amount: string; currency: 'COP' };

    expect(Money.parse(wire.amount, wire.currency).equals(original)).toBe(true);
  });

  it('renders full precision for numeric(19,4) storage', () => {
    expect(cop('90').toDecimalString()).toBe('90.0000');
    expect(cop('-0.0001').toDecimalString()).toBe('-0.0001');
  });
});
