import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { formatPercent } from './format.js';
import admin from './locales/es/admin.json';
import common from './locales/es/common.json';
import home from './locales/es/home.json';
import identity from './locales/es/identity.json';
import platform from './locales/es/platform.json';

/**
 * The product is in Spanish; the code is in English.
 *
 * Keys describe meaning, not text: `members.invite.title`, never
 * `members.invitarAlguien` and never `text1`. A key that names its own copy has to be
 * renamed the day the copy changes.
 */
export const SUPPORTED_LANGUAGE = 'es';

// Not awaited: the resources are bundled, so init resolves synchronously and a
// top-level await here would only force the whole app into a module graph the browser
// target cannot express.
void i18n.use(initReactI18next).init({
  lng: SUPPORTED_LANGUAGE,
  fallbackLng: false,
  defaultNS: 'common',
  ns: ['common', 'home', 'identity', 'admin', 'platform'],
  resources: {
    es: { common, home, identity, admin, platform },
  },
  interpolation: {
    escapeValue: false,
    /**
     * Formatters for the values that cross the wire as raw data.
     *
     * The API sends a share as `"1.0000"`, because Spanish text never crosses the wire
     * and a JSON number would lose digits. Without this, a sentence reads "el 1.0000 de
     * su cuota" — technically the right value and unreadable to the person it is for.
     *
     * language-i18n.md: format at the edge with `Intl`, never by hand.
     */
    format: (value, format) => {
      if (format === 'percent' && typeof value === 'string') {
        return formatPercent(Number(value));
      }
      return String(value);
    },
  },
  // A missing key must fail loudly rather than render its own name to a client.
  saveMissing: false,
  missingKeyHandler: (_lngs, ns, key) => {
    const message = `Missing translation: ${ns}:${key}`;
    if (import.meta.env.DEV) throw new Error(message);
  },
});

export { i18n };
