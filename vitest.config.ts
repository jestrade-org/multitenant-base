import { defineConfig } from 'vitest/config';

/**
 * Two environments, deliberately.
 *
 * Everything that holds a business rule runs in `node`: the domain must not be able to
 * reach a DOM, and a test that passes only because a browser global happened to exist is
 * not evidence. The web app gets `jsdom` because its tests are about what a person sees.
 *
 * CI runs with TZ=UTC; local runs match, so a period boundary cannot pass on one machine
 * and fail on another.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/index.ts'],
    },
    name: 'node',
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'tools/**/*.test.ts'],
    // `*.test.ts` matches `*.integration.test.ts` too, which would drag a database
    // requirement into the suite that has to run without one.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
