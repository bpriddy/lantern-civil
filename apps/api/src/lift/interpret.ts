import { createHash } from 'node:crypto';
import { JsonText } from '../http/transpile-routes.js';
import type { AnalyzeAsk, AreaMemo } from './analysts.js';
import type { Facts } from './facts.js';
import type { FileMap, Skeleton } from './skeleton.js';

/**
 * Interpretation (docs/interpretation.md): how an application thinks (flow) and what it
 * is built on (architecture), drawn by agents and checked twice before Civil writes a
 * line of it. This side decides what is asked, never trusts what comes back, and does
 * the weighing; the runner (runner/interpret.py) does the model work.
 *
 * - Flow: an analyst per capability (the reader's domains, containment.ts) traces its
 *   paths from triggers to outcomes; a synthesizer draws the overview from those flows.
 * - Architecture: an analyst per angle (stack, data and deployment, auth and security,
 *   the AI subsystem) from the fact sheet (facts.ts) and the code; a synthesizer
 *   merges them into one overview, each angle a diagram to step into.
 * - Every item is checked mechanically (its evidence is in the code) and by a verifier
 *   shown it without evidence. A refuted item is not drawn; an item with neither sound
 *   evidence nor a verifier's support is not drawn either, except an actor, an output
 *   or a door, which name things outside the code.
 *
 * Optional, like every model stage: with no runner, or a failure, there is no reading
 * and the rest of the lift is unchanged.
 */

export type DiagramShape = 'flow' | 'architecture';

