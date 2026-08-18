import type pg from 'pg';
import type { GoogleProfile } from './google.js';

/**
 * Server-side sessions. A self-contained token would be smaller, but it cannot be
 * revoked before it expires — and "sign that person out now" is something the owner
 * of a shared application eventually needs.
 */

export const SESSION_COOKIE = 'civil_session';
export const OAUTH_COOKIE = 'civil_oauth';

/** Long enough not to be annoying in an editor, short enough to bound a stolen cookie. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The transient OAuth cookie only has to survive a redirect to Google and back. */
export const OAUTH_TTL_MS = 10 * 60 * 1000;

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface SessionMeta {
  userAgent: string | undefined;
  ip: string | undefined;
}

/**
 * Keyed on Google's `sub`, never on email. Google accounts can change their address,
 * and keying on email would silently fork someone's projects the day they do.
 * Email is updated on every login so it stays current for display.
 */
export async function upsertUser(pool: pg.Pool, profile: GoogleProfile): Promise<User> {
  const { rows } = await pool.query<User>(
    `INSERT INTO users (google_sub, email, email_verified, name, avatar_url, last_login_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (google_sub) DO UPDATE
       SET email          = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified,
           name           = EXCLUDED.name,
           avatar_url     = EXCLUDED.avatar_url,
           last_login_at  = now(),
           updated_at     = now()
     RETURNING id, email, name, avatar_url AS "avatarUrl"`,
    [profile.sub, profile.email, profile.emailVerified, profile.name ?? null, profile.picture ?? null],
  );
  return rows[0]!;
}

export async function createSession(
  pool: pg.Pool,
  userId: string,
  meta: SessionMeta,
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, expiresAt, meta.userAgent ?? null, meta.ip ?? null],
  );
  return { id: rows[0]!.id, expiresAt };
}

/** A forged cookie is arbitrary text; uuid is a typed column and would throw on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads and touches in one round trip. The expiry check lives in the WHERE clause
 * rather than in TypeScript, so an expired session cannot be resurrected by a clock
 * difference between the app and the database.
 */
export async function loadSession(pool: pg.Pool, sessionId: string): Promise<User | null> {
  if (!UUID.test(sessionId)) return null;

  const { rows } = await pool.query<User>(
    `WITH touched AS (
       UPDATE sessions
          SET last_seen_at = now()
        WHERE id = $1 AND expires_at > now()
        RETURNING user_id
     )
     SELECT u.id, u.email, u.name, u.avatar_url AS "avatarUrl"
       FROM touched
       JOIN users u ON u.id = touched.user_id`,
    [sessionId],
  );
  return rows[0] ?? null;
}

export async function deleteSession(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function deleteExpiredSessions(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  return rowCount ?? 0;
}
