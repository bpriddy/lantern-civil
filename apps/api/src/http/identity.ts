import type pg from 'pg';
import type { Config } from '../config.js';
import { SESSION_COOKIE, loadSession, type User } from '../auth/sessions.js';

/**
 * Resolves the current user for a request.
 *
 * This was IAP's job (PRD 12) until the owner chose to share the application. The
 * shape it returns is unchanged, so route handlers and the dev shim did not have to
 * move when the mechanism underneath did.
 */

export type Identity = User;

export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export interface IdentityReader {
  read(cookies: Record<string, string | undefined>, unsign: (v: string) => string | null): Promise<Identity>;
}

export function createIdentityReader(config: Config, pool: pg.Pool): IdentityReader {
  // PRD 2 wants one command to run locally, and a laptop has no OAuth redirect. The
  // shim resolves to a real row so foreign keys behave exactly as they will in
  // production. config.ts refuses to boot with this set in production.
  if (config.devIdentity) {
    const email = config.devIdentity;
    let cached: Identity | undefined;

    return {
      async read(): Promise<Identity> {
        if (cached) return cached;
        const { rows } = await pool.query<Identity>(
          `INSERT INTO users (google_sub, email, email_verified, name)
           VALUES ($1, $2, true, $3)
           ON CONFLICT (google_sub) DO UPDATE SET last_login_at = now()
           RETURNING id, email, name, avatar_url AS "avatarUrl"`,
          [`dev:${email}`, email, 'Local Developer'],
        );
        cached = rows[0]!;
        return cached;
      },
    };
  }

  return {
    async read(cookies, unsign): Promise<Identity> {
      const raw = cookies[SESSION_COOKIE];
      if (!raw) throw new UnauthenticatedError('no session cookie');

      // An unsigned or tampered cookie is indistinguishable from an absent one, on
      // purpose: saying which would tell an attacker whether the secret changed.
      const sessionId = unsign(raw);
      if (!sessionId) throw new UnauthenticatedError('session cookie failed signature check');

      const user = await loadSession(pool, sessionId);
      if (!user) throw new UnauthenticatedError('session expired or revoked');

      return user;
    },
  };
}
