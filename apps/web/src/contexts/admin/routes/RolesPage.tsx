import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../../shared/auth/SessionProvider.js';
import { Card, EmptyState, ErrorState, Skeleton } from '../../../shared/design/primitives.js';
import { HttpIamClient, type RoleEntry } from '../api/iamClient.js';
import { RolePermissionMatrix } from '../components/RolePermissionMatrix.js';

import './RolesPage.css';

/**
 * Who can do what, for one tenant (VC-31, VC-74, part of VC-77).
 *
 * The matrix is the whole screen. An administrator's question is never "what does the
 * `member` role contain" in isolation — it is "who can manage users", which is a
 * column, and "what can this person do", which is a row. A list of roles with a detail page
 * answers neither without clicking through all of them.
 */

const client = new HttpIamClient();

export function RolesPage() {
  const { t } = useTranslation('admin');
  const queryClient = useQueryClient();
  const { can, state } = useSession();
  const [failedRoleId, setFailedRoleId] = useState<string | undefined>();

  const permissions = useQuery({
    queryKey: ['iam', 'permissions'],
    queryFn: ({ signal }) => client.listPermissions(signal),
    staleTime: 5 * 60 * 1000,
  });

  const roles = useQuery({
    queryKey: ['iam', 'roles'],
    queryFn: ({ signal }) => client.listRoles(signal),
  });

  const setPermissions = useMutation({
    mutationFn: (input: { roleId: string; permissions: readonly string[] }) =>
      client.setPermissions(input.roleId, input.permissions),
    onMutate: () => {
      setFailedRoleId(undefined);
    },
    onError: (_error, input) => {
      // No optimistic update: this is an authorization change, and showing a grant that the
      // server refused is the one lie a permissions screen must never tell. The refetch in
      // `onSettled` puts the checkbox back where the server says it belongs.
      setFailedRoleId(input.roleId);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['iam', 'roles'] }),
  });

  /**
   * What this administrator may hand out.
   *
   * The domain refuses to grant a capability the actor does not hold, and the server is
   * the authority. Reflecting it here is honesty rather than security: a checkbox that
   * looks usable and is not teaches people to distrust the screen.
   */
  const grantable = useMemo(
    () => (state.status === 'authenticated' ? state.session.permissions : []),
    [state],
  );

  if (permissions.isPending || roles.isPending) {
    // A skeleton shaped like the matrix, not a spinner: the layout should not jump when
    // twenty-two columns arrive.
    return (
      <Card title={t('roles.matrix.title')}>
        <Skeleton rows={5} />
      </Card>
    );
  }

  if (permissions.isError || roles.isError) {
    return (
      <ErrorState
        message={t('roles.error')}
        onRetry={() => {
          void permissions.refetch();
          void roles.refetch();
        }}
        retryLabel={t('roles.retry')}
      />
    );
  }

  if (roles.data.length === 0) {
    return <EmptyState message={t('roles.empty')} />;
  }

  const readOnly = !can('iam:role_manage');

  return (
    <div className="roles">
      <header className="roles__header">
        <h1>{t('roles.title')}</h1>
        <p className="roles__intro">{readOnly ? t('roles.readOnlyIntro') : t('roles.intro')}</p>
      </header>

      {failedRoleId === undefined ? null : (
        <p className="roles__error" role="alert">
          {t('roles.changeRejected')}
        </p>
      )}

      <Card title={t('roles.matrix.title')}>
        <RolePermissionMatrix
          grantable={grantable}
          permissions={permissions.data}
          roles={roles.data}
          {...(readOnly
            ? {}
            : {
                onToggle: ({ roleId, permission, granted }) => {
                  const role = roles.data.find((candidate) => candidate.id === roleId);
                  if (role === undefined) return;
                  setPermissions.mutate({
                    roleId,
                    permissions: nextPermissions(role, permission, granted),
                  });
                },
              })}
          {...(setPermissions.isPending ? { pendingRoleId: setPermissions.variables.roleId } : {})}
        />
      </Card>
    </div>
  );
}

/** The role's capabilities with one added or removed. Never mutates the existing array. */
function nextPermissions(role: RoleEntry, permission: string, granted: boolean): readonly string[] {
  return granted
    ? [...role.permissions, permission]
    : role.permissions.filter((held) => held !== permission);
}
