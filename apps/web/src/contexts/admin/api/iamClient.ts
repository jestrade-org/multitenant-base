import { ApiError } from '../../../shared/api/apiError.js';

/**
 * Roles and the permission catalogue, as the admin panel needs them.
 */

export interface PermissionEntry {
  readonly code: string;
  /** Bounded context the capability belongs to: `tenancy`, `iam`, `audit`. */
  readonly context: string;
  readonly description: string;
}

export interface RoleEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  /** System roles are shared by every tenant and cannot be edited here. */
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
}

export interface MemberEntry {
  readonly memberId: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly isActive: boolean;
  readonly canManageUsers: boolean;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
}

export interface IamClient {
  listMembers(signal?: AbortSignal): Promise<readonly MemberEntry[]>;
  inviteMember(input: {
    readonly email: string;
    readonly fullName: string;
    readonly roleCode: string;
  }): Promise<MemberEntry>;
  changeMemberRole(memberId: string, roleCode: string): Promise<MemberEntry>;
  setMemberActive(memberId: string, isActive: boolean): Promise<MemberEntry>;
  listPermissions(signal?: AbortSignal): Promise<readonly PermissionEntry[]>;
  listRoles(signal?: AbortSignal): Promise<readonly RoleEntry[]>;
  createRole(input: {
    readonly code: string;
    readonly name: string;
    readonly permissions: readonly string[];
  }): Promise<RoleEntry>;
  setPermissions(roleId: string, permissions: readonly string[]): Promise<RoleEntry>;
}

function readCsrfToken(): string | undefined {
  return /(?:^|;\s*)mtb_csrf=([^;]+)/.exec(document.cookie)?.[1];
}

async function request<T>(
  path: string,
  init: { readonly method?: string; readonly body?: string; readonly signal?: AbortSignal } = {},
): Promise<T> {
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
      error?: { code?: string; correlationId?: string };
    };
    throw new ApiError(
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.correlationId,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export class HttpIamClient implements IamClient {
  public async listMembers(signal?: AbortSignal): Promise<readonly MemberEntry[]> {
    const body = await request<{ items: readonly MemberEntry[] }>(
      '/api/v1/admin/members',
      signal === undefined ? {} : { signal },
    );
    return body.items;
  }

  public inviteMember(input: {
    readonly email: string;
    readonly fullName: string;
    readonly roleCode: string;
  }): Promise<MemberEntry> {
    return request<MemberEntry>('/api/v1/admin/members', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public changeMemberRole(memberId: string, roleCode: string): Promise<MemberEntry> {
    return request<MemberEntry>(`/api/v1/admin/members/${encodeURIComponent(memberId)}/role`, {
      method: 'PUT',
      body: JSON.stringify({ roleCode }),
    });
  }

  public setMemberActive(memberId: string, isActive: boolean): Promise<MemberEntry> {
    return request<MemberEntry>(`/api/v1/admin/members/${encodeURIComponent(memberId)}/status`, {
      method: 'PUT',
      body: JSON.stringify({ isActive }),
    });
  }

  public listPermissions(signal?: AbortSignal): Promise<readonly PermissionEntry[]> {
    return request<readonly PermissionEntry[]>(
      '/api/v1/iam/permissions',
      signal === undefined ? {} : { signal },
    );
  }

  public listRoles(signal?: AbortSignal): Promise<readonly RoleEntry[]> {
    return request<readonly RoleEntry[]>(
      '/api/v1/iam/roles',
      signal === undefined ? {} : { signal },
    );
  }

  public createRole(input: {
    readonly code: string;
    readonly name: string;
    readonly permissions: readonly string[];
  }): Promise<RoleEntry> {
    return request<RoleEntry>('/api/v1/iam/roles', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public setPermissions(roleId: string, permissions: readonly string[]): Promise<RoleEntry> {
    return request<RoleEntry>(`/api/v1/iam/roles/${encodeURIComponent(roleId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ permissions }),
    });
  }
}
