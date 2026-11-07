import { describe, expect, it } from 'vitest';

import { ValidationError } from '@multitenant-base/shared-kernel';

import {
  ApiKey,
  ApiKeyRevokedError,
  formatApiToken,
  formatKeyPrefix,
  parseApiToken,
  type SecretHasher,
} from './apiKey.js';

/**
 * API keys, and the ways one stops being a secret.
 *
 * The tests worth having here are about what happens *after* the happy path: a key that
 * was revoked, a key that was rotated, a token somebody made up. Those are the requests a
 * public endpoint actually receives.
 */

/**
 * A hasher a test can reason about. The real one is SHA-256, in infrastructure.
 *
 * Neither embeds the secret nor truncates it. A fake that embedded it would pass the
 * assertion that a stored snapshot cannot be replayed while proving nothing; one that
 * truncated would collide on two secrets sharing a tail, and a rotation test would pass
 * while the key still accepted the secret it replaced.
 */
const hasher: SecretHasher = {
  hash: (secret) => {
    let accumulated = 2166136261;
    for (let index = 0; index < secret.length; index += 1) {
      accumulated = Math.imul(accumulated ^ secret.charCodeAt(index), 16777619) >>> 0;
    }
    return `digest-${String(secret.length)}-${accumulated.toString(16)}`;
  },
  matches: (hash, secret) => hash === hasher.hash(secret),
};

const NOW = new Date('2026-08-24T15:00:00.000Z');
// Not a run of one character: a digest of that could contain it by coincidence.
const SECRET = 'sEcReT0-de-prueba-suficientemente-largo-123';

function issue(overrides: { permissions?: readonly string[]; name?: string } = {}) {
  return ApiKey.issue({
    id: 'key-1',
    tenantId: 'tenant-1',
    environment: 'live',
    publicId: 'ab12cd34',
    secret: SECRET,
    name: overrides.name ?? 'Integración contable',
    permissions: overrides.permissions ?? ['tenancy:read'],
    createdBy: 'user-1',
    hasher,
    now: NOW,
  });
}

describe('the token a client presents', () => {
  it('carries a prefix that says which environment it belongs to', () => {
    // Reading a key and not knowing whether it is live is how a staging integration ends
    // up pointed at production data.
    expect(formatKeyPrefix('test', 'ab12cd34')).toBe('mtb_test_ab12cd34');
  });

  it('refuses a public id that would not fit the stored format', () => {
    expect(() => formatKeyPrefix('live', 'short')).toThrow(ValidationError);
  });

  it('splits into the prefix the server looks up and the secret it hashes', () => {
    const parsed = parseApiToken(formatApiToken('mtb_live_ab12cd34', SECRET));

    expect(parsed).toEqual({ prefix: 'mtb_live_ab12cd34', secret: SECRET });
  });

  it.each([
    ['sin-separador'],
    ['mtb_live_ab12cd34'],
    ['otra_cosa_ab12cd34.' + 'a'.repeat(43)],
    ['mtb_live_ab12cd34.corto'],
  ])('returns nothing for %s rather than throwing', (token) => {
    // A malformed token is the ordinary case on a public endpoint. Throwing per request
    // would be a denial of service somebody else gets to schedule.
    expect(parseApiToken(token)).toBeUndefined();
  });

  it('keeps a secret containing the separator intact', () => {
    // The split is on the *first* separator, so a secret that happens to contain one is
    // still read whole rather than silently truncated.
    const parsed = parseApiToken(`mtb_live_ab12cd34.${'b'.repeat(20)}.${'c'.repeat(20)}`);

    expect(parsed?.secret).toBe(`${'b'.repeat(20)}.${'c'.repeat(20)}`);
  });
});

describe('issuing a key', () => {
  it('stores a digest and hands back the secret once', () => {
    const { key, secret } = issue();

    expect(secret).toBe(SECRET);
    expect(key.toSnapshot().secretHash).toBe(hasher.hash(SECRET));
    // The snapshot is what gets written. Nothing in it can be replayed.
    expect(JSON.stringify(key.toSnapshot())).not.toContain(SECRET);
  });

  it('refuses a key nobody could identify later', () => {
    // "test" among nine others is a key nobody dares revoke.
    expect(() => issue({ name: 'ab' })).toThrow(ValidationError);
  });

  it('refuses a key that can do nothing', () => {
    // Created by accident with none, it looks like a working key that mysteriously fails.
    expect(() => issue({ permissions: [] })).toThrow(ValidationError);
  });
});

describe('using a key', () => {
  it('accepts its own secret', () => {
    expect(issue().key.accepts(SECRET, hasher)).toBe(true);
  });

  it('rejects another secret', () => {
    expect(issue().key.accepts('b'.repeat(43), hasher)).toBe(false);
  });

  it('rejects the right secret once revoked', () => {
    const { key } = issue();
    key.revoke(NOW);

    expect(key.accepts(SECRET, hasher)).toBe(false);
  });

  it('answers a revoked key the same way as a wrong secret', () => {
    // The caller is unauthenticated. Distinguishing the two would tell an attacker that
    // the key existed, which is one bit more than they should get.
    const { key } = issue();
    key.revoke(NOW);

    expect(key.accepts(SECRET, hasher)).toBe(key.accepts('otro', hasher));
  });
});

describe('rotating', () => {
  it('replaces the secret and keeps the identity', () => {
    // Rotation is not revoke-and-recreate: the integration keeps its name, its
    // capabilities and its place in the list, which is what makes rotating something an
    // operator does rather than postpones.
    const { key } = issue();
    const replacement = 'un-secreto-de-reemplazo-suficientemente-largo';

    key.rotate({ secret: replacement, hasher });

    expect(key.accepts(replacement, hasher)).toBe(true);
    expect(key.accepts(SECRET, hasher)).toBe(false);
    expect(key.permissions).toEqual(['tenancy:read']);
    expect(key.keyPrefix).toBe('mtb_live_ab12cd34');
  });

  it('refuses to rotate a revoked key', () => {
    const { key } = issue();
    key.revoke(NOW);

    expect(() => key.rotate({ secret: 'un-secreto-de-reemplazo-largo-de-verdad', hasher })).toThrow(
      ApiKeyRevokedError,
    );
  });
});

describe('revoking', () => {
  it('is idempotent, because a second click is not an error', () => {
    const { key } = issue();
    const later = new Date('2026-08-25T15:00:00.000Z');

    key.revoke(NOW);
    key.revoke(later);

    // The first revocation is the one that happened; the second must not move the date.
    expect(key.toSnapshot().revokedAt).toEqual(NOW);
  });
});
