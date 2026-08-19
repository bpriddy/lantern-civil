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
/** The altitudes the canvas itself can draw. A code level is a takeover, not a canvas. */
export type CanvasAltitude =
  | { kind: 'composition'; label: string }
  | { kind: 'graph'; path: string; label: string };

export type Altitude =
  | { kind: 'composition'; label: string }
  | { kind: 'graph'; path: string; label: string }
  // PRD 5: a node is a canvas or it is code. A code level is a viewport takeover,
  // not another canvas, which is why it carries files rather than a manifest path.
  | { kind: 'code'; label: string; files: string[] };

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
  // A code level is rendered by the takeover, not here; the deepest canvas level is
  // what stays behind it.
  const current =
    [...stack].reverse().find((level): level is CanvasAltitude => level.kind !== 'code') ??
    ({ kind: 'composition', label: 'app' } as CanvasAltitude);

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
      const target = descentTarget(data);
      if (!target) return;

      viewports.current.set(depth, flow.getViewport());

      // Zoom toward the node first. The child then fits from that zoom level, which
      // is what makes the boundary feel like a descent rather than a page load. A
      // code takeover gets the same zoom, so entering code reads as going in rather
      // than as a modal appearing over the canvas.
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

/** Where a double-click lands: another canvas, a code takeover, or nowhere. */
function descentTarget(data: NodeData): Altitude | undefined {
  const manifest = data.manifest;
  const descent = data.descent;
  if (!descent) return undefined;

  if (descent.into === 'code') {
    // Nothing to take over the viewport for.
    if (descent.files.length === 0) return undefined;
    const label = 'name' in manifest && manifest.name ? manifest.name : manifest.id;
    return { kind: 'code', label, files: descent.files };
  }

  if (manifest.type === 'subgraph') {
    return { kind: 'graph', path: manifest.ref, label: manifest.id };
  }
  if (manifest.type === 'service' && 'graph' in manifest.impl) {
    return { kind: 'graph', path: manifest.impl.graph, label: manifest.id };
  }
  return undefined;
}
