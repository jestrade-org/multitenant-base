import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { TenantDirectory } from '@multitenant-base/tenancy';

import { ReadinessRegistry } from './health.js';
import { loadConfig } from '../../config/environment.js';
import type { SupabaseAuth } from '../../infrastructure/auth/supabaseAuth.js';
import type { ControlDatabase } from '../../infrastructure/controlDatabase.js';
import { buildServer } from '../server.js';

const silent = pino({ level: 'silent' });

async function serverWith(options: {
  readonly readiness: ReadinessRegistry;
  readonly accepting?: boolean;
}) {
  return buildServer({
    config: loadConfig({
      NODE_ENV: 'test',
      CONTROL_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
      SUPABASE_AUTH_URL: 'http://127.0.0.1:55321/auth/v1',
      SUPABASE_ANON_KEY: 'local-anon-key-for-tests-only',
      TENANT_MIGRATIONS_DIRECTORY: './supabase/tenant-migrations',
      // A health probe consults no AI provider. Naming the one that needs no credential
      // says that, where a fake API key would only look like a dependency this has.
      AI_PROVIDER: 'ollama',
    }),
    logger: silent,
    readiness: options.readiness,
    isAcceptingTraffic: () => options.accepting ?? true,
    // Health probes belong to no tenant and need no session, so neither the directory
    // nor the auth provider is consulted here.
    tenantDirectory: new TenantDirectory({ client: { query: () => Promise.resolve([]) } }),
    // Health probes write no audit events; a recorder that would throw if used proves it.
    audit: {
      record: () => Promise.reject(new Error('a health probe must not write an audit event')),
      recordInBackground: () => {
        throw new Error('a health probe must not write an audit event');
      },
    },
    auth: {
      verify: () => Promise.resolve(undefined),
      signInWithPassword: () => Promise.reject(new Error('not used')),
      refresh: () => Promise.reject(new Error('not used')),
      signOut: () => Promise.resolve(),
    } as unknown as SupabaseAuth,
    controlDatabase: { query: () => Promise.resolve([]) } as unknown as ControlDatabase,
  });
}

const openServers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

describe('health probes', () => {
  it('reports liveness as long as the process answers', async () => {
    const app = await serverWith({ readiness: new ReadinessRegistry() });
    openServers.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'live' });
  });

  it('reports ready when every registered dependency answers', async () => {
    const readiness = new ReadinessRegistry();
    readiness.register({ name: 'control-database', check: () => Promise.resolve(true) });
    const app = await serverWith({ readiness });
    openServers.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: [{ name: 'control-database', status: 'ok' }],
    });
  });

  it('reports not-ready when a dependency is unreachable', async () => {
    const readiness = new ReadinessRegistry();
    readiness.register({ name: 'control-database', check: () => Promise.resolve(false) });
    readiness.register({ name: 'job-queue', check: () => Promise.resolve(true) });
    const app = await serverWith({ readiness });
    openServers.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ status: string }>().status).toBe('not-ready');
  });

  it('treats a thrown check as a failure instead of crashing the probe', async () => {
    const readiness = new ReadinessRegistry();
    readiness.register({
      name: 'control-database',
      check: () => Promise.reject(new Error('connection refused to 10.0.0.5:5432')),
    });
    const app = await serverWith({ readiness });
    openServers.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    // The probe is unauthenticated: it names the failing dependency, never the reason.
    expect(response.body).not.toContain('10.0.0.5');
    expect(response.body).not.toContain('connection refused');
  });

  it('fails readiness while draining so the load balancer stops sending traffic', async () => {
    const readiness = new ReadinessRegistry();
    readiness.register({ name: 'control-database', check: () => Promise.resolve(true) });
    const app = await serverWith({ readiness, accepting: false });
    openServers.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ status: string }>().status).toBe('draining');
  });
});

describe('request correlation', () => {
  it('generates a correlation id and echoes it back', async () => {
    const app = await serverWith({ readiness: new ReadinessRegistry() });
    openServers.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses a well-formed inbound correlation id', async () => {
    const app = await serverWith({ readiness: new ReadinessRegistry() });
    openServers.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': '01HRZQWERTY12345' },
    });

    expect(response.headers['x-correlation-id']).toBe('01HRZQWERTY12345');
  });

  it('rejects a hostile inbound correlation id rather than logging it verbatim', async () => {
    const app = await serverWith({ readiness: new ReadinessRegistry() });
    openServers.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': 'a".$(rm -rf /)\n\rinjected' },
    });

    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error responses', () => {
  it('returns a stable code and the correlation id, never a stack trace', async () => {
    const app = await serverWith({ readiness: new ReadinessRegistry() });
    openServers.push(app);

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(response.json<{ error: { correlationId: string } }>().error.correlationId).toBeTruthy();
    expect(response.body).not.toContain('at ');
  });
});
