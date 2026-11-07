import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The session, as the client sees it.
 *
 * Deliberately thin: the browser never holds a token. The API keeps the access and
 * refresh tokens in httpOnly cookies, so there is nothing here for an XSS payload to
 * steal, and nothing to keep in sync with the server. What this holds is only what the
 * interface needs to render — a name, a role, the permissions to decide which controls to
 * show.
 *
 * Hiding a control is UX. The server checks again on every request, so a client that lies
 * to itself about its permissions gains nothing (§8.3, layer 1).
 */

export interface SessionUser {
  readonly fullName: string;
  readonly email: string;
  readonly roleCode: string;
}

export interface SessionTenant {
  readonly name: string;
  readonly subdomain: string;
  readonly timezone: string;
}

export interface Session {
  readonly user: SessionUser;
  /**
   * The company this session belongs to, or none.
   *
   * platform staff belong to no company (§8.1). Null rather than absent, because a missing key
   * reads as "still loading" to anything that checks for one, and the shell renders a
   * platform session differently rather than blankly.
   */
  readonly tenant: SessionTenant | null;
  readonly permissions: readonly string[];
  /**
   * Set when a platform staff member is acting inside this account (§8.1, VC-101).
   *
   * Null in every ordinary session, and the shell renders a standing banner when it is
   * not. The client is not a security boundary — the server decides what this session may
   * do — but it is the only place the *person* can see whose account they are in, and a
   * support session nobody notices is how a change lands in the wrong company's books.
   */
  readonly supportAccess: SupportAccess | null;
}

export interface SupportAccess {
  readonly grantId: string;
  /** The real human, so they can read their own name and check where they are. */
  readonly staffFullName: string;
  readonly staffEmail: string;
  /** ISO-8601. The grant stops working at it whether or not the tab noticed. */
  readonly expiresAt: string;
  readonly reason: string;
}

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly session: Session };

interface SessionContextValue {
  readonly state: SessionState;
  // Properties rather than methods: every caller destructures these off the context, and a
  // method signature would make each of those an unbound `this`.
  readonly signIn: (email: string, password: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** True when the session carries this capability. Never the only check. */
  readonly can: (permission: string) => boolean;
}

export class SignInError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'SignInError';
  }
}

/** Thrown when the server could not end the session, so the session is still live. */
export class SignOutError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'SignOutError';
  }
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** The CSRF cookie is readable by design — the client copies it into a header. */
function readCsrfToken(): string | undefined {
  const match = /(?:^|;\s*)mtb_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1];
}

interface ApiRequest {
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

async function api(path: string, init: ApiRequest = {}): Promise<Response> {
  const csrf = readCsrfToken();
  return fetch(path, {
    ...init,
    // Cookies are the session; without this the browser sends none of them.
    credentials: 'same-origin',
    headers: {
      // Only when there *is* a body. Declaring a JSON content type on a bodyless request
      // makes the server parse an empty body and reject it — which is how a logout can
      // fail with a 400 while the client believes it succeeded.
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
      ...init.headers,
    },
  });
}

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  // On load the client does not know whether the cookie it cannot read is still valid.
  // Asking the server is the only honest answer.
  useEffect(() => {
    // An AbortController rather than a captured flag: unmounting should stop the request,
    // not just ignore its answer.
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await api('/api/v1/auth/me', { signal: controller.signal });
        if (response.ok) {
          setState({ status: 'authenticated', session: (await response.json()) as Session });
        } else {
          setState({ status: 'anonymous' });
        }
      } catch {
        // An aborted request says nothing about the session. React's StrictMode aborts the
        // first run of this effect on a component that stays mounted, and reading that as
        // "anonymous" sent every reloaded deep link to the sign-in screen and then home.
        if (controller.signal.aborted) return;
        setState({ status: 'anonymous' });
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await api('/api/v1/auth/session', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      throw new SignInError(body.error?.code ?? 'INVALID_CREDENTIALS');
    }

    const session = (await response.json()) as Session & { csrfToken: string };
    setState({ status: 'authenticated', session });
  }, []);

  const signOut = useCallback(async () => {
    // Only the server can end a session: the tokens live in cookies the client cannot
    // read, and revocation happens at the auth provider. If that call fails, the session
    // is still live — and telling someone they are logged out when they are not is the
    // worst possible lie on a shared computer. So the failure is surfaced and the
    // interface stays signed in, rather than clearing local state and looking tidy.
    const response = await api('/api/v1/auth/session', { method: 'DELETE' });
    if (!response.ok) {
      throw new SignOutError(String(response.status));
    }
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      signIn,
      signOut,
      can: (permission) =>
        state.status === 'authenticated' && state.session.permissions.includes(permission),
    }),
    [state, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession was called outside SessionProvider.');
  return value;
}
