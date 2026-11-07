import { describe, expect, it } from 'vitest';

import { assertRecordableAuditEvent, type AuditEvent } from './auditEvent.js';

/**
 * The audit trail has the longest retention and the widest read access of anything stored
 * here. What it must never contain is worth testing as carefully as what it must.
 */

function anEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    occurredAt: new Date('2026-08-23T15:00:00.000Z'),
    tenantId: 'tenant-acme',
    actorType: 'user',
    actorId: 'user-1',
    action: 'invoice.approved',
    result: 'success',
    ...overrides,
  };
}

describe('assertRecordableAuditEvent', () => {
  it('accepts a well-formed event', () => {
    expect(() => {
      assertRecordableAuditEvent(anEvent());
    }).not.toThrow();
  });

  it.each([['approved'], ['Invoice.Approved'], ['invoice approved'], ['invoice.']])(
    'rejects %s, which no compliance query could filter on',
    (action) => {
      expect(() => {
        assertRecordableAuditEvent(anEvent({ action }));
      }).toThrow(/action code/);
    },
  );

  it('rejects an event nobody can be held to', () => {
    expect(() => {
      assertRecordableAuditEvent(anEvent({ actorId: '   ' }));
    }).toThrow(/exactly one principal/);
  });

  it('requires a tenant for anything but a platform action', () => {
    const { tenantId: _omitted, ...withoutTenant } = anEvent();

    expect(() => {
      assertRecordableAuditEvent(withoutTenant);
    }).toThrow(/belong to no tenant/);
  });

  it('allows a failed sign-in by an unknown address, which has no tenant', () => {
    // The most security-relevant event must not also be the one that cannot be written.
    const { tenantId: _omitted, ...attempt } = anEvent({
      action: 'authentication.sign_in_failed',
      result: 'denied',
      actorId: 'unknown@example.com',
    });

    expect(() => {
      assertRecordableAuditEvent(attempt);
    }).not.toThrow();
  });

  it('allows a platform action to belong to no tenant', () => {
    const { tenantId: _omitted, ...withoutTenant } = anEvent({
      actorType: 'platform_admin',
      action: 'tenant.provisioned',
    });

    expect(() => {
      assertRecordableAuditEvent(withoutTenant);
    }).not.toThrow();
  });

  it.each([
    ['password'],
    ['newPassword'],
    ['accessToken'],
    ['api_key'],
    ['apiKey'],
    ['authorization'],
    ['clientSecret'],
    ['cookie'],
  ])('refuses to record a field named %s', (key) => {
    expect(() => {
      assertRecordableAuditEvent(anEvent({ changes: { [key]: 'whatever' } }));
    }).toThrow(/credential/);
  });

  it('finds a credential nested inside the changes', () => {
    expect(() => {
      assertRecordableAuditEvent(
        anEvent({ changes: { before: { integration: { apiKey: 'sk-live-…' } } } }),
      );
    }).toThrow(/credential/);
  });

  it('accepts changes that carry only business values', () => {
    expect(() => {
      assertRecordableAuditEvent(
        anEvent({ changes: { before: { status: 'draft' }, after: { status: 'approved' } } }),
      );
    }).not.toThrow();
  });

  it('rejects a user agent longer than the column holds, rather than truncating silently', () => {
    expect(() => {
      assertRecordableAuditEvent(anEvent({ userAgent: 'x'.repeat(513) }));
    }).toThrow(/longer than the column/);
  });
});
