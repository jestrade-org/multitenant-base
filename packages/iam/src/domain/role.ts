import {
  isPermissionCode,
  permission,
  ValidationError,
  type Permission,
} from '@multitenant-base/shared-kernel';

import { RoleImmutableError, PermissionNotGrantableError } from './errors.js';

/**
 * A named bundle of capabilities.
 *
 * Roles are data, not code (§8.3). A client asking for a role that is *almost* an
 * accountant gets a row, not a release: nothing here is compiled into a deploy, and the
 * enforcement point only ever asks "does this actor hold this capability".
 *
 * Two kinds exist. System roles are seeded, shared by every tenant, and immutable —
 * editing the definition of `manager` under one client would silently change it for all of
 * them. Tenant roles belong to one company and are theirs to shape.
 */

const CODE = /^[a-z][a-z0-9_]{1,40}$/;

/** Capabilities that operate the platform itself, never delegable to a tenant. */
function isPlatformScoped(code: Permission): boolean {
  return code.startsWith('platform:');
}

export interface RoleSnapshot {
  readonly id: string;
  readonly tenantId: string | undefined;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly permissions: readonly Permission[];
}

export class Role {
  readonly #id: string;
  readonly #tenantId: string | undefined;
  readonly #code: string;
  #name: string;
  #description: string;
  readonly #isSystem: boolean;
  #permissions: readonly Permission[];

  private constructor(snapshot: RoleSnapshot) {
    this.#id = snapshot.id;
    this.#tenantId = snapshot.tenantId;
    this.#code = snapshot.code;
    this.#name = snapshot.name;
    this.#description = snapshot.description;
    this.#isSystem = snapshot.isSystem;
    this.#permissions = snapshot.permissions;
  }

  /** Rebuilds a role from storage. Performs no validation: the row was valid when written. */
  public static reconstitute(snapshot: RoleSnapshot): Role {
    return new Role(snapshot);
  }

  /**
   * Creates a role a tenant owns.
   *
   * `grantable` is what the *actor* holds. Nobody may create a role carrying a capability
   * they do not have themselves — otherwise a tenant admin mints a role with
   * `platform:tenant_manage`, assigns it to their own account, and has escalated. This is
   * the check that makes "roles are configurable" safe rather than merely convenient.
   */
  public static createForTenant(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly code: string;
    readonly name: string;
    readonly description?: string;
    readonly permissions: readonly string[];
    readonly grantable: readonly Permission[];
  }): Role {
    if (!CODE.test(input.code)) {
      throw new ValidationError('code', 'must be a lowercase slug of 2 to 41 characters');
    }
    if (input.name.trim().length === 0) {
      throw new ValidationError('name', 'a role needs a name a person can recognise');
    }

    const permissions = toPermissions(input.permissions);
    assertGrantable(permissions, input.grantable);

    return new Role({
      id: input.id,
      tenantId: input.tenantId,
      code: input.code,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      isSystem: false,
      permissions,
    });
  }

  public get id(): string {
    return this.#id;
  }

  public get tenantId(): string | undefined {
    return this.#tenantId;
  }

  public get code(): string {
    return this.#code;
  }

  public get name(): string {
    return this.#name;
  }

  public get description(): string {
    return this.#description;
  }

  public get isSystem(): boolean {
    return this.#isSystem;
  }

  public get permissions(): readonly Permission[] {
    return this.#permissions;
  }

  public has(required: Permission): boolean {
    return this.#permissions.includes(required);
  }

  /** Replaces the capability set. Intention-revealing, because this is an audited change. */
  public redefinePermissions(codes: readonly string[], grantable: readonly Permission[]): void {
    this.#assertMutable();
    const permissions = toPermissions(codes);
    assertGrantable(permissions, grantable);
    this.#permissions = permissions;
  }

  public rename(name: string, description?: string): void {
    this.#assertMutable();
    if (name.trim().length === 0) {
      throw new ValidationError('name', 'a role needs a name a person can recognise');
    }
    this.#name = name.trim();
    if (description !== undefined) this.#description = description.trim();
  }

  #assertMutable(): void {
    if (this.#isSystem) {
      // Editing `manager` for one client would change it for every client that has it.
      throw new RoleImmutableError(this.#code);
    }
  }

  public toSnapshot(): RoleSnapshot {
    return {
      id: this.#id,
      tenantId: this.#tenantId,
      code: this.#code,
      name: this.#name,
      description: this.#description,
      isSystem: this.#isSystem,
      permissions: this.#permissions,
    };
  }
}

function toPermissions(codes: readonly string[]): readonly Permission[] {
  const unknown = codes.filter((code) => !isPermissionCode(code));
  if (unknown.length > 0) {
    // Silently dropping would create a role that looks right in the interface and grants
    // less than it claims — the worst kind of permissions bug, because nobody sees it
    // until someone is refused something the screen said they had.
    throw new ValidationError('permissions', `not in the catalogue: ${unknown.join(', ')}`);
  }
  return [...new Set(codes)].map(permission);
}

function assertGrantable(wanted: readonly Permission[], grantable: readonly Permission[]): void {
  const platformScoped = wanted.filter(isPlatformScoped);
  if (platformScoped.length > 0) {
    throw new PermissionNotGrantableError(platformScoped[0] ?? '', 'platform-scoped');
  }

  const held = new Set<string>(grantable);
  const escalating = wanted.filter((code) => !held.has(code));
  if (escalating.length > 0) {
    throw new PermissionNotGrantableError(escalating[0] ?? '', 'not held by the actor');
  }
}
