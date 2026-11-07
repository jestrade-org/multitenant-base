import { PlatformError } from './platformClient.js';

/**
 * Entering and leaving a client's account (§8.1, VC-101).
 *
 * Its own client rather than a method on the roster's, because the capability behind it is
 * its own: an operator may provision companies all day and never hold `platform:support_access`.
 * Sharing the error type is deliberate — every platform screen translates the same
 * code-plus-parameters contract into Spanish the same way.
 */

export interface TenantMember {
  readonly memberId: string;
  readonly fullName: string;
  readonly email: string;
  readonly roleCode: string;
  readonly tenantId: string;
  readonly tenantName: string;
}

export interface GrantedSupportAccess {
  readonly grantId: string;
  readonly tenant: { readonly id: string; readonly name: string };
  readonly member: {
    readonly id: string;
    readonly fullName: string;
    readonly email: string;
    readonly roleCode: string;
  };
  readonly expiresAt: string;
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

export class HttpSupportAccessClient {
  /** The people inside one client, or a search across all of them. */
  public async listMembers(
    input: { readonly tenantId?: string; readonly query?: string },
    signal?: AbortSignal,
  ): Promise<readonly TenantMember[]> {
    const params = new URLSearchParams();
    if (input.tenantId !== undefined) params.set('tenantId', input.tenantId);
    if (input.query !== undefined && input.query.trim() !== '') params.set('q', input.query.trim());

    const response = await send(
      `/api/v1/platform/support-access/members?${params.toString()}`,
      signal === undefined ? {} : { signal },
    );
    const body = (await response.json()) as { readonly items: readonly TenantMember[] };
    return body.items;
  }

  public async begin(input: {
    readonly memberId: string;
    readonly reason: string;
  }): Promise<GrantedSupportAccess> {
    const response = await send('/api/v1/platform/support-access', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return (await response.json()) as GrantedSupportAccess;
  }

  /** Hand the account back. Idempotent, and it never touches the staff member's session. */
  public async end(): Promise<void> {
    await send('/api/v1/platform/support-access', { method: 'DELETE' });
  }
}
