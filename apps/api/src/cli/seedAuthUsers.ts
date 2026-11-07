import { pino } from 'pino';

import { ConfigurationError, loadConfig } from '../config/environment.js';
import { ControlDatabase } from '../infrastructure/controlDatabase.js';

/**
 * Creates the local demo users and their tenant memberships.
 *
 * Separate from `seed.sql` because a password is hashed by the auth provider: writing one
 * into a SQL seed would mean either storing a plaintext password in git or hand-rolling a
 * hash, and both are exactly what "never hand-roll authentication" rules out.
 *
 * Local development only. It refuses to run against anything that is not the local stack.
 */
interface DemoUser {
  readonly email: string;
  readonly password: string;
  readonly fullName: string;
  readonly subdomain: string;
  readonly roleCode: string;
}

const DEMO_USERS: readonly DemoUser[] = [
  {
    email: 'admin@acme.test',
    password: 'local-demo-acme-admin',
    fullName: 'Alex Morgan',
    subdomain: 'acme',
    roleCode: 'tenant_admin',
  },
  {
    email: 'member@acme.test',
    password: 'local-demo-acme-member',
    fullName: 'Jordan Lee',
    subdomain: 'acme',
    roleCode: 'member',
  },
  {
    email: 'admin@globex.test',
    password: 'local-demo-globex-admin',
    fullName: 'Sam Rivera',
    subdomain: 'globex',
    roleCode: 'tenant_admin',
  },
];

/**
 * platform staff, who belong to no tenant (§8.1).
 *
 * Seeded separately because they are a different identity in a different table — and
 * without one, the platform panel is unreachable locally, which makes it untestable.
 */
const DEMO_PLATFORM_USERS: readonly {
  readonly email: string;
  readonly password: string;
  readonly fullName: string;
  readonly roleCode: string;
}[] = [
  {
    email: 'platform@example.test',
    password: 'local-demo-platform',
    fullName: 'Taylor Quinn',
    roleCode: 'platform_admin',
  },
  {
    email: 'operator@example.test',
    password: 'local-demo-operator',
    fullName: 'Casey Kim',
    roleCode: 'platform_operator',
  },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logging.level });

  // Read from typed config, never from process.env: this file is not the config module,
  // and a second place that reads the environment is a second place that can disagree
  // with it about what is required.
  const authUrl = config.auth.authUrl;
  const serviceKey = config.auth.serviceRoleKey;
  if (serviceKey === undefined) {
    throw new ConfigurationError(
      'SUPABASE_SERVICE_ROLE_KEY is required to seed demo users. See .env.example.',
    );
  }
  if (!authUrl.includes('127.0.0.1') && !authUrl.includes('localhost')) {
    throw new ConfigurationError(
      `Refusing to seed demo users against ${authUrl}. This is a local-development tool ` +
        'and it creates accounts with known passwords.',
    );
  }

  const database = new ControlDatabase({
    connectionString: config.controlDatabase.connectionString,
    logger,
  });

  try {
    for (const user of DEMO_USERS) {
      const created = await fetch(`${authUrl}/admin/users`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: user.email,
          password: user.password,
          email_confirm: true,
        }),
      });

      const body = (await created.json()) as { id?: string; msg?: string };
      let authUserId = body.id;

      if (authUserId === undefined) {
        // Already exists from a previous run: look it up rather than failing, so the
        // seed is re-runnable like every other step.
        const existing = await fetch(
          `${authUrl}/admin/users?filter=${encodeURIComponent(user.email)}`,
          { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
        );
        const list = (await existing.json()) as { users?: { id: string; email: string }[] };
        authUserId = list.users?.find((candidate) => candidate.email === user.email)?.id;
      }

      if (authUserId === undefined) {
        logger.error({ email: user.email, reason: body.msg }, 'could not create demo user');
        continue;
      }

      await database.query(
        `insert into control.tenant_members (tenant_id, auth_user_id, email, full_name, role_id)
         select t.id, $1, $2, $3, r.id
           from control.tenants t
           join control.roles r on r.code = $5 and r.tenant_id is null
          where t.subdomain = $4
         on conflict (tenant_id, auth_user_id) do update
            set full_name = excluded.full_name, role_id = excluded.role_id, is_active = true`,
        [authUserId, user.email, user.fullName, user.subdomain, user.roleCode],
      );

      logger.info(
        { email: user.email, tenant: user.subdomain, role: user.roleCode },
        'demo member ready',
      );
    }

    for (const staff of DEMO_PLATFORM_USERS) {
      const created = await fetch(`${authUrl}/admin/users`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: staff.email,
          password: staff.password,
          email_confirm: true,
        }),
      });

      const body = (await created.json()) as { id?: string; msg?: string };
      let authUserId = body.id;

      if (authUserId === undefined) {
        const existing = await fetch(
          `${authUrl}/admin/users?filter=${encodeURIComponent(staff.email)}`,
          { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
        );
        const list = (await existing.json()) as { users?: { id: string; email: string }[] };
        authUserId = list.users?.find((candidate) => candidate.email === staff.email)?.id;
      }

      if (authUserId === undefined) {
        logger.error({ email: staff.email, reason: body.msg }, 'could not create demo staff');
        continue;
      }

      // control.platform_users, not tenant_members: staff belong to no company (§8.1).
      await database.query(
        `insert into control.platform_users (auth_user_id, email, full_name, role_id)
         select $1, $2, $3, r.id
           from control.roles r
          where r.code = $4 and r.tenant_id is null
         on conflict (auth_user_id) do update
                set role_id = excluded.role_id, is_active = true`,
        [authUserId, staff.email, staff.fullName, staff.roleCode],
      );

      logger.info({ email: staff.email, role: staff.roleCode }, 'demo platform user ready');
    }
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
  process.stderr.write(`Seeding demo users failed: ${String(error)}\n`);
  process.exit(1);
}
