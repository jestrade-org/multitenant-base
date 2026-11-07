/**
 * Typed errors with stable codes.
 *
 * The API returns a code and parameters; the client maps the code to Spanish. Spanish
 * text never crosses the wire, so the code is the contract: renaming one is a breaking
 * change for every client that translates it.
 *
 * `throw new Error('...')` is forbidden in domain/ and application/ precisely because it
 * produces a message no client can act on and no operator can aggregate.
 */

/** Values interpolated into the client-side message. Never PII, never a full record. */
export type ErrorParams = Readonly<Record<string, string | number | boolean>>;

abstract class CodedError extends Error {
  /** Stable, English, documented. Part of the API contract. */
  public abstract readonly code: string;
  public readonly params: ErrorParams;

  protected constructor(message: string, params: ErrorParams = {}) {
    super(message);
    this.params = params;
  }
}

/**
 * A business rule said no.
 *
 * Maps to 409 at the boundary: the request was well-formed and the caller was allowed to
 * make it, but the domain refuses.
 */
export abstract class DomainError extends CodedError {
  public override readonly name: string = 'DomainError';
}

/**
 * A use case could not proceed — not found, not permitted, conflicting version.
 *
 * Distinct from DomainError because these map to different statuses, and conflating them
 * makes the boundary guess.
 */
export abstract class ApplicationError extends CodedError {
  public override readonly name: string = 'ApplicationError';
}

/**
 * An adapter failed: the database, a queue, a provider.
 *
 * Always a 500 with a correlation id and nothing else. The detail goes to the log, never
 * to the client — a driver message names hosts, schemas and libraries.
 */
export abstract class InfrastructureError extends CodedError {
  public override readonly name: string = 'InfrastructureError';
}

/**
 * The caller may not do this.
 *
 * Carries no detail about what exists: authorization failures are answered identically
 * whether the resource is absent or merely someone else's (§8.3).
 */
export class NotAuthorizedError extends ApplicationError {
  public override readonly name = 'NotAuthorizedError';
  public readonly code = 'NOT_AUTHORIZED';

  public constructor(public readonly requiredPermission: string) {
    super(`Missing permission ${requiredPermission}`, { requiredPermission });
  }
}

/**
 * Two writers raced and this one lost.
 *
 * Never last-write-wins on a business record: the loser is told, and decides.
 */
export class ConcurrencyConflictError extends ApplicationError {
  public override readonly name = 'ConcurrencyConflictError';
  public readonly code = 'CONCURRENCY_CONFLICT';

  public constructor(
    public readonly resourceType: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `${resourceType} changed since it was read (expected version ${String(expectedVersion)}, found ${String(actualVersion)})`,
      { resourceType, expectedVersion, actualVersion },
    );
  }
}

/** Input that a value object refused to be constructed from. */
export class ValidationError extends DomainError {
  // Widened, not literal: a specific failure (a check digit that does not match, say)
  // subclasses this to carry its own code, so a client can translate that one case
  // precisely instead of rendering the generic sentence for every refused field.
  public override readonly name: string = 'ValidationError';
  public readonly code: string = 'VALIDATION_FAILED';

  public constructor(
    public readonly field: string,
    reason: string,
    /**
     * Extra parameters for a client to interpolate.
     *
     * `reason` is English prose for an operator's log. A client must never render it — the
     * Spanish sentence comes from the code, and anything it needs to name (the digit that
     * was expected, the limit that was exceeded) belongs here as a value, not inside a
     * sentence in the wrong language (language-i18n.md).
     */
    details: ErrorParams = {},
  ) {
    super(`${field}: ${reason}`, { ...details, field, reason });
  }
}
