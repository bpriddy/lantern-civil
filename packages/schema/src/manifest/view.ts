import { z } from 'zod';
import { zApiVersion, zId, zLayout, zMetadata } from './common.js';

/**
 * Views (docs/prd-deltas.md §21): ways of looking at one application. The composition
 * (app.yaml) is the master — every part and every edge, said once — and a view only
 * groups and places parts it already has. A view never adds, removes or changes a part.
 *
 * A view is a directory, civil/views/<id>/: a `view.yaml` and one file per domain,
 * named for the domain's id. Every view has this shape, so the canvas can draw any of
 * them without knowing what it means; Civil builds two from code (concept and
 * architecture) and a project may keep others of its own.
 */

export const VIEWS_DIR = 'civil/views';

/**
 * view.yaml. `members` are the parts drawn at the top level beside the domains that
 * have no parent. A part the view does not place is hidden or drawn at the top, as
 * `unplaced` says — never silently lost. `layout` places the top level.
 */
export const zView = z.object({
  apiVersion: zApiVersion,
  kind: z.literal('View'),
  metadata: zMetadata,
  spec: z
    .object({
      /**
       * How the view is drawn (docs/interpretation.md): `grouping` places the
       * composition's parts in domains; `flow` and `architecture` are sets of diagrams
       * — how the application thinks, and what it is built on.
       */
      shape: z.enum(['grouping', 'flow', 'architecture']).default('grouping'),
      /** For a diagram view: the diagram it opens at. */
      entry: zId.optional(),
      members: z.array(zId).default([]),
      unplaced: z.enum(['hide', 'top']).default('top'),
      /** A sentence on what this way of looking shows. */
      description: z.string().min(1).optional(),
    })
    .default({ shape: 'grouping', members: [], unplaced: 'top' }),
  layout: zLayout,
});

/** The node kinds of each diagram shape: closed, like every vocabulary (PRD §3). */
export const FLOW_NODE_KINDS = ['actor', 'trigger', 'agent', 'orchestrator', 'guard', 'step', 'tools', 'store', 'output', 'flow'] as const;
export const ARCHITECTURE_NODE_KINDS = ['client', 'service', 'worker', 'datastore', 'queue', 'external', 'platform', 'concern'] as const;
export const FLOW_EDGE_KINDS = ['next', 'uses'] as const;
export const ARCHITECTURE_EDGE_KINDS = ['uses', 'calls', 'hosts', 'governs'] as const;

/** A decision that defines a piece: what was chosen, why when it is said, where it shows. */
export const zDecision = z.object({
  statement: z.string().min(1),
  why: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)).default([]),
  source: z.enum(['code', 'docs']).optional(),
});

export const zDiagramNode = z.object({
  id: zId,
  kind: z.string().min(1),
  name: z.string().min(1),
  /** One sentence on what it is or does. */
  summary: z.string().min(1).optional(),
  /** The composition parts that implement it. */
  realizedBy: z.array(zId).default([]),
  /** Where the reading rests: "path" or "path:line". */
  evidence: z.array(z.string().min(1)).default([]),
  decisions: z.array(zDecision).default([]),
  /** Another diagram of the same view, to step into. */
  ref: zId.optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
});

export const zDiagramEdge = z.object({
  id: zId,
  from: zId,
  to: zId,
  kind: z.string().min(1),
  /** What passes, in a few words. */
  label: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)).default([]),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
});

/**
 * One diagram of a flow or architecture view (docs/interpretation.md). Unlike the
 * dataflow canvas it does not execute, so it may loop: a check that sends work back is
 * a loop, and drawing it is the point.
 */
export const zDiagram = z.object({
  apiVersion: zApiVersion,
  kind: z.literal('Diagram'),
  metadata: zMetadata,
  spec: z.object({
    description: z.string().min(1).optional(),
    nodes: z.array(zDiagramNode).default([]),
    edges: z.array(zDiagramEdge).default([]),
  }),
  layout: zLayout,
});

/**
 * One domain of a view: a part of the application you step into. `members` are the
 * parts directly inside it; a domain sits inside another through `parent`. `layout`
 * places what is drawn inside it. `evidence` and `unsure` are what the lift found —
 * where its reading rests, and which members it placed on weak evidence.
 */
export const zDomain = z.object({
  apiVersion: zApiVersion,
  kind: z.literal('Domain'),
  metadata: zMetadata,
  spec: z.object({
    parent: zId.optional(),
    members: z.array(zId).default([]),
    description: z.string().min(1).optional(),
    foundation: z.boolean().optional(),
    evidence: z.array(z.string().min(1)).optional(),
    unsure: z.array(zId).optional(),
  }),
  layout: zLayout,
});

export type View = z.infer<typeof zView>;
export type Domain = z.infer<typeof zDomain>;
export type Diagram = z.infer<typeof zDiagram>;
export type DiagramNode = z.infer<typeof zDiagramNode>;
export type DiagramEdge = z.infer<typeof zDiagramEdge>;
export type Decision = z.infer<typeof zDecision>;
