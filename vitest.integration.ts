import { defineConfig } from 'vitest/config';

/**
 * Integration tests: real Postgres, real RLS, real grants.
 *
 * A separate project from the unit suite, not a separate runner. Unit tests must stay
 * runnable on a laptop with no Docker; these cannot — but they are the only tests that can
 * prove an isolation claim, because the claim is about the database's behaviour and not
 * ours. CI runs both (git-workflow.md, steps 4 and 5).
 *
 * Requires `pnpm supabase start`.
 */
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['packages/*/src/**/*.integration.test.ts', 'apps/api/src/**/*.integration.test.ts'],
    // One database: parallel files would see each other's rows.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
