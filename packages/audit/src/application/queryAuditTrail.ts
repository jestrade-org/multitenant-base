import {
  authorizedUseCase,
  permission,
  requireAll,
  type Actor,
  type AuthorizedUseCase,
  type Clock,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

import type { AuditActorType, AuditChanges, AuditResult } from '../domain/auditEvent.js';
import { assertActionFilter, boundedWindow } from '../domain/auditQuery.js';

/**
 * Reading the audit trail across every client, and recording that it was read (§8.4, §9,
 * VC-75).
 *
 * The cross-tenant index exists so an auditor can ask "every denied attempt by this
 * accountant" without reaching into fifteen schemas — that is why `control.audit_events`
 * lives in the control plane at all. But a query that spans every client is itself one of
 * the most sensitive acts in the product: it is the one legitimate way to see what every
 * company has been doing, and it is exactly the capability an insider would want.
 *
 * So the query is audited, and the ordering is deliberate:
 *
 *   read → record → return
 *
 * The rows are held, not sent, until the `audit.searched` row is written. If that write
 * fails the whole call fails and nothing is disclosed. Recording first would file searches
 * that never happened; recording after the response would leave a window in which someone
 * saw every client's history and no row says so.
 *
 * `audit:read_all` is held by `platform_admin` and by nobody inside a client's company —
 * a tenant's own `audit:read` is a different capability, scoped to their own rows.
 */

const AUDIT_READ_ALL = permission('audit:read_all');

/** The page size cap. Bounded like every other list (api-design.md, API4). */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

export interface AuditEventDto {
  readonly eventId: string;
  readonly occurredAt: string;
  /** Absent for a platform-wide action, which belongs to no company. */
  readonly tenantId: string | undefined;
  /** Resolved for the screen: a uuid is not an answer a compliance reviewer can read. */
  readonly tenantName: string | undefined;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string | undefined;
  readonly resourceId: string | undefined;
  readonly result: AuditResult;
  /**
   * Where the attempt came from.
   *
   * Included because the question this table answers most often is "was this really them",
   * and a denial with no source address cannot be triaged. It is PII, so it is here and
   * not in any log line (§14).
   */
  readonly ipAddress: string | undefined;
  readonly correlationId: string | undefined;
  readonly changes: AuditChanges | undefined;
}

export interface AuditSearchCriteria {
  readonly tenantId?: string | undefined;
  readonly actorId?: string | undefined;
  /** A whole code (`tenant.suspended`) or a family prefix (`authentication.`). */
  readonly action?: string | undefined;
  readonly result?: AuditResult | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly pageSize?: number | undefined;
  /** Opaque keyset cursor from the previous page. Never an offset. */
  readonly cursor?: string | undefined;
}

/** What the reader is actually asked for: resolved, bounded, and no longer optional. */
export interface ResolvedAuditSearch {
  readonly tenantId: string | undefined;
  readonly actorId: string | undefined;
  readonly action: string | undefined;
  readonly result: AuditResult | undefined;
  readonly from: Date;
  readonly to: Date;
  readonly pageSize: number;
  readonly cursor: string | undefined;
}

export interface AuditPage {
  readonly items: readonly AuditEventDto[];
  /** Absent when this is the last page. Keyset, so a new row cannot shift the pagination. */
  readonly nextCursor: string | undefined;
}

export interface AuditTrailReader {
  search(criteria: ResolvedAuditSearch): Promise<AuditPage>;
}

/** Writes the `audit.searched` row. Separate port because it writes where the reader reads. */
export interface AuditSearchRecorder {
  record(input: {
    readonly actorId: string;
    readonly actorType: AuditActorType;
    readonly occurredAt: Date;
    readonly filters: Readonly<Record<string, string>>;
    readonly returned: number;
  }): Promise<void>;
}

export interface AuditTrailQueries {
  readonly searchAuditTrail: AuthorizedUseCase<AuditSearchCriteria, AuditPage>;
}

export interface AuditTrailQueryDependencies {
  readonly pep: PolicyEnforcementPoint;
  readonly reader: AuditTrailReader;
  readonly recorder: AuditSearchRecorder;
  readonly clock: Clock;
}

/**
 * What the search was, as the trail records it.
 *
 * The filters, not the results. Recording the rows a search returned would copy every
 * client's history into a second place each time somebody looked at it — which is a
 * disclosure control that creates the disclosure. The count is enough to answer "how much
 * did they see".
 */
function describeFilters(search: ResolvedAuditSearch): Readonly<Record<string, string>> {
  return {
    from: search.from.toISOString(),
    to: search.to.toISOString(),
    pageSize: String(search.pageSize),
    // `all` rather than an omitted key: "they searched every client" is the finding, and a
    // missing key reads as a filter nobody thought about.
    tenantId: search.tenantId ?? 'all',
    actorId: search.actorId ?? 'all',
    action: search.action ?? 'all',
    result: search.result ?? 'all',
    paged: search.cursor === undefined ? 'first' : 'continued',
  };
}

export function buildAuditTrailQueries(
  dependencies: AuditTrailQueryDependencies,
): AuditTrailQueries {
  const { pep, reader, recorder, clock } = dependencies;

  return {
    searchAuditTrail: authorizedUseCase(pep, {
      name: 'SearchAuditTrail',
      requirement: requireAll(AUDIT_READ_ALL),
      handler: async (actor: Actor, criteria) => {
        const window = boundedWindow({ from: criteria.from, to: criteria.to }, clock.now());

        const search: ResolvedAuditSearch = {
          tenantId: criteria.tenantId,
          actorId: criteria.actorId,
          action: criteria.action === undefined ? undefined : assertActionFilter(criteria.action),
          result: criteria.result,
          from: window.from,
          to: window.to,
          pageSize: Math.min(criteria.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
          cursor: criteria.cursor,
        };

        const page = await reader.search(search);

        // Held, not sent, until the trail has the row. A failure here fails the call and
        // discloses nothing — which is the whole reason this line is before the return.
        await recorder.record({
          actorId: actor.actorId,
          actorType: actor.actorType,
          occurredAt: clock.now(),
          filters: describeFilters(search),
          returned: page.items.length,
        });

        return page;
      },
    }),
  };
}
