import { z } from 'zod';
import { zApiVersion, zId, zLayout, zMetadata, zRelPath } from './common.js';

/**
 * PRD 4 — the composition canvas. Three node types: client, service, process.
 * Edges here mean depends-on / routes-to and NEVER dataflow. Nothing executes at
 * this altitude; Run has no meaning here.
 */

/**
 * PRD 8.1: sync-vs-async is a surface default configured on the client node,
 * not a second implementation. Omitted means Civil infers it from whether an
 * agent appears on the flow path, transitively. Present means the author
 * overrode the inference for that service.
 *
 * The PRD states this belongs on the client node but does not fix the syntax;
 * this shape is ours. See docs/prd-deltas.md.
 */
export const zInvocation = z.record(zId, z.enum(['sync', 'async'])).optional();

const zClientBase = { id: zId, type: z.literal('client') } as const;

export const zFrontendClient = z.object({
  ...zClientBase,
  client: z.literal('frontend'),
  path: zRelPath,
  dev: z.string().min(1).optional(),
});

export const zApiClient = z.object({
  ...zClientBase,
  client: z.literal('api'),
  exposes: z.array(zId).default([]),
  invocation: zInvocation,
});

export const zMcpClient = z.object({
  ...zClientBase,
  client: z.literal('mcp'),
  exposes: z.array(zId).default([]),
  invocation: zInvocation,
});

export const zClientNode = z.discriminatedUnion('client', [zFrontendClient, zApiClient, zMcpClient]);

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

/** PRD 15: schedule triggers only in v1. Queues and events later. */
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

/**
 * Not a discriminated union on `type`: all three client flavors share type "client",
 * and zod requires discriminator values to be distinct. Clients discriminate on
 * `client` among themselves; the outer union is plain. validate.ts compensates by
 * unwrapping union errors to the best-matching branch so diagnostics still land on
 * the offending field rather than listing every branch's complaints.
 */
export const zCompositionNode = z.union([
  zFrontendClient,
  zApiClient,
  zMcpClient,
  zServiceNode,
  zProcessNode,
]);

/**
 * PRD 4 names two relations at this altitude. They are carried explicitly rather
 * than inferred from endpoint types so the canvas can draw them differently and a
 * service-to-service dependency has somewhere to live. See docs/prd-deltas.md.
 *
 * `routes-to` — traffic flows this way. Originates at a client.
 * `depends-on` — this needs that to exist. Originates at a service or process.
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
export type ClientNode = z.infer<typeof zClientNode>;
export type ProcessNode = z.infer<typeof zProcessNode>;
