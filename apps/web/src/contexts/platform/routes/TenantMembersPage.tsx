import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import { useSession } from '../../../shared/auth/SessionProvider.js';
import { Card, EmptyState, ErrorState, Skeleton } from '../../../shared/design/primitives.js';
import { PlatformError } from '../api/platformClient.js';
import { HttpSupportAccessClient, type TenantMember } from '../api/supportAccessClient.js';

import './TenantMembersPage.css';

/**
 * The people inside one client, and the door into their account (§8.1, VC-101).
 *
 * Entering someone's account is the most powerful thing this product lets anybody do, so
 * the screen is built to slow it down rather than to make it convenient: the reason is
 * required before the button does anything, the confirmation names the person and the
 * company out loud, and the copy says plainly that the client will see this in their own
 * audit trail. None of that is decoration — a support session opened by reflex against the
 * wrong row is the failure mode, and it is a failure the client reads about afterwards.
 */

const client = new HttpSupportAccessClient();

export function TenantMembersPage() {
  const { t } = useTranslation('platform');
  const { tenantId } = useParams<{ tenantId: string }>();
  const { can } = useSession();

  const members = useQuery({
    queryKey: ['platform', 'tenant-members', tenantId],
    queryFn: ({ signal }) => client.listMembers({ tenantId: tenantId ?? '' }, signal),
    enabled: tenantId !== undefined,
  });

  if (tenantId === undefined) return <EmptyState message={t('support.noTenant')} />;

  if (members.isPending) {
    return (
      <Card title={t('support.membersTitle')}>
        <Skeleton rows={4} />
      </Card>
    );
  }

  if (members.isError) {
    return (
      <ErrorState
        message={t('support.membersError')}
        onRetry={() => void members.refetch()}
        retryLabel={t('tenants.retry')}
      />
    );
  }

  const tenantName = members.data[0]?.tenantName ?? '';

  return (
    <div className="members">
      <p className="members__back">
        <Link to="/plataforma/empresas">{t('support.backToTenants')}</Link>
      </p>

      {tenantName === '' ? null : <p className="members__tenant">{tenantName}</p>}
      <p className="members__intro">{t('support.intro')}</p>

      <Card title={t('support.membersTitle')}>
        {members.data.length === 0 ? (
          <EmptyState message={t('support.membersEmpty')} />
        ) : (
          <ul className="members__list">
            {members.data.map((member) => (
              <MemberRow
                canEnter={can('platform:support_access')}
                key={member.memberId}
                member={member}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function MemberRow({
  member,
  canEnter,
}: {
  readonly member: TenantMember;
  readonly canEnter: boolean;
}) {
  const { t } = useTranslation('platform');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();

  const begin = useMutation({
    mutationFn: () => client.begin({ memberId: member.memberId, reason }),
    onSuccess: () => {
      // A full navigation, not a cache invalidation. Every permission in the running app
      // has just changed, and re-deriving that from a patched cache is how a screen ends
      // up rendering one person's menu over another person's data.
      window.location.assign('/');
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    begin.mutate();
  }

  return (
    <li className="members__item">
      <div className="members__who">
        <span className="members__name">{member.fullName}</span>
        <span className="members__email">{member.email}</span>
        <span className="members__role">
          {t(`support.roles.${member.roleCode}`, { defaultValue: member.roleCode })}
        </span>
      </div>

      {/* Hiding the control is UX, not security: the server refuses the request either
          way. It is here so an operator without the capability is not offered a door that
          will not open for them. */}
      {!canEnter ? (
        <span className="members__denied">{t('support.notPermitted')}</span>
      ) : open ? (
        <form className="members__form" onSubmit={onSubmit}>
          <label className="members__label" htmlFor={reasonId}>
            {t('support.reasonLabel')}
          </label>
          {/* An example, not just a minimum length.
              Eight of the first thirteen real grants carried the consequence notice below
              pasted in as the reason: the form asked for twenty characters, and the nearest
              twenty characters on screen were ours. That is not somebody gaming a field —
              it is a field that showed a rule and no example, and the audit trail ended up
              with eight rows that explain nothing. */}
          <textarea
            aria-describedby={`${reasonId}-hint`}
            className="members__reason"
            id={reasonId}
            maxLength={500}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            placeholder={t('support.reasonPlaceholder')}
            required
            rows={2}
            value={reason}
          />
          <p className="members__hint" id={`${reasonId}-hint`}>
            {t('support.reasonHint')}
          </p>
          <p className="members__warning">
            {t('support.consequence', { name: member.fullName, tenant: member.tenantName })}
          </p>
          {begin.isError ? (
            <p className="members__error" role="alert">
              {t(`support.errors.${errorCode(begin.error)}`, {
                defaultValue: t('support.errors.generic'),
              })}
            </p>
          ) : null}
          <div className="members__actions">
            <button className="button" disabled={begin.isPending} type="submit">
              {begin.isPending ? t('support.entering') : t('support.confirmEnter')}
            </button>
            <button
              className="members__cancel"
              onClick={() => {
                setOpen(false);
              }}
              type="button"
            >
              {t('support.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <button
          className="members__enter"
          onClick={() => {
            setOpen(true);
          }}
          type="button"
        >
          {t('support.enterAs')}
        </button>
      )}
    </li>
  );
}

function errorCode(error: unknown): string {
  return error instanceof PlatformError ? error.code : 'generic';
}
