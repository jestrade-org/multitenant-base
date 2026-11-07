import { z } from 'zod';

import type { ApiKeyRepository } from '../application/manageApiKeys.js';
import { ApiKey, API_KEY_ENVIRONMENTS } from '../domain/apiKey.js';

/**
 * API keys in the control plane.
 *
 * Every statement is scoped by the tenant the caller passed, and that tenant comes from a
 * verified token. The scoping is part of the predicate rather than a filter applied after,
 * so one company's key is not merely hidden from another — it is unreachable.
 */

export interface SqlClient {
  query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

const rowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  environment: z.enum(API_KEY_ENVIRONMENTS),
  key_prefix: z.string(),
  secret_hash: z.string(),
  name: z.string(),
  permission_codes: z.array(z.string()),
  last_used_at: z.coerce.date().nullable(),
  revoked_at: z.coerce.date().nullable(),
  created_by: z.string().uuid().nullable(),
  created_at: z.coerce.date(),
});

const COLUMNS =
  'id, tenant_id, environment, key_prefix, secret_hash, name, permission_codes, ' +
  'last_used_at, revoked_at, created_by, created_at';

function toAggregate(row: Record<string, unknown>): ApiKey {
  const parsed = rowSchema.parse(row);
  return ApiKey.reconstitute({
    id: parsed.id,
    tenantId: parsed.tenant_id,
    environment: parsed.environment,
    keyPrefix: parsed.key_prefix,
    secretHash: parsed.secret_hash,
    name: parsed.name,
    permissions: parsed.permission_codes,
    lastUsedAt: parsed.last_used_at ?? undefined,
    revokedAt: parsed.revoked_at ?? undefined,
    createdBy: parsed.created_by ?? undefined,
    createdAt: parsed.created_at,
  });
}

export class PostgresApiKeyRepository implements ApiKeyRepository {
  readonly #client: SqlClient;

  public constructor(client: SqlClient) {
    this.#client = client;
  }

  public async findById(keyId: string, tenantId: string): Promise<ApiKey | undefined> {
    const rows = await this.#client.query(
      `select ${COLUMNS} from control.api_keys where id = $1 and tenant_id = $2`,
      [keyId, tenantId],
    );

    const row = rows[0];
    return row === undefined ? undefined : toAggregate(row);
  }

  public async listForTenant(tenantId: string): Promise<readonly ApiKey[]> {
    const rows = await this.#client.query(
      // Active first, then newest. A revoked key stays on the list: it is the answer to
      // "what happened to the key that used to work", and deleting it would erase that.
      `select ${COLUMNS} from control.api_keys
        where tenant_id = $1
        order by (revoked_at is null) desc, created_at desc, id desc`,
      [tenantId],
    );
    return rows.map(toAggregate);
  }

  public async save(key: ApiKey): Promise<void> {
    const snapshot = key.toSnapshot();

    await this.#client.query(
      `insert into control.api_keys
              (id, tenant_id, environment, key_prefix, secret_hash, name, permission_codes,
               revoked_at, created_by, created_at)
       values ($1, $2, $3::control.api_key_environment, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update
          set secret_hash = excluded.secret_hash,
              name = excluded.name,
              permission_codes = excluded.permission_codes,
              revoked_at = excluded.revoked_at`,
      [
        snapshot.id,
        snapshot.tenantId,
        snapshot.environment,
        snapshot.keyPrefix,
        snapshot.secretHash,
        snapshot.name,
        snapshot.permissions,
        snapshot.revokedAt ?? null,
        snapshot.createdBy ?? null,
        snapshot.createdAt,
      ],
    );
  }
}
