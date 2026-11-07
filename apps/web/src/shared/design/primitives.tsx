import type { ReactNode } from 'react';

import './primitives.css';

/**
 * The design system primitives (§12).
 *
 * Presentational only. None of these knows a business rule — a component that decides
 * whether a member may be deactivated has put a domain rule in the browser, where it cannot
 * be tested against the server and will drift from the decision the API makes.
 */

export type RiskLevel = 'normal' | 'attention' | 'critical';

export function Card({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby={`card-${slug(title)}`}>
      <header className="card__header">
        <h2 className="card__title" id={`card-${slug(title)}`}>
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  risk,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly risk?: RiskLevel;
}) {
  return (
    <div className="stat">
      <dt className="stat__label">{label}</dt>
      <dd className={`stat__value${risk ? ` stat__value--${risk}` : ''}`}>{value}</dd>
      {hint === undefined ? null : <p className="stat__hint">{hint}</p>}
    </div>
  );
}

/**
 * The shape that carries a risk state when colour cannot.
 *
 * Exported so every chip and badge on a screen uses the same three marks. Two components
 * choosing their own symbols is how a triangle comes to mean "critical" in one place and
 * "attention" in another.
 */
export function riskSymbol(level: RiskLevel): string {
  if (level === 'critical') return '▲';
  if (level === 'attention') return '●';
  return '■';
}

/**
 * A risk state.
 *
 * Carries a symbol and a word as well as a colour. Encoding the state in colour alone
 * would make it invisible to a reader with a colour vision deficiency, and this is the
 * signal the whole screen is built around.
 */
export function RiskBadge({ level, label }: { readonly level: RiskLevel; readonly label: string }) {
  const symbol = riskSymbol(level);
  return (
    <span className={`badge badge--${level}`}>
      <span aria-hidden="true">{symbol}</span> {label}
    </span>
  );
}

/**
 * The headline figures of a screen, in one grid.
 *
 * Separated by hairlines rather than cards: six bordered boxes read as six unrelated
 * things, and these are six readings of one company at one instant. The grid's own
 * background shows through a 2px gap — white doing the separating, no borders drawn.
 */
export function KpiGrid({ children }: { readonly children: ReactNode }) {
  return <div className="kpi-grid">{children}</div>;
}

/**
 * One headline figure.
 *
 * The value uses the font's proportional figures, not `tabular-nums`: equal-width digits
 * are what makes a column of numbers line up, and at 2.25rem they make a short number look
 * gappy. Columns of figures get `tabular-nums`; a standalone headline does not.
 *
 * `risk` colours the figure. It is never the only signal — the caption says the same thing
 * in words, and the card that holds the grid carries a risk badge.
 */
export function Kpi({
  label,
  value,
  caption,
  risk,
}: {
  readonly label: string;
  readonly value: string;
  readonly caption?: string;
  readonly risk?: RiskLevel;
}) {
  return (
    <div className="kpi">
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value${risk ? ` kpi__value--${risk}` : ''}`}>{value}</div>
      {caption === undefined ? null : <div className="kpi__caption">{caption}</div>}
    </div>
  );
}

/**
 * A call-out that states where the company stands.
 *
 * Carries the risk word and a shape as well as the colour, for the same reason
 * `RiskBadge` does: this is the sentence the whole screen is built around, and a reader
 * who cannot separate the magenta from the green still has to be able to read it.
 */
export function Banner({
  risk,
  eyebrow,
  children,
  action,
}: {
  readonly risk: RiskLevel;
  readonly eyebrow: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  const symbol = risk === 'critical' ? '\u25B2' : risk === 'attention' ? '\u25CF' : '\u25A0';
  return (
    <section className={`banner banner--${risk}`}>
      <p className="banner__eyebrow">
        <span aria-hidden="true">{symbol}</span> {eyebrow}
      </p>
      <div className="banner__body">{children}</div>
      {action === undefined ? null : <div className="banner__action">{action}</div>}
    </section>
  );
}

/** A skeleton shaped like the content it stands in for, not a spinner. */
export function Skeleton({ rows = 3 }: { readonly rows?: number }) {
  return (
    <div aria-hidden="true" className="skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton__row" key={index} />
      ))}
    </div>
  );
}

/** Empty is a state with something to say, not a blank panel. */
export function EmptyState({
  message,
  action,
}: {
  readonly message: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty__message">{message}</p>
      {action}
    </div>
  );
}

/**
 * Error state.
 *
 * Says what failed and how to retry, and shows the correlation id so a user can quote it
 * to support. Never the raw message: a driver error names hosts and schemas.
 */
export function ErrorState({
  message,
  correlationId,
  onRetry,
  retryLabel,
}: {
  readonly message: string;
  readonly correlationId?: string;
  readonly onRetry?: () => void;
  readonly retryLabel: string;
}) {
  return (
    <div className="error" role="alert">
      <p className="error__message">{message}</p>
      {correlationId === undefined ? null : (
        <p className="error__reference">
          <code>{correlationId}</code>
        </p>
      )}
      {onRetry === undefined ? null : (
        <button className="button" onClick={onRetry} type="button">
          {retryLabel}
        </button>
      )}
    </div>
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
}
