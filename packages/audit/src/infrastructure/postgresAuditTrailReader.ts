import { PostgresAuditTrail, type SqlClient } from './postgresAuditTrail.js';
import type {
  AuditEventDto,
  AuditPage,
  AuditSearchRecorder,
  AuditTrailReader,
  ResolvedAuditSearch,
} from '../application/queryAuditTrail.js';
import type { AuditActorType, AuditChanges, AuditResult } from '../domain/auditEvent.js';

/**
 * Reading `control.audit_events` across every client (§8.4, VC-75).
 *
 * ## Keyset, never offset
 *
 * `offset` on the largest table in the product makes page 40 read 4 000 rows to discard
 * 3 950, and — worse for a compliance query — it silently skips rows when the table is
 * written to while a reviewer pages through it. The audit table is written to on *every
 * authenticated request*, so that is not a rare race: it is the normal case. A keyset
 * cursor on `(occurred_at, event_id)` is stable under concurrent inserts, which is the
 * property that makes "I read every denied attempt last month" a true statement.
 *
 * The tuple comparison `(occurred_at, event_id) < ($n, $m)` is what makes it exact.
 * Comparing on `occurred_at` alone loses rows whenever two events share a timestamp, and
 * two events sharing a timestamp is what a single request that grants and then acts
 * produces.
 */

/** Opaque to the client, and deliberately trivial to parse here: `<iso>|<uuid>`. */
function encodeCursor(row: { readonly occurredAt: string; readonly eventId: string }): string {
  return Buffer.from(`${row.occurredAt}|${row.eventId}`, 'utf8').toString('base64url');
}

interface DecodedCursor {
  readonly occurredAt: Date;
  readonly eventId: string;
}

/**
 * Reads a cursor, or refuses.
 *
 * A malformed cursor becomes `undefined` — the first page — rather than an error. It is
 * an opaque token the client only ever echoes back, so a bad one means a truncated URL,
 * and answering a truncated URL with page one is more useful than a 400 nobody can act on.
 */
function decodeCursor(cursor: string | undefined): DecodedCursor | undefined {
  if (cursor === undefined) return undefined;

  const [occurredAt, eventId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (occurredAt === undefined || eventId === undefined) return undefined;

  const instant = new Date(occurredAt);
  if (Number.isNaN(instant.getTime())) return undefined;
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return undefined;

  return { occurredAt: instant, eventId };
}

interface AuditRow {
  readonly event_id: string;
  readonly occurred_at: Date;
  readonly tenant_id: string | null;
  readonly tenant_name: string | null;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly action: string;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly result: string;
  readonly ip_address: string | null;
  readonly correlation_id: string | null;
  readonly changes: unknown;
}

function toDto(row: AuditRow): AuditEventDto {
  return {
    eventId: row.event_id,
    occurredAt: row.occurred_at.toISOString(),
    tenantId: row.tenant_id ?? undefined,
    tenantName: row.tenant_name ?? undefined,
    actorType: row.actor_type as AuditActorType,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type ?? undefined,
    resourceId: row.resource_id ?? undefined,
    result: row.result as AuditResult,
    ipAddress: row.ip_address ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    changes:
      row.changes === null || typeof row.changes !== 'object'
        ? undefined
        : (row.changes as AuditChanges),
  };
}

export class PostgresAuditTrailReader implements AuditTrailReader {
  readonly #client: SqlClient;

  public constructor(client: SqlClient) {
    this.#client = client;
  }

  public async search(criteria: ResolvedAuditSearch): Promise<AuditPage> {
    const values: unknown[] = [criteria.from, criteria.to];
    const conditions = ['e.occurred_at >= $1', 'e.occurred_at <= $2'];

    if (criteria.tenantId !== undefined) {
      values.push(criteria.tenantId);
      conditions.push(`e.tenant_id = $${String(values.length)}`);
    }
    if (criteria.actorId !== undefined) {
      values.push(criteria.actorId);
      conditions.push(`e.actor_id = $${String(values.length)}`);
    }
    if (criteria.result !== undefined) {
      values.push(criteria.result);
      conditions.push(`e.result = $${String(values.length)}::control.audit_result`);
    }
    if (criteria.action !== undefined) {
      // A trailing dot is how a reviewer asks for a whole family. The filter was validated
      // in the domain against the same character set the column constrains, so it can
      // carry no `%` or `_` of its own — the pattern below is the only wildcard in play.
      values.push(criteria.action.endsWith('.') ? `${criteria.action}%` : criteria.action);
      conditions.push(
        criteria.action.endsWith('.')
          ? `e.action like $${String(values.length)}`
          : `e.action = $${String(values.length)}`,
      );
    }

    const cursor = decodeCursor(criteria.cursor);
    if (cursor !== undefined) {
      values.push(cursor.occurredAt, cursor.eventId);
      conditions.push(
        `(e.occurred_at, e.event_id) < ($${String(values.length - 1)}, $${String(values.length)}::uuid)`,
      );
    }

    // One more than asked for: the extra row is how "is there a next page" is answered
    // without a second count query over the largest table in the product.
    values.push(criteria.pageSize + 1);

    const rows = await this.#client.query(
      `select e.event_id, e.occurred_at, e.tenant_id, t.name as tenant_name,
              e.actor_type, e.actor_id, e.action, e.resource_type, e.resource_id,
              e.result, host(e.ip_address) as ip_address, e.correlation_id, e.changes
         from control.audit_events e
         left join control.tenants t on t.id = e.tenant_id
        where ${conditions.join(' and ')}
        order by e.occurred_at desc, e.event_id desc
        limit $${String(values.length)}`,
      values,
    );

    const page = rows.slice(0, criteria.pageSize).map((row) => toDto(row as unknown as AuditRow));
    const last = page.at(-1);

    return {
      items: page,
      nextCursor:
        rows.length > criteria.pageSize && last !== undefined ? encodeCursor(last) : undefined,
    };
  }
}

/**
 * Records that the trail was read (§8.4, VC-75).
 *
 * Writes through the same `PostgresAuditTrail` every other event goes through, so the
 * `audit.searched` row is validated by the same rules — including the credential check,
 * which matters here because the filters are caller-supplied.
 */
export class PostgresAuditSearchRecorder implements AuditSearchRecorder {
  readonly #client: SqlClient;

  public constructor(client: SqlClient) {
    this.#client = client;
  }

  public async record(input: {
    readonly actorId: string;
    readonly actorType: AuditActorType;
    readonly occurredAt: Date;
    readonly filters: Readonly<Record<string, string>>;
    readonly returned: number;
  }): Promise<void> {
    await new PostgresAuditTrail(this.#client).record({
      occurredAt: input.occurredAt,
      actorType: input.actorType,
      actorId: input.actorId,
      action: 'audit.searched',
      resourceType: 'audit_trail',
      result: 'success',
      // No tenant: a cross-tenant search belongs to no single company, which is precisely
      // what makes it worth recording.
      changes: { ...input.filters, returned: String(input.returned) },
    });
  }
}
