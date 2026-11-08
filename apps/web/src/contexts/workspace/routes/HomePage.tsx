import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useSession } from '../../../shared/auth/SessionProvider.js';
import { Icon, type IconName } from '../../../shared/design/icons.js';

import './HomePage.css';

/**
 * The company's landing screen.
 *
 * Deliberately thin. This base ships companies, users and permissions; a project built on
 * it adds its own modules as new bounded contexts beside this one, and their screens join
 * the navigation gated on the capabilities they check. Until then, the home page greets the
 * person, says which company they are acting in, and offers the screens they can reach.
 *
 * Everything shown comes from the verified session — the company name is the tenant the
 * server bound them to, never a constant.
 */
interface Shortcut {
  readonly to: string;
  /** Translation key under `home:shortcuts`; its hint is `<key>Hint`. */
  readonly key: string;
  readonly icon: IconName;
  readonly tone: 'blue' | 'green' | 'amber';
  /** The capability the target screen needs; `undefined` for screens every session has. */
  readonly requires: string | undefined;
}

const SHORTCUTS: readonly Shortcut[] = [
  {
    to: '/administracion/usuarios',
    key: 'members',
    icon: 'users',
    tone: 'blue',
    requires: 'iam:user_manage',
  },
  {
    to: '/administracion/roles',
    key: 'roles',
    icon: 'shield',
    tone: 'green',
    requires: 'iam:user_manage',
  },
  { to: '/perfil', key: 'profile', icon: 'user', tone: 'amber', requires: undefined },
];

export function HomePage() {
  const { t } = useTranslation('home');
  const { state, can } = useSession();
  const session = state.status === 'authenticated' ? state.session : undefined;

  const shortcuts = SHORTCUTS.filter(
    (shortcut) => shortcut.requires === undefined || can(shortcut.requires),
  );

  return (
    <div className="home">
      {session === undefined ? null : (
        <section aria-labelledby="home-welcome" className="home__welcome">
          <h2 className="home__greeting" id="home-welcome">
            {t('welcome', { name: session.user.fullName })}
          </h2>
          {session.tenant === null ? null : (
            <p className="home__company">{t('company', { company: session.tenant.name })}</p>
          )}
          <p className="home__intro">{t('intro')}</p>
        </section>
      )}

      <section aria-labelledby="home-shortcuts" className="home__shortcuts">
        <h2 className="home__section-title" id="home-shortcuts">
          {t('shortcuts.title')}
        </h2>
        <ul className="home__shortcut-list">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.to}>
              <Link className="home__shortcut" to={shortcut.to}>
                <span className={`home__shortcut-icon home__shortcut-icon--${shortcut.tone}`}>
                  <Icon name={shortcut.icon} size={20} />
                </span>
                <span className="home__shortcut-text">
                  <span className="home__shortcut-label">{t(`shortcuts.${shortcut.key}`)}</span>
                  <span className="home__shortcut-hint">{t(`shortcuts.${shortcut.key}Hint`)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
