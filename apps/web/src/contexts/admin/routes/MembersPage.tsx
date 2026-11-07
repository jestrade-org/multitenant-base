import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../../shared/api/apiError.js';
import { useSession } from '../../../shared/auth/SessionProvider.js';
import { Card, EmptyState, ErrorState, Skeleton } from '../../../shared/design/primitives.js';
import { formatInstantAsDate, PLATFORM_TIMEZONE } from '../../../shared/i18n/format.js';
import { HttpIamClient, type MemberEntry, type RoleEntry } from '../api/iamClient.js';

import './MembersPage.css';

/**
 * The company's own users (§9, VC-77).
 *
 * Two refusals are the reason this screen is not a table of toggles: an administrator
 * cannot deactivate themselves, and the last person who can manage users cannot be
 * deactivated or demoted. Both are enforced by the server; the interface explains them in
 * Spanish rather than presenting a control that fails.
 */

const client = new HttpIamClient();

/** Roles a company may give its own people. Derived from capabilities, never from names. */
function assignable(roles: readonly RoleEntry[]): readonly RoleEntry[] {
  return roles.filter((role) => !isPlatformRole(role));
}

function isPlatformRole(role: RoleEntry): boolean {
  return role.permissions.some((capability) => capability.startsWith('platform:'));
}

/**
 * The options for one member's role.
 *
 * Always includes the role they already hold, even when it is one this company could not
 * assign. Dropping it made the select fall back to its first option, so a platform operator
 * was displayed as "Cobranza" — the interface reporting a role the person does not have,
 * one careless change away from actually giving it to them.
 */
function optionsFor(roles: readonly RoleEntry[], current: string): readonly RoleEntry[] {
  const options = assignable(roles);
  if (options.some((role) => role.code === current)) return options;

  const held = roles.find((role) => role.code === current);
  return held === undefined ? options : [held, ...options];
}

