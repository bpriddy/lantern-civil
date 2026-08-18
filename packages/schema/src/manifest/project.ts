import { z } from 'zod';
import { zApiVersion, zMetadata, zRelPath } from './common.js';

/**
 * PRD 6.1 lists civil.yaml as project config but does not specify its contents.
 * This shape is ours and deliberately minimal — it holds only what has nowhere
 * else to live. See docs/prd-deltas.md.
 */
export const zProject = z.object({
  apiVersion: zApiVersion,
  kind: z.literal('Project'),
  metadata: zMetadata,
  spec: z.object({
    composition: zRelPath.default('app.yaml'),
    /** Falls back for any agent that does not name a model. */
    defaultModel: z.string().min(1).optional(),
    /** PRD 15: Python only in v1. Present so the assumption is visible, not buried. */
    language: z.literal('python').default('python'),
  }),
});

export type Project = z.infer<typeof zProject>;
