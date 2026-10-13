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
      members: z.array(zId).default([]),
      unplaced: z.enum(['hide', 'top']).default('top'),
      /** A sentence on what this way of looking shows. */
      description: z.string().min(1).optional(),
    })
    .default({ members: [], unplaced: 'top' }),
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
