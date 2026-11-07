import { DomainError, ValidationError } from '@multitenant-base/shared-kernel';

/**
 * API keys (§10.1, VC-79).
 *
 * A bearer credential over TLS, stored as a **hash**. The server never holds anything a
 * leak of the database could replay: what it keeps is the digest, and the only moment the
 * secret exists is between minting it and handing it to the person who asked.
 *
 * A fast hash, deliberately. Slow key-derivation functions exist to make guessing a
 * *low-entropy* password expensive; the secret here is 256 bits of randomness, where
 * guessing is not the threat and never will be. Paying argon2's work factor on every API
 * call would cost tens of milliseconds per request to defend against an attack that cannot
 * happen — and the latency would be real.
 *
 * The token carries its own public prefix (`mtb_live_ab12cd34.<secret>`) for two
 * reasons: the server finds the row by an indexed lookup instead of hashing against every
 * key it has, and secret scanners — GitHub's, gitleaks — recognise the shape, so a key
 * committed by mistake is caught by machinery that already exists.
 */

export const API_KEY_ENVIRONMENTS = ['live', 'test'] as const;

export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number];

/** The separator between the public prefix and the secret. Never appears in either. */
const TOKEN_SEPARATOR = '.';

const PREFIX_PATTERN = /^mtb_(live|test)_[A-Za-z0-9]{8,64}$/;

export class ApiKeyRevokedError extends DomainError {
  public override readonly name = 'ApiKeyRevokedError';
  public readonly code = 'API_KEY_REVOKED';

  public constructor(public readonly keyId: string) {
    super(`API key ${keyId} was revoked`, { keyId });
  }
}

/**
 * Turns a public id into the prefix stored on the row.
 *
 * The environment is part of it so a test key cannot be mistaken for a live one by
 * reading it — which is how somebody points a staging integration at production data.
 */
export function formatKeyPrefix(environment: ApiKeyEnvironment, publicId: string): string {
  const prefix = `mtb_${environment}_${publicId}`;
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new ValidationError('publicId', 'must be 8 to 64 letters or digits');
  }
  return prefix;
}

export interface ParsedToken {
  readonly prefix: string;
  readonly secret: string;
}

/**
 * Reads a presented token.
 *
 * Returns nothing for anything malformed rather than throwing: a bad token is the ordinary
 * case on a public endpoint, and an exception per unauthenticated request is a denial of
 * service somebody else gets to schedule.
 */
export function parseApiToken(token: string): ParsedToken | undefined {
  const separator = token.indexOf(TOKEN_SEPARATOR);
  if (separator === -1) return undefined;

  const prefix = token.slice(0, separator);
  const secret = token.slice(separator + 1);

  if (!PREFIX_PATTERN.test(prefix)) return undefined;
  // A short secret is not a secret. The generator produces far more than this; the floor
  // exists so a hand-made token cannot be brute-forced even in principle.
  if (secret.length < 32) return undefined;

  return { prefix, secret };
}

export function formatApiToken(prefix: string, secret: string): string {
  return `${prefix}${TOKEN_SEPARATOR}${secret}`;
}

export interface ApiKeySnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly environment: ApiKeyEnvironment;
  readonly keyPrefix: string;
  readonly secretHash: string;
  readonly name: string;
  /** What the key may do. Never wider than what the person who created it holds. */
  readonly permissions: readonly string[];
  readonly lastUsedAt: Date | undefined;
  readonly revokedAt: Date | undefined;
  readonly createdBy: string | undefined;
  readonly createdAt: Date;
}

/**
 * Hashing, as a port.
 *
 * Declared here and implemented in infrastructure, so the domain states *that* a secret is
 * hashed and compared in constant time without importing a crypto library.
 */
export interface SecretHasher {
  hash(secret: string): string;
  /** Constant time. A comparison whose duration depends on the secret leaks the secret. */
  matches(hash: string, secret: string): boolean;
}

