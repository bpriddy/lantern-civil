import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalSource, type ProjectSource } from './source.js';

/**
 * Example projects, shipped inside Civil to be opened as quickstarts.
 *
 * These do not bend the one-project-per-repository rule: an example is not a
 * repository. Nor do they bend no-local-file-storage — they are immutable, shipped
 * with the code, and reconstructible by rebuilding the image, exactly like the SPA
 * bundle. Nothing on that disk is the only copy of anything.
 *
 * They are read through the ordinary source port, so the canvas, the validator, the
 * inspector, and the pending-change overlay all treat an example exactly like any
 * other project. The only thing that has to know the difference is committing, which
 * has nowhere to go.
 */

export interface ExampleDefinition {
  slug: string;
  name: string;
  description: string;
}

/**
 * A closed, hand-edited list, in the same spirit as PRD 3's closed node vocabulary.
 * Adding an example is a commit to Civil, not a feature of Civil.
 */
export const EXAMPLES: readonly ExampleDefinition[] = [
  {
    slug: 'doc-pipeline',
    name: 'Document Pipeline',
    description:
      'The PRD’s worked example: an api and mcp boundary over a graph-backed classify ' +
      'service, a function-backed save, and a nightly process. Descends two levels.',
  },
];

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolved rather than hardcoded because the layout differs between running from
 * source (repo/apps/api/src) and running the built image (/app/apps/api/dist).
 */
function examplesRoot(): string | undefined {
  const candidates = [
    path.resolve(here, '../../../../examples'), // dist/project -> repo root
    path.resolve(here, '../../../examples'),
    path.resolve(process.cwd(), 'examples'),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

export function findExample(slug: string): ExampleDefinition | undefined {
  return EXAMPLES.find((e) => e.slug === slug);
}

/** Read-only: nothing writes here, and pending edits live in Postgres as usual. */
export function openExample(slug: string): ProjectSource | undefined {
  if (!findExample(slug)) return undefined;

  const root = examplesRoot();
  if (!root) return undefined;

  const dir = path.join(root, slug);
  if (!fs.existsSync(dir)) return undefined;

  return new LocalSource(dir);
}
