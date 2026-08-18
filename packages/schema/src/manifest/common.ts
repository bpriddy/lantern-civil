import { z } from 'zod';

/** Every manifest Civil writes carries this. Bump only with a migration path. */
export const CIVIL_API_VERSION = 'civil/v1' as const;

/**
 * PRD 6.4 states `^[a-z][a-z0-9-]{0,63}$`, but its own example graph declares
 * `search_tools`. Widened to admit underscores so a code node's id can match the
 * Python module it points at. See docs/prd-deltas.md.
 */
export const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const zId = z
  .string()
  .regex(
    ID_PATTERN,
    'must be lowercase letters, digits, hyphens and underscores, starting with a letter, max 64 chars',
  );

export const zApiVersion = z.literal(CIVIL_API_VERSION);

export const zMetadata = z.object({
  id: zId,
  name: z.string().min(1).optional(),
});

/** A path relative to the project root. Resolution is checked separately (see validate.ts). */
export const zRelPath = z.string().min(1).refine((p) => !p.startsWith('/') && !p.includes('..'), {
  message: 'must be a project-relative path without ".." segments',
});

export const zPoint = z.object({ x: z.number(), y: z.number() });

/**
 * PRD 6.3: layout is a SIBLING of spec, never inside it. Dragging a node must not
 * produce a diff that looks like a semantic change.
 */
export const zLayout = z
  .object({ nodes: z.record(zId, zPoint).default({}) })
  .default({ nodes: {} });

export type Point = z.infer<typeof zPoint>;
export type Layout = z.infer<typeof zLayout>;
export type Metadata = z.infer<typeof zMetadata>;
