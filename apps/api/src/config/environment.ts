import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { z } from 'zod';

/**
 * The only module in the process that reads `process.env`. Everything else takes typed
 * configuration as an argument.
 *
 * Configuration is validated once, at startup. The process refuses to boot on invalid
 * or missing values rather than failing later, in the middle of a request — and there
 * is no default for a secret or a URL.
 */

const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .describe('literal "true" or "false"');

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Port the HTTP server binds to. The container never publishes it to the host. */
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Postgres connection string for the control plane. No default: there is never a
   * sensible fallback for a database URL, and booting against the wrong database is
   * exactly the failure this refuses to allow.
   */
  CONTROL_DATABASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('postgres'), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),

  /**
   * Whether this process also runs the pg-boss workers.
   *
   * Fase 1 runs API and workers in one process (§2, principle 6). This flag is the seam
   * that makes VC-93 — splitting them into separate deployments — a deployment change
   * rather than a code change: the same image boots as API-only or worker-only.
   */
  WORKERS_ENABLED: booleanFromEnv.default('true'),

  /** Base URL of the Supabase Auth (GoTrue) API, e.g. http://127.0.0.1:55321/auth/v1 */
  SUPABASE_AUTH_URL: z.string().url(),

  /**
   * The publishable anon key. Public by design — it identifies the project and is safe
   * in a browser bundle; it is only ever safe because RLS is correct.
   */
  SUPABASE_ANON_KEY: z.string().min(20),
  // Optional: the API serves every request without it. Only the local seeding tool needs
  // it, and making it required would mean no environment can boot without holding the one
  // key that bypasses RLS entirely.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),

  // Root of each tenant's file storage, provisioned with the tenant. Local disk for
  // development; Supabase Storage is the same port with the same per-tenant prefix rule.
  STORAGE_ROOT_DIRECTORY: z.string().min(1).default('./.storage'),

  // Where the per-tenant migrations live. The provisioning flow applies them with the same
  // runner the CLI uses, so both must read the same directory or a newly provisioned client
  // gets a different schema from every existing one.
  //
  // The default is relative to `apps/api`, which is where the process actually starts —
  // `./supabase/...` looked right and only worked when run from the repository root.
  TENANT_MIGRATIONS_DIRECTORY: z.string().min(1).default('../../supabase/tenant-migrations'),

  /** Absolute session lifetime. A refresh token older than this stops working. */
  SESSION_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 12),

  /**
   * Host suffix under which tenant subdomains live: `acme.example.test`.
   *
   * Public product configuration, not a secret, so it carries a default — but it is
   * validated, because a wrong value here silently stops every subdomain from resolving.
   */
  ROOT_DOMAIN: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/, 'must be a bare domain such as example.test')
    .default('example.test'),

  /** Request body limit, in bytes. Bounds an obvious resource-consumption vector. */
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),

  /** Origins allowed to call the API with credentials. Never `*`. */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  /** How long the process waits for in-flight work to drain on SIGTERM. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export type Environment = z.infer<typeof environmentSchema>;

export interface AppConfig {
  readonly nodeEnv: Environment['NODE_ENV'];
  readonly isProduction: boolean;
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly bodyLimitBytes: number;
    readonly corsAllowedOrigins: readonly string[];
  };
  readonly tenancy: { readonly rootDomain: string };
  readonly auth: {
    readonly authUrl: string;
    readonly anonKey: string;
    /** Bypasses RLS. Present only where a tool genuinely needs it; never in the browser. */
    readonly serviceRoleKey?: string;
    readonly sessionMaxAgeSeconds: number;
  };
  readonly logging: { readonly level: Environment['LOG_LEVEL'] };
  readonly controlDatabase: { readonly connectionString: string };
  readonly workers: { readonly enabled: boolean };
  readonly storage: { readonly rootDirectory: string };
  readonly tenantMigrationsDirectory: string;
  readonly shutdownTimeoutMs: number;
}

/**
 * Refuses to boot when a configured directory is not there.
 *
 * A missing migrations directory is invalid configuration, and the rule is that the process
 * refuses to start on invalid configuration rather than falling over later. "Later" here
 * means the first time somebody provisions a client — a path that already created a row and
 * a schema before discovering it cannot finish.
 */
function requireDirectory(path: string, variable: string): string {
  const resolved = resolvePath(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new ConfigurationError(
      `${variable} points at ${resolved}, which is not a directory. Paths are resolved ` +
        'from the working directory of the process, which is the package root.',
    );
  }
  return resolved;
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

/**
 * Validates the environment and returns typed configuration.
 *
 * @throws ConfigurationError listing every invalid field, so a misconfigured deploy
 *   fails once with a complete report instead of one variable at a time.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(`Invalid environment configuration:\n${problems}`);
  }

  const env = parsed.data;

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    http: {
      host: env.HOST,
      port: env.PORT,
      bodyLimitBytes: env.BODY_LIMIT_BYTES,
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
    },
    tenancy: { rootDomain: env.ROOT_DOMAIN },
    auth: {
      authUrl: env.SUPABASE_AUTH_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      ...(env.SUPABASE_SERVICE_ROLE_KEY === undefined
        ? {}
        : { serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }),
      sessionMaxAgeSeconds: env.SESSION_MAX_AGE_SECONDS,
    },
    logging: { level: env.LOG_LEVEL },
    controlDatabase: { connectionString: env.CONTROL_DATABASE_URL },
    workers: { enabled: env.WORKERS_ENABLED },
    storage: { rootDirectory: env.STORAGE_ROOT_DIRECTORY },
    tenantMigrationsDirectory: requireDirectory(
      env.TENANT_MIGRATIONS_DIRECTORY,
      'TENANT_MIGRATIONS_DIRECTORY',
    ),
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}
