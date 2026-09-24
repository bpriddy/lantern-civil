import { parse } from 'yaml';
import { zComposition, zGraph, type IoNode } from '@civil/schema';
import { compositionPathFor } from './bundle.js';
import { discoverContracts, type Contract, type ContractRequest } from './contracts.js';
import type { ProjectSource } from './source.js';

/**
 * Boundary type-sync (docs/boundary-type-sync.md): keep the frontend's understanding
 * of the boundary from silently drifting from the backend's. The boundary schema is
 * the source of truth; this reads it and emits TypeScript types for the web client so
 * a schema change surfaces as a type error in the editor and at build.
 *
 * This is the honest, narrow value — propagating a fact, not imposing a style. The
 * types are generated DETERMINISTICALLY from the JSON Schema (never LLM-paraphrased):
 * drift-prevention is only as good as the types being faithful, and a faithful type
 * is a mechanical transform, the hardened-template end of the emitted-code contract.
 *
 * How call sites are WRITTEN follows first-class rule 1 — the repo's own convention.
 * Where no calling pattern exists yet (the per-surface seed case, docs/emitted-code.md)
 * this emits the most vanilla thing, thin typed fetch wrappers, as a disposable
 * default the first hand-written call supersedes. Reading an existing convention out
 * of civil/patterns.md and emitting into it is the next increment; v1 seeds.
 */

// Bump when the generated file's shape OR the signature format changes, so the memo
// (which folds the client signature into its hash) regenerates instead of replaying an
// older layout. Mirrors the runner's PROMPT_VERSION. v2: the signature gained explicit
// / separators (was a bare ''-join) — a deliberate, one-time re-emission
// for web-client projects, made intentional by this bump.
const CLIENT_VERSION = '2';

/** One exposed service, resolved to its request/response types. */
export interface Endpoint {
  /** The boundary route: POST /<name>, where name is the exposed node id. */
  name: string;
  /** The generated function name — the node id as an identifier. */
  fn: string;
  /** The PascalCase stem for this endpoint's Input/Output type names. */
  typeBase: string;
  /** The resolved input JSON Schema, or null when the boundary declares none. */
  inputSchema: unknown | null;
  /** The resolved output JSON Schema, or null when the boundary declares none. */
  outputSchema: unknown | null;
  /**
   * The resolved SSE progress-payload JSON Schema for a single typed `kind: progress`
   * out, or null. Types only: the emitted boundary server does not stream it yet
   * (docs/boundary-type-sync.md: "The progress channel").
   */
  progressSchema: unknown | null;
}

export interface BoundaryClientPlan {
  /** Repo-relative path of the generated client module. */
  clientPath: string;
  endpoints: Endpoint[];
}

const parseDoc = (source: ProjectSource, path: string): unknown => {
  const raw = source.read(path);
  if (raw === undefined) return undefined;
  try {
    return parse(raw);
  } catch {
    return undefined;
  }
};

const readSchema = (source: ProjectSource, path: string): unknown | null => {
  const raw = source.read(path);
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** node-id -> Identifier / TypeStem. `save-record` -> saveRecord / SaveRecord. */
const pascal = (id: string): string =>
  id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
const camel = (id: string): string => {
  const p = pascal(id);
  return p ? p[0]!.toLowerCase() + p.slice(1) : id;
};

/**
 * A not-yet-resolved request/response/progress type. A graph io names its schema by
 * path (`ref`, hydrated in one round); a composite of several io nodes names each
 * field's path (`object`); a discovered contract carries its schema inline. All three
 * collapse to a JSON Schema (or null) once the referenced schemas are read.
 */
type Resolvable =
  | { via: 'ref'; ref: string }
  | { via: 'object'; fields: { key: string; ref: string | null; required: boolean }[] }
  | { via: 'inline'; schema: unknown | null }
  | null;

/**
 * A graph endpoint's io in one direction, resolved into a plan. A single typed io maps
 * directly to its schema (v1's original behaviour); several synthesize an object — one
 * field per io node keyed `name ?? id`, or by id for all when those names collide, so
 * the type stays collision-free. A single untyped io stays null (unknown), as before.
 * Referenced schema paths are added to `refs` for the one hydration round.
 */
function planIo(nodes: IoNode[], refs: Set<string>): Resolvable {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) {
    const only = nodes[0]!;
    if (!only.schema) return null;
    refs.add(only.schema);
    return { via: 'ref', ref: only.schema };
  }
  const keys = nodes.map((n) => n.name ?? n.id);
  const collision = new Set(keys).size !== keys.length;
  const fields = nodes.map((n) => {
    if (n.schema) refs.add(n.schema);
    return { key: collision ? n.id : n.name ?? n.id, ref: n.schema ?? null, required: true };
  });
  return { via: 'object', fields };
}

