import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { Composition, Diagnostic, Graph } from '@civil/schema';
import type { AgentEntry } from '../project.js';
import type { NodeData } from './nodes.js';

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

// --- composition -----------------------------------------------------------

export function compositionToFlow(
  composition: Composition,
  file: string,
  diagnostics: Diagnostic[],
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const layout = composition.layout.nodes;

  const nodes = composition.spec.nodes.map((node, index): Node<NodeData> => {
    let detail: string | undefined;
    let descendable = false;

    switch (node.type) {
      case 'service':
        // PRD 4: one thing at two resolutions. A graph descends into a canvas, a
        // function into Monaco — but both are simply "the interior".
        descendable = true;
        detail = 'graph' in node.impl ? node.impl.graph : node.impl.entrypoint;
        break;
      case 'process':
        detail = `cron ${node.trigger.cron}`;
        break;
      case 'client':
        detail =
          node.client === 'frontend'
            ? node.path
            : node.exposes.length > 0
              ? `exposes ${node.exposes.join(', ')}`
              : 'exposes nothing';
        // PRD 4: a client with no service attached is not exposed, and the picture
        // should say so.
        break;
    }

    return {
      id: node.id,
      type: node.type,
      position: position(layout, node.id, index),
      data: {
        label: node.id,
        descendable,
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
  agents: Record<string, AgentEntry>,
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const layout = graph.layout.nodes;

  const nodes = graph.spec.nodes.map((node, index): Node<NodeData> => {
    let detail: string | undefined;
    let descendable = false;

    switch (node.type) {
      case 'io':
        detail = node.kind === 'progress' ? 'progress' : (node.schema ?? 'no schema');
        break;
      case 'agent': {
        // PRD 7's semantic zoom shows the first lines of an agent's objective. The
        // prompt is already in the bundle, so the face can say something true.
        const entry = agents[node.ref];
        detail = entry?.prompt?.split('\n').find((line) => line.trim().length > 0)?.slice(0, 80);
        break;
      }
      case 'code':
        detail = node.entrypoint ?? node.include.join(', ');
        break;
      case 'subgraph':
        descendable = true;
        detail = node.ref;
        break;
    }

    return {
      id: node.id,
      type: node.type,
      position: position(layout, node.id, index),
      data: {
        label: 'name' in node && node.name ? node.name : node.id,
        descendable,
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
