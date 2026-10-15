import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { Diagnostic, Diagram, DiagramNode } from '@civil/schema';
import type { NodeData } from './nodes.js';

/**
 * A flow or architecture diagram (docs/interpretation.md) as React Flow draws it.
 * Nodes are roles or technical pieces, not composition parts; a node with `ref` is a
 * door into another diagram of the same view. Edges say what passes. Nothing here is
 * executed, so a loop is drawn like any other line.
 */

/** What the canvas and inspector know about a diagram node. */
export interface RoleItem {
  id: string;
  type: 'role';
  kind: string;
  name: string;
  view: string;
  diagram: string;
  /** The diagram's file. */
  path: string;
  node: DiagramNode;
}

const FALLBACK = { x: 60, y: 60 };

export function diagramToFlow(
  diagram: Diagram,
  path: string,
  view: string,
  diagnostics: Diagnostic[],
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const layout = diagram.layout.nodes;
  const nodes = diagram.spec.nodes.map((n, index): Node<NodeData> => {
    const item: RoleItem = { id: n.id, type: 'role', kind: n.kind, name: n.name, view, diagram: diagram.metadata.id, path, node: n };
    const decisions = n.decisions.length;
    return {
      id: n.id,
      type: 'role',
      position: layout[n.id] ?? { x: FALLBACK.x + index * 220, y: FALLBACK.y + (index % 3) * 120 },
      data: {
        label: n.name,
        descent: n.ref ? { into: 'canvas', ports: [], summary: 'step in' } : undefined,
        detail: n.summary,
        contract: undefined,
        contractError: undefined,
        diagnostics: diagnostics.filter((d) => d.file === path && d.nodeId === n.id),
        manifest: item,
        ...(n.confidence ? { confidence: n.confidence } : {}),
        ...(decisions ? { badge: `${decisions} decision${decisions === 1 ? '' : 's'}` } : {}),
      },
    };
  });
  const edges = diagram.spec.edges.map((e): Edge => {
    const uses = e.kind !== 'next';
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      className: `edge-diagram edge-diagram-${e.kind}${e.confidence === 'low' ? ' edge-uncertain' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      ...(e.label ? { label: e.label } : {}),
      ...(uses ? { style: { strokeDasharray: '4 4' } } : {}),
    };
  });
  return { nodes, edges };
}