/**
 * Fold several io nodes or contract params into one object type: a property per field
 * in declaration order, keyed as given. A field with no schema becomes `{}`, which
 * tsType degrades to `unknown` — faithful, never a guess. Only fields flagged required
 * land in `required`, and it is omitted entirely when none are, so tsType marks the
 * rest optional.
 */
function synthesizeObject(
  fields: { key: string; schema: unknown | null; required: boolean }[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.key] = f.schema ?? {};
    if (f.required) required.push(f.key);
  }
  return required.length
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

/**
 * A bare, unsubscripted Python container has a knowable JSON kind even when its element
 * type is not: `dict` is an object, the sequence types an array. Anything else with no
 * discovered schema stays unknown. (civil_runtime.discover already emits JSON Schema for
 * str/int/float/bool/bytes/None and for subscripted list/dict, so those never reach here.)
 */
const PY_BARE_TYPE_SCHEMA: Record<string, Record<string, unknown>> = {
  dict: { type: 'object' },
  list: { type: 'array' },
  tuple: { type: 'array' },
  set: { type: 'array' },
  frozenset: { type: 'array' },
};

/** A contract port's effective schema: its discovered one, else the bare-container map. */
const portSchema = (port: {
  type: string | null;
  schema: Record<string, unknown> | null;
}): unknown | null => port.schema ?? (port.type ? PY_BARE_TYPE_SCHEMA[port.type] ?? null : null);

/**
 * A contract's inputs folded into one request type: a single param maps directly to its
 * schema; several synthesize an object, each param's `required` driving its field.
 */
const contractInput = (contract: Contract): unknown | null => {
  const params = contract.inputs;
  if (params.length === 0) return null;
  if (params.length === 1) return portSchema(params[0]!);
  return synthesizeObject(
    params.map((p) => ({ key: p.name, schema: portSchema(p), required: p.required })),
  );
};

/**
 * The plan for a project's web boundary client, or null when there is nothing to
 * emit — no web client to emit into, or no api boundary to type against. Only the
 * `api` boundary is a web surface; `mcp` is an agent surface and emits nothing here.
 */
