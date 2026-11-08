import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';

import { MembersPage } from './contexts/admin/routes/MembersPage.js';
import { RolesPage } from './contexts/admin/routes/RolesPage.js';
import { LoginPage } from './contexts/identity/routes/LoginPage.js';
import { ProfilePage } from './contexts/identity/routes/ProfilePage.js';
import { AuditPage } from './contexts/platform/routes/AuditPage.js';
import { PlansPage } from './contexts/platform/routes/PlansPage.js';
import { QueuesPage } from './contexts/platform/routes/QueuesPage.js';
import { TenantMembersPage } from './contexts/platform/routes/TenantMembersPage.js';
import { TenantsPage } from './contexts/platform/routes/TenantsPage.js';
import { HomePage } from './contexts/workspace/routes/HomePage.js';
import { useSession } from './shared/auth/SessionProvider.js';
import { EmptyState, Skeleton } from './shared/design/primitives.js';
import { AppShell } from './shared/layout/AppShell.js';
import { PageHeader } from './shared/layout/PageHeader.js';

/**
 * Routing.
 *
 * Paths are Spanish because they are part of the product surface — people read and
 * share them. The code around them stays English.
 *
 * The guard below is UX, not security: it decides what to *render*. Every request the
 * rendered screen makes is checked again by the server, so a user who edits their way
 * past this sees empty screens and 401s rather than another company's data.
 */
function RequireSession({ children }: { readonly children: ReactNode }) {
  const { state } = useSession();

  if (state.status === 'loading') {
    // The client cannot read the session cookie, so on first paint it genuinely does not
    // know. Showing the login form here would flash it at someone already signed in.
    return (
      <main className="shell__main" id="main">
        <Skeleton rows={5} />
      </main>
    );
  }

  if (state.status === 'anonymous') return <Navigate replace to="/entrar" />;
  return <>{children}</>;
}

function RedirectIfSignedIn({ children }: { readonly children: ReactNode }) {
  const { state } = useSession();
  // Not a fixed destination: send them wherever they can actually go. Signing in and
  // landing on a screen that refuses you is a poor first impression.
  if (state.status === 'authenticated') return <Navigate replace to="/" />;
  return <>{children}</>;
}

function Page({
  titleKey,
  namespace,
  children,
}: {
  readonly titleKey: string;
  readonly namespace: string;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation(namespace);
  return (
    <>
      <PageHeader title={t(titleKey)} />
      {children}
    </>
  );
}

/**
 * Sends each person to the first screen they can actually see.
 *
 * A fixed redirect looks harmless until someone signs in whose role does not include the
 * capability that screen needs — platform staff, for instance, who belong to no company.
 * They land on a screen that fails to load, and their first impression of the product is a
 * broken page.
 *
 * The order mirrors the navigation, so the landing page is the first item in their own
 * menu. Nobody with a valid session has no pages at all, but if that ever changes the
 * fallback says so rather than looping.
 */
function LandOnFirstAllowedPage() {
  const { can } = useSession();
  const { t } = useTranslation('common');

  const destination = LANDING_ORDER.find((candidate) => can(candidate.requires));
  if (destination === undefined) {
    return <EmptyState message={t('nav.noAccessibleScreens')} />;
  }

  return <Navigate replace to={destination.to} />;
}

/** Same order as the navigation: the landing page is the first item in their own menu. */
const LANDING_ORDER = [
  { to: '/inicio', requires: 'tenancy:read' },
  { to: '/administracion/usuarios', requires: 'iam:user_manage' },
  { to: '/administracion/roles', requires: 'iam:user_manage' },
  { to: '/plataforma/empresas', requires: 'platform:tenant_manage' },
  { to: '/plataforma/planes', requires: 'platform:plan_manage' },
  { to: '/plataforma/colas', requires: 'platform:queue_monitor' },
  { to: '/plataforma/auditoria', requires: 'audit:read_all' },
] as const;

const router = createBrowserRouter([
  {
    path: '/entrar',
    element: (
      <RedirectIfSignedIn>
        <LoginPage />
      </RedirectIfSignedIn>
    ),
  },
  {
    path: '/',
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      { index: true, element: <LandOnFirstAllowedPage /> },
      {
        path: 'inicio',
        element: (
          <Page namespace="home" titleKey="title">
            <HomePage />
          </Page>
        ),
      },
      {
        path: 'administracion/roles',
        element: (
          <Page namespace="admin" titleKey="roles.title">
            <RolesPage />
          </Page>
        ),
      },
      {
        path: 'administracion/usuarios',
        element: (
          <Page namespace="admin" titleKey="members.title">
            <MembersPage />
          </Page>
        ),
      },
      {
        // No permission gate: every session has a profile, and the theme switch on it is
        // the one control that must never be unreachable — a reader who cannot see the
        // current theme is the reader most likely to need to change it.
        path: 'perfil',
        element: (
          <Page namespace="identity" titleKey="profile.title">
            <ProfilePage />
          </Page>
        ),
      },
      {
        path: 'plataforma/empresas',
        element: (
          <Page namespace="platform" titleKey="tenants.title">
            <TenantsPage />
          </Page>
        ),
      },
      {
        // The company's own people, and the door into their account (§8.1). Nested under
        // the company rather than given its own top-level entry: it is only ever reached
        // by opening a company first, and the URL says which one.
        path: 'plataforma/empresas/:tenantId/usuarios',
        element: (
          <Page namespace="platform" titleKey="support.title">
            <TenantMembersPage />
          </Page>
        ),
      },
      {
        path: 'plataforma/planes',
        element: (
          <Page namespace="platform" titleKey="plans.title">
            <PlansPage />
          </Page>
        ),
      },
      {
        path: 'plataforma/colas',
        element: (
          <Page namespace="platform" titleKey="queues.title">
            <QueuesPage />
          </Page>
        ),
      },
      {
        path: 'plataforma/auditoria',
        element: (
          <Page namespace="platform" titleKey="audit.title">
            <AuditPage />
          </Page>
        ),
      },
      { path: '*', element: <LandOnFirstAllowedPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
