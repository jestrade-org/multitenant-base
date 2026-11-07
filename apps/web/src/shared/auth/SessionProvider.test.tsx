import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionProvider, useSession } from './SessionProvider.js';

/**
 * Regression tests for a logout that reported success while the session stayed live.
 *
 * The client sent `content-type: application/json` on a bodyless DELETE, the server
 * rejected the empty body with a 400, and the provider cleared its own state anyway. The
 * interface said "signed out" over a session anyone could resume by reloading the page —
 * on a shared machine, exactly the failure a logout exists to prevent.
 */

const SESSION = {
  user: { fullName: 'María Fernanda Rojas', email: 'member@acme.test', roleCode: 'member' },
  tenant: { name: 'Acme Logistics Inc.', subdomain: 'acme', timezone: 'America/Bogota' },
  permissions: ['tenancy:read'],
};

interface RecordedRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

let fetchMock: ReturnType<typeof vi.fn>;
let requests: RecordedRequest[];

function requestFor(method: string): RecordedRequest {
  const match = requests.find((request) => request.method === method);
  if (match === undefined) throw new Error(`no ${method} request was sent`);
  return match;
}

function Probe({
  onReady,
}: {
  readonly onReady: (session: ReturnType<typeof useSession>) => void;
}) {
  const session = useSession();
  onReady(session);
  return <span>{session.state.status}</span>;
}

async function renderSignedIn(): Promise<ReturnType<typeof useSession>> {
  let latest: ReturnType<typeof useSession> | undefined;
  render(
    <SessionProvider>
      <Probe
        onReady={(session) => {
          latest = session;
        }}
      />
    </SessionProvider>,
  );
  await waitFor(() => {
    expect(screen.getByText('authenticated')).toBeDefined();
  });
  if (latest === undefined) throw new Error('the probe never rendered');
  return latest;
}

beforeEach(() => {
  document.cookie = 'mtb_csrf=csrf-token-value';
  requests = [];
  fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    requests.push({
      path,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(new Response(JSON.stringify(SESSION), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SessionProvider', () => {
  it('does not declare a JSON content type on a request that carries no body', async () => {
    const session = await renderSignedIn();

    await act(async () => {
      await session.signOut();
    });

    const logout = requestFor('DELETE');

    expect(logout.headers['content-type']).toBeUndefined();
    expect(logout.headers['x-csrf-token']).toBe('csrf-token-value');
  });

  it('sends the JSON content type when there is a body to parse', async () => {
    const session = await renderSignedIn();

    await act(async () => {
      await session.signIn('member@acme.test', 'una-clave');
    });

    expect(requestFor('POST').headers['content-type']).toBe('application/json');
  });

  it('keeps the session signed in when the server could not end it', async () => {
    const session = await renderSignedIn();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 400 }));

    await act(async () => {
      await expect(session.signOut()).rejects.toThrow();
    });

    // The whole point: a failed revocation must never render as a completed logout.
    expect(screen.getByText('authenticated')).toBeDefined();
  });

  it('signs out only after the server confirms the session is revoked', async () => {
    const session = await renderSignedIn();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await act(async () => {
      await session.signOut();
    });

    expect(screen.getByText('anonymous')).toBeDefined();
  });
});

describe('loading the session', () => {
  it('never reports an aborted request as signed out, so a reload keeps its deep link', async () => {
    // StrictMode mounts, aborts and re-runs the effect. Reading the abort as "anonymous"
    // sent every reloaded deep link to the sign-in screen and then home.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_path: string, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
            // Slower than React's remount, as a real network is, so the first request is
            // always aborted while still in flight.
            setTimeout(() => {
              resolve(new Response(JSON.stringify(SESSION), { status: 200 }));
            }, 50);
          }),
      ),
    );
    const seen: string[] = [];

    render(
      <StrictMode>
        <SessionProvider>
          <Probe
            onReady={(session) => {
              seen.push(session.state.status);
            }}
          />
        </SessionProvider>
      </StrictMode>,
    );
    await waitFor(() => {
      expect(screen.getByText('authenticated')).toBeDefined();
    });

    expect(seen).not.toContain('anonymous');
  });
});
