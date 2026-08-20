import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ProjectBundle } from '../project.js';
import { nextEdgeId, proposeCompositionEdge, proposeGraphEdge } from './edges.js';
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
  // `active` is which of them is in front — opening another file from the tree adds
  // to the set rather than replacing it, the way tabs behave everywhere else.
  | { kind: 'code'; label: string; files: string[]; active?: string };

/** Descent time from PRD 7. Long enough to read as motion, short enough not to wait. */
const DESCENT_MS = 250;

/** How far the parent zooms in before the child takes over. */
const DESCENT_ZOOM = 2.2;

export interface EditorProps {
  bundle: ProjectBundle;
  stack: Altitude[];
  selectedId: string | null;
  selectedEdgeId: string | null;
  onDescend: (altitude: Altitude) => void;
  onAscend: () => void;
  onSelect: (id: string | null) => void;
  /** Edges select too, so Delete knows what "the selection" is. */
  onSelectEdge: (id: string | null) => void;
  /** Drawing a connection. The kind is inferred here and sent explicitly. */
  onConnect: (edge: Record<string, unknown>) => void;
  /** Refused connections say why rather than silently not happening. */
  onRefuse: (reason: string) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
}

export function Editor(props: EditorProps) {
  return (
    <ReactFlowProvider>
      <Surface {...props} />
    </ReactFlowProvider>
  );
}

function Surface({
  bundle,
  stack,
  selectedId,
  selectedEdgeId,
  onDescend,
  onAscend,
  onSelect,
  onSelectEdge,
  onConnect,
  onRefuse,
  onMoveNode,
}: EditorProps) {
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

  const { nodes: computedNodes, edges, nodeTypes } = useMemo(() => {
    const context = {
      graphs: bundle.graphs,
      agents: bundle.agents,
      files: bundle.files,
      contracts: bundle.contracts,
    };

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

  /**
   * The manifest is the truth, but a drag needs sixty frames of provisional truth
   * before its one real write. React Flow reports positions through onNodesChange;
   * holding them in state here is what makes the node travel with the pointer
   * instead of teleporting on mouse-up when the op round-trips.
   */
  const [liveNodes, setLiveNodes] = useState<Node[]>(computedNodes);
  const dragging = useRef(false);
  useEffect(() => {
    // A refresh mid-drag must not yank the node out from under the pointer; the
    // drop's own op and refresh will reconcile everything a moment later.
    if (!dragging.current) setLiveNodes(computedNodes);
  }, [computedNodes]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    // Positions and measurements only. Selection and removal belong to the shell,
    // which expresses them as ops — accepting them here would fork that authority.
    const positional = changes.filter(
      (change) => change.type === 'position' || change.type === 'dimensions',
    );
    if (positional.length > 0) {
      setLiveNodes((current) => applyNodeChanges(positional, current));
    }
  }, []);

  const depth = stack.length - 1;

  /** The manifest nodes behind the current canvas, for inferring what a link means. */
  const manifestNodes = useMemo(() => {
    if (current.kind === 'composition') return bundle.composition?.spec.nodes ?? [];
    return bundle.graphs[current.path]?.spec.nodes ?? [];
  }, [bundle, current]);

  const existingEdgeIds = useMemo(() => edges.map((e) => e.id), [edges]);

  const propose = useCallback(
    (connection: { source: string; target: string }) =>
      current.kind === 'composition'
        ? proposeCompositionEdge(manifestNodes as never, connection)
        : proposeGraphEdge(manifestNodes as never, connection),
    [current.kind, manifestNodes],
  );

  const handleConnect = useCallback(
    (connection: { source: string | null; target: string | null }) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) {
        onRefuse('A node cannot connect to itself.');
        return;
      }

      const { kind, refusal } = propose({ source: connection.source, target: connection.target });
      // PRD 6.4 would reject this anyway; saying so at the moment of the gesture is
      // better than drawing an edge and then marking it red.
      if (refusal) return onRefuse(refusal);

      onConnect({
        id: nextEdgeId(existingEdgeIds, current.kind === 'composition' ? 'c' : 'e'),
        kind,
        from: { node: connection.source },
        to: { node: connection.target },
      });
    },
    [propose, onConnect, onRefuse, existingEdgeIds, current.kind],
  );

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
      nodes={liveNodes.map((n) => ({ ...n, selected: n.id === selectedId }))}
      edges={edges.map((e) => ({ ...e, selected: e.id === selectedEdgeId }))}
      nodeTypes={nodeTypes}
      onNodeDoubleClick={handleDoubleClick}
      onNodeClick={(_e, node) => {
        onSelectEdge(null);
        onSelect(node.id);
      }}
      onEdgeClick={(_e, edge) => {
        onSelect(null);
        onSelectEdge(edge.id);
      }}
      onPaneClick={() => {
        onSelect(null);
        onSelectEdge(null);
      }}
      onConnect={handleConnect}
      onNodesChange={handleNodesChange}
      onNodeDragStart={() => {
        dragging.current = true;
      }}
      // The op is sent on drop rather than per frame: a position is worth one op,
      // and one op is one pending change, not sixty. The sixty frames in between
      // live in liveNodes above.
      onNodeDragStop={(_e, node) => {
        dragging.current = false;
        onMoveNode(node.id, Math.round(node.position.x), Math.round(node.position.y));
      }}
      // Deletion belongs to the command registry — one named action, one op path,
      // one toast — so React Flow's own delete key is turned off rather than letting
      // two listeners race for the same keystroke.
      deleteKeyCode={null}
      nodesDraggable
      nodesConnectable
      edgesFocusable
      // React Flow zooms on double-click by default, which fights the descent
      // gesture: the same action would both zoom the parent and enter the child.
      // PRD 7 gives double-click to descent, so the built-in has to go.
      zoomOnDoubleClick={false}
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
