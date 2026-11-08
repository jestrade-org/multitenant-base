import type { ReactNode } from 'react';

/**
 * The navigation icons, drawn here as simple 24×24 stroke shapes.
 *
 * Inline SVG rather than an icon package or font: a dozen glyphs do not justify a
 * dependency, and an icon font fetched at runtime is an outbound request this app does
 * not make. Every icon is decorative — `aria-hidden`, beside a visible text label — so it
 * never carries meaning on its own.
 */

export type IconName =
  'home' | 'users' | 'shield' | 'building' | 'layers' | 'queue' | 'audit' | 'logout' | 'user';

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9v12h14V9" />
      <path d="M10 21v-6h4v6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
      <path d="M18 14.3c2.1.7 3.5 2.8 3.5 5.7" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m8.8 12 2.3 2.3 4.1-4.6" />
    </>
  ),
  building: (
    <>
      <rect x="4" y="3" width="11" height="18" rx="1" />
      <path d="M15 9h4a1 1 0 0 1 1 1v11h-5" />
      <path d="M7.5 7h4M7.5 11h4M7.5 15h4" />
      <path d="M2 21h20" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  queue: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
    </>
  ),
  audit: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h5" />
      <path d="M14 3v5h5" />
      <path d="M19 8v3" />
      <circle cx="16.5" cy="16.5" r="3" />
      <path d="m18.7 18.7 2.3 2.3" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      width={size}
    >
      {PATHS[name]}
    </svg>
  );
}
