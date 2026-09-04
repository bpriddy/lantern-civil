import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { GitHubApp } from '../github/app.js';
import { SourceError, openProjectSource } from '../project/open.js';
import { OverlaySource } from '../project/overlay.js';
import {
  ContentTooLargeError,
  deletePending,
  listPending,
  revertPending,
  savePending,
} from '../project/pending.js';
import { applyOps, type ManifestOp } from '../manifest/apply.js';
import { ManifestEditError } from '../manifest/document.js';
import { parse } from 'yaml';
import { zGraph, type GraphEdge } from '@civil/schema';
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
  shapeOutput,
  storeMemo,
  type TranspileMeta,
  type TranspileOutput,
} from '../project/transpile.js';
import { idTokenFor } from './runner-auth.js';
import { transpileAndSync } from './session-routes.js';

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
export class RunnerError extends Error {
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

export const sendRunnerError = (reply: FastifyReply, error: unknown): FastifyReply => {
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

async function analyzePatterns(
  deps: TranspileDeps,
  ownerId: string,
  project: ProjectRow,
  source: ProjectSource,
  files: Record<string, string>,
  head: string | null,
): Promise<string> {
  const { config, pool } = deps;
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
}

export interface TranspileFlow {
  output: TranspileOutput;
  cached: boolean;
  patternsRefreshed: boolean;
  /** Paths a past emission produced that this one does not — retired from pending. */
  retired: string[];
}

/**
 * The whole transpile flow — staleness, maybe analyze, memo, runner, and landing
 * every emitted file as a pending change. One implementation on purpose: the
 * session route materializes the same transpiled app the transpile route previews
 * (docs/app-session.md), and two flows would drift on exactly the rules that make
 * the memo honest. The caller has already checked config.runnerUrl and opened the
 * project. Throws RunnerError and ContentTooLargeError; mapping them onto a reply
 * stays with the route.
 */
export async function transpileProject(
  deps: TranspileDeps,
  ownerId: string,
  project: ProjectRow,
  source: ProjectSource,
  overlay: OverlaySource,
): Promise<TranspileFlow> {
  const { config, pool } = deps;

  const maintained = await maintainedPaths(pool, ownerId, project.id);
  const inputs = await gatherInputs(overlay, maintained);

  // Fetched before any model work: the fingerprint is part of the memo key, and
  // a runner that cannot answer it fails the request the way an unreachable
  // runner already does — never a hash without it.
  const meta: TranspileMeta = await transpileMeta(config.runnerUrl!);

  // Read after the source opened: opening resolves and pins head_sha for a
  // repository seen for the first time, and this must compare against that.
  const state = await patternsState(pool, ownerId, project.id);
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
      inputs.patterns = await analyzePatterns(
        deps, ownerId, project, source, analyzerFiles, headSha,
      );
      patternsRefreshed = true;
    }
  }

  const hash = inputHash(inputs, meta);
  let output = await findMemo(pool, ownerId, project.id, hash);
  const cached = output !== undefined;
  if (!output) {
    const answer = await callRunner(config.runnerUrl!, '/transpile', {
      documents: inputs.documents,
      patterns: inputs.patterns,
      context: inputs.context,
    });
    const rawFiles = answer['files'];
    if (typeof rawFiles !== 'object' || rawFiles === null || Array.isArray(rawFiles)) {
      throw new RunnerError(502, {
        error: 'transpiler_answer_malformed',
        message: 'The transpiler answered without a files map.',
      });
    }
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(rawFiles)) {
      if (typeof content === 'string') files[path] = content;
    }
    output = shapeOutput(files, answer['roles'], answer['attempts']);
    await storeMemo(pool, ownerId, project.id, hash, output);
  }

  // Every emitted file is a pending change — reviewed in the diff panel and
  // committed explicitly, exactly like an edit a human made (PRD 7). Written on
  // memo hits too: the memo remembers the answer, not whether it is still pending.
  for (const path of Object.keys(output.files).sort()) {
    await savePending(pool, {
      ownerId,
      projectId: project.id,
      branch: project.defaultBranch,
      path,
      content: output.files[path]!,
      existsAtHead: source.exists(path),
    });
  }

  // Retirement: a path a past emission produced (maintainedPaths, the union over
  // the memo) that this emission does not is stale, and a session materialising
  // HEAD+pending would run it beside the new file (docs/app-session.md). Retire it
  // — a delete change when it exists at HEAD so a commit removes it from the repo
  // too, a plain revert when it was only ever pending. Runs after the writes above,
  // and the filter keeps a path this emission still owns from ever being retired.
  const retired = [...maintained].filter((path) => !(path in output.files)).sort();
  for (const path of retired) {
    if (source.exists(path)) {
      await deletePending(pool, ownerId, project.id, project.defaultBranch, path);
    } else {
      await revertPending(pool, ownerId, project.id, project.defaultBranch, path);
    }
  }

  return { output, cached, patternsRefreshed, retired };
}

