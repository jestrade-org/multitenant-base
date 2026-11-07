/**
 * Handing a client's account back (§8.1, VC-101).
 *
 * Lives beside the session rather than in the platform context because the button that
 * calls it is in the shell, on every screen: while a grant is live the person is *inside*
 * the client's product, and the platform panel is exactly what they cannot reach.
 *
 * It never touches the staff member's own session. Ending a grant removes an overlay; the
 * cookies underneath it were always their own, so returning cannot fail into being signed
 * out — which is the reason the feature is built as an overlay in the first place.
 */

function readCsrfToken(): string | undefined {
  return /(?:^|;\s*)mtb_csrf=([^;]+)/.exec(document.cookie)?.[1];
}

export class SupportAccessError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'SupportAccessError';
  }
}

export async function endSupportAccess(): Promise<void> {
  const csrf = readCsrfToken();

  const response = await fetch('/api/v1/platform/support-access', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: csrf === undefined ? {} : { 'x-csrf-token': csrf },
  });

  // 404 means there was no grant to end — which is the state the caller wanted. Treating
  // it as a failure would leave someone pressing a button that already worked.
  if (!response.ok && response.status !== 404) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    throw new SupportAccessError(body.error?.code ?? 'REQUEST_FAILED');
  }
}
