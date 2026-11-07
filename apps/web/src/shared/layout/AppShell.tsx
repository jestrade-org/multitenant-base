import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router-dom';

import { useSession } from '../auth/SessionProvider.js';
import { endSupportAccess } from '../auth/supportAccess.js';

import './AppShell.css';

/**
 * The frame every screen sits in, drawn to the navigation of the MVP designs: a standing
 * menu down the left, the brand and the scope at the top of it, and the person who is
 * signed in at the bottom.
 *
 * One bundle for every role: what a person sees comes from the permission model (§8.3),
 * never from a per-tenant code flag. Hiding a control is UX — the server still checks.
 *
 * The navigation is a real `<nav>` with links, not buttons that push history. A person
 * needs to be able to send someone the URL of the view they are looking at,
 * and a link is also what makes middle-click, bookmarking and the back button work
 * without any code from us.
 */

interface NavItem {
  readonly to: string;
  readonly labelKey: string;
  /** Permission the item is gated on. */
  readonly requires: string;
}

interface NavGroup {
  readonly id: string;
  /**
   * Shown above the group, unless it is the only group on screen — a person who can see
   * nothing but the platform section does not need it labelled twice, once under the
   * brand and once over the only list there is.
   */
  readonly labelKey: string;
  readonly items: readonly NavItem[];
}

/**
 * The menu, in three sections.
 *
 * These are three separate audiences — the company's screens, the company's own
 * administration, the platform panel — and no one person normally holds all three. They are one list here, grouped and gated, so a session that does hold two of
 * them gets one coherent menu rather than a screen that changes shape as they navigate.
 */
const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'company',
    labelKey: 'nav.group.company',
    // A project built on this base adds its own modules' screens to this group, each
    // gated on the capability its endpoints check.
    items: [{ to: '/inicio', labelKey: 'nav.home', requires: 'tenancy:read' }],
  },
  {
    // The tenant's own administration. Hidden from anyone without the capability — which
    // is UX, not security: the server checks again on every request.
    id: 'administration',
    labelKey: 'nav.group.administration',
    items: [
      { to: '/administracion/usuarios', labelKey: 'nav.members', requires: 'iam:user_manage' },
      { to: '/administracion/roles', labelKey: 'nav.roles', requires: 'iam:user_manage' },
    ],
  },
  {
    // Platform staff. Their capabilities exist in no tenant role, so this section never
    // appears for a company's user however senior. The operator holds `queue_monitor`
    // without `tenant_manage`, so they see the queues and not the companies — the permission
    // model doing its job, not a special case.
    id: 'platform',
    labelKey: 'nav.group.platform',
    items: [
      { to: '/plataforma/empresas', labelKey: 'nav.tenants', requires: 'platform:tenant_manage' },
      { to: '/plataforma/planes', labelKey: 'nav.plans', requires: 'platform:plan_manage' },
      { to: '/plataforma/colas', labelKey: 'nav.queues', requires: 'platform:queue_monitor' },
      { to: '/plataforma/auditoria', labelKey: 'nav.audit', requires: 'audit:read_all' },
    ],
  },
];

