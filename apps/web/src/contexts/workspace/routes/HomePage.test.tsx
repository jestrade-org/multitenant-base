import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomePage } from './HomePage.js';
import { SessionProvider } from '../../../shared/auth/SessionProvider.js';
// Side-effectful: initialises i18next, so assertions are on the Spanish a user reads.
import '../../../shared/i18n/index.js';
import { accessibilityViolations } from '../../../shared/testing/accessibility.js';

/**
 * The company home screen.
 *
 * It must name the company from the verified session — the tenant the server bound the
 * person to — and offer only the screens their capabilities reach.
 */

const MEMBER_SESSION = {
  user: { fullName: 'Jordan Lee', email: 'member@acme.test', roleCode: 'member' },
  tenant: { name: 'Acme Logistics Inc.', subdomain: 'acme', timezone: 'America/New_York' },
  permissions: ['tenancy:read'],
  supportAccess: null,
};

const ADMIN_SESSION = {
  ...MEMBER_SESSION,
  user: { fullName: 'Alex Morgan', email: 'admin@acme.test', roleCode: 'tenant_admin' },
  permissions: ['tenancy:read', 'iam:user_manage'],
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

/** The visible label of a shortcut tile, without the hint line beneath it. */
function shortcutLabel(link: HTMLElement): string {
  return link.querySelector('.home__shortcut-label')?.textContent ?? '';
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <HomePage />
      </SessionProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubSession(MEMBER_SESSION);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the home screen', () => {
  it('has no automatically detectable accessibility violations', async () => {
    const { container } = renderPage();
    await screen.findByText('Hola, Jordan Lee.');

    await expect(accessibilityViolations(container)).resolves.toEqual([]);
  });

  it('names the company the session is bound to', async () => {
    renderPage();

    expect(await screen.findByText('Empresa activa: Acme Logistics Inc.')).toBeDefined();
  });

  it('offers a member only the screens every session has', async () => {
    renderPage();
    await screen.findByText('Hola, Jordan Lee.');

    expect(screen.getAllByRole('link').map(shortcutLabel)).toEqual(['Mi perfil']);
  });

  it('offers an administrator the user and role screens', async () => {
    stubSession(ADMIN_SESSION);
    renderPage();
    await screen.findByText('Hola, Alex Morgan.');

    expect(screen.getAllByRole('link').map(shortcutLabel)).toEqual([
      'Administrar usuarios',
      'Roles y permisos',
      'Mi perfil',
    ]);
  });
});
