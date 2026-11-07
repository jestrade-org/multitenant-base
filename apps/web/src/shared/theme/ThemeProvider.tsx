import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';

/**
 * The colour theme, as the person reading the screen chose it.
 *
 * Three states, not two. `tokens.css` resolves every colour through `light-dark()`, which
 * follows the `color-scheme` of the document: unset, it tracks the operating system; set to
 * one theme, it pins there. A two-way switch would throw away the first of those, and
 * somebody whose laptop turns dark at sunset would have to come back here twice a day.
 *
 * Because the branch is chosen by CSS rather than by us, "sistema" needs no listener to
 * *work* — the browser repaints on its own when the OS flips. `useSyncExternalStore` below
 * exists only so the screen can *say* which way it currently resolves. A setting whose
 * effect you cannot see is a setting nobody trusts.
 */

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
/** What `system` actually came out as. Never `system` — that is a preference, not a theme. */
export type ResolvedTheme = 'light' | 'dark';

/**
 * A display preference, so `localStorage` is the right home for it: it survives a reload,
 * it is per-device (the point — the phone on the desk and the laptop in the sun are not the
 * same reading conditions), and it is worthless to an attacker. Nothing that authenticates
 * anybody goes here; the session lives in httpOnly cookies the client cannot read
 * (`security-iaaa.md` §2).
 */
const STORAGE_KEY = 'app.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** `localStorage` is input from outside the process, so it is `unknown` until checked. */
function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function readStoredPreference(): ThemePreference {
  try {
    const stored: unknown = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    // Storage throws rather than returns null when a browser has it disabled, and in
    // Safari's private mode. Handled rather than propagated on purpose: the honest
    // fallback for a colour preference is the system's, and refusing to render the
    // app over one is the wrong trade.
    return 'system';
  }
}

/**
 * Points the document at a theme.
 *
 * Exported so it can run before React mounts. Setting this after first paint is what
 * produces the white flash on a dark-themed device — a small thing at a desk, and a
 * genuinely unpleasant one on a phone at night.
 */
export function applyPreference(preference: ThemePreference): void {
  if (preference === 'system') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }
  document.documentElement.setAttribute('data-theme', preference);
}

/** The bootstrap call, for the entry point: read what they chose last time and honour it. */
export function applyStoredPreference(): void {
  applyPreference(readStoredPreference());
}

function subscribeToSystemTheme(onChange: () => void): () => void {
  // jsdom has no `matchMedia`, and neither do some embedded browsers. Reporting "claro"
  // there is wrong only cosmetically; throwing would take the whole page down.
  if (typeof window.matchMedia !== 'function') return () => undefined;

  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

interface ThemeContextValue {
  readonly preference: ThemePreference;
  /** The theme now on screen, with `system` already resolved. */
  readonly resolved: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [preference, setStoredPreference] = useState<ThemePreference>(readStoredPreference);
  const systemTheme = useSyncExternalStore(subscribeToSystemTheme, readSystemTheme);

  // Synchronising with the DOM outside React's tree, which is what an effect is for.
  useEffect(() => {
    applyPreference(preference);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredPreference(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Same trade as reading: the theme still changes for this tab, it just will not
      // survive a reload. Losing the preference beats losing the screen.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved: preference === 'system' ? systemTheme : preference,
      setPreference,
    }),
    [preference, systemTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme was called outside ThemeProvider.');
  return value;
}
