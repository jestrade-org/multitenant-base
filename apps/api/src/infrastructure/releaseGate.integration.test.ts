import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The release gate, tested (§4.3, §8.3).
 *
 * `pnpm verify:rls` fails the build when a table holding somebody's data has no isolation.
 * A gate like that has one failure mode worth fearing: passing quietly. It reports success
 * whether it is checking everything, one thing, or — after a refactor that narrowed a
 * `where` clause — nothing at all, and the first anybody hears of it is a customer reading
 * another customer's cartera.
 *
 * So this file asserts both halves. That the gate is green today, which is the release
 * claim. And that each way a table can be wrong is a way the gate actually catches, proven
 * by building the broken table and watching it get named.
 */

const CONNECTION = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

interface Offender {
  readonly schema_name: string;
  readonly table_name: string;
  readonly problem: string;
}

let pool: pg.Pool;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: CONNECTION, max: 2 });
});

afterAll(async () => {
  await pool.end();
});

/**
 * Builds the broken tables, reads the verdict, and leaves nothing behind.
 *
 * One connection and one transaction, because the DDL and the sweep have to see the same
 * uncommitted world — and because a test that creates an unisolated table must not be able
 * to leave one behind if it fails half way.
 */
async function verdictAfter(ddl: readonly string[]): Promise<readonly Offender[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const statement of ddl) await client.query(statement);

    const result = await client.query<Offender>(
      `select schema_name, table_name, problem from app.tenant_tables_missing_isolation()
       union all
       select schema_name, table_name, problem from app.control_tables_missing_isolation()`,
    );
    return result.rows;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

describe('the release claim', () => {
  it('finds nothing wrong with the schema as it stands', async () => {
    expect(await verdictAfter([])).toEqual([]);
  });

  it('is actually looking at both schemas, not at an empty set', async () => {
    const counted = await pool.query<{ tenant: string; control: string }>(
      `select
         (select count(*)::text
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname like 'tenant\\_%' and c.relkind = 'r'
             and c.relname <> 'applied_migrations') as tenant,
         (select count(*)::text
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'control' and c.relkind = 'r') as control`,
    );

    // Exact numbers would fail on every migration that adds a table, which is noise. What
    // has to hold is that both sweeps have a real population to sweep.
    // The base ships the outbox and the processed-events ledger in every tenant schema, so
    // two seeded tenants give at least four.
    expect(Number(counted.rows[0]?.tenant ?? '0')).toBeGreaterThanOrEqual(4);
    expect(Number(counted.rows[0]?.control ?? '0')).toBeGreaterThan(5);
  });
});

describe('what the control-plane sweep catches', () => {
  it('names a table with no row level security', async () => {
    const offenders = await verdictAfter(['create table control.gate_probe (id uuid primary key)']);

    expect(offenders).toContainEqual({
      schema_name: 'control',
      table_name: 'gate_probe',
      problem: 'row level security is not enabled',
    });
  });

  it('names a table whose row level security is enabled but not forced', async () => {
    // Enabled-but-not-forced is the subtle one: the table looks protected, and the owner —
    // which is what a migration and a pooled superuser connection run as — is exempt.
    const offenders = await verdictAfter([
      'create table control.gate_probe (id uuid primary key)',
      'alter table control.gate_probe enable row level security',
    ]);

    expect(offenders).toContainEqual({
      schema_name: 'control',
      table_name: 'gate_probe',
      problem: 'row level security is not forced',
    });
  });

  it('names a table the browser could reach, even with row level security in place', async () => {
    // `anon` ships in the browser bundle by design. A grant here would put the control
    // plane one query away from a page's JavaScript.
    const offenders = await verdictAfter([
      'create table control.gate_probe (id uuid primary key)',
      'alter table control.gate_probe enable row level security',
      'alter table control.gate_probe force row level security',
      'grant select on control.gate_probe to anon',
    ]);

    expect(offenders).toContainEqual({
      schema_name: 'control',
      table_name: 'gate_probe',
      problem: 'reachable by anon or authenticated: the browser holds both',
    });
  });

  it('catches a grant to authenticated as well as to anon', async () => {
    const offenders = await verdictAfter([
      'create table control.gate_probe (id uuid primary key)',
      'alter table control.gate_probe enable row level security',
      'alter table control.gate_probe force row level security',
      // An insert grant, not a select: giving yourself a membership is worse than reading
      // one, and a check that only looked at reads would miss it.
      'grant insert on control.gate_probe to authenticated',
    ]);

    expect(offenders.map((offender) => offender.table_name)).toContain('gate_probe');
  });

  it('passes a table that is enabled, forced and out of the browser’s reach', async () => {
    const offenders = await verdictAfter([
      'create table control.gate_probe (id uuid primary key)',
      'alter table control.gate_probe enable row level security',
      'alter table control.gate_probe force row level security',
    ]);

    expect(offenders).toEqual([]);
  });
});

describe('the grants that were already there', () => {
  it('leaves no control table reachable by the roles the browser holds', async () => {
    const grants = await pool.query<{ table_name: string; grantee: string }>(
      `select table_name, grantee
         from information_schema.role_table_grants
        where table_schema = 'control' and grantee in ('anon', 'authenticated')`,
    );

    expect(grants.rows).toEqual([]);
  });

  it('keeps the support access grant unreachable and forced, like the rest', async () => {
    const table = await pool.query<{ rls: boolean; forced: boolean }>(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as forced
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'control' and c.relname = 'support_access_grants'`,
    );

    expect(table.rows[0]).toEqual({ rls: true, forced: true });
  });
});
