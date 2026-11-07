import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../../shared/auth/SessionProvider.js';
import { Card, Skeleton } from '../../../shared/design/primitives.js';
import { THEME_PREFERENCES, useTheme } from '../../../shared/theme/ThemeProvider.js';

import './ProfilePage.css';

/**
 * The person, and the few things about the product that are theirs to set.
 *
 * Everything here is read back from the verified session — the name, the role, the company
 * — rather than from anything the client holds an opinion about. It is the one screen that
 * answers "who does this system think I am, and whose books am I in?", which on a product
 * with support access (§8.1) is a question worth being able to ask.
 *
 * Read-only by design: there is no endpoint to change a name or a password from here, and
 * a form that pretends otherwise is worse than its absence. Changing either is an
 * authentication event and belongs behind step-up auth when it is built.
 */
export function ProfilePage() {
  const { t } = useTranslation('identity');
  const { state } = useSession();

  // The route guard has already resolved the session, so this is a type narrowing rather
  // than a real state — but a skeleton is the honest thing to render if that ever changes.
  if (state.status !== 'authenticated') return <Skeleton rows={4} />;

  const { session } = state;

  return (
    <div className="profile">
      <Card title={t('profile.account.title')}>
        <dl className="profile__facts">
          <div className="profile__fact">
            <dt className="profile__term">{t('profile.account.name')}</dt>
            <dd className="profile__value">{session.user.fullName}</dd>
          </div>
          <div className="profile__fact">
            <dt className="profile__term">{t('profile.account.email')}</dt>
            <dd className="profile__value">{session.user.email}</dd>
          </div>
          <div className="profile__fact">
            <dt className="profile__term">{t('profile.account.role')}</dt>
            <dd className="profile__value">
              {t(`session.role.${session.user.roleCode}`, { defaultValue: session.user.roleCode })}
            </dd>
          </div>
        </dl>
        <p className="profile__note">{t('profile.account.readOnly')}</p>
      </Card>

      <Card title={t('profile.company.title')}>
        {session.tenant === null ? (
          <p className="profile__value">{t('profile.company.platform')}</p>
        ) : (
          <dl className="profile__facts">
            <div className="profile__fact">
              <dt className="profile__term">{t('profile.company.name')}</dt>
              <dd className="profile__value">{session.tenant.name}</dd>
            </div>
            <div className="profile__fact">
              <dt className="profile__term">{t('profile.company.timezone')}</dt>
              {/* Shown because it decides which day a figure lands on. A due date read in
                  the browser's zone instead of the company's is off by one for half the
                  day, and that moves revenue between periods. */}
              <dd className="profile__value">{session.tenant.timezone}</dd>
            </div>
          </dl>
        )}
      </Card>

      <Card title={t('profile.appearance.title')}>
        <ThemeChoice />
      </Card>
    </div>
  );
}

/**
 * The theme switch.
 *
 * A real radio group: three mutually exclusive options, so the arrow keys move between
 * them, the group announces itself once, and the choice is readable to a screen reader
 * without any ARIA of our own. A row of buttons would look identical and do none of that.
 */
function ThemeChoice() {
  const { t } = useTranslation('identity');
  const { preference, resolved, setPreference } = useTheme();
  const hintId = useId();

  return (
    <fieldset aria-describedby={hintId} className="theme-choice">
      <legend className="theme-choice__legend">{t('profile.appearance.legend')}</legend>
      <p className="theme-choice__hint" id={hintId}>
        {t('profile.appearance.hint')}
      </p>

      <div className="theme-choice__options">
        {THEME_PREFERENCES.map((option) => (
          <label className="theme-choice__option" key={option}>
            <input
              checked={preference === option}
              className="theme-choice__input"
              name="theme"
              onChange={() => {
                setPreference(option);
              }}
              type="radio"
              value={option}
            />
            <span className="theme-choice__label">{t(`profile.appearance.option.${option}`)}</span>
          </label>
        ))}
      </div>

      {/* Announced on change, because the one person who cannot see the screen repaint is
          exactly the person who needs telling that it did. */}
      <p className="theme-choice__resolved" role="status">
        {t('profile.appearance.current', {
          theme: t(`profile.appearance.resolved.${resolved}`),
        })}
      </p>
    </fieldset>
  );
}
