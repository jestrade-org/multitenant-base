import {
  authorizedUseCase,
  permission,
  requireAll,
  ApplicationError,
  DomainError,
  type Actor,
  type AuthorizedUseCase,
  type IdGenerator,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

import {
  ApiKey,
  formatApiToken,
  type ApiKeyEnvironment,
  type SecretHasher,
} from '../domain/apiKey.js';

/**
 * Creating, rotating and revoking API keys (§10.1, VC-79).
 *
 * The secret is returned exactly once, by the two operations that mint one. There is no
 * endpoint that shows it again, because there is nothing to show: what was stored is a
 * digest. An interface that could re-display a key would mean the server kept something a
 * database leak could replay.
 *
 * Rotation exists as its own operation rather than as revoke-plus-create because that is
 * what makes rotating a thing operators do. A rotation that costs them the key's name, its
 * capabilities and its place in a list is a rotation they postpone until the day it is
 * urgent, which is the day it is too late.
 */

const MANAGE = permission('integrations:api_key_manage');

export class ApiKeyNotFoundError extends ApplicationError {
  public override readonly name = 'ApiKeyNotFoundError';
  public readonly code = 'API_KEY_NOT_FOUND';

  public constructor(public readonly keyId: string) {
    super(`No API key ${keyId}`, { keyId });
  }
}

/**
 * A key may never carry a capability the person creating it does not hold.
 *
 * Without this, `integrations:api_key_manage` is a capability that grants every other one:
 * an administrator who may not read payroll mints a key that may, and then uses it. The
 * key is a delegation of the creator's authority, never a widening of it.
 */
export class CapabilityNotDelegatableError extends DomainError {
  public override readonly name = 'CapabilityNotDelegatableError';
  public readonly code = 'CAPABILITY_NOT_DELEGATABLE';

  public constructor(public readonly capability: string) {
    super(`Cannot grant ${capability} to a key: the creator does not hold it`, { capability });
  }
}

export interface ApiKeyDto {
  readonly id: string;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  /** The public half. Safe to show: it identifies the key and unlocks nothing. */
  readonly keyPrefix: string;
  readonly permissions: readonly string[];
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/** The one and only time a secret crosses the boundary. */
export interface IssuedApiKey {
  readonly key: ApiKeyDto;
  readonly token: string;
}

export interface ApiKeyRepository {
  findById(keyId: string, tenantId: string): Promise<ApiKey | undefined>;
  listForTenant(tenantId: string): Promise<readonly ApiKey[]>;
  save(key: ApiKey): Promise<void>;
}

export type ApiKeyAudit = (input: {
  readonly action: 'api_key.created' | 'api_key.rotated' | 'api_key.revoked';
  readonly keyId: string;
  readonly actorId: string;
  readonly changes: Readonly<Record<string, string>>;
}) => Promise<void>;

export interface SecretGenerator {
  next(): string;
}

export interface ApiKeyAdministration {
  readonly listKeys: AuthorizedUseCase<Record<string, never>, readonly ApiKeyDto[]>;
  readonly createKey: AuthorizedUseCase<
    {
      readonly name: string;
      readonly environment: ApiKeyEnvironment;
      readonly permissions: readonly string[];
    },
    IssuedApiKey
  >;
  readonly rotateKey: AuthorizedUseCase<{ readonly keyId: string }, IssuedApiKey>;
  readonly revokeKey: AuthorizedUseCase<{ readonly keyId: string }, ApiKeyDto>;
}

function toDto(key: ApiKey): ApiKeyDto {
  const snapshot = key.toSnapshot();
  return {
    id: snapshot.id,
    name: snapshot.name,
    environment: snapshot.environment,
    keyPrefix: snapshot.keyPrefix,
    permissions: snapshot.permissions,
    lastUsedAt: snapshot.lastUsedAt?.toISOString() ?? null,
    revokedAt: snapshot.revokedAt?.toISOString() ?? null,
    createdAt: snapshot.createdAt.toISOString(),
  };
}

export function buildApiKeyAdministration(dependencies: {
  readonly pep: PolicyEnforcementPoint;
  readonly keys: ApiKeyRepository;
  readonly hasher: SecretHasher;
  readonly secrets: SecretGenerator;
  readonly ids: IdGenerator;
  readonly audit: ApiKeyAudit;
  readonly clock: { now(): Date };
  /** Requires a tenant: an API key belongs to a company, never to the platform. */
  readonly tenantOf: (actor: Actor) => string;
}): ApiKeyAdministration {
  const { pep, keys, hasher, secrets, ids, audit, clock, tenantOf } = dependencies;

  async function load(actor: Actor, keyId: string): Promise<ApiKey> {
    const key = await keys.findById(keyId, tenantOf(actor));
    // Another company's key and a nonexistent one answer identically: a distinct error
    // would let somebody probe for which key ids exist elsewhere (§8.3).
    if (key === undefined) throw new ApiKeyNotFoundError(keyId);
    return key;
  }

  return {
    listKeys: authorizedUseCase(pep, {
      name: 'ListApiKeys',
      requirement: requireAll(MANAGE),
      handler: async (actor: Actor) => (await keys.listForTenant(tenantOf(actor))).map(toDto),
    }),

    createKey: authorizedUseCase(pep, {
      name: 'CreateApiKey',
      requirement: requireAll(MANAGE),
      handler: async (actor: Actor, command) => {
        // Compared as plain strings against the actor's branded capabilities. A code
        // outside the catalogue never matches, so an invented one is refused here rather
        // than becoming a capability nobody holds and nobody notices.
        const held = new Set<string>(actor.permissions);
        for (const capability of command.permissions) {
          if (!held.has(capability)) throw new CapabilityNotDelegatableError(capability);
        }

        const secret = secrets.next();
        const { key } = ApiKey.issue({
          id: ids.next(),
          tenantId: tenantOf(actor),
          environment: command.environment,
          // The public half is minted from the same generator and truncated: it only has
          // to be unique and unguessable enough that listing keys is not a map of them.
          publicId: secrets
            .next()
            .replace(/[^A-Za-z0-9]/g, '')
            .slice(0, 16),
          secret,
          name: command.name,
          permissions: command.permissions,
          createdBy: actor.actorId,
          hasher,
          now: clock.now(),
        });

        await keys.save(key);
        await audit({
          action: 'api_key.created',
          keyId: key.id,
          actorId: actor.actorId,
          // The prefix, never the secret. A trail that records a credential is a second
          // copy of it (§8.4, "never log a credential").
          changes: { keyPrefix: key.keyPrefix, environment: command.environment },
        });

        return { key: toDto(key), token: formatApiToken(key.keyPrefix, secret) };
      },
    }),

    rotateKey: authorizedUseCase(pep, {
      name: 'RotateApiKey',
      requirement: requireAll(MANAGE),
      handler: async (actor: Actor, command) => {
        const key = await load(actor, command.keyId);
        const secret = key.rotate({ secret: secrets.next(), hasher });

        await keys.save(key);
        await audit({
          action: 'api_key.rotated',
          keyId: key.id,
          actorId: actor.actorId,
          changes: { keyPrefix: key.keyPrefix },
        });

        return { key: toDto(key), token: formatApiToken(key.keyPrefix, secret) };
      },
    }),

    revokeKey: authorizedUseCase(pep, {
      name: 'RevokeApiKey',
      requirement: requireAll(MANAGE),
      handler: async (actor: Actor, command) => {
        const key = await load(actor, command.keyId);
        key.revoke(clock.now());

        await keys.save(key);
        await audit({
          action: 'api_key.revoked',
          keyId: key.id,
          actorId: actor.actorId,
          changes: { keyPrefix: key.keyPrefix },
        });

        return toDto(key);
      },
    }),
  };
}
