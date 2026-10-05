import { z } from 'zod';
import { zApiVersion, zMetadata, zRelPath } from './common.js';

/** The languages a project can be written in; only python is generated. */
export const zLanguage = z.enum(['python', 'typescript']);
export type Language = z.infer<typeof zLanguage>;

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
    /**
     * PRD 15: Civil generates Python only. `typescript` marks a project lifted from an
     * existing TypeScript codebase (docs/lift-repo.md): its own code is the
     * implementation, so the canvas describes it and Apply refuses to generate — never
     * Python beside the repo's TypeScript. Absent means python, as it always has.
     */
    language: zLanguage.default('python'),
  }),
});

export type Project = z.infer<typeof zProject>;
