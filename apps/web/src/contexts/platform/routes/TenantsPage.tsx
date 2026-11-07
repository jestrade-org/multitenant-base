import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, EmptyState, ErrorState, Skeleton } from '../../../shared/design/primitives.js';
import { formatInstantAsDate } from '../../../shared/i18n/format.js';
import { HttpPlatformClient, PlatformError, type TenantSummary } from '../api/platformClient.js';
import { TenantUsersLink } from '../components/TenantUsersLink.js';

import './TenantsPage.css';

/**
 * The client roster, and the form that creates one (§9, VC-27, VC-75).
 *
 * Provisioning is not a form submission that either works or does not. It creates a schema,
 * runs migrations and invites a person, and any of those can stop half way — so the screen
 * is built around that being *normal*: an unfinished company is listed as unfinished, with a
 * button that finishes it rather than an error the operator has to interpret.
 */

const client = new HttpPlatformClient();

/** The seeded plans. A project that defines its own plans reads the catalogue instead. */
const PLAN_CODES = ['starter', 'business', 'enterprise'] as const;

export function TenantsPage() {
  const { t } = useTranslation('platform');
  const queryClient = useQueryClient();

  const tenants = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: ({ signal }) => client.listTenants(signal),
  });

  // Void, not the promise: nothing waits for the refetch, and returning it would make
  // every caller a promise-returning handler.
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['platform', 'tenants'] });
  };

  const lifecycle = useMutation({
    mutationFn: (input: { readonly tenantId: string; readonly suspend: boolean }) =>
      input.suspend ? client.suspendTenant(input.tenantId) : client.resumeTenant(input.tenantId),
    onSettled: invalidate,
  });

  if (tenants.isPending) {
    return (
      <Card title={t('tenants.title')}>
        <Skeleton rows={4} />
      </Card>
    );
  }

  if (tenants.isError) {
    return (
      <ErrorState
        message={t('tenants.error')}
        onRetry={() => void tenants.refetch()}
        retryLabel={t('tenants.retry')}
      />
    );
  }

  return (
    <div className="tenants">
      {/* The route wrapper renders the heading; repeating it here would give the page two. */}
      <p className="tenants__intro">{t('tenants.intro')}</p>

      <NewTenantForm onProvisioned={invalidate} />

      <Card title={t('tenants.listTitle')}>
        {tenants.data.length === 0 ? (
          <EmptyState message={t('tenants.empty')} />
        ) : (
          <div className="tenants__scroll">
            <table className="tenants__table">
              <caption className="tenants__caption">{t('tenants.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('tenants.columns.name')}</th>
                  <th scope="col">{t('tenants.columns.taxId')}</th>
                  <th scope="col">{t('tenants.columns.plan')}</th>
                  <th scope="col">{t('tenants.columns.status')}</th>
                  <th scope="col">{t('tenants.columns.since')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('tenants.columns.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tenants.data.map((tenant) => (
                  <TenantRow
                    key={tenant.id}
                    onLifecycle={(suspend) => {
                      lifecycle.mutate({ tenantId: tenant.id, suspend });
                    }}
                    pending={lifecycle.isPending && lifecycle.variables.tenantId === tenant.id}
                    tenant={tenant}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function TenantRow({
  tenant,
  onLifecycle,
  pending,
}: {
  readonly tenant: TenantSummary;
  readonly onLifecycle: (suspend: boolean) => void;
  readonly pending: boolean;
}) {
  const { t } = useTranslation('platform');
  const suspended = tenant.lifecycleStatus === 'suspended';

  return (
    <tr>
      <th scope="row">
        {/* The name is the way in: opening a client lists its people, which is where a
            support session is started from. A link rather than a row click, so it can be
            middle-clicked, bookmarked and reached by keyboard like anything else. */}
        <TenantUsersLink className="tenants__name" name={tenant.name} tenantId={tenant.id} />
        <code className="tenants__subdomain">{tenant.subdomain}</code>
      </th>
      <td className="tenants__taxid">{tenant.taxId}</td>
      <td>{t(`tenants.plans.${tenant.planCode}`, { defaultValue: tenant.planCode })}</td>
      <td>
        {/* Never colour alone: a status is a word first (react.md, accessibility). */}
        <span className={`tenants__status tenants__status--${statusTone(tenant)}`}>
          {tenant.isProvisioned
            ? t(`tenants.statuses.${tenant.lifecycleStatus}`, {
                defaultValue: tenant.lifecycleStatus,
              })
            : t('tenants.statuses.unfinished')}
        </span>
      </td>
      <td>{formatInstantAsDate(tenant.createdAt, tenant.timezone)}</td>
      <td className="tenants__actions">
        <button
          className="button button--secondary"
          disabled={pending}
          onClick={() => {
            onLifecycle(!suspended);
          }}
          type="button"
        >
          {suspended ? t('tenants.resume') : t('tenants.suspend')}
        </button>
      </td>
    </tr>
  );
}

function statusTone(tenant: TenantSummary): 'ok' | 'warn' | 'stopped' {
  if (!tenant.isProvisioned) return 'warn';
  return tenant.lifecycleStatus === 'suspended' ? 'stopped' : 'ok';
}

/**
 * Registering a company.
 *
 * The subdomain is optional and derived from the name when left blank, which is what
 * usually happens — an operator should not have to invent a hostname. The tax identifier is
 * typed as it appears on a document, separators and all; the server normalises it so the
 * same company typed twice is caught as a duplicate.
 */
/**
 * The Spanish sentence for a failure.
 *
 * The server sends a code and parameters; an unmapped code becomes a sentence the operator
 * can act on rather than the raw English identifier (language-i18n.md). Field names are
 * translated too — "Revise el campo taxId" is not a message for a person.
 */
function describeFailure(t: TFunction<'platform'>, failure: PlatformError): string {
  const field = failure.params.field;

  return t(`tenants.new.errors.${failure.code}`, {
    defaultValue: t('tenants.new.errors.default'),
    ...failure.params,
    field: field === undefined ? '' : t(`tenants.new.fields.${field}`, { defaultValue: field }),
  });
}

function NewTenantForm({ onProvisioned }: { readonly onProvisioned: () => void }) {
  const { t } = useTranslation('platform');
  const nameId = useId();
  const taxIdId = useId();
  const subdomainId = useId();
  const planId = useId();
  const adminEmailId = useId();
  const adminNameId = useId();
  const errorId = useId();

  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [planCode, setPlanCode] = useState<string>('starter');
  const [administratorEmail, setAdministratorEmail] = useState('');
  const [administratorName, setAdministratorName] = useState('');

  const provision = useMutation({
    mutationFn: () =>
      client.provisionTenant({
        name,
        taxId,
        ...(subdomain.trim() === '' ? {} : { subdomain: subdomain.trim() }),
        planCode,
        administratorEmail,
        administratorName,
      }),
    onSuccess: () => {
      setName('');
      setTaxId('');
      setSubdomain('');
      setAdministratorEmail('');
      setAdministratorName('');
      onProvisioned();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (provision.isPending) return;
    provision.mutate();
  }

  const failure = provision.error instanceof PlatformError ? provision.error : undefined;

  return (
    <Card title={t('tenants.new.title')}>
      <form className="tenants__form" noValidate onSubmit={onSubmit}>
        <div className="tenants__field">
          <label htmlFor={nameId}>{t('tenants.new.name')}</label>
          <input
            id={nameId}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
            value={name}
          />
        </div>

        <div className="tenants__field">
          <label htmlFor={taxIdId}>{t('tenants.new.taxId')}</label>
          <input
            id={taxIdId}
            onChange={(event) => {
              setTaxId(event.target.value);
            }}
            placeholder="12-3456789"
            required
            value={taxId}
          />
          <p className="tenants__hint">{t('tenants.new.taxIdHint')}</p>
        </div>

        <div className="tenants__field">
          <label htmlFor={subdomainId}>{t('tenants.new.subdomain')}</label>
          <input
            id={subdomainId}
            onChange={(event) => {
              setSubdomain(event.target.value);
            }}
            value={subdomain}
          />
          <p className="tenants__hint">{t('tenants.new.subdomainHint')}</p>
        </div>

        <div className="tenants__field">
          <label htmlFor={planId}>{t('tenants.new.plan')}</label>
          <select
            id={planId}
            onChange={(event) => {
              setPlanCode(event.target.value);
            }}
            value={planCode}
          >
            {PLAN_CODES.map((code) => (
              <option key={code} value={code}>
                {t(`tenants.plans.${code}`, { defaultValue: code })}
              </option>
            ))}
          </select>
        </div>

        <div className="tenants__field">
          <label htmlFor={adminNameId}>{t('tenants.new.administratorName')}</label>
          <input
            id={adminNameId}
            onChange={(event) => {
              setAdministratorName(event.target.value);
            }}
            required
            value={administratorName}
          />
        </div>

        <div className="tenants__field">
          <label htmlFor={adminEmailId}>{t('tenants.new.administratorEmail')}</label>
          <input
            id={adminEmailId}
            inputMode="email"
            onChange={(event) => {
              setAdministratorEmail(event.target.value);
            }}
            required
            type="email"
            value={administratorEmail}
          />
          <p className="tenants__hint">{t('tenants.new.administratorEmailHint')}</p>
        </div>

        {failure === undefined ? null : (
          <p className="tenants__error" id={errorId} role="alert">
            {describeFailure(t, failure)}
            {failure.correlationId === undefined
              ? null
              : ` (${t('tenants.new.reference')}: ${failure.correlationId})`}
          </p>
        )}

        {provision.data === undefined ? null : (
          <p className="tenants__success" role="status">
            {provision.data.resumed
              ? t('tenants.new.resumed', { name: provision.data.tenant.name })
              : t('tenants.new.created', {
                  name: provision.data.tenant.name,
                  email: provision.data.administratorEmail,
                })}
          </p>
        )}

        <button
          aria-describedby={failure === undefined ? undefined : errorId}
          className="button"
          disabled={provision.isPending}
          type="submit"
        >
          {provision.isPending ? t('tenants.new.working') : t('tenants.new.submit')}
        </button>
      </form>
    </Card>
  );
}
