import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantUsersLink } from './TenantUsersLink.js';
import { SessionProvider } from '../../../shared/auth/SessionProvider.js';
// Side-effectful: initialises i18next, so the assertions are on the Spanish a user sees.
import '../../../shared/i18n/index.js';

/**
 * The way into a client's people, on every screen that lists companies (§8.1, VC-101).
 *
 * The assertion that matters is the negative one. Opening a client's user list needs
 * `platform:support_access`, and an operator can hold `platform:plan_manage` without it —
 * repricing what a client is sold is not the same power as reading their books as one of
 * their own people. Offering that operator a link to a page that answers 401 is how an
 * interface teaches people it cannot be trusted about what they can do.
 */

const TENANT_ID = '4cbf600e-a35a-4810-a36b-1f69d2c656c3';

function renderWith(permissions: readonly string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            user: { fullName: 'Daniel Ospina', email: 'plataforma@example.test', roleCode: 'x' },
            tenant: null,
            permissions,
            supportAccess: null,
          }),
      }),
    ),
  );

  return render(
    <MemoryRouter>
      <SessionProvider>
        <TenantUsersLink name="Acme Logistics Inc." tenantId={TENANT_ID} />
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('an operator who may enter a client account', () => {
  it('gets the company name as a link to its people', async () => {
    renderWith(['platform:plan_manage', 'platform:support_access']);

    const link = await screen.findByRole('link', { name: 'Acme Logistics Inc.' });
    expect(link.getAttribute('href')).toBe(`/plataforma/empresas/${TENANT_ID}/usuarios`);
  });

  it('says where it goes, for anyone who wants to know before clicking', async () => {
    renderWith(['platform:support_access']);

    const link = await screen.findByRole('link', { name: 'Acme Logistics Inc.' });
    expect(link.getAttribute('title')).toBe('Ver los usuarios de Acme Logistics Inc.');
  });
});

describe('an operator who may not', () => {
  it('sees the name and no link, rather than a door that will not open', async () => {
    renderWith(['platform:plan_manage', 'platform:tenant_manage']);

    expect(await screen.findByText('Acme Logistics Inc.')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
