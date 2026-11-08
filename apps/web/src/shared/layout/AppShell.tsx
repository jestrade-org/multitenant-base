import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router-dom';

import { NAV_GROUPS } from './navigation.js';
import { useSession } from '../auth/SessionProvider.js';
import { endSupportAccess } from '../auth/supportAccess.js';
import { Icon } from '../design/icons.js';

import './AppShell.css';

/**
 * The frame every screen sits in, in the familiar admin-dashboard layout: a dark sidebar
 * with the brand and the menu, a light top bar that says whose workspace this is and who
 * is signed in, and the screen on a light grey ground.
 *
 * One bundle for every role: what a person sees comes from the permission model (§8.3),
 * never from a per-tenant code flag. Hiding a control is UX — the server still checks.
 *
 * The navigation is a real `<nav>` with links, not buttons that push history, so a URL
 * can be shared and middle-click, bookmarks and the back button work with no code of ours.
 */

/** Up to two initials, for the avatar. Presentation only; the full name sits beside it. */
function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

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

  // Platform staff belong to no company (§8.1). Their frame carries a second mark colour,
  // following the session rather than the route, so it does not change under them as they
  // navigate and a cross-company screen is never mistaken for a single company's.
  const isPlatformStaff = session?.tenant === null;

  /**
   * Hand the company's account back.
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
      // Still inside the company's account. Saying so is the only honest option: someone
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
            <span aria-hidden="true" className="shell__logo">
              {t('app.name').slice(0, 1)}
            </span>
            <span className="shell__mark">{t('app.name')}</span>
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
                        <Icon name={item.icon} />
                        <span className="shell__nav-text">{t(item.labelKey)}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <div className="shell__content">
          <header className="shell__topbar">
            {/* Whose workspace this is, from the verified session — never a constant. Staff
                belong to no company, and saying so beats an empty slot. */}
            <p className="shell__scope">
              <Icon name={isPlatformStaff ? 'shield' : 'building'} size={16} />
              <span className="visually-hidden">
                {isPlatformStaff ? t('nav.scope.platform') : t('nav.scope.company')}:{' '}
              </span>
              <span className="shell__scope-name">
                {session?.tenant?.name ?? t('nav.platformScope')}
              </span>
            </p>

            {session === undefined ? null : (
              <div className="shell__session">
                {/* Their own name is the way in to their own settings — the convention
                    everywhere else. Not a gated nav item: every session has a profile. */}
                <NavLink
                  className={({ isActive }) =>
                    `shell__profile${isActive ? ' shell__profile--active' : ''}`
                  }
                  to="/perfil"
                >
                  <span aria-hidden="true" className="shell__avatar">
                    {initialsOf(session.user.fullName)}
                  </span>
                  <span className="shell__identity">
                    <span className="shell__user">{session.user.fullName}</span>
                    <span className="shell__role">
                      {ti(`session.role.${session.user.roleCode}`, {
                        defaultValue: session.user.roleCode,
                      })}
                    </span>
                  </span>
                </NavLink>
                <button className="shell__signout" onClick={() => void onSignOut()} type="button">
                  <Icon name="logout" size={16} />
                  <span>{ti('session.signOut')}</span>
                </button>
              </div>
            )}
          </header>

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
