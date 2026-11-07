import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfilePage } from './ProfilePage.js';
import { SessionProvider } from '../../../shared/auth/SessionProvider.js';
// Side-effectful: initialises i18next. Without it every label renders as its key, and a
// test asserting on Spanish copy would be asserting on nothing a user ever sees.
import '../../../shared/i18n/index.js';
import { accessibilityViolations } from '../../../shared/testing/accessibility.js';
import { installFakeLocalStorage } from '../../../shared/testing/localStorage.js';
import { ThemeProvider } from '../../../shared/theme/ThemeProvider.js';

/**
 * The profile screen.
 *
 * Two things are worth asserting here. The identity block must read back the *session* —
 * on a product where platform staff can act inside a client's account, "whose books am I in?"
 * is a question this screen has to answer truthfully. And the theme control must be a real
 * radio group, because a segmented control built from styled buttons looks identical and
 * is unusable with a keyboard.
 */

const SESSION = {
  user: { fullName: 'Marcela Ortiz', email: 'member@acme.test', roleCode: 'member' },
  tenant: { name: 'Acme Logistics Inc.', subdomain: 'acme', timezone: 'America/Bogota' },
  permissions: ['tenancy:read'],
  supportAccess: null,
};

const PLATFORM_SESSION = {
  user: { fullName: 'Ana Restrepo', email: 'ana@example.test', roleCode: 'platform_operator' },
  tenant: null,
  permissions: ['platform:queue_monitor'],
  supportAccess: null,
};

function respond(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubSession(session: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      if (input.includes('/auth/me')) return Promise.resolve(respond(session));
      return Promise.reject(new Error(`unexpected request to ${input}`));
    }),
  );
}

beforeEach(() => {
  installFakeLocalStorage();
  document.documentElement.removeAttribute('data-theme');
  stubSession(SESSION);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <ThemeProvider>
      <SessionProvider>
        <ProfilePage />
      </SessionProvider>
    </ThemeProvider>,
  );
}

describe('the profile screen', () => {
  it('has no automatically detectable accessibility violations', async () => {
    const { container } = renderPage();
    await screen.findByText('Marcela Ortiz');

    await expect(accessibilityViolations(container)).resolves.toEqual([]);
  });

  it('reads the person back from the verified session', async () => {
    renderPage();

    expect(await screen.findByText('Marcela Ortiz')).toBeDefined();
    expect(screen.getByText('member@acme.test')).toBeDefined();
    expect(screen.getByText('Miembro')).toBeDefined();
  });

  it('names the company whose books the session is bound to', async () => {
    renderPage();

    expect(await screen.findByText('Acme Logistics Inc.')).toBeDefined();
    // The zone decides which day a figure lands on, so it is stated rather than assumed.
    expect(screen.getByText('America/Bogota')).toBeDefined();
  });

  it('says so plainly when the session belongs to no company', async () => {
    stubSession(PLATFORM_SESSION);
    renderPage();

    await screen.findByText('Ana Restrepo');
    expect(screen.getByText(/no a una empresa\./)).toBeDefined();
    expect(screen.queryByText('America/Bogota')).toBeNull();
  });

  it('offers no form for the fields the product cannot change', async () => {
    // A disabled-looking name field invites someone to try. There is no endpoint behind
    // it, so there is no field.
    renderPage();
    await screen.findByText('Marcela Ortiz');

    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the theme switch', () => {
  it('offers the three themes as one named radio group', async () => {
    renderPage();
    await screen.findByText('Marcela Ortiz');

    const group = screen.getByRole('group', { name: 'Tema de la interfaz' });
    expect(group).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Sistema' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Claro' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Oscuro' })).toBeDefined();
  });

  it('starts on the system, so a first visit follows the device', async () => {
    renderPage();
    await screen.findByText('Marcela Ortiz');

    expect(screen.getByRole('radio', { name: 'Sistema' })).toHaveProperty('checked', true);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('repaints the app and remembers the choice', async () => {
    renderPage();
    await screen.findByText('Marcela Ortiz');

    await userEvent.click(screen.getByRole('radio', { name: 'Oscuro' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('app.theme')).toBe('dark');
  });

  it('unpins the document again when the system is chosen back', async () => {
    renderPage();
    await screen.findByText('Marcela Ortiz');

    await userEvent.click(screen.getByRole('radio', { name: 'Oscuro' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Sistema' }));

    // Not `data-theme="system"`: only the absence of the attribute lets `light-dark()`
    // track the operating system.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('states the theme now on screen, for a reader who cannot see it change', async () => {
    renderPage();
    await screen.findByText('Marcela Ortiz');

    await userEvent.click(screen.getByRole('radio', { name: 'Oscuro' }));

    expect(screen.getByRole('status').textContent).toContain('oscuro');
  });
});