export class ApiKey {
  readonly #snapshot: ApiKeySnapshot;
  #revokedAt: Date | undefined;
  #secretHash: string;

  private constructor(snapshot: ApiKeySnapshot) {
    this.#snapshot = snapshot;
    this.#revokedAt = snapshot.revokedAt;
    this.#secretHash = snapshot.secretHash;
  }

  public static reconstitute(snapshot: ApiKeySnapshot): ApiKey {
    return new ApiKey(snapshot);
  }

  /**
   * Mints a key and its one and only secret.
   *
   * The secret is returned here and nowhere else. There is no endpoint that can show it
   * again, because there is nothing to show: what was stored is a digest. A client who
   * loses it rotates, which is the same operation as having lost it to someone else.
   */
  public static issue(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly environment: ApiKeyEnvironment;
    readonly publicId: string;
    readonly secret: string;
    readonly name: string;
    readonly permissions: readonly string[];
    readonly createdBy: string;
    readonly hasher: SecretHasher;
    readonly now: Date;
  }): { readonly key: ApiKey; readonly secret: string } {
    if (input.name.trim().length < 3) {
      // A key called "test" among nine others is a key nobody dares revoke.
      throw new ValidationError('name', 'a key needs a name that says what uses it');
    }
    if (input.permissions.length === 0) {
      // A key with no capabilities can do nothing, and one created by accident with none
      // looks like a working key that mysteriously fails.
      throw new ValidationError('permissions', 'a key needs at least one capability');
    }

    const key = new ApiKey({
      id: input.id,
      tenantId: input.tenantId,
      environment: input.environment,
      keyPrefix: formatKeyPrefix(input.environment, input.publicId),
      secretHash: input.hasher.hash(input.secret),
      name: input.name.trim(),
      permissions: [...input.permissions],
      lastUsedAt: undefined,
      revokedAt: undefined,
      createdBy: input.createdBy,
      createdAt: input.now,
    });

    return { key, secret: input.secret };
  }

  public get id(): string {
    return this.#snapshot.id;
  }

  public get keyPrefix(): string {
    return this.#snapshot.keyPrefix;
  }

  public get tenantId(): string {
    return this.#snapshot.tenantId;
  }

  public get name(): string {
    return this.#snapshot.name;
  }

  public get environment(): ApiKeyEnvironment {
    return this.#snapshot.environment;
  }

  public get permissions(): readonly string[] {
    return this.#snapshot.permissions;
  }

  public get isRevoked(): boolean {
    return this.#revokedAt !== undefined;
  }

  /**
   * Whether a presented secret is this key's.
   *
   * A revoked key answers false rather than throwing: the caller is an unauthenticated
   * request, and the answer it deserves is the same one a wrong secret gets.
   */
  public accepts(secret: string, hasher: SecretHasher): boolean {
    if (this.isRevoked) return false;
    return hasher.matches(this.#secretHash, secret);
  }

  /**
   * Replaces the secret, keeping the key's identity and its capabilities.
   *
   * Rotation is not revocation plus creation: the integration keeps its name, its
   * permissions and its place in the client's list, which is what makes rotating something
   * an operator will actually do rather than postpone.
   */
  public rotate(input: { readonly secret: string; readonly hasher: SecretHasher }): string {
    if (this.isRevoked) throw new ApiKeyRevokedError(this.#snapshot.id);

    this.#secretHash = input.hasher.hash(input.secret);
    return input.secret;
  }

  public revoke(at: Date): void {
    // Idempotent: revoking twice is what happens when somebody clicks again after a slow
    // response, and the second click must not be an error on a security action.
    this.#revokedAt ??= at;
  }

  public toSnapshot(): ApiKeySnapshot {
    return {
      ...this.#snapshot,
      secretHash: this.#secretHash,
      ...(this.#revokedAt === undefined ? {} : { revokedAt: this.#revokedAt }),
    };
  }
}
