import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { GitHubApp } from '../github/app.js';
import { SourceError, openProjectSource } from '../project/open.js';
import { OverlaySource } from '../project/overlay.js';
import { ContentTooLargeError, listPending, savePending } from '../project/pending.js';
import { getProject, type ProjectRow } from '../project/repository.js';
import type { ProjectSource } from '../project/source.js';
import {
  PATTERNS_PATH,
  findMemo,
  gatherAnalyzerFiles,
  gatherInputs,
  inputHash,
  maintainedPaths,
  patternsState,
  setPatternsFresh,
  storeMemo,
  type TranspileMeta,
  type TranspileOutput,
} from '../project/transpile.js';
import { idTokenFor } from './runner-auth.js';

/**
 * docs/emitted-code.md: model access lives only in the runner (PRD 12), so both the
 * pattern analyzer and the transpiler execute there, dispatched like a run. What
 * this side owns is everything around the model call — deciding when the analysis
 * is stale, memoizing emission by input hash, and landing every emitted file as a
 * pending change, because nothing is applied unpreviewably (CLAUDE.md).
 */

interface TranspileDeps {
  config: Config;
  pool: pg.Pool;
}

/** A runner answer the client should see as-is, with the status it arrived under. */
class RunnerError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body['error'] === 'string' ? body['error'] : `runner ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** POST with a payload, GET without one; auth and error mapping are the same seam. */
async function callRunner(
  runnerUrl: string,
  path: string,
  payload?: unknown,
): Promise<Record<string, unknown>> {
  const idToken = await idTokenFor(runnerUrl);
  let response: Response;
  try {
    response = await fetch(`${runnerUrl}${path}`, {
      ...(payload === undefined
        ? { method: 'GET' }
        : { method: 'POST', body: JSON.stringify(payload) }),
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idToken ? { authorization: `Bearer ${idToken}` } : {}),
      },
    });
  } catch (error) {
    throw new RunnerError(502, {
      error: 'runner_unreachable',
      message: `The runner could not be reached: ${(error as Error).message}`,
    });
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    // 422 is the transpiler saying the emission failed its own validation — the
    // issues are the useful part, so the body passes through whole. Anything else
    // from the runner is a gateway problem as far as the client is concerned.
    throw new RunnerError(response.status === 422 ? 422 : 502, body);
  }
  return body;
}

const sendRunnerError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof RunnerError) return reply.code(error.status).send(error.body);
  throw error;
};

/**
 * GET /transpile/meta, cached briefly: the runner's resolved model id and prompt
 * version change on runner deploys, not per request, so five minutes bounds both
 * the staleness window and the per-transpile round trips. A failed fetch fails the
 * caller like an unreachable runner — hashing without the fingerprint would file
 * the memo under a key that survives a model upgrade.
 */
const META_TTL_MS = 5 * 60 * 1000;
let cachedMeta: { url: string; meta: TranspileMeta; expires: number } | null = null;

async function transpileMeta(runnerUrl: string): Promise<TranspileMeta> {
  if (cachedMeta && cachedMeta.url === runnerUrl && Date.now() < cachedMeta.expires) {
    return cachedMeta.meta;
  }
  const answer = await callRunner(runnerUrl, '/transpile/meta');
  const model = answer['model'];
  const promptVersion = answer['promptVersion'];
  if (typeof model !== 'string' || typeof promptVersion !== 'string') {
    throw new RunnerError(502, {
      error: 'meta_answer_malformed',
      message: 'The runner answered /transpile/meta without model and promptVersion.',
    });
  }
  cachedMeta = {
    url: runnerUrl,
    meta: { model, promptVersion },
    expires: Date.now() + META_TTL_MS,
  };
  return cachedMeta.meta;
}

export function registerTranspileRoutes(app: FastifyInstance, deps: TranspileDeps): void {
  const { config, pool } = deps;

  const githubApp = config.github
    ? new GitHubApp({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;

  /** The shared preamble: the project, its source, and the overlay every read uses. */
  const open = async (
    ownerId: string,
    project: ProjectRow,
  ): Promise<{ source: ProjectSource; overlay: OverlaySource }> => {
    const source = await openProjectSource({ pool, githubApp }, ownerId, project);
    const pending = await listPending(pool, ownerId, project.id, project.defaultBranch);
    return { source, overlay: new OverlaySource(source, pending) };
  };

  const analyze = async (
    ownerId: string,
    project: ProjectRow,
    source: ProjectSource,
    files: Record<string, string>,
    head: string | null,
  ): Promise<string> => {
    const answer = await callRunner(config.runnerUrl!, '/analyze', { files });
    const patterns = answer['patterns'];
    if (typeof patterns !== 'string') {
      throw new RunnerError(502, {
        error: 'analyzer_answer_malformed',
        message: 'The analyzer answered without a patterns string.',
      });
    }
    // The helper prompt is itself a civil document: committed, diffed, hand-editable
    // (docs/emitted-code.md) — so it lands as a pending change like everything else.
    await savePending(pool, {
      ownerId,
      projectId: project.id,
      branch: project.defaultBranch,
      path: PATTERNS_PATH,
      content: patterns,
      existsAtHead: source.exists(PATTERNS_PATH),
    });
    await setPatternsFresh(pool, ownerId, project.id, head);
    return patterns;
  };

  app.post('/api/projects/:id/transpile', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    if (!config.runnerUrl) {
      // Transpilation is model work and models live only in the runner (PRD 12).
      // Honest beats silent, same as run dispatch.
      return reply.code(503).send({
        error: 'runner_not_configured',
        message: 'No runner is configured (CIVIL_RUNNER_URL).',
      });
    }

    let source: ProjectSource;
    let overlay: OverlaySource;
    try {
      ({ source, overlay } = await open(request.identity.id, project));
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    const maintained = await maintainedPaths(pool, request.identity.id, project.id);
    const inputs = await gatherInputs(overlay, maintained);

    // Fetched before any model work: the fingerprint is part of the memo key, and
    // a runner that cannot answer it fails the request the way an unreachable
    // runner already does — never a hash without it.
    let meta: TranspileMeta;
    try {
      meta = await transpileMeta(config.runnerUrl);
    } catch (error) {
      return sendRunnerError(reply, error);
    }

    // Read after the source opened: opening resolves and pins head_sha for a
    // repository seen for the first time, and this must compare against that.
    const state = await patternsState(pool, request.identity.id, project.id);
    const headSha = state?.headSha ?? null;

    // The analyzer's two triggers, plus the cold start: a handwritten save set the
    // flag, an inbound change moved the head, or no helper prompt exists at all.
    const stale =
      !state || state.stale || state.head !== headSha || inputs.patterns === null;

    let patternsRefreshed = false;
    if (stale) {
      const analyzerFiles = await gatherAnalyzerFiles(overlay, maintained);
      // An empty repo has no conventions to read: skip the analysis and emit under
      // the default pattern (docs/emitted-code.md: no helper prompt → default).
      if (Object.keys(analyzerFiles).length > 0) {
        try {
          inputs.patterns = await analyze(
            request.identity.id, project, source, analyzerFiles, headSha,
          );
        } catch (error) {
          return sendRunnerError(reply, error);
        }
        patternsRefreshed = true;
      }
    }

    const hash = inputHash(inputs, meta);
    let output = await findMemo(pool, request.identity.id, project.id, hash);
    const cached = output !== undefined;
    if (!output) {
      let answer: Record<string, unknown>;
      try {
        answer = await callRunner(config.runnerUrl, '/transpile', {
          documents: inputs.documents,
          patterns: inputs.patterns,
          context: inputs.context,
        });
      } catch (error) {
        return sendRunnerError(reply, error);
      }
      const rawFiles = answer['files'];
      if (typeof rawFiles !== 'object' || rawFiles === null || Array.isArray(rawFiles)) {
        return reply.code(502).send({
          error: 'transpiler_answer_malformed',
          message: 'The transpiler answered without a files map.',
        });
      }
      const files: Record<string, string> = {};
      for (const [path, content] of Object.entries(rawFiles)) {
        if (typeof content === 'string') files[path] = content;
      }
      output = {
        files,
        attempts: typeof answer['attempts'] === 'number' ? answer['attempts'] : 1,
      } satisfies TranspileOutput;
      await storeMemo(pool, request.identity.id, project.id, hash, output);
    }

    // Every emitted file is a pending change — reviewed in the diff panel and
    // committed explicitly, exactly like an edit a human made (PRD 7). Written on
    // memo hits too: the memo remembers the answer, not whether it is still pending.
    const emitted = Object.keys(output.files).sort();
    try {
      for (const path of emitted) {
        await savePending(pool, {
          ownerId: request.identity.id,
          projectId: project.id,
          branch: project.defaultBranch,
          path,
          content: output.files[path]!,
          existsAtHead: source.exists(path),
        });
      }
    } catch (error) {
      if (error instanceof ContentTooLargeError) {
        return reply.code(413).send({ error: 'content_too_large', message: error.message });
      }
      throw error;
    }

    request.log.info(
      { projectId: project.id, files: emitted.length, cached, patternsRefreshed },
      'transpiled',
    );
    return { files: emitted, cached, patternsRefreshed };
  });

  /** Re-analysis on demand — the owner's way of saying "the code moved, look again". */
  app.post('/api/projects/:id/patterns', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    if (!config.runnerUrl) {
      return reply.code(503).send({
        error: 'runner_not_configured',
        message: 'No runner is configured (CIVIL_RUNNER_URL).',
      });
    }

    let source: ProjectSource;
    let overlay: OverlaySource;
    try {
      ({ source, overlay } = await open(request.identity.id, project));
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    const maintained = await maintainedPaths(pool, request.identity.id, project.id);
    const analyzerFiles = await gatherAnalyzerFiles(overlay, maintained);
    if (Object.keys(analyzerFiles).length === 0) {
      // A fresh project is a predictable state, not a runner failure — the runner
      // would 400 an empty files map and this route would dress that up as a 502.
      return reply.code(422).send({ error: 'no code to analyze yet' });
    }

    const state = await patternsState(pool, request.identity.id, project.id);
    try {
      await analyze(
        request.identity.id, project, source, analyzerFiles, state?.headSha ?? null,
      );
    } catch (error) {
      return sendRunnerError(reply, error);
    }

    return { path: PATTERNS_PATH };
  });
}
