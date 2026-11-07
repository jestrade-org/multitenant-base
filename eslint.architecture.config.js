// The dependency rule, enforced by the build.
//
//   domain <- application <- infrastructure <- delivery (apps/)
//
// Arrows point inward only. A violation is a failing build, not a review comment:
// `pnpm lint:arch` runs this file on its own so CI reports it as a distinct step.
//
// This is not bureaucracy. The Fase 1 simplifications of the tech spec (single Node
// process, pg-boss over Postgres instead of Redis) are only safe to reverse later
// because the domain never touches those adapters. If domain code starts calling
// pg-boss or the Supabase client directly, the §19.1 migrations stop being an
// adapter swap and become a rewrite.

/** Packages the domain layer may never import. Ports are declared, not consumed. */
const INFRASTRUCTURE_PACKAGES = [
  '@supabase/*',
  'pg',
  'pg-*',
  'postgres',
  'graphile-worker',
  'fastify',
  'fastify-*',
  '@fastify/*',
  'express',
  'pino',
  'pino-*',
  'ioredis',
  'redis',
  'bullmq',
  'axios',
  'node-fetch',
  'undici',
  'openai',
  '@anthropic-ai/*',
  'nodemailer',
  'twilio',
];

/** Node builtins that only make sense on the outside of the hexagon. */
const INFRASTRUCTURE_BUILTINS = [
  'node:fs',
  'node:fs/*',
  'node:http',
  'node:https',
  'node:net',
  'node:dns',
  'node:child_process',
  'node:worker_threads',
  'node:crypto',
  'fs',
  'http',
  'https',
  'net',
  'dns',
  'child_process',
  'worker_threads',
  'crypto',
];

const layerZones = [
  {
    // Globs here must match the FILE, not the directory: the rule minimatches the
    // resolved filename, so a trailing /** is what makes the zone fire at all.
    target: './packages/*/src/domain/**',
    from: [
      './packages/*/src/application/**',
      './packages/*/src/infrastructure/**',
      './packages/*/src/interface/**',
    ],
    message:
      'domain/ is the innermost layer: it may import only shared-kernel and the standard library.',
  },
  {
    target: './packages/*/src/application/**',
    from: ['./packages/*/src/infrastructure/**', './packages/*/src/interface/**'],
    message:
      'application/ orchestrates the domain behind ports it declares itself. It never imports infrastructure/ — inject the adapter at the composition root instead.',
  },
  {
    target: './packages/*/src/infrastructure/**',
    from: ['./packages/*/src/interface/**'],
    message: 'infrastructure/ implements ports; it does not depend on the delivery layer.',
  },
  {
    // Delivery reaches a context through its package root index.ts. Relative paths
    // that tunnel into a context's layers are caught here; imports by package name
    // are caught by the deep-import rule below.
    target: './apps/*/src/**',
    from: ['./packages/*/src/domain/**', './packages/*/src/infrastructure/**'],
    message:
      'apps/ depends on application/ only, through the package root index.ts and the composition root.',
  },
];

