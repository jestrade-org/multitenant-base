/**
 * Currencies this product handles.
 *
 * `presentationScale` is how many decimals a person sees — not how many the arithmetic
 * carries. COP is quoted and invoiced in whole pesos, but a calculation chain that
 * rounded to whole pesos at every step would drift: a 19% IVA on a line, times a hundred
 * lines, is off by pesos that a tax authority will notice. So every amount is held at
 * four decimals and rounded to `presentationScale` once, explicitly, at the end.
 *
 * Ref: financial-domain.md; tech spec §5 (`numeric(19,4)`).
 */

export const CURRENCY_CODES = ['COP', 'USD', 'EUR'] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export interface Currency {
  readonly code: CurrencyCode;
  /** Decimals shown to a person. COP: 0. USD/EUR: 2. */
  readonly presentationScale: number;
}

const CURRENCIES: Readonly<Record<CurrencyCode, Currency>> = {
  COP: { code: 'COP', presentationScale: 0 },
  USD: { code: 'USD', presentationScale: 2 },
  EUR: { code: 'EUR', presentationScale: 2 },
};

export class UnknownCurrencyError extends Error {
  public override readonly name = 'UnknownCurrencyError';
  public readonly code = 'UNKNOWN_CURRENCY';

  public constructor(public readonly attempted: string) {
    super(
      `Unknown currency "${attempted}". Add it to CURRENCY_CODES with its presentation ` +
        'scale rather than assuming two decimals.',
    );
  }
}

export function currencyOf(code: string): Currency {
  const currency = (CURRENCIES as Record<string, Currency | undefined>)[code];
  if (currency === undefined) throw new UnknownCurrencyError(code);
  return currency;
}

export function isCurrencyCode(code: string): code is CurrencyCode {
  return code in CURRENCIES;
}
