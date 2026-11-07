import {
  authorizedUseCase,
  createDomainEvent,
  permission,
  requireAny,
  type AuthorizedUseCase,
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type PolicyEnforcementPoint,
} from '@multitenant-base/shared-kernel';

import {
  readAllQuotas,
  worstStatus,
  type MeasuredUsage,
  type PlanQuotas,
  type QuotaReading,
  type QuotaStatus,
} from '../domain/planQuota.js';

/**
 * What each client is using, against what they bought (§4.2, RN-26..RN-29, VC-28, VC-75).
 *
 * Two things happen here, and they are deliberately separate:
 *
 *   - **the daily verification**, run by the `plan-quota-verification` scheduled job. It
 *     measures, stores a snapshot, and raises `QuotaThresholdReached` on the *crossing*;
 *   - **the panel's read**, which serves the stored snapshot rather than counting live.
 *
 * The panel reads a snapshot on purpose. Counting tenant-scoped records means one query per
 * tenant against that tenant's schema, and a screen that fans out across every company's
 * data on every page view is precisely the implicit read path §4.3 exists to prevent. A
 * snapshot of a few integers, refreshed on a schedule, gives an operator the same answer
 * without the platform panel ever holding a connection into a company's data.
 *
 * That trade has one honest cost: the number on the screen is as of the last pass, not as
 * of now. So every reading carries `measuredAt`, and the screen shows it. A quota figure
 * with no date is a figure nobody can act on.
 */

const PLAN_MANAGE = permission('platform:plan_manage');
const TENANT_MANAGE = permission('platform:tenant_manage');

/** Which tenant to measure. Carries what the adapter needs to bind a connection. */
export interface TenantToMeasure {
  readonly id: string;
  readonly name: string;
  readonly schemaName: string;
  readonly isolationMode: string;
  readonly timezone: string;
  readonly planCode: string;
  readonly quotas: PlanQuotas;
}

/**
 * Counts what a tenant is using.
 *
 * Returns integers and nothing else — no rows, no amounts, no names. That is the whole
 * interface, and it is narrow on purpose: an implementation of this port cannot hand the
 * platform panel a person or a record, because the type has nowhere to put one
 * (§8.1).
 */
export interface TenantUsageCounter {
  count(tenant: TenantToMeasure): Promise<MeasuredUsage>;
}

export interface QuotaUsageSnapshot {
  readonly tenantId: string;
  readonly measuredAt: Date;
  readonly usage: MeasuredUsage;
  /**
   * The worst status the client was last *told* about.
   *
   * Stored rather than recomputed so the alert fires on the crossing and not on every
   * pass. A client warned every morning at 08:00 that they are at 91% learns to ignore
   * the alert, and then does not see the one that says they are at 100%.
   */
  readonly notifiedStatus: QuotaStatus;
}

export interface QuotaUsageStore {
  save(snapshot: QuotaUsageSnapshot): Promise<void>;
  latest(tenantId: string): Promise<QuotaUsageSnapshot | undefined>;
  /** Every tenant's last snapshot, for the panel. One query, not one per client. */
  listLatest(): Promise<readonly QuotaUsageSnapshot[]>;
}

/** Where `QuotaThresholdReached` goes: the tenant's outbox, in its own transaction (§6). */
export interface QuotaAlertPublisher {
  publish(tenant: TenantToMeasure, event: DomainEvent): Promise<void>;
}

/** Every tenant the panel lists, with their plan. Read from the control plane only. */
export interface QuotaTenantDirectory {
  listMeasurable(): Promise<readonly TenantToMeasure[]>;
}

export interface TenantQuotaUsageDto {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly planCode: string;
  readonly status: QuotaStatus;
  readonly readings: readonly QuotaReading[];
  /** ISO-8601, or absent when this client has never been measured. */
  readonly measuredAt: string | undefined;
}

export interface QuotaUsageQueries {
  readonly listQuotaUsage: AuthorizedUseCase<Record<string, never>, readonly TenantQuotaUsageDto[]>;
}

export interface QuotaUsageQueryDependencies {
  readonly pep: PolicyEnforcementPoint;
  readonly tenants: QuotaTenantDirectory;
  readonly store: QuotaUsageStore;
}

