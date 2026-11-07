import { pino } from 'pino';

import {
  loadTenantMigrations,
  migrateAllTenants,
  type TenantToMigrate,
} from '@multitenant-base/tenancy';

import { ConfigurationError, loadConfig } from '../config/environment.js';
import { ControlDatabase } from '../infrastructure/controlDatabase.js';

/**
 * Deploy step: apply the tenant schema migrations to every active tenant (§5.1).
 *
 * Runs before the code that needs the new schema, and exits non-zero if any tenant is
 * left behind — a partially migrated fleet is exactly the state where the running app
 * is incompatible with the database for some customers and not others.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logging.level });
  const database = new ControlDatabase({
    connectionString: config.controlDatabase.connectionString,
    logger,
    // Migrations legitimately take longer than a request.
    statementTimeoutMs: 120_000,
    maxConnections: 1,
  });

  try {
    // Not a path computed from this file's own location: `pnpm deploy` flattens the
    // package, so a relative traversal correct for the monorepo checkout lands outside
    // the deployed image entirely. TENANT_MIGRATIONS_DIRECTORY is the one place this
    // directory is resolved, and the running app relies on the same value.
    const migrations = await loadTenantMigrations(config.tenantMigrationsDirectory);

    // Terminated tenants keep their data for the statutory retention period but are not
    // migrated: schema changes for a company that left serve nobody.
    const rows = await database.query<{ id: string; name: string; schema_name: string }>(
      `select id, name, schema_name
         from control.tenants
        where lifecycle_status <> 'terminated'
          and isolation_mode = 'shared_schema'
        order by created_at`,
    );
    const tenants: TenantToMigrate[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      schemaName: row.schema_name,
    }));

    logger.info(
      { tenants: tenants.length, migrations: migrations.length },
      'applying tenant migrations',
    );

    const results = await migrateAllTenants({ client: database, tenants, migrations });

    for (const { tenant, outcome } of results) {
      const context = { tenant: tenant.name, schema: tenant.schemaName, applied: outcome.applied };
      if (outcome.status === 'failed') {
        logger.error({ ...context, reason: outcome.error }, 'tenant migration failed');
      } else {
        logger.info({ ...context, status: outcome.status }, 'tenant migration finished');
      }
    }

    const failures = results.filter((result) => result.outcome.status === 'failed');
    if (failures.length > 0) {
      logger.error(
        { failed: failures.length, total: results.length },
        'tenant migrations left the fleet inconsistent; failing the deploy',
      );
      process.exitCode = 1;
      return;
    }

    logger.info({ total: results.length }, 'every active tenant is up to date');
  } finally {
    await database.close();
  }
}

// A deploy step is read by its exit code, so the codes have to mean something:
//   0  every active tenant is up to date
//   1  at least one tenant is behind or drifted — do not promote this release
//  78  the step was misconfigured and never looked at a tenant (EX_CONFIG)
try {
  await main();
} catch (error: unknown) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78);
  }
  process.stderr.write(`Tenant migration step failed: ${String(error)}\n`);
  process.exit(1);
}
