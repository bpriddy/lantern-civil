export interface Me {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  environment: 'development' | 'test' | 'production';
}

export interface Connection {
  provider: 'github';
  externalLogin: string | null;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; me: Me }
  | { status: 'signedOut' }
  | { status: 'error'; message: string };

/**
 * One place decides whether you are signed in: a 401 from /api/me. The SPA shell is
 * not a public route, so there is no second answer to disagree with.
 */
export async function fetchMe(signal?: AbortSignal): Promise<SessionState> {
  try {
    const response = await fetch('/api/me', {
      signal: signal ?? null,
      headers: { accept: 'application/json' },
    });
    if (response.status === 401) return { status: 'signedOut' };
    if (!response.ok) return { status: 'error', message: `server returned ${response.status}` };
    return { status: 'authenticated', me: (await response.json()) as Me };
  } catch (error) {
    if (signal?.aborted) return { status: 'loading' };
    return { status: 'error', message: (error as Error).message };
  }
}

export async function fetchConnections(signal?: AbortSignal): Promise<Connection[]> {
  const response = await fetch('/api/connections', {
    signal: signal ?? null,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return [];
  return ((await response.json()) as { connections: Connection[] }).connections;
}

/** A full navigation, not fetch: the OAuth flow has to happen in the address bar. */
export function signIn(): void {
  const returnTo = window.location.pathname + window.location.search;
  window.location.assign(`/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
}

export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.assign('/');
}

/** Sign-in failures come back as a query parameter, since the callback is a redirect. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  declined: 'Sign-in was cancelled.',
  invalid_callback: 'Google returned an unexpected response. Try again.',
  login_expired: 'That sign-in attempt timed out. Try again.',
  invalid_state: 'That sign-in could not be verified. Try again.',
  sign_in_failed: 'Sign-in failed. If it keeps happening, check the server logs.',
};
