import { describe, expect, it } from 'vitest';

import { ValidationError } from '@multitenant-base/shared-kernel';

import {
  normalizeTaxId,
  prepareTenantRegistration,
  suggestSubdomain,
  type RegisterTenantInput,
} from './tenantRegistration.js';

/**
 * These values reach SQL as identifiers. No care downstream rescues a bad one.
 */

function anInput(overrides: Partial<RegisterTenantInput> = {}): RegisterTenantInput {
  return {
    name: 'Acme Logistics Inc.',
    taxId: '12-3456789',
    planCode: 'starter',
    ...overrides,
  };
}

describe('deriving a subdomain from a company name', () => {
  it.each([
    ['Acme Logistics Inc.', 'acme-logistics'],
    ['Globex Corp.', 'globex'],
    ['Initech LLC', 'initech'],
    ['Distribuidora del Norte S.A.S.', 'distribuidora-norte'],
    [
      // Derives to more characters than a schema name allows before slicing.
      'Northern Maritime and Overland Freight Services of the Coast Ltd.',
      'northern-maritime-overland-freight-servi',
    ],
  ])('turns %s into %s', (name, expected) => {
    expect(suggestSubdomain(name)).toBe(expected);
  });

  it('never suggests something longer than a schema name allows', () => {
    const suggestion = suggestSubdomain(
      'International Consolidated Distribution and Integrated Logistics Holdings Inc.',
    );

    expect(suggestion.length).toBeLessThanOrEqual(40);
    expect(suggestion.endsWith('-')).toBe(false);
    expect(() => prepareTenantRegistration(anInput({ subdomain: suggestion }))).not.toThrow();
  });

  it('explains the limit when an operator types one that is too long', () => {
    expect(() => prepareTenantRegistration(anInput({ subdomain: 'a'.repeat(45) }))).toThrow(
      /schema name allows/,
    );
  });

  it('strips accents, which cannot appear in a hostname', () => {
    expect(suggestSubdomain('Almacén Ñandú')).toBe('almacen-nandu');
  });
});

describe('normalising a tax identifier', () => {
  it.each([
    ['12-3456789', '123456789'],
    ['b 1234 5678', 'B12345678'],
    ['900.123.456-8', '9001234568'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normalizeTaxId(raw)).toBe(expected);
  });

  it.each([['ab'], ['12#34'], ['x'.repeat(31)]])('refuses %s', (raw) => {
    expect(() => normalizeTaxId(raw)).toThrow(ValidationError);
  });
});

describe('preparing a registration', () => {
  it('derives the schema name from the subdomain, never as a separate field', () => {
    const registration = prepareTenantRegistration(anInput({ subdomain: 'acme-north' }));

    expect(registration.subdomain).toBe('acme-north');
    expect(registration.schemaName).toBe('tenant_acme_north');
  });

  it('stores the tax identifier normalised, so the same company typed twice is one', () => {
    expect(prepareTenantRegistration(anInput()).taxId).toBe('123456789');
  });

  it('defaults the timezone to UTC, and says so rather than assuming the server one', () => {
    expect(prepareTenantRegistration(anInput()).timezone).toBe('UTC');
  });

  it('accepts the company timezone when the operator gives one', () => {
    const registration = prepareTenantRegistration(anInput({ timezone: 'America/Lima' }));

    expect(registration.timezone).toBe('America/Lima');
  });

  it.each([['api'], ['www'], ['admin'], ['app'], ['panel']])(
    'refuses the reserved subdomain %s',
    (subdomain) => {
      expect(() => prepareTenantRegistration(anInput({ subdomain }))).toThrow(/reserved/);
    },
  );

  it('lowercases what the operator typed, since hostnames are case-insensitive', () => {
    expect(prepareTenantRegistration(anInput({ subdomain: 'Acme' })).subdomain).toBe('acme');
  });

  it.each([['ac_me'], ['-acme'], ['acme.co'], ['a'], ['acme north']])(
    'refuses %s as a subdomain',
    (subdomain) => {
      expect(() => prepareTenantRegistration(anInput({ subdomain }))).toThrow(ValidationError);
    },
  );

  it('refuses a name nobody could recognise', () => {
    expect(() => prepareTenantRegistration(anInput({ name: ' A ' }))).toThrow(ValidationError);
  });
});