export interface ReadNode {
  id: string;
  kind: string;
  name: string;
  summary?: string;
  /** Skeleton entity ids; the writer maps them to the composition's ids. */
  realizedBy: string[];
  evidence: string[];
  decisions: { statement: string; why?: string; source?: 'code' | 'docs'; evidence: string[] }[];
  ref?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ReadEdge {
  from: string;
  to: string;
  kind: string;
  label?: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface ReadDiagram {
  id: string;
  name: string;
  description?: string;
  nodes: ReadNode[];
  edges: ReadEdge[];
}

export interface Reading {
  shape: DiagramShape;
  entry: string;
  diagrams: ReadDiagram[];
}

export interface InterpretReport {
  tasks: number;
  cached: number;
  /** Items the weighing did not draw, in words. */
  dropped: number;
  note: string | null;
}

interface Task {
  id: string;
  shape: DiagramShape;
  role: 'analyst' | 'synth';
  title: string;
  description?: string;
  focus?: string;
  paths?: string[];
  parts?: { id: string; kind: string }[];
  facts?: Facts;
  inputs?: unknown[];
}

/** The angles an architecture is read from, in the order its overview lists them. */
export const ANGLES: { id: string; title: string; focus: string }[] = [
  { id: 'stack', title: 'Stack and structure', focus: 'The frontend and the backend: their frameworks, their structure (modules, layers, roles, deployables), and how they talk to each other.' },
  { id: 'data', title: 'Data and deployment', focus: 'Where state lives, how work waits, where the application runs, and how it ships: databases, storage, queues, hosting, infrastructure as code, CI.' },
  { id: 'security', title: 'Auth and security', focus: 'The auth model and the security model: sign-in, sessions, roles, allowlists, secrets, encryption, isolation between parts, rate limits, origin and CSRF checks.' },
  { id: 'ai', title: 'AI subsystem', focus: 'How the application uses models: providers, the gateway, agents, prompts, tools, guards, evaluation, and cost controls.' },
];

const kebab = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * A diagram id from a capability's name: a valid id (it starts with a letter, at most
 * 64 characters, room left for a suffix) not yet taken. A name with nothing usable in
 * it ("注文") becomes "flow"; a clash takes "-2", "-3"….
 */
export function diagramId(name: string, taken: Set<string>): string {
  let base = kebab(name).slice(0, 56).replace(/-+$/, '') || 'flow';
  if (!/^[a-z]/.test(base)) base = `f-${base}`.slice(0, 56);
  let id = base;
  for (let n = 2; taken.has(id) && n < 10_000; n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** The parts the analysts are told about: what the reader drew, by id and kind. */
function partsOf(skeleton: Skeleton): { id: string; kind: string }[] {
  return [
    ...skeleton.clients.map((c) => ({ id: c.id, kind: 'client' })),
    ...skeleton.servers.map((s) => ({ id: s.id, kind: 'server' })),
    ...skeleton.services.filter((s) => !s.infrastructure).map((s) => ({ id: s.id, kind: 'service' })),
    ...skeleton.agents.map((a) => ({ id: a.id, kind: 'agent' })),
    ...skeleton.processes.map((p) => ({ id: p.id, kind: 'process' })),
    ...(skeleton.datastores ?? []).map((d) => ({ id: d.id, kind: 'datastore' })),
  ];
}

/** One flow task per capability: the reader's domains, else each product service. */
export function flowTasks(skeleton: Skeleton): Task[] {
  const services = new Map(skeleton.services.map((s) => [s.id, s]));
  const kinds = new Map(partsOf(skeleton).map((p) => [p.id, p.kind]));
  const pathsOf = (members: string[], surfaces: string[]) =>
    [
      ...new Set([
        ...members.flatMap((m) => {
          const s = services.get(m);
          if (!s) return [];
          return s.directory ? [`${s.directory}/`] : [s.source.file, ...(s.files ?? [])];
        }),
        ...surfaces.map((x) => `${x}/`),
      ]),
    ].sort();
  const domains = (skeleton.domains ?? []).filter((d) => d.members.some((m) => services.has(m)));
  const units = domains.length
    ? domains.map((d) => ({ name: d.name, description: d.description, members: d.members, surfaces: d.surfaces }))
    : skeleton.services.filter((s) => !s.infrastructure).map((s) => ({ name: s.id, description: undefined, members: [s.id], surfaces: [] as string[] }));
  const taken = new Set<string>(['overview', ...ANGLES.map((a) => a.id)]);
  return units.map((u) => {
    const id = diagramId(u.name, taken);
    return {
      id,
      shape: 'flow' as const,
      role: 'analyst' as const,
      title: u.name,
      ...(u.description ? { description: u.description } : {}),
      paths: pathsOf(u.members, u.surfaces),
      parts: u.members.map((m) => ({ id: m, kind: kinds.get(m) ?? 'service' })),
    };
  });
}

export function architectureTasks(skeleton: Skeleton, facts: Facts): Task[] {
  const parts = partsOf(skeleton);
  return ANGLES.map((a) => ({ id: a.id, shape: 'architecture' as const, role: 'analyst' as const, title: a.title, focus: a.focus, parts, facts }));
}

// ---------------------------------------------------------------------------------
// Weighing: what the code and the verifier support is drawn; nothing on the model's
// word alone.
// ---------------------------------------------------------------------------------

interface RawEvidence {
  file: string;
  line?: number;
  quote?: string;
}

/** The evidence that holds: the file is the repository's, the line is in it, the quote is near it. */
function sound(evidence: unknown, files: FileMap, listed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const ev of Array.isArray(evidence) ? (evidence as RawEvidence[]) : []) {
    if (!ev || typeof ev.file !== 'string' || !listed.has(ev.file)) continue;
    const content = files[ev.file];
    if (content === undefined) {
      out.push(ev.file); // listed but not loaded: unverifiable, not wrong — cited without a line
      continue;
    }
    const lines = content.split('\n');
    if (ev.line !== undefined && (ev.line < 1 || ev.line > lines.length)) continue;
    if (ev.quote) {
      const window = ev.line === undefined ? content : lines.slice(Math.max(0, ev.line - 4), ev.line + 3).join('\n');
      const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
      if (!squash(window).includes(squash(ev.quote))) continue;
    }
    out.push(ev.line ? `${ev.file}:${ev.line}` : ev.file);
  }
  return [...new Set(out)];
}

const OUTSIDE_THE_CODE = new Set(['actor', 'output', 'flow']);

/**
 * Which part a file belongs to, when exactly one does: a service by its directory or
 * its files, an agent by its files, a process or a store by the file that declares it.
 * A file several parts share (a Terraform file of many jobs) belongs to none.
 */
export function partOwner(skeleton: Skeleton): (file: string) => string | undefined {
  const exact = new Map<string, Set<string>>();
  const own = (file: string, id: string) => exact.set(file, (exact.get(file) ?? new Set()).add(id));
  const dirs: [string, string][] = [];
  for (const s of skeleton.services) {
    if (s.infrastructure) continue;
    if (s.directory) dirs.push([`${s.directory}/`, s.id]);
    for (const f of [s.source.file, ...(s.files ?? []), ...s.controllers.map((c) => c.file), ...s.providers.map((x) => x.file)]) own(f, s.id);
  }
  for (const a of skeleton.agents) for (const f of [a.source.file, ...a.files]) own(f, a.id);
  for (const p of skeleton.processes) own(p.source.file, p.id);
  for (const d of skeleton.datastores ?? []) own(d.source.file, d.id);
  dirs.sort((a, b) => b[0].length - a[0].length);
  return (file) => {
    const owners = exact.get(file);
    if (owners?.size === 1) return [...owners][0];
    if (owners && owners.size > 1) return undefined;
    return dirs.find(([dir]) => file.startsWith(dir))?.[1];
  };
}

export function weigh(
  id: string,
  name: string,
  answer: Record<string, unknown>,
  files: FileMap,
  listed: ReadonlySet<string>,
  entities: ReadonlySet<string>,
  owner: (file: string) => string | undefined = () => undefined,
): { diagram: ReadDiagram; dropped: number } {
  const raw = (answer['diagram'] ?? {}) as { description?: string; nodes?: Record<string, unknown>[]; edges?: Record<string, unknown>[] };
  const verdicts = (answer['verdicts'] ?? {}) as Record<string, { verdict?: string }>;
  const said = (key: string) => verdicts[key]?.verdict;
  let dropped = 0;
  // The parts a node names, else the parts its sound evidence lies in: where the code
  // that shows it lives is what implements it.
  const realizedBy = (named: unknown, evidence: string[]): string[] => {
    const given = (Array.isArray(named) ? named : []).filter((p): p is string => typeof p === 'string' && entities.has(p));
    if (given.length) return [...new Set(given)];
    const found = evidence.map((e) => owner(e.replace(/:\d+$/, ''))).filter((p): p is string => !!p && entities.has(p));
    return [...new Set(found)].slice(0, 4);
  };
  const nodes: ReadNode[] = [];
  for (const n of raw.nodes ?? []) {
    const nid = String(n['id']);
    const kind = String(n['kind']);
    if (said(`node:${nid}`) === 'refute') {
      dropped += 1;
      continue;
    }
    const evidence = sound(n['evidence'], files, listed);
    const supported = said(`node:${nid}`) === 'support';
    if (!evidence.length && !supported && !OUTSIDE_THE_CODE.has(kind)) {
      dropped += 1;
      continue;
    }
    const decisions: ReadNode['decisions'] = [];
    ((n['decisions'] as Record<string, unknown>[] | undefined) ?? []).forEach((d, i) => {
      const verdict = said(`decision:${nid}#${i}`);
      const cited = sound(d['evidence'], files, listed);
      if (verdict === 'refute' || (!cited.length && verdict !== 'support')) {
        dropped += 1;
        return;
      }
      decisions.push({
        statement: String(d['statement']),
        ...(typeof d['why'] === 'string' ? { why: d['why'] } : {}),
        ...(d['source'] === 'code' || d['source'] === 'docs' ? { source: d['source'] } : {}),
        evidence: cited,
      });
    });
    nodes.push({
      id: nid,
      kind,
      name: String(n['name']),
      ...(typeof n['summary'] === 'string' ? { summary: n['summary'] } : {}),
      realizedBy: realizedBy(n['realizedBy'], evidence),
      evidence,
      decisions,
      ...(typeof n['ref'] === 'string' ? { ref: n['ref'] } : {}),
      confidence: evidence.length && supported ? 'high' : evidence.length ? 'medium' : 'low',
    });
  }
  const live = new Set(nodes.map((n) => n.id));
  const edges: ReadEdge[] = [];
  for (const e of raw.edges ?? []) {
    const [from, to, kind] = [String(e['from']), String(e['to']), String(e['kind'])];
    const verdict = said(`edge:${from}->${to}:${kind}`);
    if (!live.has(from) || !live.has(to) || verdict === 'refute') {
      dropped += 1;
      continue;
    }
    edges.push({
      from,
      to,
      kind,
      ...(typeof e['label'] === 'string' ? { label: e['label'] } : {}),
      evidence: sound(e['evidence'], files, listed),
      confidence: verdict === 'support' ? 'high' : 'medium',
    });
  }
  return {
    diagram: { id, name, ...(typeof raw.description === 'string' ? { description: raw.description } : {}), nodes, edges },
    dropped,
  };
}

/** What a synthesizer is shown of a diagram: its roles or pieces, without evidence. */
function compact(d: ReadDiagram, shape: DiagramShape): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    nodes: d.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      ...(n.summary ? { summary: n.summary } : {}),
      ...(shape === 'architecture' && n.decisions.length ? { decisions: n.decisions.map((x) => x.statement) } : {}),
    })),
    edges: d.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
  };
}

