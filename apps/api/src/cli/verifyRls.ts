import { pino } from 'pino';

import { ConfigurationError, loadConfig } from '../config/environment.js';
import { ControlDatabase } from '../infrastructure/controlDatabase.js';

/**
 * Release gate: every table that holds somebody's data is isolated.
 *
 * "A table without policies is a bug" is only true if something checks. This runs in CI and
 * fails the build the moment a table is added without isolation — before the data it holds
 * belongs to a customer.
 *
 * Two sweeps, because the two schemas answer to different rules. A tenant table must carry
 * a `tenant_id` and a policy per operation. A control-plane table often belongs to no
 * company at all — a plan, a permission — so what is required there is narrower and
 * absolute: row level security enabled and forced, and nothing reachable by `anon` or
 * `authenticated`, which are the roles the browser holds.
 *
 * Both matter. The control plane is where the rows that span every client sit: who belongs
 * to which company, the audit trail, API keys, support access grants. A table added there
 * without protection is the same bug as an unisolated tenant table, with a larger blast
 * radius.
 *
 * Exit codes: 0 everything is isolated · 1 at least one table is not · 78 misconfigured.
 */
interface Offender {
  readonly schema_name: string;
  readonly table_name: string;
  readonly problem: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logging.level });
  const database = new ControlDatabase({
    connectionString: config.controlDatabase.connectionString,
    logger,
  });

  try {
    const offenders = await database.query<Offender>(
      `select schema_name, table_name, problem from app.tenant_tables_missing_isolation()
       union all
       select schema_name, table_name, problem from app.control_tables_missing_isolation()`,
    );

    const checked = await database.query<{ tenant: string; control: string }>(
      `select
         (select count(*)::text
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname like 'tenant\\_%' and c.relkind = 'r'
             and c.relname <> 'applied_migrations') as tenant,
         (select count(*)::text
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'control' and c.relkind = 'r') as control`,
    );

    if (offenders.length > 0) {
      for (const offender of offenders) {
        logger.error(
          { schema: offender.schema_name, table: offender.table_name, problem: offender.problem },
          'table is not isolated',
        );
      }
      logger.error({ offenders: offenders.length }, 'isolation is incomplete; refusing to release');
      process.exitCode = 1;
      return;
    }

    logger.info(
      {
        tenantTablesChecked: Number(checked[0]?.tenant ?? '0'),
        controlTablesChecked: Number(checked[0]?.control ?? '0'),
      },
      'every table is isolated',
    );
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch (error: unknown) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78);
  }
  process.stderr.write(`RLS verification failed to run: ${String(error)}\n`);
  process.exit(1);
}
