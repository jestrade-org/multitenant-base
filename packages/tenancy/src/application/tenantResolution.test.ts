import { describe, expect, it } from 'vitest';

import {
  acceptResolvedTenant,
  selectTenantLookup,
  subdomainFromHost,
  type ResolvedTenant,
} from './tenantResolution.js';

const acme: ResolvedTenant = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme Logistics Inc.',
  schemaName: 'tenant_acme',
  subdomain: 'acme',
  isolationMode: 'shared_schema',
  lifecycleStatus: 'active',
  timezone: 'America/Bogota',
};

describe('selectTenantLookup', () => {
  it('prefers the verified token over everything else', () => {
    const selection = selectTenantLookup({
      tokenTenantId: acme.id,
      subdomain: 'globex',
      apiKeyPrefix: 'mtb_live_abcdefgh',
    });

    expect(selection).toEqual({
      outcome: 'lookup',
      source: 'token',
      lookup: { by: 'id', value: acme.id },
    });
  });

  it('falls back to the subdomain when there is no token', () => {
    const selection = selectTenantLookup({ subdomain: 'acme' });

    expect(selection).toMatchObject({ source: 'subdomain', lookup: { by: 'subdomain' } });
  });

  it('uses the API key prefix only when nothing else identifies the tenant', () => {
    const selection = selectTenantLookup({ apiKeyPrefix: 'mtb_live_abcdefgh' });

    expect(selection).toMatchObject({ source: 'api-key', lookup: { by: 'api-key-prefix' } });
  });

  it('reports no hint when the request identifies nothing', () => {
    expect(selectTenantLookup({})).toEqual({ outcome: 'no-hint' });
  });

  it('treats an empty string as absent rather than as a tenant named ""', () => {
    expect(selectTenantLookup({ tokenTenantId: '', subdomain: '' })).toEqual({
      outcome: 'no-hint',
    });
  });
});

describe('acceptResolvedTenant', () => {
  it('accepts a tenant resolved from a token with no host hint', () => {
    const resolution = acceptResolvedTenant({
      source: 'token',
      tenant: acme,
      hints: { tokenTenantId: acme.id },
    });

    expect(resolution).toEqual({ outcome: 'resolved', source: 'token', tenant: acme });
  });

  it('accepts a token that agrees with the host it arrived on', () => {
    const resolution = acceptResolvedTenant({
      source: 'token',
      tenant: acme,
      hints: { tokenTenantId: acme.id, subdomain: 'acme' },
    });

    expect(resolution.outcome).toBe('resolved');
  });

  it("rejects a user of one company probing another company's subdomain", () => {
    const resolution = acceptResolvedTenant({
      source: 'token',
      tenant: acme,
      hints: { tokenTenantId: acme.id, subdomain: 'globex' },
    });

    expect(resolution).toEqual({
      outcome: 'rejected',
      rejection: { reason: 'subdomain-mismatch', expected: 'acme', received: 'globex' },
    });
  });

  it('rejects a tenant the directory does not know', () => {
    const resolution = acceptResolvedTenant({
      source: 'subdomain',
      tenant: undefined,
      hints: { subdomain: 'does-not-exist' },
    });

    expect(resolution).toEqual({ outcome: 'rejected', rejection: { reason: 'unknown-tenant' } });
  });

  it.each(['suspended', 'terminated'] as const)('refuses to serve a %s tenant', (status) => {
    const resolution = acceptResolvedTenant({
      source: 'subdomain',
      tenant: { ...acme, lifecycleStatus: status },
      hints: { subdomain: 'acme' },
    });

    expect(resolution).toMatchObject({
      outcome: 'rejected',
      rejection: { reason: 'tenant-not-serving' },
    });
  });

  it.each(['onboarding', 'active'] as const)('serves a tenant in %s', (status) => {
    const resolution = acceptResolvedTenant({
      source: 'subdomain',
      tenant: { ...acme, lifecycleStatus: status },
      hints: { subdomain: 'acme' },
    });

    expect(resolution.outcome).toBe('resolved');
  });
});

describe('subdomainFromHost', () => {
  it('extracts the tenant label', () => {
    expect(subdomainFromHost('acme.example.test', 'example.test')).toBe('acme');
  });

  it('ignores the port', () => {
    expect(subdomainFromHost('acme.example.test:8443', 'example.test')).toBe('acme');
  });

  it('is case-insensitive, because host names are', () => {
    expect(subdomainFromHost('ACME.Example.Test', 'example.test')).toBe('acme');
  });

  it.each([
    ['the apex domain has no tenant', 'example.test'],
    ['a nested label is not a tenant name', 'a.b.example.test'],
    ['a different domain entirely', 'acme.evil.example'],
    ['a bare host', 'localhost'],
    ['an IP address', '10.0.0.5'],
    ['an empty label', '.example.test'],
  ])('returns undefined: %s', (_why, host) => {
    expect(subdomainFromHost(host, 'example.test')).toBeUndefined();
  });

  it('does not let a crafted Host smuggle a name through', () => {
    expect(subdomainFromHost('acme%2Eglobex.example.test', 'example.test')).toBeUndefined();
    expect(subdomainFromHost('acme/../globex.example.test', 'example.test')).toBeUndefined();
  });
});
