import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError } from 'fastify';
import type { Logger } from 'pino';
import type pg from 'pg';
import type { Config } from '../config.js';
import { checkConnection } from '../db/pool.js';
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
 * Routes that must answer before, or without, IAP. Cloud Run's own probes reach the
 * container directly rather than through the load balancer, so a health check that
 * demanded an identity would fail every deploy.
 */
const UNAUTHENTICATED_ROUTES = new Set(['/healthz', '/readyz']);

/**
 * The return type is inferred rather than annotated as FastifyInstance. Passing a
 * concrete pino Logger as `loggerInstance` specialises the instance's logger generic,
 * and under exactOptionalPropertyTypes that specialisation is not assignable to the
 * default FastifyBaseLogger — so annotating it would be a lie that only typechecks
 * with a cast.
 */
export async function createServer(deps: ServerDeps) {
  const { config, logger, pool } = deps;

  const app = Fastify({
    loggerInstance: logger,
    // PRD 2: a request id on every log line. Prefer the one the load balancer already
    // assigned, so a line in Civil's logs can be joined to the same request in
    // Cloud Logging rather than living in a parallel universe.
    genReqId: (req) => {
      const trace = req.headers['x-cloud-trace-context'];
      if (typeof trace === 'string' && trace.length > 0) return trace.split('/')[0]!;
      return randomUUID();
    },
    trustProxy: true,
  });

  const identityReader = createIdentityReader(config);

  app.addHook('onRequest', async (request, reply) => {
    if (UNAUTHENTICATED_ROUTES.has(request.url.split('?')[0]!)) return;

    try {
      request.identity = await identityReader.read(request.headers);
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        request.log.warn({ reason: error.message }, 'rejected unauthenticated request');
        // 401 rather than a redirect: IAP owns the login flow, and the SPA needs a
        // status it can act on rather than an HTML login page in a fetch response.
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

  // PRD 14 M0: an empty authenticated shell. This is what makes it authenticated.
  app.get('/api/me', async (request) => ({
    subject: request.identity.subject,
    email: request.identity.email,
    environment: config.env,
  }));

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