// `pnpm lint:arch` runs this file with --config, which replaces the whole ESLint
// configuration — including the parser. Without this, every `.ts` file fails to parse
// as JavaScript and the architecture rules silently never run on real code.
const typescriptParser = {
  languageOptions: {
    parser: (await import('typescript-eslint')).parser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
};

/**
 * Defence 1 of §4.3: the schema is never chosen by hand.
 *
 * A tenant schema name has exactly one legitimate route into SQL — the connection
 * provider binding `search_path` for one unit of work. Anything else that names a tenant
 * schema, or reaches for `search_path` on its own, is the bug class this exists to make
 * impossible: a query that reads or writes the wrong company's data.
 */
const noHandQualifiedTenantSchema = [
  {
    selector: 'Literal[value=/\\btenant_[a-z0-9_]+\\s*\\./]',
    message:
      'Never name a tenant schema in SQL. Take a TenantUnitOfWork and write unqualified ' +
      'table names — the connection is already bound to exactly one tenant (§4.3).',
  },
  {
    selector: 'TemplateElement[value.raw=/\\btenant_[a-z0-9_]+\\s*\\./]',
    message:
      'Never interpolate a tenant schema into SQL. Take a TenantUnitOfWork and write ' +
      'unqualified table names (§4.3).',
  },
  {
    // `... from ${x}` — an interpolation sitting where a table or schema identifier goes.
    // Values belong in parameters; identifiers come from a closed set or from
    // quoteIdentifier. This is the shape of both the wrong-tenant bug and SQL injection
    // by identifier, which no amount of parameterisation protects against.
    selector: 'TemplateElement[value.raw=/\\b(from|join|into|update|table|schema)\\s+$/i]',
    message:
      'An interpolation in identifier position. Take a TenantUnitOfWork and write ' +
      'unqualified names, or quote the identifier explicitly (§4.3, A03).',
  },
  {
    selector: 'Literal[value=/search_path/]',
    message:
      'search_path is bound in exactly one place, by the tenant connection provider. ' +
      'Setting it anywhere else defeats defence 1 of §4.3.',
  },
  {
    selector: 'TemplateElement[value.raw=/search_path/]',
    message: 'search_path is bound in exactly one place, by the tenant connection provider (§4.3).',
  },
];

export default [
  {
    name: 'multitenant-base/architecture/dependency-rule',
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    ...typescriptParser,
    plugins: {
      import: (await import('eslint-plugin-import')).default,
    },
    settings: {
      'import/resolver': {
        typescript: { project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json'] },
      },
    },
    rules: {
      'import/no-restricted-paths': ['error', { zones: layerZones }],
    },
  },
  {
    // A context never reaches into another context's internals. It calls the other
    // context's public index.ts, or publishes/subscribes a domain event.
    name: 'multitenant-base/architecture/context-boundaries',
    files: ['packages/**/*.ts'],
    ...typescriptParser,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@multitenant-base/*/src/*', '@multitenant-base/*/dist/*'],
              message:
                "Import another context through its package root ('@multitenant-base/<context>'), never through a deep path into its layers.",
            },
          ],
        },
      ],
    },
  },
  {
    // Defence 1: no hand-qualified tenant schema anywhere in the workspace.
    name: 'multitenant-base/architecture/tenant-schema-is-never-hand-written',
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    ignores: [
      // The one place a schema name legitimately becomes SQL, and the migration runner
      // that creates the schemas in the first place. Both are reviewed as security code.
      'apps/api/src/infrastructure/tenantConnection.ts',
      'packages/tenancy/src/infrastructure/migrations/runner.ts',
      '**/*.test.ts',
    ],
    ...typescriptParser,
    rules: {
      'no-restricted-syntax': ['error', ...noHandQualifiedTenantSchema],
    },
  },
  {
    // The domain is dependency-free by construction, not by discipline.
    name: 'multitenant-base/architecture/pure-domain',
    files: ['packages/*/src/domain/**/*.ts'],
    ...typescriptParser,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...INFRASTRUCTURE_PACKAGES, ...INFRASTRUCTURE_BUILTINS],
              message:
                'The domain layer stays dependency-free. Declare a port in application/ and implement it in infrastructure/.',
            },
            {
              group: ['@multitenant-base/*', '!@multitenant-base/shared-kernel'],
              message:
                'The domain may depend on shared-kernel only. Never import another bounded context from domain/.',
            },
          ],
        },
      ],
      // Time and identity come from injected ports (Clock, IdGenerator), so that a
      // financial calculation is reproducible and testable without freezing globals.
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Non-deterministic in the domain, and never acceptable for anything security-relevant. Inject an IdGenerator port.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Inject a Clock port so the domain stays deterministic and testable.',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message: 'The domain never reads configuration. Pass typed values in from application/.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() is a hidden dependency on the system clock. Inject a Clock port.',
        },
      ],
    },
  },
];
