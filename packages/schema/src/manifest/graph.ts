import { z } from 'zod';
import { zApiVersion, zId, zLayout, zMetadata, zRelPath } from './common.js';

/**
 * PRD 5 — the dataflow canvas, inside a service implemented as a graph.
 * Four node types: two leaves (agent, io) and two that descend (subgraph, code).
 * No blended contexts: a node is a canvas or it is code, never both.
 */

/** PRD 5: a leaf. Everything inspector-editable; tools come from capability edges. */
export const zAgentNode = z.object({
  id: zId,
  type: z.literal('agent'),
  ref: zRelPath,
});

/**
 * PRD 5: a leaf at the graph boundary. Directional — `in` or `out`, never both.
 * A bidirectional node is a source and a sink at once: a cycle the topological
 * runner would have to special-case.
 *
 * `kind: progress` outputs become SSE events on an api client and
 * notifications/progress on an mcp client. Both surfaces inherit it without
 * separate configuration.
 */
export const zIoNode = z.object({
  id: zId,
  type: z.literal('io'),
  direction: z.enum(['in', 'out']),
  name: z.string().min(1).optional(),
  schema: zRelPath.optional(),
  kind: z.literal('progress').optional(),
});

/** PRD 5: a reference to another graph file. Descent is a transform, not a page load. */
export const zSubgraphNode = z.object({
  id: zId,
  type: z.literal('subgraph'),
  ref: zRelPath,
});

/**
 * PRD 5: a named set of files playing either of two roles — capability target
 * (an agent calls a function in it, dashed edge, no ordering) or flow participant
 * (it IS a step, solid edge, ordered). A flow participant must declare an
 * entrypoint; that rule is enforced in validate.ts because it depends on edges.
 */
export const zCodeNode = z.object({
  id: zId,
  type: z.literal('code'),
  name: z.string().min(1).optional(),
  include: z.array(z.string().min(1)).default([]),
  entrypoint: zRelPath.optional(),
});

export const zGraphNode = z.discriminatedUnion('type', [zIoNode, zCodeNode, zAgentNode, zSubgraphNode]);

/**
 * PRD 5: `flow` is solid, arrowed, ordered, and participates in topological
 * execution. `capability` is dashed, unarrowed, and ignored by the runner's sort.
 * A capability edge names the function the agent may call.
 */
export const zGraphEdge = z.object({
  id: zId,
  kind: z.enum(['flow', 'capability']),
  from: z.object({ node: zId }),
  to: z.object({ node: zId, function: z.string().min(1).optional() }),
});

export const zGraph = z.object({
  apiVersion: zApiVersion,
  kind: z.literal('Graph'),
  metadata: zMetadata,
  spec: z.object({
    nodes: z.array(zGraphNode).default([]),
    edges: z.array(zGraphEdge).default([]),
  }),
  layout: zLayout,
});

export type Graph = z.infer<typeof zGraph>;
export type GraphNode = z.infer<typeof zGraphNode>;
export type GraphEdge = z.infer<typeof zGraphEdge>;
export type IoNode = z.infer<typeof zIoNode>;
export type CodeNode = z.infer<typeof zCodeNode>;
export type AgentNode = z.infer<typeof zAgentNode>;
export type SubgraphNode = z.infer<typeof zSubgraphNode>;
