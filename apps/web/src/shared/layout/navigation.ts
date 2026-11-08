import type { IconName } from '../design/icons.js';

/**
 * The menu, in three sections, and the one place that knows which screen belongs to which.
 *
 * These are three separate audiences — the company's screens, the company's own
 * administration, the platform panel — and no one person normally holds all three. They
 * are one list here, grouped and gated, so a session that does hold two of them gets one
 * coherent menu rather than a screen that changes shape as they navigate. The page header
 * reads the same list for its breadcrumb, so the two can never name a screen differently.
 */

export interface NavItem {
  readonly to: string;
  readonly labelKey: string;
  readonly icon: IconName;
  /** Permission the item is gated on. Hiding is UX; the server checks again. */
  readonly requires: string;
}

export interface NavGroup {
  readonly id: 'company' | 'administration' | 'platform';
  /**
   * Shown above the group, unless it is the only group on screen — a person who can see
   * nothing but the platform section does not need it labelled twice.
   */
  readonly labelKey: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'company',
    labelKey: 'nav.group.company',
    // A project built on this base adds its own modules' screens to this group, each
    // gated on the capability its endpoints check.
    items: [{ to: '/inicio', labelKey: 'nav.home', icon: 'home', requires: 'tenancy:read' }],
  },
  {
    // The tenant's own administration.
    id: 'administration',
    labelKey: 'nav.group.administration',
    items: [
      {
        to: '/administracion/usuarios',
        labelKey: 'nav.members',
        icon: 'users',
        requires: 'iam:user_manage',
      },
      {
        to: '/administracion/roles',
        labelKey: 'nav.roles',
        icon: 'shield',
        requires: 'iam:user_manage',
      },
    ],
  },
  {
    // Platform staff. Their capabilities exist in no tenant role, so this section never
    // appears for a company's user however senior. The operator holds `queue_monitor`
    // without `tenant_manage`, so they see the queues and not the companies — the
    // permission model doing its job, not a special case.
    id: 'platform',
    labelKey: 'nav.group.platform',
    items: [
      {
        to: '/plataforma/empresas',
        labelKey: 'nav.tenants',
        icon: 'building',
        requires: 'platform:tenant_manage',
      },
      {
        to: '/plataforma/planes',
        labelKey: 'nav.plans',
        icon: 'layers',
        requires: 'platform:plan_manage',
      },
      {
        to: '/plataforma/colas',
        labelKey: 'nav.queues',
        icon: 'queue',
        requires: 'platform:queue_monitor',
      },
      {
        to: '/plataforma/auditoria',
        labelKey: 'nav.audit',
        icon: 'audit',
        requires: 'audit:read_all',
      },
    ],
  },
];

/** The group and item a path belongs to, matching nested paths to their parent screen. */
export function locateInNavigation(
  pathname: string,
): { readonly group: NavGroup; readonly item: NavItem } | undefined {
  for (const group of NAV_GROUPS) {
    const item = group.items.find(
      (candidate) => pathname === candidate.to || pathname.startsWith(`${candidate.to}/`),
    );
    if (item !== undefined) return { group, item };
  }
  return undefined;
}
