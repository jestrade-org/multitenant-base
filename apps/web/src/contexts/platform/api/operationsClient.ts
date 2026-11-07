import { PlatformError } from './platformClient.js';

/**
 * Plans, quotas, queues and the audit trail, as the platform panel needs them.
 *
 * A separate client from the tenant roster because these are separate surfaces with
 * separate capabilities behind them — an operator may hold `platform:plan_manage` and not
 * `audit:read_all`. Sharing the error type is deliberate: every platform screen translates
 * the same code-plus-parameters contract into Spanish the same way.
 */

export interface PlanQuotas {
  readonly users: number;
}

export interface Plan {
  readonly code: string;
  readonly name: string;
  /** A **string** amount. A JSON number would go through an IEEE-754 double. */
  readonly monthlyPrice: { readonly amount: string; readonly currency: string };
  readonly quotas: PlanQuotas;
  readonly tenantCount: number;
  readonly updatedAt: string;
}

export type QuotaStatus = 'within' | 'warning' | 'exceeded';

export interface QuotaReading {
  /** The quota kind, as the API names it: `users`, plus whatever a project adds. */
  readonly kind: string;
  readonly used: number;
  readonly limit: number;
  readonly ratio: number;
  readonly status: QuotaStatus;
}

export interface TenantQuotaUsage {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly planCode: string;
  readonly status: QuotaStatus;
  readonly readings: readonly QuotaReading[];
  /** Absent when this client has never been measured. The screen says so rather than lying. */
  readonly measuredAt: string | undefined;
}

export interface QueueSnapshot {
  readonly name: string;
  readonly describes: string;
  readonly pending: number;
  readonly active: number;
  readonly completedLastDay: number;
  readonly failedLastDay: number;
  readonly deadLettered: number;
  readonly oldestPendingAgeSeconds: number | undefined;
  readonly retryLimit: number;
}

export interface DeadLetterJob {
  readonly jobId: string;
  readonly queue: string;
  readonly jobName: string;
  readonly tenantId: string | undefined;
  readonly correlationId: string | undefined;
  readonly failedAt: string;
  readonly attempts: number;
  /** A failure class, never a message: an error's message quotes the client's own rows. */
  readonly failureClass: string;
}

export interface AuditEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly tenantId: string | undefined;
  readonly tenantName: string | undefined;
  readonly actorType: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string | undefined;
  readonly resourceId: string | undefined;
  readonly result: 'success' | 'denied' | 'error';
  readonly ipAddress: string | undefined;
  readonly correlationId: string | undefined;
  readonly changes: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditPage {
  readonly items: readonly AuditEvent[];
  readonly nextCursor: string | undefined;
}

export interface AuditFilters {
  readonly tenantId?: string;
  readonly actorId?: string;
  readonly action?: string;
  readonly result?: 'success' | 'denied' | 'error';
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
}

function readCsrfToken(): string | undefined {
  return /(?:^|;\s*)mtb_csrf=([^;]+)/.exec(document.cookie)?.[1];
}

async function send(
  path: string,
  init: { readonly method?: string; readonly body?: string; readonly signal?: AbortSignal } = {},
): Promise<Response> {
  const csrf = readCsrfToken();

  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: {
        code?: string;
        correlationId?: string;
        params?: Readonly<Record<string, string>>;
      };
    };
    throw new PlatformError(
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.params ?? {},
      body.error?.correlationId,
    );
  }

  return response;
}

/** Drops the keys the caller left blank, so an empty field is not sent as `?actorId=`. */
function queryStringOf(filters: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value.trim() !== '') params.set(key, value.trim());
  }

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export class HttpPlatformOperationsClient {
  public async listPlans(signal?: AbortSignal): Promise<readonly Plan[]> {
    const response = await send('/api/v1/platform/plans', signal === undefined ? {} : { signal });
    return (await response.json()) as readonly Plan[];
  }

  public async savePlan(input: {
    readonly code: string;
    readonly name: string;
    readonly monthlyPrice: string;
    readonly currency: string;
    readonly quotas: PlanQuotas;
    /** True when the plan already exists: the same form both creates and redefines. */
    readonly exists: boolean;
  }): Promise<Plan> {
    const body = JSON.stringify({
      code: input.code,
      name: input.name,
      monthlyPrice: input.monthlyPrice,
      currency: input.currency,
      quotas: input.quotas,
    });

    const response = input.exists
      ? await send(`/api/v1/platform/plans/${encodeURIComponent(input.code)}`, {
          method: 'PUT',
          body,
        })
      : await send('/api/v1/platform/plans', { method: 'POST', body });

    return (await response.json()) as Plan;
  }

  public async assignPlan(tenantId: string, planCode: string): Promise<void> {
    await send(`/api/v1/platform/tenants/${encodeURIComponent(tenantId)}/plan`, {
      method: 'POST',
      body: JSON.stringify({ planCode }),
    });
  }

  public async listQuotaUsage(signal?: AbortSignal): Promise<readonly TenantQuotaUsage[]> {
    const response = await send(
      '/api/v1/platform/quota-usage',
      signal === undefined ? {} : { signal },
    );
    return (await response.json()) as readonly TenantQuotaUsage[];
  }

  public async listQueues(signal?: AbortSignal): Promise<readonly QueueSnapshot[]> {
    const response = await send('/api/v1/platform/queues', signal === undefined ? {} : { signal });
    return (await response.json()) as readonly QueueSnapshot[];
  }

  public async listDeadLettered(
    queue: string | undefined,
    signal?: AbortSignal,
  ): Promise<readonly DeadLetterJob[]> {
    const response = await send(
      `/api/v1/platform/queues/dead-letter${queryStringOf({ queue })}`,
      signal === undefined ? {} : { signal },
    );
    return (await response.json()) as readonly DeadLetterJob[];
  }

  public async replayJob(jobId: string): Promise<DeadLetterJob> {
    const response = await send(
      `/api/v1/platform/queues/dead-letter/${encodeURIComponent(jobId)}/replay`,
      { method: 'POST' },
    );
    return (await response.json()) as DeadLetterJob;
  }

  public async discardJob(jobId: string, reason: string): Promise<DeadLetterJob> {
    const response = await send(
      `/api/v1/platform/queues/dead-letter/${encodeURIComponent(jobId)}/discard`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
    return (await response.json()) as DeadLetterJob;
  }

  public async searchAuditTrail(filters: AuditFilters, signal?: AbortSignal): Promise<AuditPage> {
    const response = await send(
      `/api/v1/platform/audit-events${queryStringOf(filters)}`,
      signal === undefined ? {} : { signal },
    );
    return (await response.json()) as AuditPage;
  }
}
