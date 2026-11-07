import type { DomainEvent } from './domainEvent.js';
import { isKnownEventType } from './eventCatalogue.js';
import { err, ok, type Result } from './result.js';

/**
 * Validating an event that arrived from somewhere else.
 *
 * An event read back out of the outbox, off a queue, or replayed from the audit index is
 * untrusted input in the same sense a request body is: it was serialised by a version of
 * this code that may no longer exist. Trusting its shape because we wrote it once is how
 * a consumer crashes on a field that a deploy three months ago stopped writing.
 *
 * Hand-written rather than delegated to a schema library, because shared-kernel is the
 * package everything else depends on and it stays dependency-free. The envelope is eight
 * fields; a dependency here would be paid for by every context.
 */

export type EnvelopeProblem =
  | { readonly field: string; readonly reason: 'missing' }
  | { readonly field: string; readonly reason: 'wrong-type'; readonly expected: string }
  | { readonly field: string; readonly reason: 'malformed'; readonly detail: string };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks an unknown value against the envelope contract of §6.
 *
 * Returns every problem rather than the first: an operator debugging a poisoned queue
 * message needs to see the whole shape, not to fix one field per redeploy.
 */
export function parseEventEnvelope(
  candidate: unknown,
): Result<DomainEvent, readonly EnvelopeProblem[]> {
  const problems: EnvelopeProblem[] = [];

  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return err([{ field: '.', reason: 'wrong-type', expected: 'object' }]);
  }

  const raw = candidate as Record<string, unknown>;

  const requireString = (field: string, pattern?: RegExp, patternName?: string): void => {
    const value = raw[field];
    if (value === undefined || value === null) {
      problems.push({ field, reason: 'missing' });
      return;
    }
    if (typeof value !== 'string') {
      problems.push({ field, reason: 'wrong-type', expected: 'string' });
      return;
    }
    if (value === '') {
      problems.push({ field, reason: 'malformed', detail: 'empty string' });
      return;
    }
    if (pattern && !pattern.test(value)) {
      problems.push({
        field,
        reason: 'malformed',
        detail: `expected ${patternName ?? pattern.source}`,
      });
    }
  };

  requireString('eventId', UUID, 'a uuid');
  requireString('tenantId', UUID, 'a uuid');
  requireString('correlationId');
  requireString('occurredAt', ISO_INSTANT, 'an ISO-8601 instant in UTC');
  requireString('type');

  // An unknown type is not a malformed envelope — it is an event this build does not
  // know about, which happens legitimately during a rolling deploy. It is reported so
  // the consumer can park the message rather than treat it as corrupt.
  if (typeof raw.type === 'string' && raw.type !== '' && !isKnownEventType(raw.type)) {
    problems.push({
      field: 'type',
      reason: 'malformed',
      detail: `"${raw.type}" is not in the event catalogue`,
    });
  }

  if (raw.payload === undefined || raw.payload === null) {
    problems.push({ field: 'payload', reason: 'missing' });
  } else if (typeof raw.payload !== 'object' || Array.isArray(raw.payload)) {
    problems.push({ field: 'payload', reason: 'wrong-type', expected: 'object' });
  }

  const causationId = raw.causationId;
  if (causationId !== undefined && causationId !== null && typeof causationId !== 'string') {
    problems.push({ field: 'causationId', reason: 'wrong-type', expected: 'string' });
  }

  if (problems.length > 0) return err(problems);

  return ok({
    eventId: raw.eventId as string,
    tenantId: raw.tenantId as string,
    type: raw.type as string,
    occurredAt: raw.occurredAt as string,
    payload: raw.payload,
    correlationId: raw.correlationId as string,
    ...(typeof causationId === 'string' ? { causationId } : {}),
  });
}

/** A one-line summary for logs. Never the payload: it can carry personal details. */
export function describeEnvelopeProblems(problems: readonly EnvelopeProblem[]): string {
  return problems
    .map((problem) =>
      problem.reason === 'missing'
        ? `${problem.field} is missing`
        : problem.reason === 'wrong-type'
          ? `${problem.field} should be ${problem.expected}`
          : `${problem.field} is malformed (${problem.detail})`,
    )
    .join('; ');
}
