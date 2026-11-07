import { describe, expect, it } from 'vitest';

import type { SqlClient } from './migrations/runner.js';
import { TenantDirectory } from './tenantDirectory.js';

const acmeRow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme Logistics Inc.',
  schema_name: 'tenant_acme',
  subdomain: 'acme',
  isolation_mode: 'shared_schema',
  lifecycle_status: 'active',
  timezone: 'America/Bogota',
};

class RecordingClient implements SqlClient {
  public readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  #rows: readonly Record<string, unknown>[];

  public constructor(rows: readonly Record<string, unknown>[] = [acmeRow]) {
    this.#rows = rows;
  }

  public query(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Record<string, unknown>[]> {
    this.calls.push({ sql, values });
    return Promise.resolve(this.#rows);
  }
}

describe('TenantDirectory', () => {
  it('maps a control-plane row to the tenant the edge needs', async () => {
    const directory = new TenantDirectory({ client: new RecordingClient() });

    const tenant = await directory.find({ by: 'subdomain', value: 'acme' });

    expect(tenant).toEqual({
      id: acmeRow.id,
      name: 'Acme Logistics Inc.',
      schemaName: 'tenant_acme',
      subdomain: 'acme',
      isolationMode: 'shared_schema',
      lifecycleStatus: 'active',
      timezone: 'America/Bogota',
    });
  });

  it('passes the lookup value as a parameter, never inside the statement', async () => {
    const client = new RecordingClient();
    const directory = new TenantDirectory({ client });

    await directory.find({ by: 'subdomain', value: "acme'; drop schema control;--" });

    expect(client.calls[0]?.values).toEqual(["acme'; drop schema control;--"]);
    expect(client.calls[0]?.sql).not.toContain('drop schema');
  });

  it('returns undefined for a malformed tenant id instead of letting Postgres raise', async () => {
    const client = new RecordingClient();
    const directory = new TenantDirectory({ client });

    const tenant = await directory.find({ by: 'id', value: 'not-a-uuid' });

    expect(tenant).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it('only matches API keys that have not been revoked', async () => {
    const client = new RecordingClient();
    const directory = new TenantDirectory({ client });

    await directory.find({ by: 'api-key-prefix', value: 'mtb_live_abcdefgh' });

    expect(client.calls[0]?.sql).toContain('revoked_at is null');
  });

  it('caches a hit so every request does not hit the control plane', async () => {
    const client = new RecordingClient();
    const directory = new TenantDirectory({ client, ttlMs: 30_000, now: () => 1000 });

    await directory.find({ by: 'subdomain', value: 'acme' });
    await directory.find({ by: 'subdomain', value: 'acme' });

    expect(client.calls).toHaveLength(1);
  });

  it('stops serving a cached tenant once the TTL passes', async () => {
    const client = new RecordingClient();
    let now = 1000;
    const directory = new TenantDirectory({ client, ttlMs: 5_000, now: () => now });

    await directory.find({ by: 'subdomain', value: 'acme' });
    now += 5_001;
    await directory.find({ by: 'subdomain', value: 'acme' });

    // A suspended tenant must stop being served quickly, so the cache has to expire.
    expect(client.calls).toHaveLength(2);
  });

  it('never caches a miss, so a tenant created a moment ago is found', async () => {
    const client = new RecordingClient([]);
    const directory = new TenantDirectory({ client });

    await directory.find({ by: 'subdomain', value: 'brand-new' });
    await directory.find({ by: 'subdomain', value: 'brand-new' });

    expect(client.calls).toHaveLength(2);
  });

  it('bounds the cache, so unknown-subdomain traffic cannot exhaust memory', async () => {
    const client = new RecordingClient();
    const directory = new TenantDirectory({ client, maxEntries: 3, now: () => 1000 });

    for (let i = 0; i < 10; i += 1) {
      await directory.find({ by: 'subdomain', value: `probe-${String(i)}` });
    }
    // The earliest entries were evicted, so re-asking for one costs another query.
    const callsBefore = client.calls.length;
    await directory.find({ by: 'subdomain', value: 'probe-0' });

    expect(client.calls.length).toBe(callsBefore + 1);
  });

  it('drops everything on invalidate, for a lifecycle change', async () => {
    const client = new RecordingClient();
    const directory = new TenantDirectory({ client, now: () => 1000 });

    await directory.find({ by: 'subdomain', value: 'acme' });
    directory.invalidate();
    await directory.find({ by: 'subdomain', value: 'acme' });

    expect(client.calls).toHaveLength(2);
  });
});