export function buildQuotaUsageQueries(
  dependencies: QuotaUsageQueryDependencies,
): QuotaUsageQueries {
  const { pep, tenants, store } = dependencies;

  return {
    listQuotaUsage: authorizedUseCase(pep, {
      name: 'ListQuotaUsage',
      // Either capability: an operator managing plans and one managing clients both need
      // to see who is against a limit, and they are the same person today. `any` rather
      // than `all` so the split, when it comes, does not lock one of them out.
      requirement: requireAny(PLAN_MANAGE, TENANT_MANAGE),
      handler: async () => {
        const measurable = await tenants.listMeasurable();
        const snapshots = new Map(
          (await store.listLatest()).map((snapshot) => [snapshot.tenantId, snapshot]),
        );

        return measurable.map((tenant) => {
          const snapshot = snapshots.get(tenant.id);

          // A client provisioned since the last pass has no snapshot. Reported as zeros
          // with no `measuredAt` rather than omitted: a client missing from the quota
          // screen looks like a client who is fine.
          const usage: MeasuredUsage = snapshot?.usage ?? { users: 0 };
          const readings = readAllQuotas(tenant.quotas, usage);

          return {
            tenantId: tenant.id,
            tenantName: tenant.name,
            planCode: tenant.planCode,
            status: worstStatus(readings),
            readings,
            measuredAt: snapshot?.measuredAt.toISOString(),
          };
        });
      },
    }),
  };
}

export interface QuotaVerificationDependencies {
  readonly counter: TenantUsageCounter;
  readonly store: QuotaUsageStore;
  readonly alerts: QuotaAlertPublisher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface QuotaVerificationOutcome {
  readonly tenantId: string;
  readonly status: QuotaStatus;
  readonly readings: readonly QuotaReading[];
  /** True when this pass raised `QuotaThresholdReached`. */
  readonly alerted: boolean;
}

/** Ordered worst-last, so "did this get worse" is a comparison rather than a table. */
const SEVERITY: Readonly<Record<QuotaStatus, number>> = { within: 0, warning: 1, exceeded: 2 };

/**
 * One tenant's quota verification pass (VC-28, VC-42).
 *
 * Run by the scheduled job, which is idempotent by slot — so this may run twice for the
 * same day and must produce one alert. It does, because the alert is driven by a
 * *transition*: the second pass finds the stored status already at `warning` and says
 * nothing.
 *
 * The event is raised when the status gets worse, never when it improves. A company that
 * deactivates users and falls back under 90% does not need to be told; and recording the
 * improvement is what lets the *next* crossing alert again rather than being swallowed as
 * "already warned".
 */
export function verifyTenantQuota(dependencies: QuotaVerificationDependencies) {
  return async function verify(tenant: TenantToMeasure): Promise<QuotaVerificationOutcome> {
    const usage = await dependencies.counter.count(tenant);
    const readings = readAllQuotas(tenant.quotas, usage);
    const status = worstStatus(readings);

    const previous = await dependencies.store.latest(tenant.id);
    const previousStatus = previous?.notifiedStatus ?? 'within';
    const worsened = SEVERITY[status] > SEVERITY[previousStatus];

    if (worsened) {
      // Ids and primitives only: which limit, how much of it, and the plan. Never a
      // person, never an amount — this event is read by notification consumers, which have
      // no business holding a company's data (§6).
      const strained = readings.filter((reading) => reading.status !== 'within');

      await dependencies.alerts.publish(
        tenant,
        createDomainEvent(
          { clock: dependencies.clock, ids: dependencies.ids },
          {
            tenantId: tenant.id,
            type: 'QuotaThresholdReached',
            correlationId: dependencies.ids.next(),
            payload: {
              planCode: tenant.planCode,
              status,
              quotas: strained.map((reading) => ({
                kind: reading.kind,
                used: reading.used,
                limit: reading.limit,
              })),
            },
          },
        ),
      );
    }

    await dependencies.store.save({
      tenantId: tenant.id,
      measuredAt: dependencies.clock.now(),
      usage,
      // Only a raised alert moves the notified status *up*. An improvement is recorded
      // immediately, which is what re-arms the alert for the next crossing.
      notifiedStatus: worsened
        ? status
        : SEVERITY[status] < SEVERITY[previousStatus]
          ? status
          : previousStatus,
    });

    return { tenantId: tenant.id, status, readings, alerted: worsened };
  };
}
