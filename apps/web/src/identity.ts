export interface Me {
  subject: string;
  email: string;
  environment: 'development' | 'test' | 'production';
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; me: Me }
  | { status: 'unauthenticated'; message: string }
  | { status: 'error'; message: string };

/**
 * PRD 12: IAP owns the login flow, so there is no login screen to build. A 401 here
 * means the assertion did not verify — reloading sends the browser back through IAP,
 * which is the only remedy the SPA has.
 */
export async function fetchMe(signal?: AbortSignal): Promise<SessionState> {
  try {
    // `?? null` rather than omitting: exactOptionalPropertyTypes distinguishes an
    // absent property from an undefined one, and RequestInit.signal accepts null.
    const response = await fetch('/api/me', {
      signal: signal ?? null,
      headers: { accept: 'application/json' },
    });
    if (response.status === 401) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      return { status: 'unauthenticated', message: body.message ?? 'not signed in' };
    }
    if (!response.ok) {
      return { status: 'error', message: `server returned ${response.status}` };
    }
    return { status: 'authenticated', me: (await response.json()) as Me };
  } catch (error) {
    if (signal?.aborted) return { status: 'loading' };
    return { status: 'error', message: (error as Error).message };
  }
}
