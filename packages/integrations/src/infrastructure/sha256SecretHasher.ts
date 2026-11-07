import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SecretHasher } from '../domain/apiKey.js';

/**
 * SHA-256, and a comparison whose duration does not depend on the secret.
 *
 * A fast hash on purpose. Slow key-derivation functions (argon2, bcrypt) exist to make
 * guessing a low-entropy *password* expensive; these secrets carry 256 bits of randomness,
 * where guessing is not a threat that arithmetic can make worse. Paying argon2's work
 * factor on every API request would cost tens of milliseconds each to defend against an
 * attack that cannot happen, and the latency would be entirely real.
 *
 * What does matter is the comparison. `===` on two digests returns as soon as they differ,
 * so its duration leaks how much of a guess was right — enough, over many requests, to
 * find the rest a byte at a time. `timingSafeEqual` does not.
 */
export class Sha256SecretHasher implements SecretHasher {
  public hash(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  public matches(hash: string, secret: string): boolean {
    const expected = Buffer.from(hash, 'hex');
    const actual = Buffer.from(this.hash(secret), 'hex');

    // Different lengths cannot be compared in constant time, and a stored digest of the
    // wrong length is corrupt rather than merely wrong — it never matches.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

/**
 * Mints a secret.
 *
 * 32 bytes from the platform's CSPRNG, base64url so the token stays one word a person can
 * paste and a shell will not mangle. `Math.random` is not a source of secrets and never
 * was: it is seeded predictably and its output is recoverable from a handful of samples.
 */
export class RandomSecretGenerator {
  public next(): string {
    return randomBytes(32).toString('base64url');
  }
}
