import { ID_PATTERN } from '@civil/schema';
import type { Refinement, Skeleton } from './skeleton.js';

/**
 * The lift's optional model pass (docs/lift-repo.md): the runner's POST /lift/refine
 * reads a compact summary of the skeleton beside the repo's docs and offers clearer
 * ids, which services are plumbing, a sentence per entity, and a summary. It renames,
 * classifies and describes — it never adds or removes an entity.
 *
 * The answer is validated here again, never trusted: the runner validates too, but
 * the API is what writes the documents, and a runner is a service that can be
 * replaced, misconfigured, or a version behind. Any failure — no runner, a runner
 * error, an answer that oversteps — returns the reader's deterministic skeleton with
 * a note saying why, so the feature works the same without a model, only plainer.
 */

/** Posts a body to the runner's /lift/refine; index.ts binds it to callRunner. */
export type RefineAsk = (body: unknown) => Promise<Record<string, unknown>>;

/** Routes per server the summary carries: enough to show what a server is for. */
const ROUTE_SAMPLE = 12;

// Mirrors runner/refine.py. The two sides must agree on what they accept, or a
// runner-valid answer is rejected here and every lift silently loses its words.
const MAX_DESCRIPTION_SENTENCES = 2;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_SUMMARY_CHARS = 8_000;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/;

const DETERMINISTIC = "the graph is the reader's deterministic result";

/**
 * What the model reads: ids, kinds, files and relationships, with routes counted and
 * sampled — the whole skeleton of a large repo would spend the window on route
 * tables, and the model needs to know what a server is for, not every path it serves.
 */
export function skeletonSummary(skeleton: Skeleton): Record<string, unknown> {
  return {
    clients: skeleton.clients.map((c) => ({ id: c.id, path: c.path, calls: c.calls })),
    servers: skeleton.servers.map((s) => ({
      id: s.id,
      path: s.path,
      globalPrefix: s.globalPrefix,
      routeCount: s.routes.length,
      routes: s.routes.slice(0, ROUTE_SAMPLE).map((r) => `${r.method} ${r.path}`),
      exposes: s.exposes,
    })),
    services: skeleton.services.map((s) => ({
      id: s.id,
      server: s.server,
      moduleClass: s.moduleClass,
      // What makes a service product rather than plumbing, said plainly: the model is
      // told it may not file a service that serves routes or runs agents under
      // infrastructure, and both sides drop such a call (protectedServices).
      routes: routesServedBy(skeleton, s.id),
      root: s.root ?? false,
      files: [
        ...new Set([s.source.file, ...s.controllers.map((c) => c.file), ...s.providers.map((p) => p.file)]),
      ],
      controllers: s.controllers.map((c) => c.name),
      providers: s.providers.map((p) => p.name),
      dependsOn: s.dependsOn,
      agents: s.agents,
      infrastructure: s.infrastructure,
    })),
    agents: skeleton.agents.map((a) => ({ id: a.id, files: a.files, tools: a.tools.map((t) => t.name) })),
    processes: skeleton.processes.map((p) => ({ id: p.id, schedule: p.schedule, calls: p.calls })),
    unresolved: skeleton.unresolved.length,
    frameworks: skeleton.frameworks,
  };
}

/** How many routes a service's controllers serve, across every deployment. */
function routesServedBy(skeleton: Skeleton, serviceId: string): number {
  const service = skeleton.services.find((s) => s.id === serviceId);
  if (!service) return 0;
  const controllers = new Set(service.controllers.map((c) => `${c.file}#${c.name}`));
  const seen = new Set<string>();
  for (const server of skeleton.servers)
    for (const r of server.routes) if (controllers.has(`${r.source.file}#${r.controller}`)) seen.add(`${r.method} ${r.path}`);
  return seen.size;
}

/**
 * Services the model may not call infrastructure: one that serves routes, runs
 * agents, or is a deployment's root is what the product does, and filing it under
 * plumbing takes it — and every agent it runs — off the canvas. The reader's own
 * classification stands either way; this only limits what the model adds.
 */
export function protectedServices(skeleton: Skeleton): Set<string> {
  return new Set(
    skeleton.services.filter((s) => s.agents.length > 0 || s.root || routesServedBy(skeleton, s.id) > 0).map((s) => s.id),
  );
}

/**
 * Prose as the model meant it. A summary sometimes arrives JSON-encoded — wrapped in
 * quotes, its newlines written as backslash-n — and landing that verbatim puts one
 * 3 KB line of escapes into architecture.md. A quoted string that parses as JSON is
 * decoded; literal "\n" in text with no real newlines becomes a newline.
 */
