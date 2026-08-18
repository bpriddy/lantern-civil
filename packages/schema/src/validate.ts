import { Ajv2020 } from 'ajv/dist/2020.js';
import type { z } from 'zod';
import type { Diagnostic, DiagnosticCode, Severity } from './diagnostics.js';
import type { ProjectFiles } from './files.js';
import { zComposition, type Composition } from './manifest/composition.js';
import { zGraph, type Graph, type GraphEdge } from './manifest/graph.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ptr = (...segments: (string | number)[]): string =>
  `/${segments.map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;

interface Sink {
  push(d: Omit<Diagnostic, 'file' | 'severity'> & { severity?: Severity }): void;
  all(): Diagnostic[];
}

function sink(file: string): Sink {
  const out: Diagnostic[] = [];
  return {
    push(d) {
      out.push({ file, severity: 'error', ...d });
    },
    all: () => out,
  };
}

/**
 * zod issues carry a path array; RFC 6901 wants a pointer.
 *
 * Union errors are unwrapped rather than reported whole. A composition node failing
 * `z.union([...five node shapes...])` otherwise produces five branches of complaints,
 * four of which are noise — and these render on a node face, where noise is fatal to
 * comprehension. The branch with the fewest issues is the one the author meant.
 */
function flattenIssues(issues: readonly z.ZodIssue[]): z.ZodIssue[] {
  const out: z.ZodIssue[] = [];
  for (const issue of issues) {
    if (issue.code !== 'invalid_union') {
      out.push(issue);
      continue;
    }
    const branches = issue.unionErrors.map((e) => flattenIssues(e.issues));
    const best = branches.reduce((a, b) => (b.length < a.length ? b : a), branches[0] ?? []);
    // Re-root each branch issue under the union's own path.
    out.push(...best.map((i) => ({ ...i, path: [...issue.path, ...i.path] })));
  }
  return out;
}

function fromZod(issues: readonly z.ZodIssue[], file: string): Diagnostic[] {
  return flattenIssues(issues).map((issue) => ({
    file,
    jsonPointer: issue.path.length ? ptr(...issue.path) : '',
    code: 'invalid-manifest' as DiagnosticCode,
    message: issue.message,
    severity: 'error' as Severity,
  }));
}

export interface ParseResult<T> {
  doc?: T;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// JSON Schema (PRD 6.4: schemas parse as JSON Schema 2020-12)
// ---------------------------------------------------------------------------

/**
 * Compiled per unique schema *content*, not per path. Two graphs referencing the same
 * schema file is normal and correct, but a shared Ajv instance rejects the second
 * registration of an $id it has already seen — so each compile gets a throwaway
 * instance and the verdict is memoised.
 */
const schemaVerdicts = new Map<string, string | null>();

function schemaError(source: string): string | null {
  const cached = schemaVerdicts.get(source);
  if (cached !== undefined) return cached;

  let verdict: string | null = null;
  try {
    const parsed: unknown = JSON.parse(source);
    // `logger: false` because `format` is annotation-only in JSON Schema 2020-12
    // unless the format-assertion vocabulary is enabled, so Ajv's "unknown format"
    // warnings are noise here. Real problems surface through errorsText and throws,
    // never the logger. ajv-formats would fix the warning but is CJS-only, and this
    // module is imported by the browser (PRD 6.4).
    const ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      validateSchema: false,
      logger: false,
    });
    // Check the meta-schema first: it produces the readable message.
    if (!ajv.validateSchema(parsed as object)) {
      verdict = ajv.errorsText(ajv.errors, { dataVar: 'schema' });
    } else {
      // Then compile, which catches what the meta-schema cannot: bad patterns,
      // unresolvable $refs.
      ajv.compile(parsed as object);
    }
  } catch (err) {
    verdict = (err as Error).message;
  }

  schemaVerdicts.set(source, verdict);
  return verdict;
}

function checkJsonSchema(
  path: string,
  files: ProjectFiles,
  s: Sink,
  where: { jsonPointer: string; nodeId?: string },
): void {
  if (!files.exists(path)) {
    s.push({
      ...where,
      code: 'unresolved-schema',
      message: `schema file "${path}" does not exist`,
    });
    return;
  }
  const raw = files.read(path);
  if (raw === undefined) return;

  try {
    JSON.parse(raw);
  } catch (err) {
    s.push({
      ...where,
      code: 'invalid-json-schema',
      message: `schema file "${path}" is not valid JSON: ${(err as Error).message}`,
    });
    return;
  }

  const error = schemaError(raw);
  if (error !== null) {
    s.push({
      ...where,
      code: 'invalid-json-schema',
      message: `schema file "${path}" is not valid JSON Schema 2020-12: ${error}`,
    });
  }
}

// ---------------------------------------------------------------------------
// shared structural checks
// ---------------------------------------------------------------------------

function checkDuplicateIds(
  items: readonly { id: string }[],
  kind: 'node' | 'edge',
  s: Sink,
): void {
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const first = seen.get(item.id);
    if (first === undefined) {
      seen.set(item.id, index);
      return;
    }
    s.push({
      jsonPointer: ptr('spec', `${kind}s`, index, 'id'),
      code: 'duplicate-id',
      message: `${kind} id "${item.id}" is already used at index ${first}; ids must be unique within their canvas`,
      ...(kind === 'node' ? { nodeId: item.id } : { edgeId: item.id }),
    });
  });
}

/**
 * PRD 6.4 forbids flow cycles in v1 but is explicit that they must not fail the save:
 * "Let the user draw one, mark it red, block Run — don't fail the save."
 * So this is run-blocking, not an error, and it reports the full path.
 */
function checkFlowCycles(edges: readonly GraphEdge[], s: Sink): void {
  const adjacency = new Map<string, { to: string; edgeId: string }[]>();
  for (const e of edges) {
    if (e.kind !== 'flow') continue;
    const list = adjacency.get(e.from.node) ?? [];
    list.push({ to: e.to.node, edgeId: e.id });
    adjacency.set(e.from.node, list);
  }

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (node: string): void => {
    colour.set(node, GREY);
    stack.push(node);
    for (const { to, edgeId } of adjacency.get(node) ?? []) {
      const c = colour.get(to) ?? WHITE;
      if (c === GREY) {
        const start = stack.indexOf(to);
        const cyclePath = [...stack.slice(start), to];
        const key = [...cyclePath].sort().join('>');
        if (!reported.has(key)) {
          reported.add(key);
          s.push({
            jsonPointer: ptr('spec', 'edges'),
            code: 'flow-cycle',
            message: `flow edges form a cycle: ${cyclePath.join(' → ')}. Cycles are not supported in v1; Run is blocked until it is broken.`,
            severity: 'run-blocking',
            edgeId,
            cyclePath,
          });
        }
      } else if (c === WHITE) {
        visit(to);
      }
    }
    stack.pop();
    colour.set(node, BLACK);
  };

  for (const node of adjacency.keys()) if ((colour.get(node) ?? WHITE) === WHITE) visit(node);
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

export function validateComposition(
  raw: unknown,
  file: string,
  files: ProjectFiles,
): ParseResult<Composition> {
  const parsed = zComposition.safeParse(raw);
  if (!parsed.success) return { diagnostics: fromZod(parsed.error.issues, file) };

  const doc = parsed.data;
  const s = sink(file);
  const { nodes, edges } = doc.spec;

  checkDuplicateIds(nodes, 'node', s);
  checkDuplicateIds(edges, 'edge', s);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const serviceIds = new Set(nodes.filter((n) => n.type === 'service').map((n) => n.id));

  nodes.forEach((node, i) => {
    if (node.type === 'service') {
      // PRD 4: a service is a graph or a function — one thing at two resolutions.
      const target = 'graph' in node.impl ? node.impl.graph : node.impl.entrypoint;
      const key = 'graph' in node.impl ? 'graph' : 'entrypoint';
      if (!files.exists(target)) {
        s.push({
          jsonPointer: ptr('spec', 'nodes', i, 'impl', key),
          code: key === 'graph' ? 'unresolved-ref' : 'unresolved-entrypoint',
          message: `service "${node.id}" points at "${target}", which does not exist`,
          nodeId: node.id,
        });
      }
      return;
    }

    if (node.type === 'process') {
      // PRD 6.4: `calls` must name services.
      node.calls.forEach((target, j) => {
        if (serviceIds.has(target)) return;
        s.push({
          jsonPointer: ptr('spec', 'nodes', i, 'calls', j),
          code: 'calls-non-service',
          message: byId.has(target)
            ? `process "${node.id}" calls "${target}", which is a ${byId.get(target)!.type}, not a service`
            : `process "${node.id}" calls "${target}", which is not a node in this composition`,
          nodeId: node.id,
        });
      });
      return;
    }

    if (node.client === 'frontend') {
      if (!files.exists(node.path)) {
        s.push({
          jsonPointer: ptr('spec', 'nodes', i, 'path'),
          code: 'unresolved-ref',
          message: `frontend client "${node.id}" points at "${node.path}", which does not exist`,
          nodeId: node.id,
        });
      }
      return;
    }

    // PRD 6.4: `exposes` must name services.
    node.exposes.forEach((target, j) => {
      if (serviceIds.has(target)) return;
      s.push({
        jsonPointer: ptr('spec', 'nodes', i, 'exposes', j),
        code: 'exposes-non-service',
        message: byId.has(target)
          ? `client "${node.id}" exposes "${target}", which is a ${byId.get(target)!.type}, not a service`
          : `client "${node.id}" exposes "${target}", which is not a node in this composition`,
        nodeId: node.id,
      });
    });

    // Invocation overrides may only name services this client actually exposes.
    for (const target of Object.keys(node.invocation ?? {})) {
      if (node.exposes.includes(target)) continue;
      s.push({
        jsonPointer: ptr('spec', 'nodes', i, 'invocation', target),
        code: 'exposes-non-service',
        message: `client "${node.id}" sets an invocation default for "${target}", which it does not expose`,
        nodeId: node.id,
      });
    }
  });

  edges.forEach((edge, i) => {
    for (const [end, side] of [[edge.from.node, 'from'], [edge.to.node, 'to']] as const) {
      if (byId.has(end)) continue;
      s.push({
        jsonPointer: ptr('spec', 'edges', i, side, 'node'),
        code: 'unknown-node',
        message: `edge "${edge.id}" references node "${end}", which does not exist`,
        edgeId: edge.id,
      });
    }

    // PRD 6.4: client nodes may not be edge targets of services. Traffic flows
    // client → service, so the reverse would put a generated boundary downstream
    // of the thing it exposes.
    const from = byId.get(edge.from.node);
    const to = byId.get(edge.to.node);
    if (from?.type === 'service' && to?.type === 'client') {
      s.push({
        jsonPointer: ptr('spec', 'edges', i, 'to', 'node'),
        code: 'client-is-edge-target',
        message: `edge "${edge.id}" points from service "${from.id}" to client "${to.id}"; clients are never edge targets of services`,
        edgeId: edge.id,
      });
    }
  });

  return { doc, diagnostics: s.all() };
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

export function validateGraph(raw: unknown, file: string, files: ProjectFiles): ParseResult<Graph> {
  const parsed = zGraph.safeParse(raw);
  if (!parsed.success) return { diagnostics: fromZod(parsed.error.issues, file) };

  const doc = parsed.data;
  const s = sink(file);
  const { nodes, edges } = doc.spec;

  checkDuplicateIds(nodes, 'node', s);
  checkDuplicateIds(edges, 'edge', s);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const onFlowEdge = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'flow') continue;
    onFlowEdge.add(e.from.node);
    onFlowEdge.add(e.to.node);
  }

  nodes.forEach((node, i) => {
    switch (node.type) {
      case 'io': {
        if (node.schema) {
          checkJsonSchema(node.schema, files, s, {
            jsonPointer: ptr('spec', 'nodes', i, 'schema'),
            nodeId: node.id,
          });
        }
        break;
      }
      case 'agent':
      case 'subgraph': {
        if (!files.exists(node.ref)) {
          s.push({
            jsonPointer: ptr('spec', 'nodes', i, 'ref'),
            code: 'unresolved-ref',
            message: `${node.type} "${node.id}" references "${node.ref}", which does not exist`,
            nodeId: node.id,
          });
        }
        break;
      }
      case 'code': {
        // PRD 6.4: a code node on a flow edge must declare an entrypoint. As a pure
        // capability target it does not need one — the agent names the function.
        if (onFlowEdge.has(node.id) && !node.entrypoint) {
          s.push({
            jsonPointer: ptr('spec', 'nodes', i),
            code: 'flow-code-node-needs-entrypoint',
            message: `code node "${node.id}" participates in the flow, so it is a step and must declare an entrypoint`,
            nodeId: node.id,
          });
        }
        if (node.entrypoint && !files.exists(node.entrypoint)) {
          s.push({
            jsonPointer: ptr('spec', 'nodes', i, 'entrypoint'),
            code: 'unresolved-entrypoint',
            message: `code node "${node.id}" declares entrypoint "${node.entrypoint}", which does not exist`,
            nodeId: node.id,
          });
        }
        node.include.forEach((pattern, j) => {
          if (files.glob(pattern).length > 0) return;
          s.push({
            jsonPointer: ptr('spec', 'nodes', i, 'include', j),
            code: 'unresolved-ref',
            message: `code node "${node.id}" includes "${pattern}", which matches no files`,
            nodeId: node.id,
          });
        });
        break;
      }
    }
  });

  edges.forEach((edge, i) => {
    const from = byId.get(edge.from.node);
    const to = byId.get(edge.to.node);

    for (const [end, side] of [[edge.from.node, 'from'], [edge.to.node, 'to']] as const) {
      if (byId.has(end)) continue;
      s.push({
        jsonPointer: ptr('spec', 'edges', i, side, 'node'),
        code: 'unknown-node',
        message: `edge "${edge.id}" references node "${end}", which does not exist`,
        edgeId: edge.id,
      });
    }
    if (!from || !to) return;

    if (edge.kind === 'capability') {
      // PRD 6.4: capability edges originate at an agent and terminate at a code node.
      if (from.type !== 'agent') {
        s.push({
          jsonPointer: ptr('spec', 'edges', i, 'from', 'node'),
          code: 'capability-edge-bad-source',
          message: `capability edge "${edge.id}" starts at ${from.type} "${from.id}"; capability edges originate at an agent`,
          edgeId: edge.id,
        });
      }
      if (to.type !== 'code') {
        s.push({
          jsonPointer: ptr('spec', 'edges', i, 'to', 'node'),
          code: 'capability-edge-bad-target',
          message: `capability edge "${edge.id}" ends at ${to.type} "${to.id}"; capability edges terminate at a code node`,
          edgeId: edge.id,
        });
      }
      return;
    }

    // PRD 5: io nodes are directional so the runner never has to special-case a node
    // that is a source and a sink at once. Inputs left, outputs right.
    if (from.type === 'io' && from.direction === 'out') {
      s.push({
        jsonPointer: ptr('spec', 'edges', i, 'from', 'node'),
        code: 'io-direction-violation',
        message: `flow edge "${edge.id}" starts at output io node "${from.id}"; outputs are sinks`,
        edgeId: edge.id,
      });
    }
    if (to.type === 'io' && to.direction === 'in') {
      s.push({
        jsonPointer: ptr('spec', 'edges', i, 'to', 'node'),
        code: 'io-direction-violation',
        message: `flow edge "${edge.id}" ends at input io node "${to.id}"; inputs are sources`,
        edgeId: edge.id,
      });
    }
  });

  checkFlowCycles(edges, s);

  return { doc, diagnostics: s.all() };
}
