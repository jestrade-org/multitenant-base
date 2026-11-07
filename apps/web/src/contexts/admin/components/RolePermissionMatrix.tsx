import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PermissionEntry, RoleEntry } from '../api/iamClient.js';

import './RolePermissionMatrix.css';

/**
 * Roles down the side, capabilities across the top (VC-74).
 *
 * Shared by the platform panel and the tenant panel, because the question is the same in
 * both — *who can do what* — and two implementations of that question drift, which on a
 * permissions screen means one of them eventually shows a grant that is not real.
 *
 * A real `<table>` with `<caption>`, `<th scope>` and a checkbox per cell. A grid of divs
 * would read to a screen reader as a wall of checkboxes with no idea which role or which
 * capability each belongs to — which is precisely the information the screen exists to
 * convey. Each checkbox is labelled with both axes for the same reason.
 *
 * Capabilities are grouped by bounded context, so an administrator scans `iam` as a
 * block rather than hunting alphabetically through twenty-two rows.
 */

export interface RolePermissionMatrixProps {
  readonly roles: readonly RoleEntry[];
  readonly permissions: readonly PermissionEntry[];
  /** Absent in read-only mode — the platform panel views a tenant without editing it. */
  readonly onToggle?: (input: {
    readonly roleId: string;
    readonly permission: string;
    readonly granted: boolean;
  }) => void;
  /** Capabilities the current user cannot grant, because they do not hold them. */
  readonly grantable?: readonly string[];
  readonly pendingRoleId?: string;
}

export function RolePermissionMatrix({
  roles,
  permissions,
  onToggle,
  grantable,
  pendingRoleId,
}: RolePermissionMatrixProps) {
  const { t } = useTranslation('admin');
  const captionId = useId();

  const byContext = useMemo(() => {
    const grouped = new Map<string, PermissionEntry[]>();
    for (const permission of permissions) {
      const list = grouped.get(permission.context) ?? [];
      list.push(permission);
      grouped.set(permission.context, list);
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [permissions]);

  const readOnly = onToggle === undefined;

  return (
    <div className="matrix__scroll">
      <table aria-describedby={captionId} className="matrix">
        <caption className="matrix__caption" id={captionId}>
          {t('roles.matrix.caption')}
        </caption>

        <thead>
          <tr>
            <th className="matrix__corner" scope="col">
              {t('roles.matrix.role')}
            </th>
            {byContext.map(([context, entries]) => (
              <th colSpan={entries.length} key={context} scope="colgroup">
                {t(`roles.contexts.${context}`, { defaultValue: context })}
              </th>
            ))}
          </tr>
          <tr>
            <th className="matrix__corner" scope="col">
              <span className="visually-hidden">{t('roles.matrix.role')}</span>
            </th>
            {byContext.flatMap(([, entries]) =>
              entries.map((permission) => (
                <th className="matrix__capability" key={permission.code} scope="col">
                  {/* The code, not a translation: it is the contract the server enforces,
                      and showing a friendly name would hide which capability is really
                      being granted. The description is the tooltip. */}
                  <abbr title={permission.description}>{permission.code.split(':')[1]}</abbr>
                </th>
              )),
            )}
          </tr>
        </thead>

        <tbody>
          {roles.map((role) => (
            <tr key={role.id}>
              <th className="matrix__role" scope="row">
                <span className="matrix__role-name">{role.name}</span>
                <code className="matrix__role-code">{role.code}</code>
                {role.isSystem ? (
                  <span className="matrix__badge">{t('roles.matrix.system')}</span>
                ) : null}
              </th>

              {byContext.flatMap(([, entries]) =>
                entries.map((permission) => {
                  const granted = role.permissions.includes(permission.code);
                  // A system role is the same for every client, so editing it here would
                  // change it for all of them. A capability the user does not hold cannot
                  // be granted at all — the server refuses, and a control that looks
                  // usable and is not teaches people to distrust the screen.
                  const editable =
                    !readOnly &&
                    !role.isSystem &&
                    (grantable === undefined || grantable.includes(permission.code));

                  return (
                    <td className="matrix__cell" key={permission.code}>
                      <input
                        aria-label={t('roles.matrix.cellLabel', {
                          role: role.name,
                          permission: permission.code,
                        })}
                        checked={granted}
                        disabled={!editable || pendingRoleId === role.id}
                        onChange={(event) =>
                          onToggle?.({
                            roleId: role.id,
                            permission: permission.code,
                            granted: event.target.checked,
                          })
                        }
                        type="checkbox"
                      />
                    </td>
                  );
                }),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