export async function planBoundaryClient(
  source: ProjectSource,
): Promise<BoundaryClientPlan | null> {
  const compositionPath = compositionPathFor(source);
  await source.ensure?.([compositionPath]);
  const composition = zComposition.safeParse(parseDoc(source, compositionPath));
  if (!composition.success) return null;
  const nodes = composition.data.spec.nodes;

  const web = nodes.find((n) => n.type === 'client' && n.client === 'web');
  if (!web || web.type !== 'client') return null;

  // Every service the api boundaries expose, in declaration order, deduped.
  const exposed: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'boundary' || node.boundary !== 'api') continue;
    for (const id of node.exposes) if (!exposed.includes(id)) exposed.push(id);
  }
  if (exposed.length === 0) return null;

  const services = new Map<string, (typeof nodes)[number]>();
  for (const node of nodes) if (node.type === 'service') services.set(node.id, node);

  // Gather the graph refs and function entrypoints first so a lazy (GitHub) source
  // hydrates them in one round before anything reads them.
  const graphRefs: string[] = [];
  const entrypoints: { id: string; file: string }[] = [];
  for (const id of exposed) {
    const svc = services.get(id);
    if (svc?.type !== 'service') continue;
    if ('graph' in svc.impl) graphRefs.push(svc.impl.graph);
    else if ('entrypoint' in svc.impl) entrypoints.push({ id, file: svc.impl.entrypoint });
  }
  await source.ensure?.([...graphRefs, ...entrypoints.map((e) => e.file)]);

  // A function-backed service declares no schema in the graph; recover its request and
  // response types from the source via contract discovery (contracts.ts), keyed exactly
  // like bundle.ts (`${compositionPath}:${nodeId}`). This degrades quietly — no Python
  // interpreter or a discovery failure leaves the endpoint unknown, never crashing the
  // plan, exactly as discoverContracts already does.
  const contractRequests: ContractRequest[] = [];
  for (const { id, file } of entrypoints) {
    const src = source.read(file);
    if (src === undefined) continue;
    contractRequests.push({ key: `${compositionPath}:${id}`, source: src });
  }
  const contracts = await discoverContracts(contractRequests);

  // Each endpoint's request/response/progress resolves in one of two shapes: a graph io
  // names a schema by path (hydrated in the round below), a discovered contract carries
  // its schema inline. Both collapse to a JSON Schema (or null) in the resolve pass.
  const endpoints: Endpoint[] = [];
  const schemaRefs = new Set<string>();
  const plans = new Map<Endpoint, { in: Resolvable; out: Resolvable; progress: Resolvable }>();

  for (const id of exposed) {
    const svc = services.get(id);
    const endpoint: Endpoint = {
      name: id,
      fn: camel(id),
      typeBase: pascal(id),
      inputSchema: null,
      outputSchema: null,
      progressSchema: null,
    };
    const plan: { in: Resolvable; out: Resolvable; progress: Resolvable } = {
      in: null,
      out: null,
      progress: null,
    };

    if (svc?.type === 'service' && 'graph' in svc.impl) {
      // A graph-backed service carries its I/O in the graph's io nodes. A single typed
      // in/out maps directly; several synthesize an object rather than stay unknown.
      const graph = zGraph.safeParse(parseDoc(source, svc.impl.graph));
      if (graph.success) {
        const io = graph.data.spec.nodes.filter(
          (n): n is Extract<typeof n, { type: 'io' }> => n.type === 'io',
        );
        const ins = io.filter((n) => n.direction === 'in');
        // A progress out is an SSE channel, not the response body — excluded here.
        const outs = io.filter((n) => n.direction === 'out' && n.kind !== 'progress');
        // Count ALL progress outs, not just schema-bearing ones: several progress
        // channels is a composite v1 does not invent, so it stays null even if only
        // one carries a schema (docs/boundary-type-sync.md: "The progress channel").
        const progress = io.filter((n) => n.direction === 'out' && n.kind === 'progress');
        plan.in = planIo(ins, schemaRefs);
        plan.out = planIo(outs, schemaRefs);
        // A single typed progress out becomes the SSE payload type; zero, several, or
        // schema-less stays null.
        if (progress.length === 1 && progress[0]!.schema) {
          schemaRefs.add(progress[0]!.schema);
          plan.progress = { via: 'ref', ref: progress[0]!.schema };
        }
      }
    } else if (svc?.type === 'service' && 'entrypoint' in svc.impl) {
      // A function-backed service recovers its types from its discovered contract; if
      // discovery yielded nothing (or an error), the endpoint stays unknown.
      const result = contracts.get(`${compositionPath}:${id}`);
      if (result && !('error' in result)) {
        plan.in = { via: 'inline', schema: contractInput(result) };
        plan.out = { via: 'inline', schema: portSchema(result.output) };
      }
    }

    endpoints.push(endpoint);
    plans.set(endpoint, plan);
  }

  // Read the referenced schemas (one hydration round), then resolve every endpoint's
  // request, response, and progress plan to its final JSON Schema.
  await source.ensure?.([...schemaRefs]);
  const resolved = new Map<string, unknown | null>();
  for (const ref of schemaRefs) resolved.set(ref, readSchema(source, ref));
  const finalize = (r: Resolvable): unknown | null => {
    if (r === null) return null;
    if (r.via === 'inline') return r.schema;
    if (r.via === 'ref') return resolved.get(r.ref) ?? null;
    return synthesizeObject(
      r.fields.map((f) => ({
        key: f.key,
        schema: f.ref === null ? null : resolved.get(f.ref) ?? null,
        required: f.required,
      })),
    );
  };
  for (const ep of endpoints) {
    const plan = plans.get(ep)!;
    ep.inputSchema = finalize(plan.in);
    ep.outputSchema = finalize(plan.out);
    ep.progressSchema = finalize(plan.progress);
  }

  return { clientPath: clientPathFor(source, web.path), endpoints };
}

