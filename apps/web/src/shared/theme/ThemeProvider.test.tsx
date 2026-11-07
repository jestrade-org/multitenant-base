import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyStoredPreference,
  readStoredPreference,
  ThemeProvider,
  useTheme,
} from './ThemeProvider.js';
import { installFakeLocalStorage } from '../testing/localStorage.js';

/**
 * The theme preference, and the two things that can go wrong with it.
 *
 * One: what comes back out of `localStorage` is whatever was last written there, by any
 * version of this app or by a person with a console open. It is input, and it is checked.
 *
 * Two: a browser may refuse storage entirely. A colour preference is not worth a blank
 * screen, so the failure is a fallback rather than a throw — asserted here, because the
 * catch that makes it true is invisible until it is deleted.
 */

const STORAGE_KEY = 'app.theme';

let storage: ReturnType<typeof installFakeLocalStorage>;

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div>
      <p>{`preference:${preference}`}</p>
      <p>{`resolved:${resolved}`}</p>
      <button
        onClick={() => {
          setPreference('dark');
        }}
        type="button"
      >
        oscuro
      </button>
    </div>
  );
}

beforeEach(() => {
  storage = installFakeLocalStorage();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reading the stored preference', () => {
  it('returns what was stored when it is one of the three themes', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');

    expect(readStoredPreference()).toBe('dark');
  });

  it('falls back to the system when the stored value is not a theme', () => {
    // The shape this takes in practice: a key renamed between releases, leaving the old
    // value behind. Trusting it would put an unknown string on `data-theme`.
    window.localStorage.setItem(STORAGE_KEY, 'solarized');

    expect(readStoredPreference()).toBe('system');
  });

  it('falls back to the system when storage itself throws', () => {
    // Not hypothetical: a browser with storage disabled, and Safari in private mode,
    // throw on access rather than returning null.
    storage.refuseEverything();

    expect(readStoredPreference()).toBe('system');
  });
});

describe('applying the stored preference before React mounts', () => {
  it('pins the document to the stored theme', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');

    applyStoredPreference();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('leaves the document unpinned when the choice is the system', () => {
    // Absence is the signal: `tokens.css` resolves `light-dark()` against the OS only
    // while no `data-theme` is set. Writing `data-theme="system"` would pin it to light.
    document.documentElement.setAttribute('data-theme', 'dark');
    window.localStorage.setItem(STORAGE_KEY, 'system');

    applyStoredPreference();

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('choosing a theme', () => {
  it('puts the choice on the document and keeps it for the next visit', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'oscuro' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('still changes the theme when storage refuses the write', async () => {
    storage.refuseWrites();

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'oscuro' }));

    // The preference is lost on reload, which is the acceptable half of the trade.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('reports light when the browser cannot answer what the system prefers', () => {
    // jsdom has no `matchMedia`, which is exactly the case the guard exists for.
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(screen.getByText('preference:system')).toBeDefined();
    expect(screen.getByText('resolved:light')).toBeDefined();
  });

  it('follows the operating system while the choice is the system', () => {
    const listeners = new Set<() => void>();
    let prefersDark = false;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return prefersDark;
        },
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      })),
    );

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByText('resolved:light')).toBeDefined();

    act(() => {
      prefersDark = true;
      listeners.forEach((listener) => {
        listener();
      });
    });

    expect(screen.getByText('resolved:dark')).toBeDefined();
  });
});