// ---------------------------------------------------------------------------------
// Asking.
// ---------------------------------------------------------------------------------

export interface InterpretOptions {
  memo?: AreaMemo;
  version?: string;
  concurrency?: number;
  progress?: (done: number, total: number) => void;
}

/** Asked at once: beside the area analysts, within the runner's capacity. */
export const INTERPRET_CONCURRENCY = 6;

export async function interpretApplication(
  ask: AnalyzeAsk | undefined,
  input: { skeleton: Skeleton; files: FileMap; listed: readonly string[]; product: readonly string[]; facts: Facts },
  opts: InterpretOptions = {},
): Promise<{ flow?: Reading; architecture?: Reading; report: InterpretReport }> {
  const report: InterpretReport = { tasks: 0, cached: 0, dropped: 0, note: null };
  if (!ask) return { report: { ...report, note: 'Flow and architecture were not read: no runner is configured.' } };
  const { skeleton, files, listed, product, facts } = input;
  const listedSet = new Set(listed);
  const entities = new Set(partsOf(skeleton).map((p) => p.id));
  const owner = partOwner(skeleton);
  const productSet = new Set(product);
  const sent = Object.fromEntries(Object.entries(files).filter(([p]) => productSet.has(p)));
  // The repository is serialised once for every request (see JsonText).
  const shared = JSON.stringify({ files: sent, index: product }).slice(0, -1);
  // What any task may read, once, so a memo goes stale when the code does.
  const repoDigest = createHash('sha256');
  for (const p of Object.keys(sent).sort()) repoDigest.update(p).update('\0').update(sent[p]!).update('\0');
  const digest = repoDigest.digest('hex');

  const failures: string[] = [];
  const flowAnalysts = flowTasks(skeleton);
  const archAnalysts = architectureTasks(skeleton, facts);
  // Both overviews are counted from the start; one that has nothing to work from is
  // counted done when it is skipped, so the count always reaches its total.
  const total = flowAnalysts.length + archAnalysts.length + 2;
  let done = 0;
  opts.progress?.(0, total);

  const run = async (task: Task): Promise<ReadDiagram | undefined> => {
    report.tasks += 1;
    const area = `interpret:${task.shape}:${task.id}`;
    const fingerprint = opts.version
      ? `sha256:${createHash('sha256').update(opts.version).update('\0interpret\0').update(JSON.stringify(task)).update(digest).digest('hex')}`
      : undefined;
    // The memo is a cache: an error reading or writing it is a miss, never a failed lift.
    const recall = async (get: () => Promise<unknown> | undefined) => {
      try {
        return (await get()) as Record<string, unknown> | undefined;
      } catch {
        return undefined;
      }
    };
    /** An answer worth keeping: the runner drew something within its budget. */
    const usable = (a: Record<string, unknown> | undefined) =>
      !!a && !a['error'] && ((a['diagram'] as { nodes?: unknown[] } | undefined)?.nodes?.length ?? 0) > 0;
    let answer = fingerprint ? await recall(() => opts.memo?.get(fingerprint)) : undefined;
    if (usable(answer)) report.cached += 1;
    else {
      let why = '';
      try {
        answer = await ask(new JsonText(`${shared},${JSON.stringify({ mode: 'interpret', task }).slice(1)}`));
        if (!usable(answer)) why = String(answer?.['error'] ?? 'nothing was drawn');
      } catch (error) {
        why = (error as Error).message.slice(0, 160);
      }
      if (why) {
        // A failure is not remembered: the next lift asks again. Meanwhile this task's
        // last good answer stands, said in the note, as an area's does.
        const last = await recall(() => opts.memo?.latest(area));
        answer = usable(last) ? last : undefined;
        failures.push(`${task.shape} ${task.id} (${why}${answer ? '; the last reading was kept' : ''})`);
      } else if (fingerprint) {
        await recall(() => opts.memo?.put(fingerprint, area, answer as never));
      }
    }
    done += 1;
    opts.progress?.(done, total);
    if (!answer) return undefined;
    const { diagram, dropped } = weigh(task.id, task.title, answer, files, listedSet, entities, owner);
    report.dropped += dropped;
    return diagram.nodes.length ? diagram : undefined;
  };

  const pool = async <T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> => {
    const out: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(opts.concurrency ?? INTERPRET_CONCURRENCY, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
    });
    await Promise.all(workers);
    return out;
  };

  const analysed = await pool([...flowAnalysts, ...archAnalysts], run);
  const flows = analysed.slice(0, flowAnalysts.length).filter((d): d is ReadDiagram => !!d && d.nodes.length > 0);
  const angles = analysed.slice(flowAnalysts.length).filter((d): d is ReadDiagram => !!d && d.nodes.length > 0);

  // The overviews, from what the analysts drew.
  const [flowOverview, archOverview] = await pool(
    [
      flows.length > 1
        ? ({ id: 'overview', shape: 'flow', role: 'synth', title: 'How the application works', inputs: flows.map((f) => compact(f, 'flow')) } as Task)
        : undefined,
      angles.length
        ? ({ id: 'overview', shape: 'architecture', role: 'synth', title: 'What the application is built on', inputs: angles.map((a) => compact(a, 'architecture')) } as Task)
        : undefined,
    ],
    async (t) => {
      if (t) return run(t);
      done += 1;
      opts.progress?.(done, total);
      return undefined;
    },
  );

  // Without the model's overview, one drawn from what the analysts drew — never a
  // canvas that opens on whichever capability sorts first.
  const flowFront = flowOverview ?? (flows.length > 1 ? flowIndex(flows) : undefined);
  const archFront = archOverview ?? (angles.length > 1 ? mergedAngles(angles) : undefined);

  if (failures.length) report.note = `${failures.length} of ${report.tasks} interpretation tasks fell short: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '; ...' : ''}.`;
  const flowReading: Reading | undefined = flows.length
    ? { shape: 'flow', entry: flowFront ? 'overview' : flows[0]!.id, diagrams: [...(flowFront ? [{ ...flowFront, id: 'overview', name: flowOverview ? 'How the application works' : flowFront.name }] : []), ...flows] }
    : undefined;
  const archReading: Reading | undefined = angles.length
    ? { shape: 'architecture', entry: archFront ? 'overview' : angles[0]!.id, diagrams: [...(archFront ? [{ ...archFront, id: 'overview', name: archOverview ? 'What the application is built on' : archFront.name }] : []), ...angles] }
    : undefined;
  // A door opens only a diagram that was drawn.
  for (const reading of [flowReading, archReading]) {
    if (!reading) continue;
    const ids = new Set(reading.diagrams.map((d) => d.id));
    for (const d of reading.diagrams) for (const n of d.nodes) if (n.ref && !ids.has(n.ref)) delete n.ref;
  }
  return { ...(flowReading ? { flow: flowReading } : {}), ...(archReading ? { architecture: archReading } : {}), report };
}

