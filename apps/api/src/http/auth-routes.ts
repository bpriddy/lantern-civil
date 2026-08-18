import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { redirectUri } from '../config.js';
import { OAuthError, authorizationUrl, beginAuth, exchangeCode, type AuthRequest } from '../auth/google.js';
import {
  OAUTH_COOKIE,
  OAUTH_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  deleteSession,
  upsertUser,
} from '../auth/sessions.js';

/**
 * Sign-in is open: anyone with a Google account may create an account and their own
 * projects, which is what the owner asked for in order to share the application.
 *
 * That is safe while Civil has no runtime. It stops being safe at M4, when code
 * nodes begin executing, because PRD 2 excludes sandbox isolation of untrusted code
 * from v1 — an exclusion that was written when there was exactly one user running
 * exactly their own code. See docs/prd-deltas.md.
 */

interface AuthDeps {
  config: Config;
  pool: pg.Pool;
}

/**
 * Only same-origin absolute paths. Without this check, `?returnTo=https://evil.test`
 * turns the login endpoint into an open redirect that borrows Civil's credibility.
 * `//host` is rejected too — browsers read it as protocol-relative.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { config, pool } = deps;

  const cookieBase = {
    path: '/',
    httpOnly: true,
    // Lax rather than Strict: Strict would drop the session cookie on the redirect
    // back from Google and the user would land signed out. Lax still refuses the
    // cookie on cross-site POSTs, which is the CSRF case that matters.
    sameSite: 'lax',
    secure: config.isProduction,
    signed: true,
  } as const;

  app.get('/auth/google/start', async (request, reply) => {
    if (!config.google) {
      return reply.code(503).send({ error: 'oauth_not_configured' });
    }

    const authRequest = beginAuth();
    const returnTo = safeReturnTo((request.query as Record<string, unknown>)['returnTo']);

    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ ...authRequest, returnTo }), {
      ...cookieBase,
      maxAge: Math.floor(OAUTH_TTL_MS / 1000),
    });

    return reply.redirect(
      authorizationUrl({ ...config.google, redirectUri: redirectUri(config) }, authRequest),
    );
  });

  app.get('/auth/google/callback', async (request, reply) => {
    if (!config.google) {
      return reply.code(503).send({ error: 'oauth_not_configured' });
    }

    const query = request.query as Record<string, unknown>;

    // Google reports user-facing refusals here rather than as an HTTP error.
    if (typeof query['error'] === 'string') {
      request.log.info({ oauthError: query['error'] }, 'sign-in declined at Google');
      return reply.redirect('/?error=declined');
    }

    const code = query['code'];
    const state = query['state'];
    if (typeof code !== 'string' || typeof state !== 'string') {
      return reply.redirect('/?error=invalid_callback');
    }

    const raw = request.cookies[OAUTH_COOKIE];
    reply.clearCookie(OAUTH_COOKIE, { path: '/' });
    if (!raw) return reply.redirect('/?error=login_expired');

    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return reply.redirect('/?error=login_expired');

    let stored: AuthRequest & { returnTo: string };
    try {
      stored = JSON.parse(unsigned.value) as AuthRequest & { returnTo: string };
    } catch {
      return reply.redirect('/?error=login_expired');
    }

    // The state check is the CSRF defence: it proves this callback answers a login
    // this browser actually started.
    if (state !== stored.state) {
      request.log.warn('oauth state mismatch');
      return reply.redirect('/?error=invalid_state');
    }

    try {
      const profile = await exchangeCode(
        { ...config.google, redirectUri: redirectUri(config) },
        code,
        stored,
      );

      const user = await upsertUser(pool, profile);
      const session = await createSession(pool, user.id, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });

      reply.setCookie(SESSION_COOKIE, session.id, {
        ...cookieBase,
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });

      request.log.info({ userId: user.id }, 'signed in');
      return reply.redirect(safeReturnTo(stored.returnTo));
    } catch (error) {
      if (error instanceof OAuthError) {
        // The detail matters for diagnosis and must not reach the browser.
        request.log.error({ err: error }, 'oauth exchange failed');
        return reply.redirect('/?error=sign_in_failed');
      }
      throw error;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      // Deleted server-side, not merely un-set in the browser: clearing the cookie
      // alone would leave a valid session for anyone holding a copy of it.
      if (unsigned.valid && unsigned.value) await deleteSession(pool, unsigned.value);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}
