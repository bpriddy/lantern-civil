import { z } from 'zod';
import { zApiVersion, zId, zLayout, zMetadata, zRelPath } from './common.js';

/**
 * PRD 4 — the composition canvas, as revised by the owner (docs/prd-deltas.md):
 * four node types. Clients consume, boundaries expose, services behave, processes
 * initiate. Edges here mean routes-to / depends-on and NEVER dataflow. Nothing
 * executes at this altitude; Run has no meaning here.
 *
 * The split the PRD did not have: its "client" bundled the things that consume the
 * application (web, mobile) with the generated surfaces they consume through (api,
 * mcp). Those are different in every way that matters — a boundary exposes
 * services and is generated; a client is authored code that lives in a directory —
 * so they are two types, not three flavours of one.
 */

/**
 * PRD 8.1: sync-vs-async is a surface default configured where the surface is —
 * the boundary node. Omitted means Civil infers it from whether an agent appears
 * on the flow path, transitively. Present means the author overrode the inference.
 */
export const zInvocation = z.record(zId, z.enum(['sync', 'async'])).optional();

/**
 * A generated surface over the services it exposes. `api` speaks HTTP; `mcp`
 * exposes the same services as tools an agent may call (PRD 9.2, 9.3).
 */
export const zBoundaryNode = z.object({
  id: zId,
  type: z.literal('boundary'),
  boundary: z.enum(['api', 'mcp']),
  exposes: z.array(zId).default([]),
  invocation: zInvocation,
});

/**
 * A consumer of the application: authored code in a directory, reaching services
 * only through a boundary. `web` is built and served (PRD 9.4); `mobile` is built
 * and shipped. The vocabulary is closed — adding a platform is a commit to Civil.
 */
export const zClientNode = z.object({
  id: zId,
  type: z.literal('client'),
  client: z.enum(['web', 'mobile']),
  path: zRelPath,
  dev: z.string().min(1).optional(),
});

/**
 * PRD 4: a service implemented as a graph and one implemented as a function are
 * not two categories — they are one thing at two resolutions. Referenced identically.
 */
export const zServiceImpl = z.union([
  z.object({ graph: zRelPath }).strict(),
  z.object({ entrypoint: zRelPath }).strict(),
]);

export const zServiceNode = z.object({
  id: zId,
  type: z.literal('service'),
  impl: zServiceImpl,
});

/** PRD 15, reaffirmed by the owner: schedule triggers only. */
export const zTrigger = z.object({
  kind: z.literal('schedule'),
  cron: z.string().min(1),
});

export const zProcessNode = z.object({
  id: zId,
  type: z.literal('process'),
  trigger: zTrigger,
  calls: z.array(zId).default([]),
});

export const zCompositionNode = z.discriminatedUnion('type', [
  zClientNode,
  zBoundaryNode,
  zServiceNode,
  zProcessNode,
]);

/**
 * Two relations, carried explicitly so they are checkable (docs/prd-deltas.md):
 *
 * `routes-to` — traffic flows this way: client → boundary, boundary → service.
 * `depends-on` — this needs that to exist: service or process → service.
 *
 * Neither is dataflow. Nothing executes at this altitude (PRD 4).
 */
export const zCompositionEdgeKind = z.enum(['routes-to', 'depends-on']);

export const zCompositionEdge = z.object({
  id: zId,
  kind: zCompositionEdgeKind,
  from: z.object({ node: zId }),
  to: z.object({ node: zId }),
});

export const zComposition = z.object({
  apiVersion: zApiVersion,
  kind: z.literal('Composition'),
  metadata: zMetadata,
  spec: z.object({
    nodes: z.array(zCompositionNode).default([]),
    edges: z.array(zCompositionEdge).default([]),
  }),
  layout: zLayout,
});

export type Composition = z.infer<typeof zComposition>;
export type CompositionNode = z.infer<typeof zCompositionNode>;
export type CompositionEdge = z.infer<typeof zCompositionEdge>;
export type CompositionEdgeKind = z.infer<typeof zCompositionEdgeKind>;
export type ServiceNode = z.infer<typeof zServiceNode>;
export type BoundaryNode = z.infer<typeof zBoundaryNode>;
export type ClientNode = z.infer<typeof zClientNode>;
export type ProcessNode = z.infer<typeof zProcessNode>;
