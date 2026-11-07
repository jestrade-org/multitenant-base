import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { planMigrations, type AppliedMigration, type AvailableMigration } from './plan.js';

/**
 * Applies the tenant schema migrations to every active tenant.
 *
 * The Supabase CLI owns `supabase/migrations/` — one database, one linear history. It
 * cannot express "apply this to each of N schemas", which is what Option A needs, so
 * tenant migrations live in `supabase/tenant-migrations/` and this runner applies them.
 *
 * Two properties matter more than convenience here:
 *   - re-running is a no-op, so the deploy step is safe to retry
 *   - one tenant failing does not stop the others from being reported, and any failure
 *     fails the deploy
 */

const MIGRATION_FILENAME = /^(?<version>\d{4})_(?<name>[a-z0-9_]+)\.sql$/;

/** Namespace for the advisory lock, so two concurrent deploys cannot interleave. */
const ADVISORY_LOCK_NAMESPACE = 4_182_331;

export interface SqlClient {
  query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export interface TenantToMigrate {
  readonly id: string;
  readonly name: string;
  readonly schemaName: string;
}

export type TenantMigrationOutcome =
  | { readonly status: 'up-to-date'; readonly applied: readonly string[] }
  | { readonly status: 'migrated'; readonly applied: readonly string[] }
  | { readonly status: 'failed'; readonly applied: readonly string[]; readonly error: string };

export interface TenantMigrationResult {
  readonly tenant: TenantToMigrate;
  readonly outcome: TenantMigrationOutcome;
}

export async function loadTenantMigrations(directory: string): Promise<AvailableMigration[]> {
  const entries = await readdir(directory);
  const migrations: AvailableMigration[] = [];

  for (const entry of entries.toSorted((a, b) => a.localeCompare(b))) {
    const match = MIGRATION_FILENAME.exec(entry);
    if (!match?.groups) {
      if (entry.endsWith('.sql')) {
        throw new Error(
          `Migration filename "${entry}" does not match NNNN_snake_case.sql. Ordering is ` +
            'derived from the name, so an unparseable name has no defined position.',
        );
      }
      continue;
    }

    const sql = await readFile(join(directory, entry), 'utf8');
    migrations.push({
      version: match.groups.version ?? '',
      name: match.groups.name ?? '',
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  return migrations;
}

/**
 * Bookkeeping lives inside the tenant's own schema, so dropping a tenant takes its
 * migration history with it and cannot leave an orphan row claiming work was done.
 */
async function ensureBookkeeping(client: SqlClient, schemaName: string): Promise<void> {
  // The schema name already passed the `tenants_schema_name_format` check constraint on
  // the way into the control plane (VC-22), and quoteIdentifier re-validates it here.
  // Two guards, because this is the only place a name becomes SQL.
  await client.query(`create schema if not exists ${quoteIdentifier(schemaName)}`);
  await client.query(
    `create table if not exists ${quoteIdentifier(schemaName)}.applied_migrations (
       version     text primary key,
       name        text        not null,
       checksum    text        not null,
       applied_at  timestamptz not null default now()
     )`,
  );
}

/**
 * Quotes a Postgres identifier.
 *
 * Schema names reaching this point have already passed the `tenants_schema_name_format`
 * check constraint, so they cannot contain a quote — but this function must be correct
 * on its own terms rather than relying on that, because it is the last thing standing
 * between a name and the SQL parser.
 */
export function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Refusing to use "${identifier}" as a SQL identifier.`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Quotes a schema name as a string *literal*, for the migrations that pass it to a
 * function rather than using it as an identifier — `app.install_tenant_isolation` takes
 * text, not a table reference.
 *
 * Validated by the same rule as the identifier form, so the two cannot disagree about
 * what a legitimate schema name is.
 */
export function quoteLiteral(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Refusing to use "${value}" as a SQL literal.`);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

async function readApplied(client: SqlClient, schemaName: string): Promise<AppliedMigration[]> {
  const rows = await client.query(
    `select version, checksum from ${quoteIdentifier(schemaName)}.applied_migrations`,
  );
  return rows.map((row) => ({
    version: String(row.version),
    checksum: String(row.checksum),
  }));
}

async function migrateOneTenant(
  client: SqlClient,
  tenant: TenantToMigrate,
  available: readonly AvailableMigration[],
): Promise<TenantMigrationOutcome> {
  const applied: string[] = [];

  try {
    await ensureBookkeeping(client, tenant.schemaName);
    const plan = planMigrations(available, await readApplied(client, tenant.schemaName));

    if (plan.kind === 'drifted') {
      return { status: 'failed', applied, error: plan.reason };
    }
    if (plan.kind === 'up-to-date') {
      return { status: 'up-to-date', applied };
    }

    for (const migration of plan.migrations) {
      // One transaction per migration: a failure leaves the schema at the last
      // consistent version rather than half-way through the current one.
      await client.query('begin');
      try {
        // Two substitutions, because a migration needs the schema name in two shapes:
        //   :"schema"  as an identifier — `create table :"schema".projects`
        //   :'schema'  as a text literal — `select app.install_tenant_isolation(:'schema', ...)`
        // Both go through the same validation, so they cannot disagree about what a
        // legitimate schema name is. The value comes from the control plane, never from
        // a request.
        const sql = migration.sql
          .replaceAll(':"schema"', quoteIdentifier(tenant.schemaName))
          .replaceAll(":'schema'", quoteLiteral(tenant.schemaName));
        await client.query(sql);
        await client.query(
          `insert into ${quoteIdentifier(tenant.schemaName)}.applied_migrations
             (version, name, checksum) values ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('commit');
        applied.push(`${migration.version}_${migration.name}`);
      } catch (error: unknown) {
        await client.query('rollback');
        throw error;
      }
    }

    return { status: 'migrated', applied };
  } catch (error: unknown) {
    return {
      status: 'failed',
      applied,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface MigrateTenantsOptions {
  readonly client: SqlClient;
  readonly tenants: readonly TenantToMigrate[];
  readonly migrations: readonly AvailableMigration[];
}

/**
 * Migrates every tenant and returns one result per tenant.
 *
 * A failure on one tenant does not abort the run: the caller needs the full picture to
 * decide what to do, and stopping at the first failure hides how widespread a problem
 * is. The caller fails the deploy on any non-success.
 */
export async function migrateAllTenants(
  options: MigrateTenantsOptions,
): Promise<readonly TenantMigrationResult[]> {
  const { client, tenants, migrations } = options;

  // Singleton across deploys. Without it, two pipelines can apply the same migration to
  // the same schema concurrently and both think they succeeded.
  await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_NAMESPACE]);
  try {
    const results: TenantMigrationResult[] = [];
    for (const tenant of tenants) {
      results.push({ tenant, outcome: await migrateOneTenant(client, tenant, migrations) });
    }
    return results;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_NAMESPACE]);
  }
}