/**
 * The edge ops that make a graph's flow edges match a lifted set: remove the flow
 * edges the code no longer expresses, add the ones it now does, and leave every
 * capability edge untouched (lift's remit is flow only). Order-insensitive by
 * {from,to}, so lifting an unchanged emission yields no ops — an open never churns
 * the graph. New ids avoid every id already in the document.
 */
export function liftEdgesToOps(
  edges: readonly GraphEdge[],
  lifted: readonly { from: string; to: string }[],
): { ops: ManifestOp[]; added: number; removed: number } {
  const key = (from: string, to: string) => `${from}\u0000${to}`;
  const flow = edges.filter((e) => e.kind === 'flow');
  const liftedKeys = new Set(lifted.map((e) => key(e.from, e.to)));
  const currentKeys = new Set(flow.map((e) => key(e.from.node, e.to.node)));

  const ops: ManifestOp[] = [];
  for (const e of flow) {
    if (!liftedKeys.has(key(e.from.node, e.to.node))) ops.push({ op: 'removeEdge', id: e.id });
  }
  const taken = new Set(edges.map((e) => e.id));
  let n = 1;
  const mintId = (): string => {
    for (;;) {
      const candidate = `e${n++}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  };
  let added = 0;
  for (const e of lifted) {
    if (!currentKeys.has(key(e.from, e.to))) {
      ops.push({ op: 'addEdge', edge: { id: mintId(), kind: 'flow', from: { node: e.from }, to: { node: e.to } } });
      added += 1;
    }
  }
  const removed = ops.length - added;
  return { ops, added, removed };
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

    // Transpile, then push to a live session best-effort (docs/app-session.md): a
    // session catches the edit without a manual Run, and "no session" is silence.
    let flow: TranspileFlow;
    try {
      flow = await transpileAndSync(deps, request.identity.id, project, source, overlay);
    } catch (error) {
      if (error instanceof ContentTooLargeError) {
        return reply.code(413).send({ error: 'content_too_large', message: error.message });
      }
      return sendRunnerError(reply, error);
    }

    const { output, cached, patternsRefreshed } = flow;
    const emitted = Object.keys(output.files).sort();
    request.log.info(
      { projectId: project.id, files: emitted.length, cached, patternsRefreshed },
      'transpiled',
    );
    return { files: emitted, roles: output.roles, cached, patternsRefreshed };
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
      await analyzePatterns(
        deps, request.identity.id, project, source, analyzerFiles, state?.headSha ?? null,
      );
    } catch (error) {
      return sendRunnerError(reply, error);
    }

    return { path: PATTERNS_PATH };
  });

  // Lift: read a graph's hand-edited orchestration back into its flow edges
  // (docs/lift.md). The runner parses the straight-line run(); this turns the
  // recovered edge set into ops against the graph document — the theirs of
  // mine-or-theirs for orchestration, and the round-trip's return leg.
  app.post('/api/projects/:id/lift', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { graphPath?: unknown };
    const graphPath = typeof body?.graphPath === 'string' ? body.graphPath : '';
    if (!graphPath) return reply.code(400).send({ error: 'graph_path_required' });

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

    await overlay.ensure?.([graphPath]);
    const graphDoc = overlay.read(graphPath);
    if (graphDoc === undefined) {
      return reply.code(404).send({ error: 'graph_not_found', message: `${graphPath} could not be read.` });
    }
    // Which emitted file is this graph's orchestration: the transpiler chooses the
    // path (graphs/X.graph.yaml became src/graphs/X.py here, not graphs/X.py), so
    // match on basename stem across the files Civil maintains rather than a
    // same-directory guess. v1 heuristic; a persisted graph<->file map is the robust
    // successor (docs/lift.md), and a stem collision across directories is its edge.
    const stem = graphPath.split('/').pop()!.replace(/\.graph\.ya?ml$/, '');
    const maintained = await maintainedPaths(pool, request.identity.id, project.id);
    // maintainedPaths unions every emission this project ever produced, so a stem
    // can match a path from an OLD layout that no longer exists (graphs/X.py before
    // the emitter moved to src/graphs/X.py). Ensure the candidates, then take the
    // one that actually reads — the file lift is meant to reconcile.
    const candidates = [...maintained]
      .filter((mp) => mp.endsWith('.py') && mp.split('/').pop() === `${stem}.py`);
    await overlay.ensure?.(candidates);
    let orchestrationPath: string | undefined;
    let orchestration: string | undefined;
    for (const candidate of candidates) {
      const content = overlay.read(candidate);
      if (content !== undefined) {
        orchestrationPath = candidate;
        orchestration = content;
        break;
      }
    }
    if (orchestrationPath === undefined || orchestration === undefined) {
      return reply.code(404).send({
        error: 'orchestration_not_found',
        message: `No emitted orchestration matches ${graphPath} — nothing to lift from.`,
      });
    }

    let answer: Record<string, unknown>;
    try {
      answer = await callRunner(config.runnerUrl, '/lift', { graphPath, graphDoc, orchestration });
    } catch (error) {
      return sendRunnerError(reply, error);
    }
    if (answer['unliftable']) {
      // Not an error: the canvas cannot represent what the human wrote (control
      // flow, an unknown symbol). Regenerate stays the only reconciliation.
      return reply.code(422).send({ error: 'unliftable', reason: answer['reason'] ?? 'unliftable' });
    }

    const lifted = Array.isArray(answer['edges'])
      ? (answer['edges'] as { from?: unknown; to?: unknown }[]).flatMap((e) =>
          typeof e?.from === 'string' && typeof e?.to === 'string' ? [{ from: e.from, to: e.to }] : [],
        )
      : [];

    // The document's current edges: flow edges reconcile against the lift; every
    // capability edge is left exactly as it is (lift's remit is flow only).
    const parsed = zGraph.safeParse(parse(graphDoc));
    if (!parsed.success) {
      return reply.code(422).send({ error: 'graph_unparseable', reason: 'the graph document does not parse' });
    }
    const { ops, added, removed } = liftEdgesToOps(parsed.data.spec.edges, lifted);

    // Idempotent: the unchanged emission lifts to the current edge set, so nothing
    // is written and an open never churns the graph.
    if (ops.length === 0) {
      return { graphPath, added: 0, removed: 0, unliftable: false };
    }

    let applied;
    try {
      applied = applyOps(graphDoc, ops);
    } catch (error) {
      if (error instanceof ManifestEditError) {
        return reply.code(422).send({ error: 'lift_refused', reason: error.message });
      }
      throw error;
    }
    await savePending(pool, {
      ownerId: request.identity.id,
      projectId: project.id,
      branch: project.defaultBranch,
      path: graphPath,
      content: applied.source,
      existsAtHead: source.exists(graphPath),
    });

    request.log.info({ projectId: project.id, graphPath, added, removed }, 'lifted');
    return { graphPath, added, removed, unliftable: false };
  });
}
