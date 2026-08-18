import { z } from 'zod';
import { zApiVersion, zMetadata, zRelPath } from './common.js';

/**
 * PRD 6.3. Tool access is declared by capability edges in the graph, never
 * duplicated here — one source of truth.
 *
 * PRD 12: model ids are not hardcoded. Omitted means the project default;
 * the inspector offers a dropdown from a server-side list resolved at build time.
 */
export const zAgent = z.object({
  apiVersion: zApiVersion,
  kind: z.literal('Agent'),
  metadata: zMetadata,
  spec: z.object({
    model: z.string().min(1).optional(),
    promptFile: zRelPath,
    maxTurns: z.number().int().positive().optional(),
  }),
});

export type Agent = z.infer<typeof zAgent>;
