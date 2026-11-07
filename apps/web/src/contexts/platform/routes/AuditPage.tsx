import { useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, EmptyState, ErrorState, Skeleton } from '../../../shared/design/primitives.js';
import { formatDateTime, PLATFORM_TIMEZONE } from '../../../shared/i18n/format.js';
import {
  HttpPlatformOperationsClient,
  type AuditEvent,
  type AuditFilters,
} from '../api/operationsClient.js';
import { PlatformError } from '../api/platformClient.js';

import './AuditPage.css';

/**
 * The cross-tenant audit query (§8.4, VC-75).
 *
 * The one screen in the product that can see what every client has been doing. Two
 * consequences shape it.
 *
 * First, **the search itself is recorded**. The banner says so out loud rather than hiding
 * it in a policy document: an operator who knows their query is logged behaves differently
 * from one who assumes it is not, and that difference is the control.
 *
 * Second, **the window is bounded**. The form defaults to the last thirty days because
 * that is what a compliance review asks for; the server refuses anything wider than a
 * year. An unbounded query over the largest table in the product is not a slow page, it is
 * a page that returns a payload nobody can read.
 */

const client = new HttpPlatformOperationsClient();

/** Filters live in state, not in the URL, because a shared URL would replay the search. */
interface AuditForm {
  readonly tenantId: string;
  readonly actorId: string;
  readonly action: string;
  readonly result: '' | 'success' | 'denied' | 'error';
  readonly from: string;
  readonly to: string;
}

const EMPTY_FORM: AuditForm = {
  tenantId: '',
  actorId: '',
  action: '',
  result: '',
  from: '',
  to: '',
};

/**
 * The families a reviewer actually asks for, as a shortcut.
 *
 * A trailing dot is the API's own "whole family" filter, so these are the same query a
 * person could type — the buttons save the typing, they do not add a capability.
 */
const ACTION_SHORTCUTS = [
  'authentication.',
  'authorization.',
  'iam.',
  'tenant.',
  'platform.',
  'audit.',
] as const;

