import { describe, expect, it } from 'vitest';

import { planMigrations, type AppliedMigration, type AvailableMigration } from './plan.js';

function available(version: string, name: string, checksum: string): AvailableMigration {
  return { version, name, sql: `-- ${name}`, checksum };
}
function applied(version: string, checksum: string): AppliedMigration {
  return { version, checksum };
}

describe('planMigrations', () => {
  it('reports up-to-date when the schema has every migration', () => {
    const plan = planMigrations(
      [available('0001', 'baseline', 'aaa'), available('0002', 'invoices', 'bbb')],
      [applied('0001', 'aaa'), applied('0002', 'bbb')],
    );

    expect(plan).toEqual({ kind: 'up-to-date' });
  });

  it('reports up-to-date for a schema with nothing to do, so re-running is a no-op', () => {
    expect(planMigrations([], [])).toEqual({ kind: 'up-to-date' });
  });

  it('returns pending migrations in version order', () => {
    const plan = planMigrations(
      [
        available('0003', 'payments', 'ccc'),
        available('0001', 'baseline', 'aaa'),
        available('0002', 'invoices', 'bbb'),
      ],
      [applied('0001', 'aaa')],
    );

    expect(plan.kind).toBe('pending');
    expect(plan.kind === 'pending' && plan.migrations.map((m) => m.version)).toEqual([
      '0002',
      '0003',
    ]);
  });

  it('refuses to proceed when an applied migration was edited afterwards', () => {
    const plan = planMigrations(
      [available('0001', 'baseline', 'edited-checksum')],
      [applied('0001', 'original-checksum')],
    );

    expect(plan.kind).toBe('drifted');
    expect(plan.kind === 'drifted' && plan.reason).toContain('modified after being applied');
  });

  it('refuses to proceed when the schema is ahead of this build', () => {
    const plan = planMigrations(
      [available('0001', 'baseline', 'aaa')],
      [applied('0001', 'aaa'), applied('0002', 'from-a-newer-deploy')],
    );

    expect(plan.kind).toBe('drifted');
    expect(plan.kind === 'drifted' && plan.reason).toContain('does not exist in this build');
  });

  it('refuses to backfill a migration older than one already applied', () => {
    // Two branches merged and someone numbered a migration below the current head.
    // Applying it now would run it after the newer one already changed the schema.
    const plan = planMigrations(
      [available('0001', 'baseline', 'aaa'), available('0002', 'late_arrival', 'bbb')],
      [applied('0001', 'aaa'), applied('0003', 'ccc')],
    );

    expect(plan.kind).toBe('drifted');
  });

  it('treats drift as more urgent than pending work', () => {
    // There is both something to apply and an edited migration. The edit wins: applying
    // the pending one on top of an inconsistent schema makes the divergence permanent.
    const plan = planMigrations(
      [available('0001', 'baseline', 'edited'), available('0002', 'invoices', 'bbb')],
      [applied('0001', 'original')],
    );

    expect(plan.kind).toBe('drifted');
  });
});
