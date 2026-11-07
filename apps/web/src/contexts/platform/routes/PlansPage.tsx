import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, EmptyState, ErrorState, Skeleton } from '../../../shared/design/primitives.js';
import { formatDateTime, formatMoney, PLATFORM_TIMEZONE } from '../../../shared/i18n/format.js';
import {
  HttpPlatformOperationsClient,
  type Plan,
  type QuotaReading,
  type QuotaStatus,
  type TenantQuotaUsage,
} from '../api/operationsClient.js';
import { PlatformError } from '../api/platformClient.js';
import { TenantUsersLink } from '../components/TenantUsersLink.js';

import './PlansPage.css';

/**
 * Plans, their quotas, and what each client is actually using (§4.2, VC-28, VC-75).
 *
 * Two things on one screen because they are one question. "Should we reprice Business?"
 * and "who is about to hit their limit?" are asked together, and putting them on separate
 * screens means the operator answers the first without the second.
 *
 * The usage figures carry an explicit "última actualización". They come from the daily
 * verification pass, not from a live count — the platform panel deliberately holds no
 * connection into a company's data (§8.1) — and a number whose age is hidden is a
 * number somebody will act on as if it were current.
 */

const client = new HttpPlatformOperationsClient();

/** Currencies a plan may be priced in. Mirrors CURRENCY_CODES in the shared kernel. */
const CURRENCIES = ['USD', 'EUR', 'COP'] as const;

const PLAN_KEYS = { plans: ['platform', 'plans'], usage: ['platform', 'quota-usage'] } as const;

export function PlansPage() {
  const { t } = useTranslation('platform');
  const queryClient = useQueryClient();

  const plans = useQuery({
    queryKey: PLAN_KEYS.plans,
    queryFn: ({ signal }) => client.listPlans(signal),
  });

  const usage = useQuery({
    queryKey: PLAN_KEYS.usage,
    queryFn: ({ signal }) => client.listQuotaUsage(signal),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: PLAN_KEYS.plans });
    void queryClient.invalidateQueries({ queryKey: PLAN_KEYS.usage });
  };

  if (plans.isPending || usage.isPending) {
    return (
      <Card title={t('plans.title')}>
        <Skeleton rows={5} />
      </Card>
    );
  }

  if (plans.isError || usage.isError) {
    return (
      <ErrorState
        message={t('plans.error')}
        onRetry={() => {
          void plans.refetch();
          void usage.refetch();
        }}
        retryLabel={t('plans.retry')}
      />
    );
  }

  return (
    <div className="plans">
      <p className="plans__intro">{t('plans.intro')}</p>

      <QuotaUsageCard usage={usage.data} />
      <PlanCatalogueCard onSaved={invalidate} plans={plans.data} />
    </div>
  );
}

