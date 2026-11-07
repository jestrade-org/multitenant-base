import { ValidationError } from './errors.js';

/**
 * The capability catalogue.
 *
 * Authorization is checked as a capability (`iam:user_manage`), never by comparing role
 * strings. Roles are how capabilities are packaged for humans; a rule written as
 * `if (role === 'accountant')` has to be found and edited in every file the day a client
 * asks for a role that is *almost* an accountant, and one of those files is always missed.
 *
 * The codes here mirror `control.permissions`, seeded in
 * `20260823090100_seed_permission_catalogue.sql` and extended by later migrations. A test
 * asserts the two lists are identical, because a capability that exists in TypeScript and
 * not in the database denies silently, and one that exists only in the database is never
 * enforced.
 */

/** Branded so a bare string cannot be passed where a checked capability is required. */
export type Permission = string & { readonly __brand: 'Permission' };

export const PERMISSIONS = [
  'audit:read',
  'audit:read_all',
  'iam:role_manage',
  'iam:user_manage',
  'integrations:api_key_manage',
  'integrations:oauth_manage',
  'platform:plan_manage',
  'platform:queue_manage',
  'platform:queue_monitor',
  'platform:support_access',
  'platform:tenant_manage',
  'tenancy:read',
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

const KNOWN = new Set<string>(PERMISSIONS);

export function isPermissionCode(value: string): value is PermissionCode {
  return KNOWN.has(value);
}

/**
 * Turns a code into a checked capability.
 *
 * Rejects anything outside the catalogue rather than treating it as a capability nobody
 * holds. A typo like `iam:user_mange` would otherwise be a permission that is simply
 * never granted — the use case would deny everyone, forever, and read as working.
 */
export function permission(code: string): Permission {
  if (!isPermissionCode(code)) {
    throw new ValidationError('permission', `${code} is not in the permission catalogue`);
  }
  return code as Permission;
}

/**
 * Reads the capabilities carried by a verified session.
 *
 * Unknown codes are dropped rather than rejected: the database is allowed to be ahead of
 * a running instance during a deploy, and refusing every request in that window would
 * turn a routine migration into an outage. Dropping is safe in the direction that
 * matters — an unknown code can only ever fail to grant something.
 */
export function permissionsFrom(codes: readonly string[]): readonly Permission[] {
  return codes.filter(isPermissionCode) as Permission[];
}
