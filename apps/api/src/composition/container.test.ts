import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { buildContainer } from './container.js';
import { loadConfig } from '../config/environment.js';

/**
 * The composition root must assemble from configuration alone.
 *
 * Nothing here connects to anything: pools are lazy and the workers are off, so a failure
 * is a wiring mistake — a port left unsatisfied, an adapter constructed with the wrong
 * shape — caught before any request depends on it.
 */

const REQUIRED: NodeJS.ProcessEnv = {
  CONTROL_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
  TENANT_MIGRATIONS_DIRECTORY: './supabase/tenant-migrations',
  SUPABASE_AUTH_URL: 'http://127.0.0.1:55321/auth/v1',
  SUPABASE_ANON_KEY: 'local-anon-key-for-tests-only',
  // Nothing here connects to anything; the workers would.
  WORKERS_ENABLED: 'false',
};

function containerFor(overrides: NodeJS.ProcessEnv = {}) {
  return buildContainer({
    config: loadConfig({ ...REQUIRED, ...overrides }),
    logger: pino({ level: 'silent' }),
  });
}

describe('building the container', () => {
  it('comes up from the required configuration alone', () => {
    expect(() => containerFor()).not.toThrow();
  });

  it('exposes the platform context the routes are wired to', () => {
    expect(Object.keys(containerFor().platform)).toEqual(
      expect.arrayContaining(['withRoles', 'withApiKeys', 'withPlatform', 'withPlans']),
    );
  });
});
