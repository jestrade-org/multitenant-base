import { describe, expect, it } from 'vitest';

import type { AvailableMigration } from './plan.js';
import { migrateAllTenants, quoteIdentifier, quoteLiteral, type SqlClient } from './runner.js';

/**
 * An in-memory stand-in for Postgres: enough to assert ordering, transaction framing and
 * idempotence without a database. The real SQL is exercised against the local Supabase
 * stack; what is worth isolating here is the runner's decision-making.
 */
class FakeDatabase implements SqlClient {
  public readonly statements: string[] = [];
  readonly #appliedBySchema = new Map<string, { version: string; checksum: string }[]>();
  #failOn: string | undefined;

  public constructor(options: { readonly failOn?: string } = {}) {
    this.#failOn = options.failOn;
  }

  public query(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Record<string, unknown>[]> {
    this.statements.push(sql.trim().split('\n')[0]?.trim() ?? '');

    if (this.#failOn !== undefined && sql.includes(this.#failOn)) {
      return Promise.reject(new Error(`relation already exists: ${this.#failOn}`));
    }

    const schema = /"([a-z0-9_]+)"/.exec(sql)?.[1] ?? '';

    if (sql.includes('select version, checksum')) {
      return Promise.resolve(this.#appliedBySchema.get(schema) ?? []);
    }
    if (sql.includes('insert into') && sql.includes('applied_migrations')) {
      const rows = this.#appliedBySchema.get(schema) ?? [];
      rows.push({ version: String(values[0]), checksum: String(values[2]) });
      this.#appliedBySchema.set(schema, rows);
    }
    return Promise.resolve([]);
  }

  public appliedFor(schema: string): string[] {
    return (this.#appliedBySchema.get(schema) ?? []).map((row) => row.version);
  }
}

const migrations: AvailableMigration[] = [
  { version: '0001', name: 'baseline', sql: 'create table :"schema".a ()', checksum: 'aaa' },
  { version: '0002', name: 'invoices', sql: 'create table :"schema".b ()', checksum: 'bbb' },
];

const tenants = [
  { id: 't1', name: 'Acme Logistics Inc.', schemaName: 'tenant_acme' },
  { id: 't2', name: 'Globex Corporation', schemaName: 'tenant_globex' },
];

describe('migrateAllTenants', () => {
  it('applies every migration to every tenant', async () => {
    const client = new FakeDatabase();

    const results = await migrateAllTenants({ client, tenants, migrations });

    expect(results.map((r) => r.outcome.status)).toEqual(['migrated', 'migrated']);
    expect(client.appliedFor('tenant_acme')).toEqual(['0001', '0002']);
    expect(client.appliedFor('tenant_globex')).toEqual(['0001', '0002']);
  });

  it('is a no-op on a second run, so the deploy step is safe to retry', async () => {
    const client = new FakeDatabase();
    await migrateAllTenants({ client, tenants, migrations });
    const statementsAfterFirstRun = client.statements.length;

    const results = await migrateAllTenants({ client, tenants, migrations });

    expect(results.map((r) => r.outcome.status)).toEqual(['up-to-date', 'up-to-date']);
    expect(results.flatMap((r) => r.outcome.applied)).toEqual([]);
    // No begin/commit at all on the second pass.
    const second = client.statements.slice(statementsAfterFirstRun);
    expect(second.filter((s) => s === 'begin')).toHaveLength(0);
  });

  it('takes an advisory lock so two deploys cannot interleave', async () => {
    const client = new FakeDatabase();

    await migrateAllTenants({ client, tenants, migrations });

    expect(client.statements[0]).toContain('pg_advisory_lock');
    expect(client.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('releases the lock even when a tenant fails', async () => {
    const client = new FakeDatabase({ failOn: '.a ()' });

    await migrateAllTenants({ client, tenants, migrations });

    expect(client.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('wraps each migration in its own transaction and rolls back on failure', async () => {
    // Fails on the migration body itself, after the bookkeeping table exists, so the
    // failure lands inside a transaction rather than before one is opened.
    const client = new FakeDatabase({ failOn: '.a ()' });

    const results = await migrateAllTenants({ client, tenants, migrations });

    expect(results.every((r) => r.outcome.status === 'failed')).toBe(true);
    expect(client.statements).toContain('rollback');
    expect(client.statements).not.toContain('commit');
  });

  it('fails the tenant when its schema cannot even be prepared', async () => {
    // No transaction has been opened yet at this point, so there is nothing to roll
    // back — but the tenant must still be reported as failed rather than up-to-date.
    const client = new FakeDatabase({ failOn: 'applied_migrations' });

    const results = await migrateAllTenants({ client, tenants, migrations });

    expect(results.every((r) => r.outcome.status === 'failed')).toBe(true);
    expect(client.statements).not.toContain('begin');
  });

  it('keeps migrating the remaining tenants after one fails, so the report is complete', async () => {
    const failingFirst = [{ id: 't0', name: 'Broken', schemaName: 'tenant_broken' }, ...tenants];
    // Only the first tenant fails; the other two must still be attempted and reported.
    const clientThatFailsOnce = new (class extends FakeDatabase {
      public override query(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<readonly Record<string, unknown>[]> {
        if (sql.includes('tenant_broken') && sql.includes('create table')) {
          return Promise.reject(new Error('permission denied'));
        }
        return super.query(sql, values);
      }
    })();

    const results = await migrateAllTenants({
      client: clientThatFailsOnce,
      tenants: failingFirst,
      migrations,
    });

    expect(results).toHaveLength(3);
    expect(results[0]?.outcome.status).toBe('failed');
    expect(results[1]?.outcome.status).toBe('migrated');
    expect(results[2]?.outcome.status).toBe('migrated');
    expect(clientThatFailsOnce.appliedFor('tenant_acme')).toEqual(['0001', '0002']);
  });
});

describe('quoteLiteral', () => {
  it('quotes a schema name for a function that takes text', () => {
    expect(quoteLiteral('tenant_acme')).toBe("'tenant_acme'");
  });

  it.each(["tenant'; drop schema control cascade;--", 'tenant acme', ''])(
    'refuses %j rather than quoting it into a statement',
    (hostile) => {
      expect(() => quoteLiteral(hostile)).toThrow(/Refusing to use/);
    },
  );
});

describe('quoteIdentifier', () => {
  it('quotes a legitimate schema name', () => {
    expect(quoteIdentifier('tenant_acme')).toBe('"tenant_acme"');
  });

  it.each([
    'public; drop table control.tenants;--',
    'tenant"; drop schema control cascade;--',
    "tenant' or '1'='1",
    'tenant acme',
    '',
  ])('refuses %j rather than quoting it into a statement', (hostile) => {
    expect(() => quoteIdentifier(hostile)).toThrow(/Refusing to use/);
  });
});
