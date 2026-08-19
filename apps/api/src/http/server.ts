import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyError } from 'fastify';
import type { Logger } from 'pino';
import type pg from 'pg';
import type { Config } from '../config.js';
import { checkConnection } from '../db/pool.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerGitHubRoutes } from './github-routes.js';
import { registerProjectRoutes } from './project-routes.js';
import { UnauthenticatedError, createIdentityReader, type Identity } from './identity.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook for every route except the unauthenticated ones. */
    identity: Identity;
  }
}

export interface ServerDeps {
  config: Config;
  logger: Logger;
  pool: pg.Pool;
}

/**
 * Only the data is guarded. The application shell — index.html and its assets — is
 * public, because a signed-out visitor has to be able to load the app in order to be
 * shown a sign-in screen. Refusing the shell means the browser renders a JSON 401
 * instead, and there is no way in.
 *
 * The bundle carries no secrets: every project, manifest, and file is fetched through
 * /api, which is exactly what this guards. That is the standard SPA split, and it is
 * also why the auth hook cannot simply cover everything.
 *
 * /auth/ is likewise public — it is how a session is obtained in the first place.
 */
export const isGuarded = (url: string): boolean => {
  const path = url.split('?')[0]!;
  // Linking GitHub is different from signing in: it attaches an installation to an
  // existing Civil account, so it requires a session rather than creating one.
  // Leaving it public would let an unauthenticated caller drive the link.
  return path.startsWith('/api/') || path.startsWith('/auth/github/');
};

export async function createServer(deps: ServerDeps) {
  const { config, logger, pool } = deps;

  const app = Fastify({
    // Widened to FastifyBaseLogger deliberately. Passing the concrete pino type
    // specialises the whole FastifyInstance generic, and every helper that then takes
    // a plain FastifyInstance stops matching it under exactOptionalPropertyTypes.
    loggerInstance: logger as FastifyBaseLogger,
    // PRD 2: a request id on every log line. Prefer the one the load balancer already
    // assigned, so a line here joins to the same request in Cloud Logging rather than
    // living in a parallel universe.
    genReqId: (req) => {
      const trace = req.headers['x-cloud-trace-context'];
      if (typeof trace === 'string' && trace.length > 0) return trace.split('/')[0]!;
      return randomUUID();
    },
    trustProxy: true,
  });

  await app.register(fastifyCookie, {
    // Signing detects tampering with the session id. Without it a forged cookie would
    // reach the database as a lookup for an id the attacker chose.
    secret: config.sessionSecret ?? 'development-only-unsigned-secret-not-for-production',
  });

  registerAuthRoutes(app, { config, pool });

  const identityReader = createIdentityReader(config, pool);

  /**
   * API responses are never cacheable.
   *
   * Without this, a 404 or 410 is cacheable by default under HTTP semantics, so a
   * transient failure — a project mid-creation, a source briefly unreadable — gets
   * stored by the browser and the application stays broken after the cause is fixed.
   * That failure is especially cruel because reloading does not clear it and the
   * server looks healthy from every other angle.
   *
   * The SPA shell and its assets are untouched: they are fingerprinted and should
   * cache.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!isGuarded(request.url)) return;

    try {
      request.identity = await identityReader.read(request.cookies, (value) => {
        const result = request.unsignCookie(value);
        return result.valid ? result.value : null;
      });
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        // 401 rather than a redirect: the SPA needs a status it can act on, not an
        // HTML sign-in page arriving inside a fetch response.
        return reply.code(401).send({ error: 'unauthenticated', message: error.message });
      }
      throw error;
    }
  });

  // Liveness: the process is up. Deliberately does not touch the database, so a
  // Postgres blip does not cause Cloud Run to kill and restart healthy instances.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: the process can actually serve, which means the database answers.
  app.get('/readyz', async (_request, reply) => {
    try {
      await checkConnection(pool);
      return { status: 'ok', database: 'ok' };
    } catch (error) {
      app.log.error({ err: error }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable', database: 'error' });
    }
  });

  app.get('/api/me', async (request) => ({
    id: request.identity.id,
    email: request.identity.email,
    name: request.identity.name,
    avatarUrl: request.identity.avatarUrl,
    environment: config.env,
  }));

  registerProjectRoutes(app, { config, pool });
  registerGitHubRoutes(app, { config, pool });

  // IAP fronted one service, and so does this: the SPA is served from the same origin
  // as the API. Registered after the auth hook, so static assets are behind it too.
  if (config.webRoot) {
    // `index` must be set, not false. With it disabled, @fastify/static matches the
    // request for "/" as a directory and answers 403 — and because it matched, the
    // SPA fallback below never runs. The root URL is the one every visitor types, so
    // that failure locks everyone out while every other route looks correct.
    await app.register(fastifyStatic, { root: config.webRoot, index: 'index.html' });

    // SPA fallback, scoped to non-/api paths so a mistyped API route still 404s as
    // JSON rather than silently returning HTML.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', requestId: request.id });
      }
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'unhandled error');
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.code(status).send({
      error: status === 500 ? 'internal' : error.name,
      // Never leak an internal message to the client; the request id is the join key
      // back to the log line that has the detail.
      message: status === 500 ? 'internal server error' : error.message,
      requestId: request.id,
    });
  });

  return app;
}