function QuotaUsageCard({ usage }: { readonly usage: readonly TenantQuotaUsage[] }) {
  const { t } = useTranslation('platform');

  if (usage.length === 0) {
    return (
      <Card title={t('plans.usage.title')}>
        <EmptyState message={t('plans.usage.empty')} />
      </Card>
    );
  }

  // Worst first. An operator scanning this screen should not have to find the client in
  // trouble; the client in trouble should be the first row.
  const ordered = [...usage].sort((left, right) => severity(right.status) - severity(left.status));

  return (
    <Card title={t('plans.usage.title')}>
      <div className="plans__scroll">
        <table className="plans__table">
          <caption className="plans__caption">{t('plans.usage.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('plans.usage.columns.tenant')}</th>
              <th scope="col">{t('plans.usage.columns.plan')}</th>
              <th scope="col">{t('plans.usage.columns.users')}</th>
              <th scope="col">{t('plans.usage.columns.measuredAt')}</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((tenant) => (
              <tr key={tenant.tenantId}>
                <th scope="row">
                  <TenantUsersLink name={tenant.tenantName} tenantId={tenant.tenantId} />
                </th>
                <td>{t(`tenants.plans.${tenant.planCode}`, { defaultValue: tenant.planCode })}</td>
                <QuotaCell reading={readingOf(tenant, 'users')} />
                <td className="plans__measured">
                  {tenant.measuredAt === undefined
                    ? t('plans.usage.neverMeasured')
                    : formatDateTime(tenant.measuredAt, PLATFORM_TIMEZONE)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="plans__hint">{t('plans.usage.freshness')}</p>
    </Card>
  );
}

/**
 * One limit, as a number and a bar.
 *
 * The number first and the bar second: a bar alone encodes the state in width and colour,
 * and an operator deciding whether to call a client needs "1 843 de 2 000", not a shape.
 * The state is also a word in the label, so it never depends on colour alone.
 */
function QuotaCell({ reading }: { readonly reading: QuotaReading | undefined }) {
  const { t } = useTranslation('platform');

  if (reading === undefined) return <td>—</td>;

  return (
    <td className="plans__quota">
      <span className="plans__quota-figures">
        {t('plans.usage.ofLimit', {
          used: reading.used.toLocaleString('es'),
          limit: reading.limit.toLocaleString('es'),
        })}
      </span>
      <span
        aria-hidden="true"
        className={`plans__bar plans__bar--${reading.status}`}
        style={{ '--fill': `${String(Math.min(reading.ratio, 1) * 100)}%` } as React.CSSProperties}
      />
      {reading.status === 'within' ? null : (
        <span className={`plans__flag plans__flag--${reading.status}`}>
          {t(`plans.usage.status.${reading.status}`)}
        </span>
      )}
    </td>
  );
}

function readingOf(tenant: TenantQuotaUsage, kind: QuotaReading['kind']): QuotaReading | undefined {
  return tenant.readings.find((reading) => reading.kind === kind);
}

function severity(status: QuotaStatus): number {
  return status === 'exceeded' ? 2 : status === 'warning' ? 1 : 0;
}

function PlanCatalogueCard({
  plans,
  onSaved,
}: {
  readonly plans: readonly Plan[];
  readonly onSaved: () => void;
}) {
  const { t } = useTranslation('platform');
  const [editing, setEditing] = useState<Plan | undefined>(undefined);

  return (
    <Card title={t('plans.catalogue.title')}>
      <div className="plans__scroll">
        <table className="plans__table">
          <caption className="plans__caption">{t('plans.catalogue.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('plans.catalogue.columns.plan')}</th>
              <th scope="col">{t('plans.catalogue.columns.price')}</th>
              <th scope="col">{t('plans.catalogue.columns.users')}</th>
              <th scope="col">{t('plans.catalogue.columns.tenants')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('plans.catalogue.columns.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.code}>
                <th scope="row">
                  <span className="plans__name">{plan.name}</span>
                  <code className="plans__code">{plan.code}</code>
                </th>
                <td className="plans__price">
                  {formatMoney(plan.monthlyPrice.amount, plan.monthlyPrice.currency)}
                </td>
                <td>{plan.quotas.users.toLocaleString('es')}</td>
                <td>{plan.tenantCount}</td>
                <td>
                  <button
                    className="button button--secondary"
                    onClick={() => {
                      setEditing(plan);
                    }}
                    type="button"
                  >
                    {t('plans.catalogue.edit')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PlanForm
        key={editing?.code ?? 'new'}
        onSaved={() => {
          setEditing(undefined);
          onSaved();
        }}
        plan={editing}
      />
    </Card>
  );
}

/**
 * The Spanish sentence for a failure.
 *
 * The server sends a code and parameters; an unmapped code becomes a sentence the operator
 * can act on rather than the raw English identifier (language-i18n.md).
 */
function describeFailure(t: TFunction<'platform'>, failure: PlatformError): string {
  const field = failure.params.field;

  return t(`plans.form.errors.${failure.code}`, {
    defaultValue: t('plans.form.errors.default'),
    ...failure.params,
    field: field === undefined ? '' : t(`plans.form.fields.${field}`, { defaultValue: field }),
  });
}

/**
 * Creating or repricing a plan.
 *
 * One form for both, because they are the same six fields and a second form would be a
 * second place for the validation to drift. Editing an existing plan locks its code: the
 * code is what every tenant row points at, and renaming it in place would silently move
 * clients between plans.
 */
function PlanForm({
  plan,
  onSaved,
}: {
  readonly plan: Plan | undefined;
  readonly onSaved: () => void;
}) {
  const { t } = useTranslation('platform');
  const codeId = useId();
  const nameId = useId();
  const priceId = useId();
  const currencyId = useId();
  const usersId = useId();
  const errorId = useId();

  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [monthlyPrice, setMonthlyPrice] = useState(plan?.monthlyPrice.amount ?? '');
  const [currency, setCurrency] = useState(plan?.monthlyPrice.currency ?? CURRENCIES[0]);
  const [users, setUsers] = useState(String(plan?.quotas.users ?? ''));

  const save = useMutation({
    mutationFn: () =>
      client.savePlan({
        code: code.trim(),
        name: name.trim(),
        monthlyPrice: monthlyPrice.trim(),
        currency,
        quotas: { users: Number(users) },
        exists: plan !== undefined,
      }),
    onSuccess: onSaved,
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (save.isPending) return;
    save.mutate();
  }

  const failure = save.error instanceof PlatformError ? save.error : undefined;

  return (
    <form className="plans__form" noValidate onSubmit={onSubmit}>
      <h3 className="plans__form-title">
        {plan === undefined
          ? t('plans.form.newTitle')
          : t('plans.form.editTitle', { name: plan.name })}
      </h3>

      <div className="plans__field">
        <label htmlFor={codeId}>{t('plans.form.code')}</label>
        <input
          id={codeId}
          onChange={(event) => {
            setCode(event.target.value);
          }}
          readOnly={plan !== undefined}
          required
          value={code}
        />
        <p className="plans__field-hint">
          {plan === undefined ? t('plans.form.codeHint') : t('plans.form.codeLocked')}
        </p>
      </div>

      <div className="plans__field">
        <label htmlFor={nameId}>{t('plans.form.name')}</label>
        <input
          id={nameId}
          onChange={(event) => {
            setName(event.target.value);
          }}
          required
          value={name}
        />
      </div>

      <div className="plans__field">
        <label htmlFor={priceId}>{t('plans.form.monthlyPrice')}</label>
        {/* Text, not `type="number"`: a number input hands back a float, and a price that
            went through a float is a price that can be a fraction of a cent wrong. */}
        <input
          id={priceId}
          inputMode="decimal"
          onChange={(event) => {
            setMonthlyPrice(event.target.value);
          }}
          placeholder="149.0000"
          required
          value={monthlyPrice}
        />
        <p className="plans__field-hint">{t('plans.form.monthlyPriceHint')}</p>
      </div>

      <div className="plans__field">
        <label htmlFor={currencyId}>{t('plans.form.currency')}</label>
        <select
          id={currencyId}
          onChange={(event) => {
            setCurrency(event.target.value);
          }}
          value={currency}
        >
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>

      <div className="plans__field">
        <label htmlFor={usersId}>{t('plans.form.users')}</label>
        <input
          id={usersId}
          inputMode="numeric"
          min={1}
          onChange={(event) => {
            setUsers(event.target.value);
          }}
          required
          type="number"
          value={users}
        />
      </div>

      {plan !== undefined && plan.tenantCount > 0 ? (
        <p className="plans__warning" role="status">
          {t('plans.form.affectsTenants', { count: plan.tenantCount })}
        </p>
      ) : null}

      {failure === undefined ? null : (
        <p className="plans__error" id={errorId} role="alert">
          {describeFailure(t, failure)}
          {failure.correlationId === undefined
            ? null
            : ` (${t('plans.form.reference')}: ${failure.correlationId})`}
        </p>
      )}

      <button
        aria-describedby={failure === undefined ? undefined : errorId}
        className="button"
        disabled={save.isPending}
        type="submit"
      >
        {save.isPending ? t('plans.form.working') : t('plans.form.submit')}
      </button>
    </form>
  );
}