export function plainText(text: string): string {
  let out = text.trim();
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(out);
      if (typeof decoded === 'string') out = decoded.trim();
    } catch {
      out = out.slice(1, -1).trim();
    }
  }
  // Escapes left in text that has no real line breaks are an encoding, not prose.
  if (!out.includes('\n') && out.includes('\\n')) {
    out = out.replace(/\\n/g, '\n').replace(/\\t/g, '  ').replace(/\\"/g, '"').trim();
  }
  return out;
}

/** Every entity id in the skeleton, with whether some service carries it. */
function entityIds(skeleton: Skeleton): { ids: Set<string>; services: Set<string> } {
  const ids = new Set<string>();
  for (const list of [skeleton.clients, skeleton.servers, skeleton.services, skeleton.agents, skeleton.processes]) {
    for (const entity of list) ids.add(entity.id);
  }
  return { ids, services: new Set(skeleton.services.map((s) => s.id)) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The runner's refinement held to the same rules the runner holds it to — strictly:
 * ids after renames everywhere but the renames themselves, since the runner already
 * normalizes. Returns the issues; an empty list means the answer is safe to apply.
 *
 * Two things are dropped rather than refused, and listed in `dropped`: an
 * infrastructure call on a protected service (protectedServices — the reader's
 * product class stands), and, in `lenient` mode, any entry that no longer fits the
 * skeleton. Lenient is for an answer recorded on an earlier lift and reused now: a
 * service that has since gone should cost its own entries, not every word the model
 * wrote about the rest.
 */
export function validateRefinement(
  value: unknown,
  skeleton: Skeleton,
  opts: { lenient?: boolean } = {},
): { refinement: Refinement | null; issues: string[]; dropped: string[] } {
  if (!isRecord(value)) return { refinement: null, issues: ['the refinement is not an object'], dropped: [] };
  const strict: string[] = [];
  const dropped: string[] = [];
  // A per-entry problem: refused in strict mode, skipped in lenient mode.
  const entry = (issue: string) => (opts.lenient ? dropped : strict).push(issue);
  const { ids, services } = entityIds(skeleton);
  const guarded = protectedServices(skeleton);

  const renames: Record<string, string> = {};
  if (!isRecord(value['renames'])) entry('renames is not an object');
  else {
    for (const [from, to] of Object.entries(value['renames'])) {
      if (!ids.has(from)) entry(`renames: "${from}" is not an entity in the skeleton`);
      else if (typeof to !== 'string' || !ID_PATTERN.test(to)) entry(`renames: "${String(to)}" is not a valid id`);
      else if (to !== from) renames[from] = to;
    }
  }

  // One-to-one, as on the runner: no new id lands on a remaining id or on another
  // rename's new id. Otherwise two entities merge, which the model may never do.
  // Lenient mode drops the later rename of a clashing pair and keeps the rest.
  const final = new Map<string, string>();
  for (const id of [...ids].sort()) {
    let target = renames[id] ?? id;
    const prior = final.get(target);
    if (prior !== undefined) {
      entry(`renames: "${prior}" and "${id}" would both be called "${target}"`);
      if (opts.lenient && renames[id]) {
        delete renames[id];
        target = id;
      }
    }
    if (!final.has(target)) final.set(target, id);
  }

  const infrastructure: string[] = [];
  if (!Array.isArray(value['infrastructure'])) entry('infrastructure is not a list');
  else {
    for (const id of value['infrastructure']) {
      const original = typeof id === 'string' ? final.get(id) : undefined;
      if (original === undefined) entry(`infrastructure: "${String(id)}" is not an entity in the skeleton`);
      else if (!services.has(original)) entry(`infrastructure: "${id}" is not a service`);
      else if (guarded.has(original)) dropped.push(`infrastructure: "${id}" serves routes or runs agents, so it stays on the canvas`);
      else if (!infrastructure.includes(id as string)) infrastructure.push(id as string);
    }
  }

  const descriptions: Record<string, string> = {};
  if (!isRecord(value['descriptions'])) entry('descriptions is not an object');
  else {
    for (const [id, text] of Object.entries(value['descriptions'])) {
      if (!final.has(id)) entry(`descriptions: "${id}" is not an entity in the skeleton`);
      else if (typeof text !== 'string' || !text.trim()) entry(`descriptions: "${id}" is empty`);
      else {
        const trimmed = plainText(text);
        const sentences = trimmed.split(SENTENCE_BREAK).filter(Boolean).length;
        if (trimmed.includes('\n') || trimmed.length > MAX_DESCRIPTION_CHARS || sentences > MAX_DESCRIPTION_SENTENCES) {
          entry(`descriptions: "${id}" is not one or two sentences`);
        } else descriptions[id] = trimmed;
      }
    }
  }

  // The summary is the one field with no partial form: without it the answer is not
  // one, in either mode.
  const raw = value['summary'];
  const summary = typeof raw === 'string' ? plainText(raw) : '';
  if (!summary) strict.push('summary is empty');
  else if (summary.length > MAX_SUMMARY_CHARS) strict.push('summary is too long');

  if (strict.length) return { refinement: null, issues: strict, dropped };
  return { refinement: { renames, infrastructure, descriptions, summary }, issues: [], dropped };
}

/**
 * The skeleton with every rename applied wherever an id is said — the entity's own
 * id and every reference to it (calls, exposes, server, dependsOn, agents) — and the
 * refinement's infrastructure marked. One map, applied to every id field, is what
 * keeps the rename consistent: an id shared by two kinds renames in both.
 */
export function applyRefinement(skeleton: Skeleton, refinement: Refinement): Skeleton {
  const r = (id: string) => refinement.renames[id] ?? id;
  const rs = (ids: string[]) => ids.map(r);
  const infrastructure = new Set(refinement.infrastructure);
  return {
    ...skeleton,
    clients: skeleton.clients.map((c) => ({ ...c, id: r(c.id), calls: rs(c.calls) })),
    servers: skeleton.servers.map((s) => ({ ...s, id: r(s.id), exposes: rs(s.exposes) })),
    services: skeleton.services.map((s) => ({
      ...s,
      id: r(s.id),
      server: r(s.server),
      dependsOn: rs(s.dependsOn),
      agents: rs(s.agents),
      ...(s.dispatchesTo ? { dispatchesTo: rs(s.dispatchesTo) } : {}),
      ...(s.agentsVia
        ? { agentsVia: Object.fromEntries(Object.entries(s.agentsVia).map(([a, callers]) => [r(a), rs(callers)])) }
        : {}),
      // The reader's own classification stands; the model may only add to it.
      infrastructure: s.infrastructure || infrastructure.has(r(s.id)),
    })),
    agents: skeleton.agents.map((a) => ({ ...a, id: r(a.id) })),
    processes: skeleton.processes.map((p) => ({ ...p, id: r(p.id), calls: rs(p.calls) })),
  };
}

/** A runner failure in words: RunnerError's body carries the runner's own reason. */
function failureReason(error: unknown): string {
  const body = (error as { body?: unknown }).body;
  if (isRecord(body)) {
    const issues = Array.isArray(body['issues']) ? body['issues'].filter((i) => typeof i === 'string') : [];
    if (issues.length) return `its answer failed validation (${issues.slice(0, 3).join('; ')})`;
    for (const key of ['message', 'error']) {
      if (typeof body[key] === 'string') return body[key] as string;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function refineSkeleton(
  skeleton: Skeleton,
  docs: Record<string, string>,
  ask: RefineAsk | undefined,
): Promise<{ skeleton: Skeleton; refinement: Refinement | null; note: string | null }> {
  const plain = (why: string) => ({
    skeleton,
    refinement: null,
    note: `The model pass was skipped: ${why}; ${DETERMINISTIC}.`,
  });
  if (!ask) return plain('no runner is configured');

  let answer: Record<string, unknown>;
  try {
    answer = await ask({ skeleton: skeletonSummary(skeleton), docs });
  } catch (error) {
    return plain(`the runner failed — ${failureReason(error)}`);
  }

  const { refinement, issues, dropped } = validateRefinement(answer['refinement'], skeleton);
  if (!refinement) return plain(`the model's answer was refused (${issues.slice(0, 3).join('; ')})`);

  const cut = Array.isArray(answer['docsCut']) ? answer['docsCut'].filter((p) => typeof p === 'string') : [];
  const notes = [
    cut.length ? `The model did not read these docs, for size: ${cut.join(', ')}.` : null,
    dropped.length ? `Part of the model's answer was set aside: ${dropped.slice(0, 3).join('; ')}.` : null,
  ].filter((n): n is string => n !== null);
  return {
    skeleton: applyRefinement(skeleton, refinement),
    refinement,
    note: notes.length ? notes.join(' ') : null,
  };
}
