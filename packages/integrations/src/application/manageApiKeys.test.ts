import { beforeEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  NotAuthorizedError,
  permission,
  PolicyEnforcementPoint,
  SequentialIdGenerator,
  type Actor,
  type AuthorizationAuditSink,
} from '@multitenant-base/shared-kernel';

import {
  ApiKeyNotFoundError,
  buildApiKeyAdministration,
  CapabilityNotDelegatableError,
  type ApiKeyAdministration,
  type ApiKeyRepository,
} from './manageApiKeys.js';
import {
  parseApiToken,
  type ApiKey,
  type ApiKeyEnvironment,
  type SecretHasher,
} from '../domain/apiKey.js';

/**
 * The lifecycle of a credential.
 *
 * Three properties carry the weight: the secret is shown once and never again, a key can
 * never be given a capability its creator does not hold, and one company's key is
 * unreachable from another's session.
 */

const CLOCK = new FixedClock('2026-08-24T15:00:00.000Z');
const silentAudit: AuthorizationAuditSink = { record: () => Promise.resolve() };

/**
 * A hasher a test can reason about. The real one is SHA-256, in infrastructure.
 *
 * Neither embeds the secret nor truncates it. A fake that embedded it would pass the
 * assertion that nothing stored can be replayed while proving nothing; one that truncated
 * would collide on two secrets sharing a tail, and the rotation test would pass while the
 * key still accepted the secret it replaced — which is exactly what happened first.
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

class InMemoryKeys implements ApiKeyRepository {
  public readonly stored = new Map<string, ApiKey>();

  public findById(keyId: string, tenantId: string): Promise<ApiKey | undefined> {
    const key = this.stored.get(keyId);
    // The tenant is part of the lookup, exactly as it is in SQL. A fake that ignored it
    // would let the isolation test pass against a repository that does not isolate.
    return Promise.resolve(key?.tenantId === tenantId ? key : undefined);
  }

  public listForTenant(tenantId: string): Promise<readonly ApiKey[]> {
    return Promise.resolve([...this.stored.values()].filter((key) => key.tenantId === tenantId));
  }

  public save(key: ApiKey): Promise<void> {
    this.stored.set(key.id, key);
    return Promise.resolve();
  }
}

let keys: InMemoryKeys;
let administration: ApiKeyAdministration;
let audited: { action: string; keyId: string; changes: Record<string, string> }[];
let minted: number;

function anActor(overrides: Partial<Actor> = {}): Actor {
  return {
    actorId: 'admin-1',
    actorType: 'user',
    tenantId: 'tenant-1',
    roleCode: 'tenant_admin',
    permissions: [
      permission('integrations:api_key_manage'),
      permission('tenancy:read'),
      permission('audit:read'),
    ],
    ...overrides,
  };
}

function create(environment: ApiKeyEnvironment = 'live') {
  return administration.createKey(anActor(), {
    name: 'Integración contable',
    environment,
    permissions: ['tenancy:read'],
  });
}

beforeEach(() => {
  keys = new InMemoryKeys();
  audited = [];
  minted = 0;
  administration = buildApiKeyAdministration({
    pep: new PolicyEnforcementPoint({ clock: CLOCK, auditSink: silentAudit }),
    keys,
    hasher,
    // Distinct every call, like the real generator, so a rotation cannot accidentally
    // produce the secret it replaced.
    secrets: {
      next: () => {
        minted += 1;
        return `secreto${String(minted)}${'x'.repeat(40)}`;
      },
    },
    ids: new SequentialIdGenerator('key'),
    audit: (input) => {
      audited.push(input);
      return Promise.resolve();
    },
    clock: CLOCK,
    tenantOf: (actor) => actor.tenantId ?? 'tenant-1',
  });
});

describe('creating a key', () => {
  it('returns a token that parses into the stored prefix and a secret', async () => {
    const issued = await create();
    const parsed = parseApiToken(issued.token);

    expect(parsed?.prefix).toBe(issued.key.keyPrefix);
    expect(parsed?.secret).toBeDefined();
  });

  it('never puts the secret in what is stored or listed', async () => {
    // The whole point of hashing. If either of these carried it, a database leak or a
    // screenshot of the list would be a working credential.
    const issued = await create();
    const secret = parseApiToken(issued.token)?.secret ?? '';

    expect(JSON.stringify(issued.key)).not.toContain(secret);
    expect(JSON.stringify(await administration.listKeys(anActor(), {}))).not.toContain(secret);
  });

  it('shows the secret once and has no way to show it again', async () => {
    const issued = await create();
    const secret = parseApiToken(issued.token)?.secret ?? '';

    const listed = await administration.listKeys(anActor(), {});

    // There is no read operation that returns a token: the surface itself makes this
    // impossible, and this test is what keeps someone from adding one.
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(Object.keys(listed[0] ?? {})).not.toContain('token');
  });

  it('records the prefix and never the secret', async () => {
    const issued = await create();
    const secret = parseApiToken(issued.token)?.secret ?? '';

    expect(audited[0]).toMatchObject({ action: 'api_key.created' });
    expect(JSON.stringify(audited)).not.toContain(secret);
    expect(audited[0]?.changes.keyPrefix).toBe(issued.key.keyPrefix);
  });

  it('marks a test key as one, so it cannot be mistaken for live', async () => {
    const issued = await create('test');

    expect(issued.key.keyPrefix).toMatch(/^mtb_test_/);
  });
});

describe('what a key may be given', () => {
  it('refuses a capability the creator does not hold', async () => {
    // Otherwise `integrations:api_key_manage` is the capability that grants every other
    // one: an administrator who may not read payroll mints a key that may, then uses it.
    await expect(
      administration.createKey(anActor(), {
        name: 'Escalada',
        environment: 'live',
        permissions: ['iam:role_manage'],
      }),
    ).rejects.toBeInstanceOf(CapabilityNotDelegatableError);

    expect(keys.stored.size).toBe(0);
  });

  it('refuses a capability that is not in the catalogue at all', async () => {
    await expect(
      administration.createKey(anActor(), {
        name: 'Inventada',
        environment: 'live',
        permissions: ['inventada:capacidad'],
      }),
    ).rejects.toBeInstanceOf(CapabilityNotDelegatableError);
  });

  it('allows what the creator does hold', async () => {
    const issued = await administration.createKey(anActor(), {
      name: 'Cartera',
      environment: 'live',
      permissions: ['tenancy:read', 'audit:read'],
    });

    expect(issued.key.permissions).toEqual(['tenancy:read', 'audit:read']);
  });
});

describe('rotating', () => {
  it('hands back a new secret and stops accepting the old one', async () => {
    const issued = await create();
    const before = parseApiToken(issued.token)?.secret ?? '';

    const rotated = await administration.rotateKey(anActor(), { keyId: issued.key.id });
    const after = parseApiToken(rotated.token)?.secret ?? '';

    expect(after).not.toBe(before);
    const stored = keys.stored.get(issued.key.id);
    expect(stored?.accepts(after, hasher)).toBe(true);
    expect(stored?.accepts(before, hasher)).toBe(false);
  });

  it('keeps the key identifiable, which is what makes rotation something people do', async () => {
    const issued = await create();

    const rotated = await administration.rotateKey(anActor(), { keyId: issued.key.id });

    expect(rotated.key.id).toBe(issued.key.id);
    expect(rotated.key.name).toBe(issued.key.name);
    expect(rotated.key.permissions).toEqual(issued.key.permissions);
  });
});

describe('revoking', () => {
  it('stops the key working and records it', async () => {
    const issued = await create();
    const secret = parseApiToken(issued.token)?.secret ?? '';

    const revoked = await administration.revokeKey(anActor(), { keyId: issued.key.id });

    expect(revoked.revokedAt).not.toBeNull();
    expect(keys.stored.get(issued.key.id)?.accepts(secret, hasher)).toBe(false);
    expect(audited.at(-1)).toMatchObject({ action: 'api_key.revoked' });
  });

  it('keeps the row, because the trail points at it', async () => {
    const issued = await create();
    await administration.revokeKey(anActor(), { keyId: issued.key.id });

    // Never deleted: audit rows and request logs name this key for years, and a deleted
    // row turns all of them into an unattributable id.
    expect(keys.stored.has(issued.key.id)).toBe(true);
  });
});

describe('one company cannot reach another’s key', () => {
  it('answers not-found rather than refusing, which would confirm it exists', async () => {
    const issued = await create();
    const stranger = anActor({ tenantId: 'tenant-2', actorId: 'admin-2' });

    await expect(
      administration.revokeKey(stranger, { keyId: issued.key.id }),
    ).rejects.toBeInstanceOf(ApiKeyNotFoundError);

    expect(keys.stored.get(issued.key.id)?.isRevoked).toBe(false);
  });

  it('lists only its own', async () => {
    await create();
    const stranger = anActor({ tenantId: 'tenant-2' });

    expect(await administration.listKeys(stranger, {})).toEqual([]);
  });
});

describe('who may manage keys', () => {
  it('refuses an actor without the capability', async () => {
    const reader = anActor({ permissions: [permission('tenancy:read')] });

    await expect(
      administration.createKey(reader, {
        name: 'Sin permiso',
        environment: 'live',
        permissions: ['tenancy:read'],
      }),
    ).rejects.toBeInstanceOf(NotAuthorizedError);
  });
});
