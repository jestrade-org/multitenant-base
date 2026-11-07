import { randomUUID } from 'node:crypto';

import type { AuthorizationAttempt, AuthorizationAuditSink } from '@multitenant-base/shared-kernel';

import { assertRecordableAuditEvent, type AuditEvent } from '../domain/auditEvent.js';

/**
 * Writes the audit trail to `control.audit_events`.
 *
 * Takes a client rather than a pool so the write can join the caller's transaction. That
 * is the point of §8.4: the audit row and the change it describes commit together, or
 * neither does. An audit trail written on a separate connection would record approvals
 * for payments that rolled back.
 */

export interface SqlClient {
  query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

/**
 * No `returning`, and the id is generated here.
 *
 * `returning` looked like a cheap way to confirm the row landed. It is not: it makes the
 * statement read the row back, which applies the *select* policy — and that policy is
 * tenant-scoped, so an authentication attempt with no tenant could never be written. The
 * most security-relevant event was the one event this table refused.
 *
 * Nothing is lost by dropping it. A `with check` violation raises; it does not silently
 * discard a row, so there was never a silent failure to detect.
 */
const INSERT = `
  insert into control.audit_events (
    event_id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
    result, ip_address, user_agent, occurred_at, correlation_id, changes
  ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
`;

export class PostgresAuditTrail {
  readonly #client: SqlClient;

  public constructor(client: SqlClient) {
    this.#client = client;
  }

  public async record(event: AuditEvent): Promise<string> {
    assertRecordableAuditEvent(event);

    const eventId = randomUUID();
    await this.#client.query(INSERT, [
      eventId,
      event.tenantId ?? null,
      event.actorType,
      event.actorId,
      event.action,
      event.resourceType ?? null,
      event.resourceId ?? null,
      event.result,
      event.ipAddress ?? null,
      event.userAgent ?? null,
      event.occurredAt,
      event.correlationId ?? null,
      event.changes === undefined ? null : JSON.stringify(event.changes),
    ]);

    return eventId;
  }
}

/**
 * Adapts the authorization decisions of the policy enforcement point onto the trail.
 *
 * Both outcomes are recorded, not only denials. A grant is the evidence that answers
 * "who read this payroll run", which is the question a data-protection request asks.
 */
/** Request context the decision itself does not carry. Read per attempt, never cached. */
export interface AuditRequestContext {
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly correlationId?: string;
}

export class AuthorizationAuditTrail implements AuthorizationAuditSink {
  readonly #trail: PostgresAuditTrail;
  readonly #context: () => AuditRequestContext;

  public constructor(trail: PostgresAuditTrail, context: () => AuditRequestContext = () => ({})) {
    this.#trail = trail;
    this.#context = context;
  }

  public async record(attempt: AuthorizationAttempt): Promise<void> {
    const request = this.#context();

    await this.#trail.record({
      occurredAt: attempt.occurredAt,
      ...(attempt.tenantId === undefined ? {} : { tenantId: attempt.tenantId }),
      actorType: attempt.actorType,
      actorId: attempt.actorId,
      action: attempt.outcome === 'denied' ? 'authorization.denied' : 'authorization.granted',
      resourceType: 'use_case',
      resourceId: attempt.useCase,
      result: attempt.outcome === 'denied' ? 'denied' : 'success',
      ...(request.ipAddress === undefined ? {} : { ipAddress: request.ipAddress }),
      ...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
      ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
      changes: {
        roleCode: attempt.roleCode,
        missingPermissions: attempt.missingPermissions,
        ...(attempt.attemptedTenantId === undefined
          ? {}
          : { attemptedTenantId: attempt.attemptedTenantId }),
      },
    });
  }
}