/**
 * Where the generated client lands: under the web client's source dir, in a civil/
 * subfolder that marks it Civil-owned (kept out of the human's hand-written space, so
 * a hand edit is never silently clobbered by regeneration). Prefers <path>/src when it
 * exists — the conventional layout — and falls back to <path> for a flat client.
 */
function clientPathFor(source: ProjectSource, webPath: string): string {
  const base = webPath.replace(/\/+$/, '');
  const hasSrc = source.list().some((p) => p.startsWith(`${base}/src/`));
  return hasSrc ? `${base}/src/civil/client.ts` : `${base}/civil/client.ts`;
}

/**
 * A deterministic fingerprint of everything that decides the generated bytes — the
 * output path, each endpoint's names, and its resolved schemas. Folded into the
 * transpile memo hash so a schema edit (or a CLIENT_VERSION bump) regenerates the
 * client, and an unchanged boundary replays it. A project with no web client produces
 * no plan and so contributes nothing to the hash — its emission is untouched.
 */
export function clientSignature(plan: BoundaryClientPlan): string {
  const stable = (v: unknown): string => (v === null || v === undefined ? '' : JSON.stringify(v));
  // Unambiguous separators: control chars cannot appear in ids or JSON, so no two
  // distinct plans can collide on the joined string. (\u0001/\u0002 replace the original
  // bare ''-join, a deliberate change made intentional by the CLIENT_VERSION bump.)
  const FIELD = '\u0001';
  const PART = '\u0002';
  const parts = [`v${CLIENT_VERSION}`, plan.clientPath];
  for (const ep of plan.endpoints) {
    const fields = [ep.name, ep.fn, ep.typeBase, stable(ep.inputSchema), stable(ep.outputSchema)];
    // Append the progress schema ONLY when present, so adding progress typing to one
    // endpoint never shifts the fingerprint of endpoints that have none (the join uses
    // a real separator, so an empty trailing field would still move the hash).
    if (ep.progressSchema !== null) fields.push(stable(ep.progressSchema));
    parts.push(fields.join(FIELD));
  }
  return parts.join(PART);
}

// ---- JSON Schema (2020-12 subset) -> TypeScript type expression -------------------

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propKey = (k: string): string => (IDENT.test(k) ? k : quote(k));

const literal = (v: unknown): string => {
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  return 'unknown';
};

const unique = (items: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) if (!seen.has(i)) (seen.add(i), out.push(i));
  return out;
};

/**
 * A JSON Schema rendered as a TypeScript type. The subset the boundary schemas use —
 * objects, arrays, primitives, enums, const, nullable unions — is rendered exactly;
 * anything unrecognized degrades to `unknown`, because a faithful client never guesses
 * a shape it cannot read. Object properties keep the schema's declaration order, so
 * the emission is diff-stable.
 */
export function tsType(schema: unknown, indent = 0): string {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return 'unknown';
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s['enum'])) {
    const parts = unique((s['enum'] as unknown[]).map(literal));
    return parts.length ? parts.join(' | ') : 'never';
  }
  if ('const' in s) return literal(s['const']);

  const type = s['type'];
  if (Array.isArray(type)) {
    return unique(type.map((t) => ofType(String(t), s, indent))).join(' | ') || 'unknown';
  }
  if (typeof type === 'string') return ofType(type, s, indent);

  if (s['properties'] !== undefined || s['required'] !== undefined) return objectType(s, indent);
  return 'unknown';
}

