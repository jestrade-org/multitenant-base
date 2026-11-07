import { DomainError, ValidationError } from '@multitenant-base/shared-kernel';

/**
 * The bounds a cross-tenant audit query must respect (§8.4, VC-75).
 *
 * The audit table is the largest table in the product and the one with the longest
 * retention, so an unbounded query over it is not a slow request — it is a request that
 * holds a connection for minutes and returns a payload nobody can read (api-design.md,
 * API4). Bounding it is also a disclosure control: "everything that ever happened" is a
 * different act from "what this accountant did last Tuesday", and only the second is a
 * compliance question.
 *
 * The window is validated here rather than at the route because it is a rule about what a
 * query *means*, not about what a request looks like.
 */

/** Default when the caller names no window. A month is what a compliance review asks for. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * The widest window a single query may span.
 *
 * A year plus a day, so "the whole of 2026" is one query rather than two that a person has
 * to stitch together. Beyond that the answer belongs in an export, which is itself audited
 * as `reports.exported`.
 */
export const MAX_WINDOW_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

export class AuditWindowTooWideError extends DomainError {
  public override readonly name = 'AuditWindowTooWideError';
  public readonly code = 'AUDIT_WINDOW_TOO_WIDE';

  public constructor(
    public readonly requestedDays: number,
    public readonly maximumDays: number,
  ) {
    super(`an audit query may span ${String(maximumDays)} days, not ${String(requestedDays)}`, {
      requestedDays,
      maximumDays,
    });
  }
}

export interface AuditWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface AuditWindowInput {
  /** ISO-8601 instant. Absent means `to` minus the default window. */
  readonly from?: string | undefined;
  /** ISO-8601 instant. Absent means now. */
  readonly to?: string | undefined;
}

/**
 * ISO-8601 only, checked by shape before `Date` is allowed near it.
 *
 * `new Date` accepts far more than ISO-8601 and resolves the ambiguity the wrong way for
 * this product: `new Date('01/08/2026')` is 8 January, and an operator in Latin America typing
 * `01/08/2026` means 1 August. That is a seven-month error in a compliance query, and it
 * would return rows rather than an error — the worst shape a date bug can take.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

function parseInstant(field: 'from' | 'to', value: string): Date {
  if (!ISO_INSTANT.test(value.trim())) {
    throw new ValidationError(field, 'must be an ISO-8601 instant');
  }

  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    // Shape is not validity: 2026-02-30 matches the pattern and is not a day.
    throw new ValidationError(field, 'must be an ISO-8601 instant');
  }
  return parsed;
}

/**
 * Resolves and bounds the window a query covers.
 *
 * `now` is passed in rather than read: this is domain code, and a default window computed
 * from the process clock is a default that cannot be tested at a boundary.
 */
export function boundedWindow(input: AuditWindowInput, now: Date): AuditWindow {
  const to = input.to === undefined ? now : parseInstant('to', input.to);
  const from =
    input.from === undefined
      ? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS)
      : parseInstant('from', input.from);

  if (from.getTime() > to.getTime()) {
    // Silently swapping them would answer a different question than the one asked, and
    // the caller would never learn their filter was wrong.
    throw new ValidationError('from', 'the start of the window is after its end');
  }

  const days = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
  if (days > MAX_WINDOW_DAYS) throw new AuditWindowTooWideError(days, MAX_WINDOW_DAYS);

  return { from, to };
}

/**
 * The shape of an action filter.
 *
 * Either a whole code (`tenant.suspended`) or a family prefix (`authentication.`). Both
 * are validated against the same character set the column constrains, so the filter can
 * never carry a wildcard that turns into a `like` pattern the caller did not write.
 */
const ACTION_FILTER = /^[a-z_]+(\.[a-z_]*)?$/;

export function assertActionFilter(action: string): string {
  if (!ACTION_FILTER.test(action)) {
    throw new ValidationError(
      'action',
      'an action filter is a code like tenant.suspended or a family like authentication.',
    );
  }
  return action;
}
