import { parse } from 'yaml';
import { zComposition, zGraph } from '@civil/schema';
import { compositionPathFor } from './bundle.js';
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

// Bump when the generated file's shape changes, so the memo (which folds the client
// signature into its hash) regenerates instead of replaying an older layout. Mirrors
// the runner's PROMPT_VERSION for the same reason.
const CLIENT_VERSION = '1';

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

  // Gather the graph refs first so a lazy (GitHub) source hydrates them in one round.
  const graphRefs: string[] = [];
  for (const id of exposed) {
    const svc = services.get(id);
    if (svc?.type === 'service' && 'graph' in svc.impl) graphRefs.push(svc.impl.graph);
  }
  await source.ensure?.(graphRefs);

  const endpoints: Endpoint[] = [];
  const schemaRefs = new Set<string>();
  for (const id of exposed) {
    const svc = services.get(id);
    const endpoint: Endpoint = {
      name: id,
      fn: camel(id),
      typeBase: pascal(id),
      inputSchema: null,
      outputSchema: null,
    };
    // A graph-backed service carries its I/O in the graph's io nodes; a function-backed
    // one declares no schema here, so its types read as unknown until discovery (a
    // later increment) can recover them. v1 types precisely what the boundary declares.
    if (svc?.type === 'service' && 'graph' in svc.impl) {
      const graph = zGraph.safeParse(parseDoc(source, svc.impl.graph));
      if (graph.success) {
        const io = graph.data.spec.nodes.filter((n) => n.type === 'io');
        const ins = io.filter((n) => n.type === 'io' && n.direction === 'in' && n.schema);
        // A progress out is an SSE channel, not the response body — excluded here.
        const outs = io.filter(
          (n) => n.type === 'io' && n.direction === 'out' && n.kind !== 'progress' && n.schema,
        );
        // A single typed in/out maps cleanly to one request/response type. Zero or
        // several is a composite this v1 does not invent — it stays unknown, honestly.
        if (ins.length === 1 && ins[0]!.type === 'io' && ins[0]!.schema) {
          schemaRefs.add(ins[0]!.schema);
        }
        if (outs.length === 1 && outs[0]!.type === 'io' && outs[0]!.schema) {
          schemaRefs.add(outs[0]!.schema);
        }
        endpoint.inputSchema = ins.length === 1 ? (ins[0]! as { schema?: string }).schema ?? null : null;
        endpoint.outputSchema =
          outs.length === 1 ? (outs[0]! as { schema?: string }).schema ?? null : null;
      }
    }
    endpoints.push(endpoint);
  }

  // Read the referenced schemas (one hydration round), then resolve each endpoint's
  // schema path to its parsed content.
  await source.ensure?.([...schemaRefs]);
  const resolved = new Map<string, unknown | null>();
  for (const ref of schemaRefs) resolved.set(ref, readSchema(source, ref));
  for (const ep of endpoints) {
    ep.inputSchema =
      typeof ep.inputSchema === 'string' ? resolved.get(ep.inputSchema) ?? null : null;
    ep.outputSchema =
      typeof ep.outputSchema === 'string' ? resolved.get(ep.outputSchema) ?? null : null;
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
  const parts = [`v${CLIENT_VERSION}`, plan.clientPath];
  for (const ep of plan.endpoints) {
    parts.push(
      [ep.name, ep.fn, ep.typeBase, stable(ep.inputSchema), stable(ep.outputSchema)].join(''),
    );
  }
  return parts.join('');
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
