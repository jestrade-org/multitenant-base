import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { SignInError, useSession } from '../../../shared/auth/SessionProvider.js';

import './LoginPage.css';

/**
 * Sign in.
 *
 * One message for every failure. The form must not reveal whether an address has an
 * account: a login page that says "no such user" is a way to enumerate a client's staff,
 * and staff lists are what phishing campaigns are built from.
 *
 * The password is never put in component state longer than the submit takes, never
 * logged, and the field is a real `type="password"` with the autocomplete hints a password
 * manager needs — the alternative to a manager is a password people can remember, which
 * is the weaker one.
 */
export function LoginPage() {
  const { t } = useTranslation('identity');
  const { signIn } = useSession();

  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setErrorCode(undefined);
    try {
      await signIn(email.trim(), password);
    } catch (error: unknown) {
      setErrorCode(error instanceof SignInError ? error.code : 'INVALID_CREDENTIALS');
      // Clear the password on failure so a shoulder-surfer does not get a second look,
      // and keep the email so a typo in the password is not punished twice.
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login" id="main">
      <div className="login__card">
        <header className="login__header">
          <span className="login__mark">{t('brand')}</span>
          <h1 className="login__title">{t('signIn.title')}</h1>
          <p className="login__subtitle">{t('signIn.subtitle')}</p>
        </header>

        <form noValidate onSubmit={(event) => void onSubmit(event)}>
          <div className="login__field">
            <label htmlFor={emailId}>{t('signIn.email')}</label>
            <input
              autoComplete="username"
              id={emailId}
              inputMode="email"
              name="email"
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              required
              type="email"
              value={email}
            />
          </div>

          <div className="login__field">
            <label htmlFor={passwordId}>{t('signIn.password')}</label>
            <input
              autoComplete="current-password"
              id={passwordId}
              name="password"
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              required
              type="password"
              value={password}
            />
          </div>

          {errorCode === undefined ? null : (
            <p className="login__error" id={errorId} role="alert">
              {t(`signIn.errors.${errorCode}`, { defaultValue: t('signIn.errors.default') })}
            </p>
          )}

          <button
            aria-describedby={errorCode === undefined ? undefined : errorId}
            className="button login__submit"
            disabled={submitting}
            type="submit"
          >
            {submitting ? t('signIn.submitting') : t('signIn.submit')}
          </button>
        </form>

        <p className="login__note">{t('signIn.demoHint')}</p>
      </div>
    </main>
  );
}
