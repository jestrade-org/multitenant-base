import { beforeEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  NotAuthorizedError,
  permissionsFrom,
  PolicyEnforcementPoint,
  type Actor,
  type AuthorizationAttempt,
} from '@multitenant-base/shared-kernel';

import {
  buildAuditTrailQueries,
  type AuditPage,
  type AuditSearchRecorder,
  type AuditTrailReader,
  type ResolvedAuditSearch,
} from './queryAuditTrail.js';
import { AuditWindowTooWideError } from '../domain/auditQuery.js';

/**
 * A cross-tenant audit search is itself audited (VC-75).
 *
 * Fakes rather than mocks for the two ports we own, because the property under test is a
 * sequence — the rows must not leave this use case before the `audit.searched` row is
 * written — and a fake that records its calls in order is the only way to assert it.
 */

const NOW = new Date('2026-08-24T15:00:00.000Z');

class RecordingReader implements AuditTrailReader {
  public readonly seen: ResolvedAuditSearch[] = [];
  public page: AuditPage = { items: [], nextCursor: undefined };

  public search(criteria: ResolvedAuditSearch): Promise<AuditPage> {
    this.seen.push(criteria);
    return Promise.resolve(this.page);
  }
}

class RecordingRecorder implements AuditSearchRecorder {
  public readonly recorded: {
    readonly filters: Readonly<Record<string, string>>;
    readonly returned: number;
  }[] = [];
  public failNext = false;

  public record(input: {
    readonly filters: Readonly<Record<string, string>>;
    readonly returned: number;
  }): Promise<void> {
    if (this.failNext) return Promise.reject(new Error('the trail is unreachable'));
    this.recorded.push({ filters: input.filters, returned: input.returned });
    return Promise.resolve();
  }
}

const attempts: AuthorizationAttempt[] = [];

function staff(permissions: readonly string[]): Actor {
  return {
    actorId: '11111111-1111-4111-8111-111111111111',
    actorType: 'platform_admin',
    tenantId: undefined,
    roleCode: 'platform_admin',
    permissions: permissionsFrom(permissions),
  };
}

function buildQueries(reader: AuditTrailReader, recorder: AuditSearchRecorder) {
  return buildAuditTrailQueries({
    pep: new PolicyEnforcementPoint({
      clock: new FixedClock(NOW),
      auditSink: {
        record: (attempt) => {
          attempts.push(attempt);
          return Promise.resolve();
        },
      },
    }),
    reader,
    recorder,
    clock: new FixedClock(NOW),
  });
}

let reader: RecordingReader;
let recorder: RecordingRecorder;

beforeEach(() => {
  attempts.length = 0;
  reader = new RecordingReader();
  recorder = new RecordingRecorder();
});

describe('searching the cross-tenant audit trail', () => {
  it('refuses a caller without audit:read_all', async () => {
    const queries = buildQueries(reader, recorder);

    await expect(queries.searchAuditTrail(staff(['audit:read']), {})).rejects.toThrow(
      NotAuthorizedError,
    );
    expect(reader.seen).toHaveLength(0);
  });

  it('records the search itself, with the filters and how many rows it returned', async () => {
    reader.page = {
      items: [
        {
          eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          occurredAt: NOW.toISOString(),
          tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tenantName: 'Acme Logistics Inc.',
          actorType: 'user',
          actorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          action: 'advisory.approved',
          resourceType: 'diagnosis',
          resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          result: 'success',
          ipAddress: '190.85.1.10',
          correlationId: '01HRZTESTCORRELATION',
          changes: undefined,
        },
      ],
      nextCursor: undefined,
    };
    const queries = buildQueries(reader, recorder);

    await queries.searchAuditTrail(staff(['audit:read_all']), { action: 'advisory.approved' });

    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.returned).toBe(1);
    expect(recorder.recorded[0]?.filters).toMatchObject({
      action: 'advisory.approved',
      tenantId: 'all',
      actorId: 'all',
      result: 'all',
    });
  });

  it('records the filters, never the rows the search returned', async () => {
    reader.page = {
      items: [
        {
          eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          occurredAt: NOW.toISOString(),
          tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tenantName: 'Acme Logistics Inc.',
          actorType: 'user',
          actorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          action: 'collections.debtor_excluded',
          resourceType: 'debtor',
          resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          result: 'success',
          ipAddress: '190.85.1.10',
          correlationId: '01HRZTESTCORRELATION',
          changes: { reason: 'acuerdo de pago firmado' },
        },
      ],
      nextCursor: undefined,
    };
    const queries = buildQueries(reader, recorder);

    await queries.searchAuditTrail(staff(['audit:read_all']), {});

    // Copying every client's history into a second place each time somebody looked at it
    // would be a disclosure control that creates the disclosure.
    const written = JSON.stringify(recorder.recorded);
    expect(written).not.toContain('acuerdo de pago firmado');
    expect(written).not.toContain('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  });

  it('discloses nothing when the search cannot be recorded', async () => {
    reader.page = { items: [], nextCursor: 'cursor-1' };
    recorder.failNext = true;
    const queries = buildQueries(reader, recorder);

    await expect(queries.searchAuditTrail(staff(['audit:read_all']), {})).rejects.toThrow(
      'the trail is unreachable',
    );
  });

  it('bounds the page size at a hundred however large the request', async () => {
    const queries = buildQueries(reader, recorder);

    await queries.searchAuditTrail(staff(['audit:read_all']), { pageSize: 100_000 });

    expect(reader.seen[0]?.pageSize).toBe(100);
  });

  it('defaults the window rather than reading the whole retention period', async () => {
    const queries = buildQueries(reader, recorder);

    await queries.searchAuditTrail(staff(['audit:read_all']), {});

    expect(reader.seen[0]?.to).toEqual(NOW);
    expect(reader.seen[0]?.from).toEqual(new Date('2026-07-25T15:00:00.000Z'));
  });

  it('refuses a window wider than a year before reaching the database', async () => {
    const queries = buildQueries(reader, recorder);

    await expect(
      queries.searchAuditTrail(staff(['audit:read_all']), {
        from: '2020-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(AuditWindowTooWideError);

    expect(reader.seen).toHaveLength(0);
    expect(recorder.recorded).toHaveLength(0);
  });
});