/**
 * The flow overview when the model's could not be drawn: every traced capability as a
 * door into its flow. It says how far it goes — which capabilities exist — and no
 * further: how they pass work to each other is the synthesizer's reading.
 */
export function flowIndex(flows: readonly ReadDiagram[]): ReadDiagram {
  const taken = new Set<string>();
  return {
    id: 'overview',
    name: 'Capabilities',
    description: 'The capabilities Civil traced, each a flow to step into. How they pass work to one another is drawn when the overview can be read.',
    nodes: flows.map((f) => ({
      id: diagramId(`${f.id}-flow`, taken),
      kind: 'flow',
      name: f.name,
      ...(f.description ? { summary: f.description } : {}),
      realizedBy: [...new Set(f.nodes.flatMap((n) => n.realizedBy))].slice(0, 8),
      evidence: [],
      decisions: [],
      ref: f.id,
      confidence: 'high' as const,
    })),
    edges: [],
  };
}

/**
 * The architecture overview when the model's could not be drawn: the angles merged, each
 * piece once (the first angle to draw it names it), its decisions gathered up to four, a
 * line wherever an angle drew one, and a door back to the angle it came from.
 */
export function mergedAngles(angles: readonly ReadDiagram[]): ReadDiagram {
  const nodes = new Map<string, ReadNode>();
  // The same piece drawn by two angles under two ids ("parse" and "parse-role") is
  // one piece when its name is the same: its first id names it, the other is mapped.
  const byName = new Map<string, string>();
  const alias = new Map<string, string>();
  const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const a of angles) {
    for (const n of a.nodes) {
      const known = nodes.has(n.id) ? n.id : byName.get(norm(n.name));
      if (known && known !== n.id) alias.set(`${a.id}:${n.id}`, known);
      const held = known ? nodes.get(known) : undefined;
      if (!held) byName.set(norm(n.name), n.id);
      if (!held) {
        nodes.set(n.id, { ...n, decisions: n.decisions.slice(0, 4), ref: a.id });
        continue;
      }
      const seen = new Set(held.decisions.map((d) => d.statement));
      held.decisions = [...held.decisions, ...n.decisions.filter((d) => !seen.has(d.statement))].slice(0, 4);
      held.realizedBy = [...new Set([...held.realizedBy, ...n.realizedBy])];
      held.evidence = [...new Set([...held.evidence, ...n.evidence])].slice(0, 5);
    }
  }
  const edges = new Map<string, ReadEdge>();
  for (const a of angles) {
    for (const e of a.edges) {
      const from = alias.get(`${a.id}:${e.from}`) ?? e.from;
      const to = alias.get(`${a.id}:${e.to}`) ?? e.to;
      if (from === to) continue;
      const key = `${from}->${to}:${e.kind}`;
      if (!edges.has(key)) edges.set(key, { ...e, from, to });
    }
  }
  return {
    id: 'overview',
    name: 'Built on',
    description: 'Every piece the angles drew, once, with its main decisions. Step into a piece for the angle that describes it.',
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}
