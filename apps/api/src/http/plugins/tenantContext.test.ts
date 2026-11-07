import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { TenantDirectory } from '@multitenant-base/tenancy';

import { tenantContextPlugin } from './tenantContext.js';

const acmeRow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme Logistics Inc.',
  schema_name: 'tenant_acme',
  subdomain: 'acme',
  isolation_mode: 'shared_schema',
  lifecycle_status: 'active',
  timezone: 'America/Bogota',
};
const globexRow = { ...acmeRow, id: '22222222-2222-4222-8222-222222222222', subdomain: 'globex' };

/** Stands in for the control plane: answers by whichever column the lookup used. */
function directoryOf(rows: readonly Record<string, unknown>[]) {
  return new TenantDirectory({
    client: {
      query: (sql: string, values: readonly unknown[] = []) => {
        const needle = String(values[0]);
        const column = sql.includes('t.subdomain = $1')
          ? 'subdomain'
          : sql.includes('t.id = $1')
            ? 'id'
            : 'key_prefix';
        return Promise.resolve(
          column === 'key_prefix' ? rows.slice(0, 1) : rows.filter((row) => row[column] === needle),
        );
      },
    },
    // No caching between assertions.
    ttlMs: 0,
  });
}

async function appWith(options: {
  readonly rows?: readonly Record<string, unknown>[];
  readonly readVerifiedTenantId?: (request: FastifyRequest) => string | undefined;
}) {
  const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });

  await app.register(tenantContextPlugin, {
    directory: directoryOf(options.rows ?? [acmeRow, globexRow]),
    rootDomain: 'example.test',
    tenantScopedPrefixes: ['/api/v1'],
    ...(options.readVerifiedTenantId ? { readVerifiedTenantId: options.readVerifiedTenantId } : {}),
  });

  app.setErrorHandler((error: FastifyError, _request, reply) =>
    reply.code(error.statusCode ?? 500).send({ error: { code: error.code } }),
  );

  // Routes owned by this test: one tenant-scoped, one public.
  app.get('/api/v1/whoami', (request, reply) =>
    reply.send({ schema: request.tenant?.schemaName ?? null }),
  );
  app.get('/health/live', (_request, reply) => reply.send({ status: 'live' }));
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND' } }),
  );

  return app;
}

describe('tenant context', () => {
  it('resolves a tenant-scoped request from the host', async () => {
    const app = await appWith({});

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { host: 'acme.example.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schema: 'tenant_acme' });
    await app.close();
  });

  it('leaves public routes alone: a health probe belongs to no tenant', async () => {
    const app = await appWith({});

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a tenant-scoped request that identifies no tenant', async () => {
    const app = await appWith({});

    const response = await app.inject({ method: 'GET', url: '/api/v1/whoami' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    await app.close();
  });

  it('answers an unknown subdomain exactly as it answers a nonexistent route', async () => {
    const app = await appWith({});

    const unknownTenant = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { host: 'not-a-customer.example.test' },
    });
    const unknownRoute = await app.inject({
      method: 'GET',
      url: '/api/v1/no-such-route',
      headers: { host: 'acme.example.test' },
    });

    // Byte-identical, deliberately. Any difference would let someone probe subdomains
    // and learn which companies are customers.
    expect(unknownTenant.statusCode).toBe(unknownRoute.statusCode);
    expect(unknownTenant.json()).toEqual(unknownRoute.json());
    await app.close();
  });

  it("refuses a verified user of one company on another company's host", async () => {
    const app = await appWith({ readVerifiedTenantId: () => acmeRow.id });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { host: 'globex.example.test' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('accepts a verified user on their own host', async () => {
    const app = await appWith({ readVerifiedTenantId: () => acmeRow.id });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { host: 'acme.example.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schema: 'tenant_acme' });
    await app.close();
  });

  it('ignores the host entirely when it is not under the root domain', async () => {
    const app = await appWith({});

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { host: 'acme.attacker.example' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('refuses a suspended tenant', async () => {
    const app = await appWith({
      rows: [{ ...acmeRow, lifecycle_status: 'suspended' }],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/whoami',
      headers: { host: 'acme.example.test' },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
