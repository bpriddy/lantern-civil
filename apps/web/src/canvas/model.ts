import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { Composition, Diagnostic, Graph } from '@civil/schema';
import { isContract, type AgentEntry, type ContractResult, type LiftUnit } from '../project.js';
import type { Descent, NodeData } from './nodes.js';
import { domainSummary, projectLevel, type LoadedView } from './levels.js';

/**
 * Turns a manifest into what React Flow draws. Positions come from the `layout`
 * block, which PRD 6.3 keeps as a sibling of `spec` so dragging a node never produces
 * a diff that looks like a semantic change.
 */

const FALLBACK_SPACING = 200;

function position(layout: Record<string, { x: number; y: number }>, id: string, index: number) {
  // A node with no layout entry is legal — it was just added by hand. Placing it on a
  // predictable diagonal beats stacking every such node at the origin.
  return layout[id] ?? { x: 60 + index * FALLBACK_SPACING, y: 60 + (index % 3) * 120 };
}

function attach(diagnostics: Diagnostic[], file: string, id: string): Diagnostic[] {
  return diagnostics.filter((d) => d.file === file && d.nodeId === id);
}

/** What the canvas needs beyond the manifest being drawn. */
export interface FlowContext {
  graphs: Record<string, Graph>;
  agents: Record<string, AgentEntry>;
  files: string[];
  contracts: Record<string, ContractResult>;
  /**
   * Composition nodes a lift wrote, by id: the repository files each stands for
   * (civil/registry.yaml, role repo). Optional: only a lifted project has them.
   */
  repoUnits?: Record<string, LiftUnit>;
}

/** Contracts are keyed by the manifest they were found from plus the node id. */
function contractFor(context: FlowContext, manifest: string, nodeId: string) {
  const result = context.contracts[`${manifest}:${nodeId}`];
  return {
    contract: isContract(result) ? result : undefined,
    contractError: result && 'error' in result ? result.error : undefined,
  };
}

/**
 * PRD 5: "A subgraph's boundary ports ARE its io nodes seen from inside." Reading
 * them from the referenced graph is what lets the parent's face show the interior
 * rather than just its filename.
 */
function canvasDescent(graphs: Record<string, Graph>, ref: string): Descent {
  const graph = graphs[ref];
  const ports = (graph?.spec.nodes ?? [])
    .filter((n): n is Extract<typeof n, { type: 'io' }> => n.type === 'io')
    // Inputs left, outputs right (PRD 5), so inputs read first.
    .sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1))
    .map((n) => ({ name: n.name ?? n.id, direction: n.direction }));
  // A graph with no io nodes (a lifted one never has them: the reader does not invent
  // a schema) is described by what it holds instead of by an empty interior.
  const nodes = graph?.spec.nodes ?? [];
  const agents = nodes.filter((n) => n.type === 'agent').length;
  const summary = graph
    ? `${nodes.length} node${nodes.length === 1 ? '' : 's'}${agents ? ` · ${agents} agent${agents === 1 ? '' : 's'}` : ''}`
    : undefined;
  return { into: 'canvas', ports, ...(summary ? { summary } : {}) };
}

const globToRe = (pattern: string) =>
  new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*/g, '[^/]*') +
      '$',
  );

function codeDescent(files: string[], include: string[], note: string): Descent {
  const matchers = include.map(globToRe);
  return { into: 'code', files: files.filter((f) => matchers.some((re) => re.test(f))), note };
}

// --- composition -----------------------------------------------------------

/**
 * One level of the composition (§21): the top when `scope` is absent, otherwise the
 * inside of that domain. Edges from deeper in roll up, and edges that leave the level
 * end at "outside" stubs (levels.ts).
 */
