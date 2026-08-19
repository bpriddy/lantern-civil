import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { githubRedirectUri } from '../config.js';
import { GitHubApp, type Repository } from '../github/app.js';
import {
  GitHubAuthError,
  beginUserAuth,
  completeUserAuth,
  userAuthorizationUrl,
} from '../github/user-auth.js';
import {
  getGitHubConnection,
  listConnections,
  removeGitHubConnection,
  upsertGitHubConnection,
} from '../project/connections.js';

const GITHUB_OAUTH_COOKIE = 'civil_github_oauth';
const OAUTH_TTL_MS = 10 * 60 * 1000;

interface Deps {
  config: Config;
  pool: pg.Pool;
}

export function registerGitHubRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, pool } = deps;

  const githubApp = config.github
    ? new GitHubApp({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;

  const cookieBase = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    signed: true,
  } as const;

  app.get('/api/connections', async (request) => ({
    connections: await listConnections(pool, request.identity.id),
  }));

  app.get('/auth/github/start', async (request, reply) => {
    if (!config.github) return reply.code(503).send({ error: 'github_not_configured' });

    const { state } = beginUserAuth();
    reply.setCookie(GITHUB_OAUTH_COOKIE, state, {
      ...cookieBase,
      maxAge: Math.floor(OAUTH_TTL_MS / 1000),
    });

    return reply.redirect(
      userAuthorizationUrl(
        { ...config.github, redirectUri: githubRedirectUri(config) },
        state,
      ),
    );
  });

  app.get('/auth/github/callback', async (request, reply) => {
    if (!config.github) return reply.code(503).send({ error: 'github_not_configured' });

    const query = request.query as Record<string, unknown>;
    if (typeof query['error'] === 'string') {
      return reply.redirect('/?github=declined');
    }

    const code = query['code'];
    const state = query['state'];
    if (typeof code !== 'string' || typeof state !== 'string') {
      return reply.redirect('/?github=invalid_callback');
    }

    const raw = request.cookies[GITHUB_OAUTH_COOKIE];
    reply.clearCookie(GITHUB_OAUTH_COOKIE, { path: '/' });
    if (!raw) return reply.redirect('/?github=expired');

    const unsigned = request.unsignCookie(raw);
    // GitHub does not support PKCE for Apps, so state is the entire CSRF defence.
    if (!unsigned.valid || unsigned.value !== state) {
      request.log.warn('github oauth state mismatch');
      return reply.redirect('/?github=invalid_state');
    }

    try {
      const { user, installations } = await completeUserAuth(
        { ...config.github, redirectUri: githubRedirectUri(config) },
        code,
      );

      // GitHub decides what this account may reach, not Civil. If they have no
      // installation, the link is still recorded so the UI can offer to install
      // rather than silently doing nothing.
      const installation = installations[0];

      await upsertGitHubConnection(
        pool,
        request.identity.id,
        user.login,
        String(user.id),
        installation ? String(installation.installationId) : null,
      );

      request.log.info(
        { userId: request.identity.id, login: user.login, installations: installations.length },
        'linked github account',
      );
      return reply.redirect(installation ? '/?github=connected' : '/?github=no_installation');
    } catch (error) {
      if (error instanceof GitHubAuthError) {
        request.log.error({ err: error }, 'github link failed');
        return reply.redirect('/?github=failed');
      }
      throw error;
    }
  });

  app.delete('/api/connections/github', async (request, reply) => {
    await removeGitHubConnection(pool, request.identity.id);
    return reply.code(204).send();
  });

  /** What this user may open. Scoped by their installation, never by Civil's guess. */
  app.get('/api/github/repositories', async (request, reply) => {
    if (!githubApp) return reply.code(503).send({ error: 'github_not_configured' });

    const connection = await getGitHubConnection(pool, request.identity.id);
    if (!connection?.installationId) {
      return reply.code(409).send({
        error: 'github_not_connected',
        message: 'Connect GitHub in settings first.',
      });
    }

    const result = await githubApp.asInstallation<{ repositories: Repository[]; total_count: number }>(
      connection.installationId,
      '/installation/repositories?per_page=100&sort=updated',
    );

    return {
      total: result.total_count,
      repositories: result.repositories.map((r) => ({
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        defaultBranch: r.default_branch,
        private: r.private,
      })),
    };
  });
}
