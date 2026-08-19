import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { Composition, Diagnostic, Graph } from '@civil/schema';
import type { AgentEntry } from '../project.js';
import type { Descent, NodeData } from './nodes.js';

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
  return { into: 'canvas', ports };
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

export function compositionToFlow(
  composition: Composition,
  file: string,
  diagnostics: Diagnostic[],
  context: FlowContext,
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const layout = composition.layout.nodes;

  const nodes = composition.spec.nodes.map((node, index): Node<NodeData> => {
    let detail: string | undefined;
    let descent: Descent;

    switch (node.type) {
      case 'service':
        // PRD 4: one thing at two resolutions. Which resolution decides which kind
        // of context opens, and the face has to say which.
        if ('graph' in node.impl) {
          detail = node.impl.graph;
          descent = canvasDescent(context.graphs, node.impl.graph);
        } else {
          detail = node.impl.entrypoint;
          descent = codeDescent(context.files, [node.impl.entrypoint], 'entrypoint');
        }
        break;
      case 'process':
        detail = `cron ${node.trigger.cron}`;
        break;
      case 'client':
        if (node.client === 'frontend') {
          // PRD 4: "an app you build. Descends into Monaco."
          detail = node.path;
          descent = codeDescent(context.files, [`${node.path}/**/*`], 'frontend');
        } else {
          // api and mcp are generated from io nodes, not authored, so there is no
          // interior to enter. PRD 4: a service with no client attached is not
          // exposed, and the picture should say so.
          detail = node.exposes.length > 0 ? `exposes ${node.exposes.join(', ')}` : 'exposes nothing';
        }
        break;
    }

    return {
      id: node.id,
      type: node.type,
      position: position(layout, node.id, index),
      data: {
        label: node.id,
        descent,
        detail,
        diagnostics: attach(diagnostics, file, node.id),
        manifest: node,
      },
    };
  });

  const edges = composition.spec.edges.map((edge): Edge => {
    const routes = edge.kind === 'routes-to';
    return {
      id: edge.id,
      source: edge.from.node,
      target: edge.to.node,
      // Carrying `kind` explicitly is what lets the canvas draw PRD 4's two relations
      // differently at all.
      className: routes ? 'edge-routes' : 'edge-depends',
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      // Spread rather than an explicit undefined: exactOptionalPropertyTypes treats
      // "absent" and "present but undefined" as different, and Edge wants absent.
      ...(routes ? {} : { style: { strokeDasharray: '2 4' }, label: 'depends on' }),
    };
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
        // prompt is already in the bundle, so the face can say something true.
        const entry = context.agents[node.ref];
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