export function AppShell() {
  const { t } = useTranslation('common');
  const { t: ti } = useTranslation('identity');
  const { state, signOut, can } = useSession();
  const session = state.status === 'authenticated' ? state.session : undefined;
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [returning, setReturning] = useState(false);
  const [returnFailed, setReturnFailed] = useState(false);

  // Showing a menu item that leads to a 403 is worse than not showing it: the person
  // clicks, is refused, and learns the interface cannot be trusted about what they can do.
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => can(item.requires)),
  })).filter((group) => group.items.length > 0);

  // Platform staff belong to no company (§8.1), and their panel is the darker one. It follows the session rather than the route, so the frame does not change
  // colour under someone as they navigate.
  const isPlatformStaff = session?.tenant === null;

  /**
   * Hand the client's account back.
   *
   * A full navigation afterwards, not a cache invalidation: every permission in the
   * running app has just changed, and re-deriving that from a patched cache is how a
   * screen ends up rendering one person's menu over another person's data.
   */
  async function onReturn(): Promise<void> {
    setReturnFailed(false);
    setReturning(true);
    try {
      await endSupportAccess();
      window.location.assign('/');
    } catch {
      // Still inside the client's account. Saying so is the only honest option: someone
      // who believes they left and has not is about to act as somebody else by accident.
      setReturning(false);
      setReturnFailed(true);
    }
  }

  async function onSignOut(): Promise<void> {
    setSignOutFailed(false);
    try {
      await signOut();
    } catch {
      // Still signed in. Saying so is the only honest option: a person who walks away
      // from a shared screen believing they logged out is the harm this avoids.
      setSignOutFailed(true);
    }
  }

  return (
    <>
      {/* First thing in the tab order: a keyboard user should not have to walk the whole
          menu on every page to reach the content. */}
      <a className="skip-link" href="#main">
        {t('nav.skipToContent')}
      </a>

      {/* Above everything, on every screen, for as long as the grant lasts. A support
          session the person stops noticing is how a change lands in the wrong company —
          and the company reads our name on it afterwards either way. */}
      {session?.supportAccess == null ? null : (
        <div className="support-bar" role="status">
          <p className="support-bar__text">
            <strong>{t('support.acting')}</strong>{' '}
            {t('support.actingDetail', {
              staff: session.supportAccess.staffFullName,
              user: session.user.fullName,
              tenant: session.tenant?.name ?? '',
            })}
          </p>
          <button
            className="support-bar__return"
            disabled={returning}
            onClick={() => void onReturn()}
            type="button"
          >
            {returning ? t('support.returning') : t('support.return')}
          </button>
          {returnFailed ? (
            <p className="support-bar__error" role="alert">
              {t('support.returnFailed')}
            </p>
          ) : null}
        </div>
      )}

      <div className={`shell${isPlatformStaff ? ' shell--platform' : ''}`}>
        <nav aria-label={t('nav.label')} className="shell__nav">
          <div className="shell__brand">
            <span className="shell__mark">{t('app.name')}</span>
            <span className="shell__scope">
              {isPlatformStaff ? t('nav.scope.platform') : t('nav.scope.company')}
            </span>
          </div>

          <div className="shell__sections">
            {groups.map((group) => (
              <div className="shell__section" key={group.id}>
                {groups.length === 1 ? null : (
                  <p className="shell__section-label" id={`nav-${group.id}`}>
                    {t(group.labelKey)}
                  </p>
                )}
                <ul
                  aria-labelledby={groups.length === 1 ? undefined : `nav-${group.id}`}
                  className="shell__nav-list"
                >
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        className={({ isActive }) =>
                          `shell__nav-link${isActive ? ' shell__nav-link--active' : ''}`
                        }
                        to={item.to}
                      >
                        <span className="shell__nav-text">{t(item.labelKey)}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {session === undefined ? null : (
            <div className="shell__session">
              {/* Their own name is the way in to their own settings — the convention
                  everywhere else, and it costs the menu no new row. It is deliberately not
                  a gated nav item: every session has a profile. */}
              <p className="shell__user">
                <NavLink
                  className={({ isActive }) =>
                    `shell__profile${isActive ? ' shell__profile--active' : ''}`
                  }
                  to="/perfil"
                >
                  {session.user.fullName}
                </NavLink>
              </p>
              <p className="shell__role">
                {ti(`session.role.${session.user.roleCode}`, {
                  defaultValue: session.user.roleCode,
                })}
              </p>
              {/* The company name comes from the verified session, not from a constant:
                  what a person sees has to be the tenant the server bound them to. Staff
                  belong to no company, and saying so beats an empty line that reads as a
                  name which failed to load. */}
              <p className="shell__tenant">{session.tenant?.name ?? t('nav.platformScope')}</p>
              <button className="shell__signout" onClick={() => void onSignOut()} type="button">
                {ti('session.signOut')}
              </button>
            </div>
          )}
        </nav>

        <div className="shell__content">
          {signOutFailed ? (
            <p className="shell__signout-error" role="alert">
              {ti('session.signOutFailed')}
            </p>
          ) : null}

          <main className="shell__main" id="main">
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
