import { describe, expect, it } from 'vitest';

import { RandomSecretGenerator, Sha256SecretHasher } from './sha256SecretHasher.js';

const hasher = new Sha256SecretHasher();

describe('hashing a secret', () => {
  it('produces a hex digest that does not contain the secret', () => {
    const secret = 'un-secreto-de-prueba-suficientemente-largo';

    expect(hasher.hash(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hasher.hash(secret)).not.toContain(secret);
  });

  it('is stable, so a stored digest keeps matching', () => {
    expect(hasher.hash('mismo')).toBe(hasher.hash('mismo'));
  });

  it('accepts the secret it was made from and nothing else', () => {
    const digest = hasher.hash('correcto');

    expect(hasher.matches(digest, 'correcto')).toBe(true);
    expect(hasher.matches(digest, 'incorrecto')).toBe(false);
  });

  it('refuses a stored digest of the wrong length rather than crashing', () => {
    // A truncated or corrupt row must answer "no", not take the process down on every
    // request that touches it.
    expect(hasher.matches('abc', 'correcto')).toBe(false);
  });

  it('refuses a digest that is not hex at all', () => {
    expect(hasher.matches('no-es-hexadecimal', 'correcto')).toBe(false);
  });
});

describe('minting a secret', () => {
  const generator = new RandomSecretGenerator();

  it('produces a token long enough for the format to accept', () => {
    expect(generator.next().length).toBeGreaterThanOrEqual(32);
  });

  it('produces one word a shell will not mangle', () => {
    // base64url: no `+`, no `/`, no `=`. A person pastes it into a config file or an env
    // var, and a character needing quoting is a character that arrives truncated.
    expect(generator.next()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat', () => {
    const minted = new Set(Array.from({ length: 50 }, () => generator.next()));

    expect(minted.size).toBe(50);
  });
});
