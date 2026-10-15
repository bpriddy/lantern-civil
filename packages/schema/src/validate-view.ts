import type { Diagnostic } from './diagnostics.js';
import { fromZod } from './validate.js';
import {
  ARCHITECTURE_EDGE_KINDS,
  ARCHITECTURE_NODE_KINDS,
  FLOW_EDGE_KINDS,
  FLOW_NODE_KINDS,
  zDiagram,
  zDomain,
  zView,
  type Diagram,
  type Domain,
  type View,
} from './manifest/view.js';

/**
 * A view checked against the composition it looks at (docs/prd-deltas.md §21). The
 * composition is the master: a view may only name parts it has. Within a view a part
 * is placed once, a domain's parent is a domain of the same view, and no domain is
 * inside itself. A domain file is named for its id.
 */
export interface ViewSource {
  /** civil/views/<id>/view.yaml and its parsed document. */
  path: string;
  raw: unknown;
  /** The view's other documents: one per domain. */
  domains: { path: string; raw: unknown }[];
}

export interface ViewResult {
  view?: View;
  /** Domain id → its document and path, for every domain that parsed (a grouping view). */
  domains: Record<string, { path: string; doc: Domain }>;
  /** Diagram id → its document and path (a flow or architecture view). */
  diagrams: Record<string, { path: string; doc: Diagram }>;
  diagnostics: Diagnostic[];
}

const at = (path: string, pointer: string, code: Diagnostic['code'], message: string, nodeId?: string): Diagnostic => ({
  file: path,
  jsonPointer: pointer,
  code,
  message,
  severity: 'error',
  ...(nodeId ? { nodeId } : {}),
});

export function validateView(source: ViewSource, parts: ReadonlySet<string>): ViewResult {
  const diagnostics: Diagnostic[] = [];
  const parsed = zView.safeParse(source.raw);
  if (!parsed.success) diagnostics.push(...fromZod(parsed.error.issues, source.path));
  const view = parsed.success ? parsed.data : undefined;
  const dir = source.path.split('/').slice(-2, -1)[0];
  if (view && dir !== undefined && view.metadata.id !== dir) {
    diagnostics.push(at(source.path, '/metadata/id', 'invalid-manifest', `view "${view.metadata.id}" is in views/${dir}/; a view's directory is named for its id`));
  }

  const domains: ViewResult['domains'] = {};
  if (view && view.spec.shape !== 'grouping') {
    const diagrams = validateDiagrams(source, view, parts, diagnostics);
    return { view, domains, diagrams, diagnostics };
  }
  for (const file of source.domains) {
    const result = zDomain.safeParse(file.raw);
    if (!result.success) {
      diagnostics.push(...fromZod(result.error.issues, file.path));
      continue;
    }
    const id = result.data.metadata.id;
    const named = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '');
    if (named !== id) {
      diagnostics.push(at(file.path, '/metadata/id', 'invalid-manifest', `domain "${id}" is in ${named}.yaml; a domain file is named for its id`, id));
    }
    if (domains[id]) {
      diagnostics.push(at(file.path, '/metadata/id', 'duplicate-id', `domain "${id}" is defined twice in this view`, id));
      continue;
    }
    if (parts.has(id)) {
      diagnostics.push(at(file.path, '/metadata/id', 'duplicate-id', `domain "${id}" has the id of a part in the composition`, id));
    }
    domains[id] = { path: file.path, doc: result.data };
  }

  // Every placement names a real part, and a part is placed once in this view.
  const placedAt = new Map<string, string>();
  const place = (part: string, where: string, path: string, pointer: string, owner?: string) => {
    if (!parts.has(part)) {
      diagnostics.push(at(path, pointer, 'unknown-node', `${where} holds "${part}", which is not a part in the composition`, owner));
      return;
    }
    const before = placedAt.get(part);
    if (before) {
      diagnostics.push(at(path, pointer, 'placed-twice', `"${part}" is placed in ${before} and in ${where}; a view places a part once`, owner));
      return;
    }
    placedAt.set(part, where);
  };
  view?.spec.members.forEach((part, i) => place(part, 'the top level', source.path, `/spec/members/${i}`));
  for (const [id, { path, doc }] of Object.entries(domains)) {
    doc.spec.members.forEach((part, i) => place(part, `domain "${id}"`, path, `/spec/members/${i}`, id));
    const parent = doc.spec.parent;
    if (parent !== undefined && !domains[parent]) {
      diagnostics.push(at(path, '/spec/parent', 'parent-not-domain', `domain "${id}" is inside "${parent}", which is not a domain of this view`, id));
    }
  }

  // No domain inside itself; the cycle is named once, from its first domain.
  const reported = new Set<string>();
  for (const id of Object.keys(domains).sort()) {
    const chain = [id];
    for (let up = domains[id]!.doc.spec.parent; up !== undefined && domains[up]; up = domains[up]!.doc.spec.parent) {
      if (up === id) {
        const key = [...chain].sort().join('>');
        if (!reported.has(key)) {
          reported.add(key);
          diagnostics.push({
            ...at(domains[id]!.path, '/spec/parent', 'domain-cycle', `domain "${id}" is inside itself: ${[...chain, id].join(' → ')}`, id),
            cyclePath: [...chain, id],
          });
        }
        break;
      }
      if (chain.includes(up)) break; // a cycle further up, reported from its own domain
      chain.push(up);
    }
  }

  return { ...(view ? { view } : {}), domains, diagrams: {}, diagnostics };
}

