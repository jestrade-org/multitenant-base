/**
 * A failed API request, carrying the stable code the client translates.
 *
 * The API never sends Spanish text: it sends a code, optional parameters and a
 * correlation id. Screens map the code to copy and show the correlation id so a person can
 * quote it to support.
 */
export class ApiError extends Error {
  public constructor(
    public readonly code: string,
    public readonly correlationId: string | undefined,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}
