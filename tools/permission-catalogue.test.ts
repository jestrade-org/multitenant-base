import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PERMISSIONS } from '../packages/shared-kernel/src/domain/permission.js';

/**
 * The TypeScript catalogue and the seeded one must be the same list.
 *
 * Drift is silent in both directions and neither direction announces itself. A capability
 * that exists only in TypeScript is required by a use case and granted to nobody, so the
 * feature denies every user and looks like a permissions bug in support. One that exists
 * only in the database is granted to roles and never checked, so it reads as working while
 * enforcing nothing. This test is the reason neither can happen quietly.
 */

const MIGRATIONS = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));

/**
 * Every migration, not only the original seed.
 *
 * Reading one file was right while one file existed. It stopped being right the first time
 * a capability arrived in a later migration — and it would have failed *open* in the
 * direction that matters least and closed in the direction that matters most: the new code
 * is in TypeScript, the test does not see it in SQL, and the suite reports drift that is
 * not there. A capability added to the database and never to TypeScript is the silent one,
 * and scanning every migration is what catches it.
 */
function seededPermissions(): readonly string[] {
  const codes = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) => {
      const sql = readFileSync(new URL(file, `file://${MIGRATIONS}`), 'utf8');

      // A removal would make a union of inserts wrong, and silently. There is no such
      // migration today; the day someone writes one, this test has to be rethought rather
      // than quietly keep reporting a capability that no longer exists.
      if (/delete\s+from\s+control\.permissions/i.test(sql)) {
        throw new Error(`${file} deletes permissions; this test only unions inserts`);
      }

      return [...sql.matchAll(/insert into control\.permissions[\s\S]*?;/gi)].flatMap((insert) =>
        [...insert[0].matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((match) => match[1] ?? ''),
      );
    });

  if (codes.length === 0) throw new Error('no insert into control.permissions found');
  return [...new Set(codes)].sort();
}

describe('permission catalogue', () => {
  it('lists exactly the capabilities seeded into control.permissions', () => {
    expect([...PERMISSIONS].sort()).toEqual(seededPermissions());
  });

  it('names every capability as context:action so the owner is always readable', () => {
    for (const code of PERMISSIONS) {
      expect(code).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });
});
