import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ProjectBundle } from '../project.js';
import { compositionToFlow, graphToFlow } from './model.js';
import { compositionNodeTypes, graphNodeTypes, type NodeData } from './nodes.js';

/**
 * PRD 1: two altitudes, and the boundary between them is a descent. Keeping the two
 * edge semantics on separate canvases is load-bearing — an edge meaning "this route
 * calls that handler" and one meaning "this output feeds that input" look identical
 * and mean unrelated things, so they never share a surface.
 */
export type Altitude =
  | { kind: 'composition'; label: string }
  | { kind: 'graph'; path: string; label: string };

/** Descent time from PRD 7. Long enough to read as motion, short enough not to wait. */
const DESCENT_MS = 250;

/** How far the parent zooms in before the child takes over. */
const DESCENT_ZOOM = 2.2;

export interface EditorProps {
  bundle: ProjectBundle;
  stack: Altitude[];
  selectedId: string | null;
  onDescend: (altitude: Altitude) => void;
  onAscend: () => void;
  onSelect: (id: string | null) => void;
}

export function Editor(props: EditorProps) {
  return (
    <ReactFlowProvider>
      <Surface {...props} />
    </ReactFlowProvider>
  );
}

function Surface({ bundle, stack, selectedId, onDescend, onAscend, onSelect }: EditorProps) {
  const flow = useReactFlow();
  const current = stack[stack.length - 1]!;

  /**
   * PRD 7: ascent returns to "the parent's exact prior viewport". Captured on the way
   * down rather than recomputed on the way up, because a fitView on return would put
   * you somewhere reasonable instead of somewhere you recognise.
   */
  const viewports = useRef<Map<number, Viewport>>(new Map());

  const { nodes, edges, nodeTypes } = useMemo(() => {
    const context = { graphs: bundle.graphs, agents: bundle.agents, files: bundle.files };

    if (current.kind === 'composition') {
      const composition = bundle.composition;
      if (!composition) return { nodes: [], edges: [], nodeTypes: compositionNodeTypes };
      return {
        ...compositionToFlow(composition, bundle.compositionPath, bundle.diagnostics, context),
        nodeTypes: compositionNodeTypes,
      };
    }
    const graph = bundle.graphs[current.path];
    if (!graph) return { nodes: [], edges: [], nodeTypes: graphNodeTypes };
    return {
      ...graphToFlow(graph, current.path, bundle.diagnostics, context),
      nodeTypes: graphNodeTypes,
    };
  }, [bundle, current]);

  const depth = stack.length - 1;

  // Arriving at a new altitude: fit the new content over the same interval the parent
  // spent zooming in. The two motions read as one continuous move rather than a cut.
  useEffect(() => {
    const restored = viewports.current.get(depth);
    if (restored) {
      void flow.setViewport(restored, { duration: DESCENT_MS });
      viewports.current.delete(depth);
      return;
    }
    void flow.fitView({ duration: DESCENT_MS, padding: 0.22, maxZoom: 1.1 });
  }, [depth, current, flow]);

  const handleDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const data = node.data as NodeData;
      // Code descent opens Monaco (PRD 5), which is M2. Until it exists, a code node
      // says what it would open rather than pretending to open it.
      if (data.descent?.into !== 'canvas') return;

      const target = descentTarget(data);
      if (!target) return;

      viewports.current.set(depth, flow.getViewport());

      // Zoom toward the node first. The child then fits from that zoom level, which
      // is what makes the boundary feel like a descent rather than a page load.
      void flow.setCenter(node.position.x + 100, node.position.y + 40, {
        zoom: DESCENT_ZOOM,
        duration: DESCENT_MS,
      });
      window.setTimeout(() => onDescend(target), DESCENT_MS);
    },
    [depth, flow, onDescend],
  );

  // PRD 7: Escape ascends.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && stack.length > 1) onAscend();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stack.length, onAscend]);

  return (
    <ReactFlow
      nodes={nodes.map((n) => ({ ...n, selected: n.id === selectedId }))}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeDoubleClick={handleDoubleClick}
      onNodeClick={(_e, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      // M1 is read-only. PRD 14 puts visual editing in M3, behind the structured op
      // layer — dragging a node here would write nothing and teach the wrong thing.
      nodesDraggable={false}
      nodesConnectable={false}
      // React Flow zooms on double-click by default, which fights the descent
      // gesture: the same action would both zoom the parent and enter the child.
      // PRD 7 gives double-click to descent, so the built-in has to go.
      zoomOnDoubleClick={false}
      edgesFocusable={false}
      elementsSelectable
      minZoom={0.2}
      maxZoom={3}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** Where a double-click lands, or undefined if the interior is not a canvas. */
function descentTarget(data: NodeData): Altitude | undefined {
  const manifest = data.manifest;

  if (manifest.type === 'subgraph') {
    return { kind: 'graph', path: manifest.ref, label: manifest.id };
  }

  if (manifest.type === 'service' && 'graph' in manifest.impl) {
    return { kind: 'graph', path: manifest.impl.graph, label: manifest.id };
  }

  return undefined;
}
