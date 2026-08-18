import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyError } from 'fastify';
import type { Logger } from 'pino';
import type pg from 'pg';
import type { Config } from '../config.js';
import { checkConnection } from '../db/pool.js';
import { registerAuthRoutes } from './auth-routes.js';
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
 * Routes reachable without a session. Cloud Run's probes cannot present one, and the
 * auth routes are how you get one in the first place.
 *
 * The SPA shell is deliberately NOT here. It renders its own signed-out state from a
 * 401 on /api/me, which keeps exactly one place deciding who is signed in.
 */
const PUBLIC_PREFIXES = ['/healthz', '/readyz', '/auth/'];

const isPublic = (url: string): boolean => {
  const path = url.split('?')[0]!;
  return PUBLIC_PREFIXES.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
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

  app.addHook('onRequest', async (request, reply) => {
    if (isPublic(request.url)) return;

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

  // Placeholder for the settings surface the owner asked for: GitHub is linked here
  // rather than at sign-in, so one connection serves every project a user owns.
  app.get('/api/connections', async (request) => {
    const { rows } = await pool.query<{ provider: string; externalLogin: string | null }>(
      `SELECT provider, external_login AS "externalLogin"
         FROM user_connections WHERE user_id = $1`,
      [request.identity.id],
    );
    return { connections: rows };
  });

  // IAP fronted one service, and so does this: the SPA is served from the same origin
  // as the API. Registered after the auth hook, so static assets are behind it too.
  if (config.webRoot) {
    await app.register(fastifyStatic, { root: config.webRoot, index: false });

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
