/**
 * Deciding *what* to apply is pure logic, so it is separated from the IO that applies
 * it. This is the part that decides whether a deploy proceeds or stops, and it is worth
 * being able to test exhaustively without a database.
 */

export interface AvailableMigration {
  /** Zero-padded ordering prefix from the filename: `0001`, `0002`. */
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  /** SHA-256 of `sql`, so an edit to an applied migration is detectable. */
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
}

export type MigrationPlan =
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'pending'; readonly migrations: readonly AvailableMigration[] }
  | { readonly kind: 'drifted'; readonly reason: string };

/**
 * Compares what a schema has against what the repository ships.
 *
 * Three outcomes matter, and conflating them is how a bad deploy gets through:
 *   - up-to-date: nothing to do, and re-running must stay a no-op
 *   - pending: apply these, in order
 *   - drifted: stop. Either an applied migration was edited after the fact, or the
 *     schema is ahead of this build. Both mean the deploy is not what it claims to be.
 */
export function planMigrations(
  available: readonly AvailableMigration[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const appliedByVersion = new Map(applied.map((m) => [m.version, m]));
  const availableByVersion = new Map(available.map((m) => [m.version, m]));

  // A schema that has run something this build does not know about is ahead of the
  // code. Rolling forward over it would apply migrations out of order.
  for (const record of applied) {
    if (!availableByVersion.has(record.version)) {
      return {
        kind: 'drifted',
        reason:
          `schema has migration ${record.version} applied, which does not exist in this build. ` +
          'The schema is ahead of the code, or a migration file was deleted.',
      };
    }
  }

  // Never edit an applied migration: the schemas that already ran the old text will
  // never converge with the ones that run the new text.
  for (const migration of available) {
    const record = appliedByVersion.get(migration.version);
    if (record !== undefined && record.checksum !== migration.checksum) {
      return {
        kind: 'drifted',
        reason:
          `migration ${migration.version}_${migration.name} was modified after being applied ` +
          `(recorded ${record.checksum.slice(0, 12)}, now ${migration.checksum.slice(0, 12)}). ` +
          'Add a new migration instead of editing an applied one.',
      };
    }
  }

  const pending = available
    .filter((migration) => !appliedByVersion.has(migration.version))
    .toSorted((a, b) => a.version.localeCompare(b.version));

  // A gap means an older migration would run after a newer one already did.
  const highestApplied = applied
    .map((m) => m.version)
    .toSorted((a, b) => a.localeCompare(b))
    .at(-1);
  if (highestApplied !== undefined) {
    const outOfOrder = pending.filter((m) => m.version.localeCompare(highestApplied) < 0);
    if (outOfOrder.length > 0) {
      return {
        kind: 'drifted',
        reason:
          `migration(s) ${outOfOrder.map((m) => m.version).join(', ')} are older than the ` +
          `highest applied version ${highestApplied}. Applying them now would run migrations ` +
          'out of order.',
      };
    }
  }

  return pending.length === 0 ? { kind: 'up-to-date' } : { kind: 'pending', migrations: pending };
}
