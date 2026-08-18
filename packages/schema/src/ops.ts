import { z } from 'zod';
import { zId, zPoint } from './manifest/common.js';
import { zCompositionEdge, zCompositionNode } from './manifest/composition.js';
import { zGraphEdge, zGraphNode } from './manifest/graph.js';

/**
 * PRD 7.1 — mutations are structured ops. The client never constructs YAML: it posts
 * ops, the server applies them to the parsed document, re-serialises preserving
 * comments, validates, and returns diff + validation.
 *
 * This vocabulary is the seam for the roadmap agent (PRD 16). Every mutation the UI
 * can perform must be expressible here, with no UI-only shortcuts — get that right
 * and the copilot is a client of an existing API rather than a rewrite.
 *
 * The same vocabulary serves both canvases; only the node/edge payloads differ.
 */

const zRemoveNode = z.object({
  op: z.literal('removeNode'),
  id: zId,
  /** Without this, removing a node leaves dangling edges that fail validation. */
  cascadeEdges: z.boolean().default(true),
});

const zRemoveEdge = z.object({ op: z.literal('removeEdge'), id: zId });

/** Layout ops touch the `layout` block only — never `spec`. See PRD 6.3. */
const zSetLayout = z.object({ op: z.literal('setLayout'), id: zId }).extend(zPoint.shape);

const zRenameNode = z.object({
  op: z.literal('renameNode'),
  from: zId,
  to: zId,
  /** Rewrites edge endpoints and layout keys so the rename is atomic. */
  updateReferences: z.boolean().default(true),
});

function opsFor<N extends z.ZodTypeAny, E extends z.ZodTypeAny>(node: N, edge: E) {
  return z.discriminatedUnion('op', [
    z.object({ op: z.literal('addNode'), node }),
    z.object({ op: z.literal('updateNode'), id: zId, patch: z.record(z.string(), z.unknown()) }),
    zRemoveNode,
    zRenameNode,
    z.object({ op: z.literal('addEdge'), edge }),
    z.object({ op: z.literal('updateEdge'), id: zId, patch: z.record(z.string(), z.unknown()) }),
    zRemoveEdge,
    zSetLayout,
  ]);
}

export const zCompositionOp = opsFor(zCompositionNode, zCompositionEdge);
export const zGraphOp = opsFor(zGraphNode, zGraphEdge);

export const zCompositionOpBatch = z.object({ ops: z.array(zCompositionOp).min(1) });
export const zGraphOpBatch = z.object({ ops: z.array(zGraphOp).min(1) });

export type CompositionOp = z.infer<typeof zCompositionOp>;
export type GraphOp = z.infer<typeof zGraphOp>;
export type AnyOp = CompositionOp | GraphOp;

/** Every op names the node or edge it touches; the UI uses this to attach diagnostics. */
export function opTargetId(op: AnyOp): string {
  switch (op.op) {
    case 'addNode':
      return op.node.id;
    case 'addEdge':
      return op.edge.id;
    case 'renameNode':
      return op.from;
    default:
      return op.id;
  }
}