export function compositionToFlow(
  composition: Composition,
  file: string,
  diagnostics: Diagnostic[],
  context: FlowContext,
  view?: LoadedView,
  scope?: string,
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const level = projectLevel(composition, file, view, scope);
  const layout = level.layout;

  const nodes = level.items.map((item, index): Node<NodeData> => {
    if (item.kind === 'domain') {
      // A level of its own, in this view: stepping in shows what it holds, so the
      // interior preview says what that is.
      const d = item.domain;
      const summary = domainSummary(composition, view!, d.id);
      return {
        id: d.id,
        type: 'domain',
        position: position(layout, d.id, index),
        data: {
          label: d.name,
          descent: { into: 'canvas', ports: [], summary },
          detail: undefined,
          contract: undefined,
          contractError: undefined,
          diagnostics: diagnostics.filter((x) => x.file === d.path),
          manifest: d,
          ...(d.unsure?.length ? { confidence: 'low' as const } : {}),
        },
      };
    }
    const node = item.node;
    let detail: string | undefined;
    let descent: Descent;
    const label: string = node.id;

    switch (node.type) {
      case 'service':
        // PRD 4: one thing at two resolutions. Which resolution decides which kind
        // of context opens, and the face has to say which.
        if ('graph' in node.impl) {
          detail = node.impl.graph;
          descent = canvasDescent(context.graphs, node.impl.graph);
        } else {
          detail = node.impl.entrypoint;
          // A lifted service stands for every file the registry lists for it, not
          // the one its entrypoint names: open them all, entrypoint first.
          const unit = context.repoUnits?.[node.id];
          const entry = node.impl.entrypoint;
          descent = unit
            ? { into: 'code', files: [entry, ...unit.files.filter((f) => f !== entry)], note: 'from the repo' }
            : codeDescent(context.files, [entry], 'entrypoint');
        }
        break;
      case 'process':
        detail = `cron ${node.trigger.cron}`;
        break;
      case 'client':
        // A client is an app you author. Descends into Monaco.
        detail = node.path;
        descent = codeDescent(context.files, [`${node.path}/**/*`], 'client');
        break;
      case 'boundary':
        // Boundaries are generated from what they expose, not authored, so there
        // is no interior to enter. A service with no boundary in front of it is
        // not reachable, and the picture should say so.
        detail = node.exposes.length > 0 ? `exposes ${node.exposes.join(', ')}` : 'exposes nothing';
        break;
      case 'datastore':
        // Where state lives. It has no code (generation emits nothing for a store),
        // so nothing to enter; the face names the technology, or says it is unnamed.
        detail = node.engine ?? 'engine unspecified';
        break;
    }

    return {
      id: node.id,
      type: node.type,
      position: position(layout, node.id, index),
      data: {
        label,
        descent,
        detail,
        ...contractFor(context, file, node.id),
        diagnostics: attach(diagnostics, file, node.id),
        manifest: node,
        // How sure the lift was that this is here; the face marks only the unsure.
        ...(context.repoUnits?.[node.id]?.confidence
          ? { confidence: context.repoUnits[node.id]!.confidence }
          : {}),
      },
    };
  });

  // Stubs for what lies outside this level, in a column beside what is drawn: what
  // this level uses on the right, what uses it on the left.
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const [minX, maxX, minY] = [Math.min(0, ...xs), Math.max(0, ...xs), Math.min(0, ...ys)];
  let rightRow = 0;
  let leftRow = 0;
  for (const stub of level.outside) {
    const left = stub.side === 'in';
    const row = left ? leftRow++ : rightRow++;
    nodes.push({
      id: stub.id,
      type: 'outside',
      position: { x: left ? minX - 300 : maxX + 320, y: minY + row * 90 },
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        label: stub.path[stub.path.length - 1] ?? stub.target,
        descent: undefined,
        detail: stub.path.length > 1 ? `in ${stub.path.slice(0, -1).join(' › ')}` : 'outside this domain',
        contract: undefined,
        contractError: undefined,
        diagnostics: [],
        // A stub stands for a node elsewhere; it is never edited here.
        manifest: { id: stub.target, type: 'domain', name: stub.path[stub.path.length - 1] ?? stub.target, path: '', view: view?.view.metadata.id ?? '' },
        outside: true,
      },
    });
  }

  const edges = level.edges.map((edge): Edge => {
    // Carrying `kind` explicitly is what lets the canvas draw PRD 4's relations
    // differently at all.
    const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14 };
    const base: Edge = { id: edge.id, source: edge.from, target: edge.to, animated: false, markerEnd: arrow };
    // A rolled-up line is a projection, not a stored edge: it cannot be selected or
    // deleted here, and it says how many edges it stands for when more than one.
    const derived: Partial<Edge> = edge.stored ? {} : { selectable: false, deletable: false, focusable: false };
    const many = edge.count > 1 ? ` ×${edge.count}` : '';
    const rolled = edge.stored ? '' : ' edge-rollup';
    switch (edge.kind) {
      case 'routes-to':
        return { ...base, ...derived, className: `edge-routes${rolled}`, ...(many ? { label: many.trim() } : {}) };
      case 'calls':
        // A line between deployables: rarer than a dependency and a different kind of
        // claim (a network call through another deployable's boundary), so it is
        // long-dashed AND named — a reader should not have to know the dash code.
        return { ...base, ...derived, className: `edge-calls${rolled}`, label: `calls${many}`, style: { strokeDasharray: '6 4' } };
      default:
        // No label: the dashed stroke is the relation, and a label chip per dependency
        // buries a dense canvas (a lifted backend has dozens) in "depends on".
        return { ...base, ...derived, className: `edge-depends${rolled}`, style: { strokeDasharray: '2 4' }, ...(many ? { label: many.trim() } : {}) };
    }
  });

  return { nodes, edges };
}

