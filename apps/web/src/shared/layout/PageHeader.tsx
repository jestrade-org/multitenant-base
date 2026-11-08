import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';

import { locateInNavigation } from './navigation.js';

/**
 * The page title and its breadcrumb: where this screen sits in the menu.
 *
 * The trail is read from the same navigation list the sidebar draws, so the two can never
 * name a screen differently. A screen outside the menu — the profile — gets the root and
 * its own title.
 */
export function PageHeader({ title }: { readonly title: string }) {
  const { t } = useTranslation('common');
  const { pathname } = useLocation();
  const located = locateInNavigation(pathname);
  // The group is worth naming only when it is not the screen itself (`Inicio › Inicio`).
  const groupLabel =
    located === undefined || located.item.to === '/inicio' ? undefined : t(located.group.labelKey);
  // A nested screen links back to the menu item it belongs to.
  const parent =
    located !== undefined && located.item.to !== pathname
      ? { to: located.item.to, label: t(located.item.labelKey) }
      : undefined;
  // The home screen *is* the root: a one-step trail under its own title says nothing.
  const isRoot = located?.item.to === '/inicio' && parent === undefined;

  return (
    <header className="page-header">
      <h1 className="page-header__title">{title}</h1>
      {isRoot ? null : (
        <nav aria-label={t('nav.breadcrumbLabel')}>
          <ol className="page-header__crumbs">
            <li>
              <Link to="/">{t('nav.breadcrumbRoot')}</Link>
            </li>
            {groupLabel === undefined ? null : <li>{groupLabel}</li>}
            {parent === undefined ? null : (
              <li>
                <Link to={parent.to}>{parent.label}</Link>
              </li>
            )}
            <li aria-current="page">{title}</li>
          </ol>
        </nav>
      )}
    </header>
  );
}