function ofType(type: string, s: Record<string, unknown>, indent: number): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const inner = s['items'] === undefined ? 'unknown' : tsType(s['items'], indent);
      // A union or a multi-line object inside an array reads clearest wrapped.
      return inner.includes('|') || inner.startsWith('{') ? `Array<${inner}>` : `${inner}[]`;
    }
    case 'object':
      return objectType(s, indent);
    default:
      return 'unknown';
  }
}

function objectType(s: Record<string, unknown>, indent: number): string {
  const propsVal = s['properties'];
  const props =
    propsVal && typeof propsVal === 'object' && !Array.isArray(propsVal)
      ? (propsVal as Record<string, unknown>)
      : undefined;
  const required = new Set(Array.isArray(s['required']) ? (s['required'] as unknown[]) : []);

  if (!props || Object.keys(props).length === 0) {
    const ap = s['additionalProperties'];
    if (ap && typeof ap === 'object') return `Record<string, ${tsType(ap, indent)}>`;
    if (ap === false) return 'Record<string, never>';
    return 'Record<string, unknown>';
  }

  const pad = '  '.repeat(indent + 1);
  const close = '  '.repeat(indent);
  const lines: string[] = [];
  for (const [key, sub] of Object.entries(props)) {
    const optional = required.has(key) ? '' : '?';
    lines.push(`${pad}${propKey(key)}${optional}: ${tsType(sub, indent + 1)};`);
  }
  return `{\n${lines.join('\n')}\n${close}}`;
}

// ---- Emission --------------------------------------------------------------------

function renderType(name: string, schema: unknown | null): string {
  if (schema === null || schema === undefined) {
    return (
      `// The boundary declares no schema for this endpoint; its shape is unknown.\n` +
      `export type ${name} = unknown;`
    );
  }
  const expr = tsType(schema, 0);
  return expr.startsWith('{') ? `export interface ${name} ${expr}` : `export type ${name} = ${expr};`;
}

/**
 * The generated client module: faithful types followed by the greenfield seed — a
 * thin typed fetch wrapper per endpoint. The seed is a disposable default; when the
 * repo shows a calling convention of its own, rule 1 says that convention wins and a
 * later increment emits into it. One file, deterministic, safe to regenerate.
 */
export function generateBoundaryClient(plan: BoundaryClientPlan): {
  files: Record<string, string>;
  roles: Record<string, 'boundary-client'>;
} {
  const out: string[] = [
    '// Generated by Civil — boundary type-sync. Do not edit.',
    '// These types track the boundary schema and are rewritten on every transpile;',
    '// import them from your own code. Hand edits here are overwritten.',
    '',
  ];

  for (const ep of plan.endpoints) {
    out.push(renderType(`${ep.typeBase}Input`, ep.inputSchema));
    out.push(renderType(`${ep.typeBase}Output`, ep.outputSchema));
    if (ep.progressSchema !== null) {
      out.push(
        '// The SSE progress-payload shape only. The emitted boundary server does not',
        '// stream it yet (docs/boundary-type-sync.md: "The progress channel").',
        renderType(`${ep.typeBase}Progress`, ep.progressSchema),
      );
    }
    out.push('');
  }

  out.push(
    '// Where the api boundary is reached. Vite exposes import.meta.env; override with',
    '// VITE_API_URL, defaulting to same-origin.',
    'const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;',
    "const BASE_URL = env?.VITE_API_URL ?? '';",
    '',
    'async function post<T>(path: string, body: unknown): Promise<T> {',
    '  const response = await fetch(`${BASE_URL}${path}`, {',
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    '    body: JSON.stringify(body),',
    '  });',
    '  if (!response.ok) {',
    '    throw new Error(`POST ${path} failed: ${response.status} ${response.statusText}`);',
    '  }',
    '  return response.json() as Promise<T>;',
    '}',
    '',
  );

  for (const ep of plan.endpoints) {
    out.push(
      `export function ${ep.fn}(input: ${ep.typeBase}Input): Promise<${ep.typeBase}Output> {`,
      `  return post(${JSON.stringify('/' + ep.name)}, input);`,
      '}',
      '',
    );
  }

  const content = out.join('\n').replace(/\n+$/, '\n');
  return {
    files: { [plan.clientPath]: content },
    roles: { [plan.clientPath]: 'boundary-client' },
  };
}
