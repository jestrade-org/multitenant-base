import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from './environment.js';

const DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

/**
 * The variables with no safe default: the process must refuse to boot without them, so
 * every valid environment carries them. Tests vary only what they are about.
 */
const REQUIRED: NodeJS.ProcessEnv = {
  CONTROL_DATABASE_URL: DATABASE_URL,
  // Vitest runs from the repository root; the process itself runs from apps/api. The
  // default is correct for the process, so the tests state the path they actually have.
  TENANT_MIGRATIONS_DIRECTORY: './supabase/tenant-migrations',
  SUPABASE_AUTH_URL: 'http://127.0.0.1:55321/auth/v1',
  SUPABASE_ANON_KEY: 'local-anon-key-for-tests-only',
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...REQUIRED, ...overrides };
}

describe('loadConfig', () => {
  it('applies documented defaults when only the required shape is present', () => {
    const config = loadConfig(env());

    expect(config.nodeEnv).toBe('development');
    expect(config.http.port).toBe(3000);
    expect(config.workers.enabled).toBe(true);
    expect(config.http.corsAllowedOrigins).toEqual([]);
  });

  it('refuses to boot on a port outside the valid range', () => {
    expect(() => loadConfig(env({ PORT: '70000' }))).toThrow(ConfigurationError);
  });

  it('refuses to boot on an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'staging' }))).toThrow(ConfigurationError);
  });

  it('reports every invalid field at once, not one per restart', () => {
    let message = '';
    try {
      loadConfig(env({ PORT: 'not-a-number', NODE_ENV: 'staging', LOG_LEVEL: 'chatty' }));
    } catch (error: unknown) {
      message = (error as Error).message;
    }

    expect(message).toContain('PORT');
    expect(message).toContain('NODE_ENV');
    expect(message).toContain('LOG_LEVEL');
  });

  it('treats WORKERS_ENABLED as a strict boolean, never as truthiness', () => {
    expect(loadConfig(env({ WORKERS_ENABLED: 'false' })).workers.enabled).toBe(false);
    expect(() => loadConfig(env({ WORKERS_ENABLED: '0' }))).toThrow(ConfigurationError);
    expect(() => loadConfig(env({ WORKERS_ENABLED: 'no' }))).toThrow(ConfigurationError);
  });

  it('refuses to boot without a control database URL rather than guessing one', () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
    expect(() => loadConfig(env({ CONTROL_DATABASE_URL: 'not-a-url' }))).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig(env({ CONTROL_DATABASE_URL: 'https://example.com' }))).toThrow(
      ConfigurationError,
    );
  });

  it('parses the CORS allowlist into trimmed origins', () => {
    const config = loadConfig(
      env({ CORS_ALLOWED_ORIGINS: 'https://app.example.test, https://admin.example.test ,' }),
    );

    expect(config.http.corsAllowedOrigins).toEqual([
      'https://app.example.test',
      'https://admin.example.test',
    ]);
  });
});

describe('directories the process refuses to boot without', () => {
  it('accepts a migrations directory that exists', () => {
    expect(loadConfig(env()).tenantMigrationsDirectory).toContain('tenant-migrations');
  });

  it('refuses one that does not, rather than failing at the first provisioning', () => {
    // "Later" would mean the first time somebody creates a client — a path that already
    // wrote a row and created a schema before discovering it cannot finish.
    expect(() => loadConfig(env({ TENANT_MIGRATIONS_DIRECTORY: './no/such/directory' }))).toThrow(
      ConfigurationError,
    );
  });

  it('says where it looked, since the path is relative to the working directory', () => {
    expect(() => loadConfig(env({ TENANT_MIGRATIONS_DIRECTORY: './nope' }))).toThrow(
      /working directory/,
    );
  });
});