// --- dataflow --------------------------------------------------------------

export function graphToFlow(
  graph: Graph,
  file: string,
  diagnostics: Diagnostic[],
  context: FlowContext,
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const layout = graph.layout.nodes;

  const nodes = graph.spec.nodes.map((node, index): Node<NodeData> => {
    let detail: string | undefined;
    let descent: Descent;

    switch (node.type) {
      case 'io':
        detail = node.kind === 'progress' ? 'progress' : (node.schema ?? 'no schema');
        break;
      case 'agent': {
        // PRD 7's semantic zoom shows the first lines of an agent's objective. The
        // prompt is already in the bundle, keyed graphPath#nodeId because a node id
        // is unique only within its graph.
        const entry = context.agents[`${file}#${node.id}`];
        detail = entry?.prompt?.split('\n').find((line) => line.trim().length > 0)?.slice(0, 80);
        break;
      }
      case 'code':
        // PRD 5: a code node descends into Monaco, never into a canvas.
        detail = node.entrypoint ?? node.include.join(', ');
        // PRD 5: a code node is a flow step when it declares an entrypoint, and a
        // capability target when it does not. That distinction is the node's whole
        // role in the graph, so it belongs on the face.
        descent = codeDescent(
          context.files,
          node.include,
          node.entrypoint ? 'step' : 'capability target',
        );
        break;
      case 'subgraph':
        // PRD 5: descends as a continuous transform into another canvas.
        detail = node.ref;
        descent = canvasDescent(context.graphs, node.ref);
        break;
    }

    return {
      id: node.id,
      type: node.type,
      position: position(layout, node.id, index),
      data: {
        label: 'name' in node && node.name ? node.name : node.id,
        descent,
        detail,
        ...contractFor(context, file, node.id),
        diagnostics: attach(diagnostics, file, node.id),
        manifest: node,
      },
    };
  });

  const edges = graph.spec.edges.map((edge): Edge => {
    // PRD 5: flow is solid, arrowed, ordered. Capability is dashed and unarrowed
    // because it carries no ordering and the runner's topological sort ignores it.
    const flow = edge.kind === 'flow';
    return {
      id: edge.id,
      source: edge.from.node,
      target: edge.to.node,
      className: flow ? 'edge-flow' : 'edge-capability',
      ...(flow
        ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 } }
        : { style: { strokeDasharray: '4 4' } }),
      ...(edge.to.function ? { label: edge.to.function } : {}),
    };
  });

  return { nodes, edges };
}
