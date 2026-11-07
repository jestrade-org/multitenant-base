import { ValidationError } from '@multitenant-base/shared-kernel';

/**
 * One entry in the audit trail (§8.4).
 *
 * A business record, not a log line. It outlives the request by six years, so the shape
 * is validated here rather than trusted: a row that turns out to be unreadable in 2032 is
 * indistinguishable from a row that was never written.
 */

export type AuditActorType = 'user' | 'api_key' | 'platform_admin' | 'mcp_client';
export type AuditResult = 'success' | 'denied' | 'error';

/** Before/after for a mutation. Never a credential, never a whole business record. */
export type AuditChanges = Readonly<Record<string, unknown>>;

export interface AuditEvent {
  readonly occurredAt: Date;
  /** Absent only for platform-wide actions that belong to no tenant. */
  readonly tenantId?: string;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  /** English verb code, `noun.verb_past`: `tenant.suspended`, `authorization.denied`. */
  readonly action: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly result: AuditResult;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly correlationId?: string;
  readonly changes?: AuditChanges;
}

const ACTION_SHAPE = /^[a-z_]+(\.[a-z_]+)+$/;

/**
 * Keys whose values must never reach the trail.
 *
 * The audit table has the longest retention of anything we store and the widest read
 * access, so a secret written here is a secret that outlives every rotation policy. The
 * check is on the key rather than the value because a token is not recognisable by shape.
 */
const FORBIDDEN_KEY = /password|passwd|secret|token|api[-_]?key|authorization|cookie|cvv/i;

function assertNoCredentials(changes: AuditChanges, path = 'changes'): void {
  for (const [key, value] of Object.entries(changes)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new ValidationError(`${path}.${key}`, 'an audit event may not carry a credential');
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      assertNoCredentials(value as AuditChanges, `${path}.${key}`);
    }
  }
}

/**
 * Validates an event before it is written.
 *
 * Rejecting is the right answer: §8.4 makes the audit write part of the same transaction
 * as the change, so a malformed event fails the operation instead of silently recording a
 * row nobody can query.
 */
export function assertRecordableAuditEvent(event: AuditEvent): void {
  if (!ACTION_SHAPE.test(event.action)) {
    throw new ValidationError('action', `${event.action} is not a noun.verb_past action code`);
  }
  if (event.actorId.trim().length === 0) {
    throw new ValidationError('actorId', 'every action is attributable to exactly one principal');
  }
  if (
    event.tenantId === undefined &&
    event.actorType !== 'platform_admin' &&
    !event.action.startsWith('authentication.')
  ) {
    // Authentication is the one exception, and a narrow one: a sign-in attempt with an
    // address that belongs to nobody has no tenant to be filed under, and it is exactly
    // the event a credential-stuffing run generates. Everything else must be attributable
    // to a company.
    throw new ValidationError(
      'tenantId',
      'only a platform action or an authentication attempt may belong to no tenant',
    );
  }
  if (event.userAgent !== undefined && event.userAgent.length > 512) {
    throw new ValidationError('userAgent', 'longer than the column allows');
  }
  if (event.changes !== undefined) {
    assertNoCredentials(event.changes);
  }
}