export function MembersPage() {
  const { t } = useTranslation('admin');
  const { state } = useSession();

  const timeZone =
    state.status === 'authenticated'
      ? (state.session.tenant?.timezone ?? PLATFORM_TIMEZONE)
      : PLATFORM_TIMEZONE;

  const members = useQuery({
    queryKey: ['iam', 'members'],
    queryFn: ({ signal }) => client.listMembers(signal),
  });

  const roles = useQuery({
    queryKey: ['iam', 'roles'],
    queryFn: ({ signal }) => client.listRoles(signal),
  });

  if (members.isPending || roles.isPending) {
    return (
      <Card title={t('members.title')}>
        <Skeleton rows={5} />
      </Card>
    );
  }

  if (members.isError || roles.isError) {
    return (
      <ErrorState
        message={t('members.error')}
        onRetry={() => void members.refetch()}
        retryLabel={t('members.retry')}
      />
    );
  }

  return (
    <div className="members">
      <p className="members__intro">{t('members.intro')}</p>

      {/* Only the roles a company may actually hand out. A platform role carries
          capabilities that reach every client (§8.1); the server refuses to assign one, and
          offering it here would be an invitation to discover that by being refused. */}
      <InviteForm roles={assignable(roles.data)} />

      <Card title={t('members.title')}>
        {members.data.length === 0 ? (
          <EmptyState message={t('members.empty')} />
        ) : (
          <div className="members__scroll">
            <table className="members__table">
              <caption className="members__caption">{t('members.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('members.columns.person')}</th>
                  <th scope="col">{t('members.columns.role')}</th>
                  <th scope="col">{t('members.columns.status')}</th>
                  <th scope="col">{t('members.columns.since')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('members.columns.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data.map((member) => (
                  <MemberRow
                    key={member.memberId}
                    member={member}
                    roles={roles.data}
                    timeZone={timeZone}
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

function MemberRow({
  member,
  roles,
  timeZone,
}: {
  readonly member: MemberEntry;
  readonly roles: readonly RoleEntry[];
  readonly timeZone: string;
}) {
  const { t } = useTranslation('admin');
  const queryClient = useQueryClient();
  const roleId = useId();

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['iam', 'members'] });
  };

  const changeRole = useMutation({
    mutationFn: (roleCode: string) => client.changeMemberRole(member.memberId, roleCode),
    onSuccess: invalidate,
  });

  const setActive = useMutation({
    mutationFn: (isActive: boolean) => client.setMemberActive(member.memberId, isActive),
    onSuccess: invalidate,
  });

  const failure =
    changeRole.error instanceof ApiError
      ? changeRole.error
      : setActive.error instanceof ApiError
        ? setActive.error
        : undefined;

  return (
    <>
      <tr className={member.isActive ? undefined : 'members__row--inactive'}>
        <th scope="row">
          <span className="members__name">{member.fullName}</span>
          <span className="members__email">{member.email}</span>
        </th>
        <td>
          <label className="visually-hidden" htmlFor={roleId}>
            {t('members.changeRoleFor', { name: member.fullName })}
          </label>
          <select
            disabled={changeRole.isPending}
            id={roleId}
            onChange={(event) => {
              changeRole.mutate(event.target.value);
            }}
            value={member.roleCode}
          >
            {optionsFor(roles, member.roleCode).map((role) => (
              // A platform role can be shown but never chosen: the server refuses it, and
              // an option that always fails is worse than one that is not offered.
              <option disabled={isPlatformRole(role)} key={role.code} value={role.code}>
                {role.name}
              </option>
            ))}
          </select>
        </td>
        <td>
          <span
            className={`members__status members__status--${member.isActive ? 'active' : 'inactive'}`}
          >
            {member.isActive ? t('members.status.active') : t('members.status.inactive')}
          </span>
        </td>
        <td>{formatInstantAsDate(member.createdAt, timeZone)}</td>
        <td className="members__actions">
          <button
            className="button button--secondary"
            disabled={setActive.isPending}
            onClick={() => {
              setActive.mutate(!member.isActive);
            }}
            type="button"
          >
            {member.isActive ? t('members.deactivate') : t('members.reactivate')}
          </button>
        </td>
      </tr>

      {failure === undefined ? null : (
        <tr>
          <td colSpan={5}>
            <p className="members__error" role="alert">
              {describeFailure(t, failure)}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The Spanish for a refusal.
 *
 * These two codes are the whole reason the screen is not a grid of switches, so they say
 * what happened and what to do — not "no se pudo".
 */
function describeFailure(t: TFunction<'admin'>, failure: ApiError): string {
  return t(`members.errors.${failure.code}`, { defaultValue: t('members.errors.default') });
}

function InviteForm({ roles }: { readonly roles: readonly RoleEntry[] }) {
  const { t } = useTranslation('admin');
  const queryClient = useQueryClient();
  const nameId = useId();
  const emailId = useId();
  const roleId = useId();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [roleCode, setRoleCode] = useState(roles[0]?.code ?? '');

  const invite = useMutation({
    mutationFn: () =>
      client.inviteMember({ email: email.trim(), fullName: fullName.trim(), roleCode }),
    onSuccess: () => {
      setFullName('');
      setEmail('');
      void queryClient.invalidateQueries({ queryKey: ['iam', 'members'] });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!invite.isPending) invite.mutate();
  }

  const failure = invite.error instanceof ApiError ? invite.error : undefined;

  return (
    <Card title={t('members.invite.title')}>
      <form className="members__form" noValidate onSubmit={onSubmit}>
        <div className="members__field">
          <label htmlFor={nameId}>{t('members.invite.name')}</label>
          <input
            id={nameId}
            onChange={(event) => {
              setFullName(event.target.value);
            }}
            required
            value={fullName}
          />
        </div>

        <div className="members__field">
          <label htmlFor={emailId}>{t('members.invite.email')}</label>
          <input
            id={emailId}
            inputMode="email"
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            required
            type="email"
            value={email}
          />
          <p className="members__hint">{t('members.invite.emailHint')}</p>
        </div>

        <div className="members__field">
          <label htmlFor={roleId}>{t('members.invite.role')}</label>
          <select
            id={roleId}
            onChange={(event) => {
              setRoleCode(event.target.value);
            }}
            value={roleCode}
          >
            {roles.map((role) => (
              <option key={role.code} value={role.code}>
                {role.name}
              </option>
            ))}
          </select>
        </div>

        {failure === undefined ? null : (
          <p className="members__error" role="alert">
            {describeFailure(t, failure)}
          </p>
        )}

        {invite.data === undefined ? null : (
          <p className="members__success" role="status">
            {t('members.invite.sent', { email: invite.data.email })}
          </p>
        )}

        <button
          className="button"
          disabled={invite.isPending || fullName.trim() === '' || email.trim() === ''}
          type="submit"
        >
          {invite.isPending ? t('members.invite.sending') : t('members.invite.submit')}
        </button>
      </form>
    </Card>
  );
}