/**
 * A flow or architecture view (docs/interpretation.md): every other document is a
 * Diagram. Its nodes are of its shape's closed kinds, its edges join its own nodes, a
 * node realised by parts names parts the composition has, and a door (`ref`) opens a
 * diagram of the same view. The view's entry is one of them.
 */
function validateDiagrams(
  source: ViewSource,
  view: View,
  parts: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): ViewResult['diagrams'] {
  const flow = view.spec.shape === 'flow';
  const nodeKinds: readonly string[] = flow ? FLOW_NODE_KINDS : ARCHITECTURE_NODE_KINDS;
  const edgeKinds: readonly string[] = flow ? FLOW_EDGE_KINDS : ARCHITECTURE_EDGE_KINDS;
  const diagrams: ViewResult['diagrams'] = {};
  for (const file of source.domains) {
    const result = zDiagram.safeParse(file.raw);
    if (!result.success) {
      diagnostics.push(...fromZod(result.error.issues, file.path));
      continue;
    }
    const id = result.data.metadata.id;
    const named = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '');
    if (named !== id) {
      diagnostics.push(at(file.path, '/metadata/id', 'invalid-manifest', `diagram "${id}" is in ${named}.yaml; a diagram file is named for its id`));
    }
    if (diagrams[id]) {
      diagnostics.push(at(file.path, '/metadata/id', 'duplicate-id', `diagram "${id}" is defined twice in this view`));
      continue;
    }
    diagrams[id] = { path: file.path, doc: result.data };
  }
  for (const { path, doc } of Object.values(diagrams)) {
    const ids = new Set<string>();
    doc.spec.nodes.forEach((node, i) => {
      if (ids.has(node.id)) diagnostics.push(at(path, `/spec/nodes/${i}/id`, 'duplicate-id', `node "${node.id}" appears twice in this diagram`, node.id));
      ids.add(node.id);
      if (!nodeKinds.includes(node.kind)) {
        diagnostics.push(at(path, `/spec/nodes/${i}/kind`, 'invalid-manifest', `node "${node.id}" is a ${node.kind}; a ${view.spec.shape} diagram's nodes are ${nodeKinds.join(', ')}`, node.id));
      }
      node.realizedBy.forEach((part, j) => {
        if (!parts.has(part)) diagnostics.push(at(path, `/spec/nodes/${i}/realizedBy/${j}`, 'unknown-node', `node "${node.id}" is realised by "${part}", which is not a part in the composition`, node.id));
      });
      if (node.ref !== undefined && !diagrams[node.ref]) {
        diagnostics.push(at(path, `/spec/nodes/${i}/ref`, 'unresolved-ref', `node "${node.id}" opens "${node.ref}", which is not a diagram of this view`, node.id));
      }
    });
    doc.spec.edges.forEach((edge, i) => {
      for (const [end, side] of [[edge.from, 'from'], [edge.to, 'to']] as const) {
        if (!ids.has(end)) diagnostics.push({ ...at(path, `/spec/edges/${i}/${side}`, 'unknown-node', `edge "${edge.id}" references "${end}", which is not a node of this diagram`), edgeId: edge.id });
      }
      if (!edgeKinds.includes(edge.kind)) {
        diagnostics.push({ ...at(path, `/spec/edges/${i}/kind`, 'invalid-manifest', `edge "${edge.id}" is ${edge.kind}; a ${view.spec.shape} diagram's edges are ${edgeKinds.join(', ')}`), edgeId: edge.id });
      }
    });
  }
  if (view.spec.entry !== undefined && !diagrams[view.spec.entry]) {
    diagnostics.push(at(source.path, '/spec/entry', 'unresolved-ref', `the view opens at "${view.spec.entry}", which is not a diagram of this view`));
  }
  return diagrams;
}
