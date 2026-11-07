/**
 * The outcome of an operation that is expected to fail sometimes.
 *
 * Business rule violations are not exceptional: a member already invited, the last
 * administrator being removed, a quota reached. Throwing for those makes the
 * failure invisible in the type, and the caller finds out at runtime whether they
 * handled it. `Result` puts the failure in the signature, so not handling it does not
 * compile.
 *
 * Exceptions stay for genuinely exceptional conditions — a dropped connection, a bug.
 */

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/** Applies a function to the value of a successful result, leaving a failure untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> {
  return result.ok ? ok(transform(result.value)) : result;
}

/**
 * Collects results, failing on the first error.
 *
 * Validating a batch of rows and reporting only the first problem wastes a
 * round trip, so prefer `partitionResults` where a caller can act on several at once.
 */
export function allResults<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/** Splits results, so a caller can report every failure rather than only the first. */
export function partitionResults<T, E>(
  results: readonly Result<T, E>[],
): { readonly values: T[]; readonly errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
}

/**
 * Unwraps a successful result, throwing on failure.
 *
 * For the boundary where a failure genuinely cannot be handled — and for tests. Using it
 * to avoid handling an error defeats the point of the type.
 */
export function unwrapOrThrow<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error
    ? result.error
    : new Error(`Unwrapped a failed result: ${JSON.stringify(result.error)}`);
}
