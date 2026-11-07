/** A failed platform request, carrying the code and the parameters the client translates. */
export class PlatformError extends Error {
  public constructor(
    public readonly code: string,
    public readonly params: Readonly<Record<string, string>>,
    public readonly correlationId: string | undefined,
  ) {
    super(code);
    this.name = 'PlatformError';
  }
}

/** Tenants, as the platform panel needs them (§9, VC-27, VC-75). */

export interface TenantSummary {
  readonly id: string;
  readonly name: string;
  readonly taxId: string;
  readonly subdomain: string;
  readonly schemaName: string;
  readonly timezone: string;
  readonly planCode: string;
  readonly lifecycleStatus: string;
  /** False while a provisioning is unfinished — the visible state of "something stopped". */
  readonly isProvisioned: boolean;
  readonly createdAt: string;
}

export interface ProvisionTenantInput {
  readonly name: string;
  readonly taxId: string;
  readonly subdomain?: string;
  readonly planCode: string;
  readonly administratorEmail: string;
  readonly administratorName: string;
}

export interface ProvisionResult {
  readonly tenant: TenantSummary;
  readonly administratorEmail: string;
  readonly resumed: boolean;
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
    // Code plus parameters, never the server's English prose: the screen decides the
    // Spanish, and the parameters are what let it name the field that was refused.
    throw new PlatformError(
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.params ?? {},
      body.error?.correlationId,
    );
  }

  return response;
}

export class HttpPlatformClient {
  public async listTenants(signal?: AbortSignal): Promise<readonly TenantSummary[]> {
    const response = await send('/api/v1/platform/tenants', signal === undefined ? {} : { signal });
    return (await response.json()) as readonly TenantSummary[];
  }

  public async provisionTenant(input: ProvisionTenantInput): Promise<ProvisionResult> {
    const response = await send('/api/v1/platform/tenants', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return (await response.json()) as ProvisionResult;
  }

  public async suspendTenant(tenantId: string): Promise<void> {
    await send(`/api/v1/platform/tenants/${encodeURIComponent(tenantId)}/suspend`, {
      method: 'POST',
    });
  }

  public async resumeTenant(tenantId: string): Promise<void> {
    await send(`/api/v1/platform/tenants/${encodeURIComponent(tenantId)}/resume`, {
      method: 'POST',
    });
  }
}