function toFilters(form: AuditForm, cursor: string | undefined): AuditFilters {
  return {
    ...(form.tenantId.trim() === '' ? {} : { tenantId: form.tenantId.trim() }),
    ...(form.actorId.trim() === '' ? {} : { actorId: form.actorId.trim() }),
    ...(form.action.trim() === '' ? {} : { action: form.action.trim() }),
    ...(form.result === '' ? {} : { result: form.result }),
    // A date input yields `YYYY-MM-DD`; the day's end is spelled out so "to: today" means
    // the whole of today rather than midnight, which would silently exclude the morning.
    ...(form.from.trim() === '' ? {} : { from: `${form.from}T00:00:00.000Z` }),
    ...(form.to.trim() === '' ? {} : { to: `${form.to}T23:59:59.999Z` }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function AuditPage() {
  const { t } = useTranslation('platform');

  const [form, setForm] = useState<AuditForm>(EMPTY_FORM);
  // The submitted filters, separate from what is being typed: a query only runs when the
  // reviewer asks for it, because every run is an audited disclosure.
  const [applied, setApplied] = useState<AuditForm>(EMPTY_FORM);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const events = useQuery({
    queryKey: ['platform', 'audit-events', applied, cursor],
    queryFn: ({ signal }) => client.searchAuditTrail(toFilters(applied, cursor), signal),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setCursor(undefined);
    setApplied(form);
  }

  const failure = events.error instanceof PlatformError ? events.error : undefined;

  return (
    <div className="audit">
      <p className="audit__intro">{t('audit.intro')}</p>

      {/* Stated, not buried. An operator who knows the search is recorded behaves
          differently from one who assumes it is not — that difference is the control. */}
      <p className="audit__notice" role="note">
        {t('audit.recordedNotice')}
      </p>

      <AuditFiltersForm
        form={form}
        onChange={setForm}
        onReset={() => {
          setForm(EMPTY_FORM);
          setApplied(EMPTY_FORM);
          setCursor(undefined);
        }}
        onSubmit={onSubmit}
      />

      <Card title={t('audit.results.title')}>
        {events.isPending ? (
          <Skeleton rows={6} />
        ) : events.isError ? (
          <ErrorState
            message={
              failure === undefined
                ? t('audit.results.error')
                : t(`audit.errors.${failure.code}`, {
                    defaultValue: t('audit.results.error'),
                    ...failure.params,
                  })
            }
            onRetry={() => void events.refetch()}
            retryLabel={t('audit.results.retry')}
          />
        ) : events.data.items.length === 0 ? (
          <EmptyState message={t('audit.results.empty')} />
        ) : (
          <>
            <div className="audit__scroll">
              <table className="audit__table">
                <caption className="audit__caption">{t('audit.results.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('audit.columns.occurredAt')}</th>
                    <th scope="col">{t('audit.columns.tenant')}</th>
                    <th scope="col">{t('audit.columns.actor')}</th>
                    <th scope="col">{t('audit.columns.action')}</th>
                    <th scope="col">{t('audit.columns.resource')}</th>
                    <th scope="col">{t('audit.columns.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.items.map((event) => (
                    <AuditRow event={event} key={event.eventId} />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="audit__paging">
              {cursor === undefined ? null : (
                <button
                  className="button button--secondary"
                  onClick={() => {
                    setCursor(undefined);
                  }}
                  type="button"
                >
                  {t('audit.results.firstPage')}
                </button>
              )}
              {events.data.nextCursor === undefined ? (
                <span className="audit__paging-end">{t('audit.results.lastPage')}</span>
              ) : (
                <button
                  className="button"
                  onClick={() => {
                    setCursor(events.data.nextCursor);
                  }}
                  type="button"
                >
                  {t('audit.results.nextPage')}
                </button>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function AuditFiltersForm({
  form,
  onChange,
  onSubmit,
  onReset,
}: {
  readonly form: AuditForm;
  readonly onChange: (form: AuditForm) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onReset: () => void;
}) {
  const { t } = useTranslation('platform');
  const tenantId = useId();
  const actorId = useId();
  const action = useId();
  const result = useId();
  const from = useId();
  const to = useId();

  return (
    <Card title={t('audit.filters.title')}>
      <form className="audit__form" noValidate onSubmit={onSubmit}>
        <div className="audit__field">
          <label htmlFor={tenantId}>{t('audit.filters.tenantId')}</label>
          <input
            id={tenantId}
            onChange={(event) => {
              onChange({ ...form, tenantId: event.target.value });
            }}
            value={form.tenantId}
          />
          <p className="audit__hint">{t('audit.filters.tenantIdHint')}</p>
        </div>

        <div className="audit__field">
          <label htmlFor={actorId}>{t('audit.filters.actorId')}</label>
          <input
            id={actorId}
            onChange={(event) => {
              onChange({ ...form, actorId: event.target.value });
            }}
            value={form.actorId}
          />
        </div>

        <div className="audit__field">
          <label htmlFor={action}>{t('audit.filters.action')}</label>
          <input
            id={action}
            onChange={(event) => {
              onChange({ ...form, action: event.target.value });
            }}
            placeholder="authentication."
            value={form.action}
          />
          <div className="audit__shortcuts">
            {ACTION_SHORTCUTS.map((family) => (
              <button
                className="audit__shortcut"
                key={family}
                onClick={() => {
                  onChange({ ...form, action: family });
                }}
                type="button"
              >
                {family}
              </button>
            ))}
          </div>
        </div>

        <div className="audit__field">
          <label htmlFor={result}>{t('audit.filters.result')}</label>
          <select
            id={result}
            onChange={(event) => {
              onChange({ ...form, result: event.target.value as AuditForm['result'] });
            }}
            value={form.result}
          >
            <option value="">{t('audit.filters.anyResult')}</option>
            <option value="success">{t('audit.results.outcome.success')}</option>
            <option value="denied">{t('audit.results.outcome.denied')}</option>
            <option value="error">{t('audit.results.outcome.error')}</option>
          </select>
        </div>

        <div className="audit__field">
          <label htmlFor={from}>{t('audit.filters.from')}</label>
          <input
            id={from}
            onChange={(event) => {
              onChange({ ...form, from: event.target.value });
            }}
            type="date"
            value={form.from}
          />
        </div>

        <div className="audit__field">
          <label htmlFor={to}>{t('audit.filters.to')}</label>
          <input
            id={to}
            onChange={(event) => {
              onChange({ ...form, to: event.target.value });
            }}
            type="date"
            value={form.to}
          />
          <p className="audit__hint">{t('audit.filters.windowHint')}</p>
        </div>

        <div className="audit__actions">
          <button className="button" type="submit">
            {t('audit.filters.search')}
          </button>
          <button className="button button--secondary" onClick={onReset} type="button">
            {t('audit.filters.reset')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function AuditRow({ event }: { readonly event: AuditEvent }) {
  const { t } = useTranslation('platform');

  return (
    <tr>
      <td className="audit__when">{formatDateTime(event.occurredAt, PLATFORM_TIMEZONE)}</td>
      <td>
        {/* Staff act for no company. Saying so beats an empty cell that reads as data
            that failed to load. */}
        {event.tenantName ?? t('audit.results.platformScope')}
      </td>
      <td className="audit__actor">
        <span className="audit__actor-type">
          {t(`audit.actorTypes.${event.actorType}`, { defaultValue: event.actorType })}
        </span>
        <code>{event.actorId}</code>
      </td>
      <td>
        <code className="audit__action">{event.action}</code>
        {event.correlationId === undefined ? null : (
          <span className="audit__correlation">{event.correlationId}</span>
        )}
      </td>
      <td className="audit__resource">
        {event.resourceType ?? '—'}
        {event.resourceId === undefined ? null : <code>{event.resourceId}</code>}
      </td>
      <td>
        {/* Never colour alone: an outcome is a word first (react.md, accessibility). */}
        <span className={`audit__outcome audit__outcome--${event.result}`}>
          {t(`audit.results.outcome.${event.result}`)}
        </span>
      </td>
    </tr>
  );
}
