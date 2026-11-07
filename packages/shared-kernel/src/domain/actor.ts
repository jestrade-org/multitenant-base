import { NotAuthorizedError } from './errors.js';
import type { Permission } from './permission.js';

/**
 * Who is asking.
 *
 * Always derived from a verified token, never from a request body, header or query
 * parameter (§8.1). A `tenantId` the client sent is data; this is identity.
 *
 * Machine principals are distinct `actorType`s rather than a user account shared by a cron
 * job, so that every entry in the audit trail names one human or one integration — "who
 * approved this payment" must have exactly one answer. The four types mirror
 * `control.audit_actor_type` (§8.4).
 */
export type ActorType = 'user' | 'api_key' | 'platform_admin' | 'mcp_client';

export interface Actor {
  readonly actorId: string;
  readonly actorType: ActorType;
  /**
   * The tenant this actor is acting within. Every tenant-scoped query is scoped by it.
   *
   * Absent for platform staff, who belong to no company (§8.1). Modelled as absent rather than
   * as a placeholder because a placeholder is a value that gets used: the first version of
   * this passed the string `'platform'`, and it reached a `uuid` column within the hour.
   */
  readonly tenantId: string | undefined;
  readonly roleCode: string;
  readonly permissions: readonly Permission[];
}

export function actorHas(actor: Actor, required: Permission): boolean {
  return actor.permissions.includes(required);
}

/**
 * The tenant an actor is acting within, or a refusal.
 *
 * Every tenant-scoped use case calls this instead of reading `tenantId` directly, so
 * "what happens when platform staff reach this?" is answered once, in the open, rather than
 * by whatever a `string | undefined` happens to do when it is interpolated.
 *
 * The answer is always the same: staff have no company, so a use case that needs one
 * refuses. Reaching a client's data as staff requires a deliberate, audited elevation
 * (§8.1, VC-101) — not a use case quietly accepting `undefined`.
 */
export function requireTenant(actor: Actor): string {
  if (actor.tenantId === undefined) {
    throw new NotAuthorizedError('tenant-scoped operation');
  }
  return actor.tenantId;
}
