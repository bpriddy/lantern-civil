import { createHash } from 'node:crypto';
import { Document } from 'yaml';
import type { Unit } from '../project/registry.js';
import { parse } from 'yaml';
import type { Provenance } from './claims.js';
import type { FileMap, Refinement } from './skeleton.js';

/**
 * civil/registry.yaml for a lifted project (docs/registry.md). The same shape a
 * transpile writes — apiVersion civil/v1, kind Registry, units keyed by the ids
 * deriveUnits computes from the documents — so registry.ts reads it unchanged. What
 * differs is who the implementation belongs to: every file is the repository's own
 * code, role `repo`, because nothing here was generated.
 *
 * There is no `generated_from`: no generation produced this code, so applyState reads
 * `never`, and Apply — which would generate Python — has nothing to be current with.
 * Infrastructure modules, which are on no canvas and so are no unit, are recorded under
 * `shared`, the registry's existing place for code that serves several units.
 */

export const LIFT_ROLE = 'repo';

/**
 * What a lift was read from, kept in the registry as `lifted_from` (docs/lift-repo.md).
 * The model pass is not deterministic — ask twice, get two wordings — so an Update
 * over unchanged code reuses the answer recorded here instead of asking again. That
 * is what makes "Update on an unchanged repository proposes nothing" hold with the
 * model on, and it saves the call. `fingerprint` covers what the model was shown (the
 * reader's skeleton and the docs); `refinement` is the validated answer, absent when
 * the lift had none (no runner, or the model pass failed — worth asking again).
 */
export interface LiftProvenance {
  fingerprint: string;
  refinement: Refinement | null;
  /**
   * Units a lift wrote that the author then removed from the canvas (app/<id>,
   * graph/<g>/<id>). Remembered so an Update does not add them back — the registry is
   * rebuilt from the documents, and without this a deletion would be forgotten one
   * Update later. Optional; absent means none.
   */
  removed?: string[];
}

/** The provenance the current registry records, or undefined when it has none. */
export function readLiftProvenance(text: string | undefined): LiftProvenance | undefined {
  if (text === undefined) return undefined;
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return undefined;
  }
  const from = (doc as { lifted_from?: { fingerprint?: unknown; refinement?: unknown; removed?: unknown } } | null)?.lifted_from;
  if (!from || typeof from.fingerprint !== 'string') return undefined;
  // Shape only; the caller re-validates the refinement against the skeleton it has.
  const refinement = from.refinement && typeof from.refinement === 'object' ? (from.refinement as Refinement) : null;
  const removed = Array.isArray((from as { removed?: unknown }).removed)
    ? ((from as { removed: unknown[] }).removed.filter((u) => typeof u === 'string') as string[])
    : [];
  return { fingerprint: from.fingerprint, refinement, ...(removed.length ? { removed } : {}) };
}

/** The same short content hash a transpile records, so a hand edit shows either way. */
const contentHash = (content: string): string =>
  `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Byte-stable for the same inputs: units and files sorted, no timestamps. A file's
 * hash is recorded when the repository's content was read (`repo`); without it the
 * entry carries the role alone rather than a hash of nothing.
 */
/** Evidence lines kept per unit: enough to go and look, not a second file list. */
const EVIDENCE_SHOWN = 5;

export function liftRegistry(
  units: readonly Unit[],
  filesOf: ReadonlyMap<string, readonly string[]>,
  shared: readonly string[],
  repo: FileMap | undefined,
  liftedFrom?: LiftProvenance,
  /** Unit id → the model's sentence on it, shown in the inspector beside the files. */
  descriptionOf: ReadonlyMap<string, string> = new Map(),
  /** Unit id → what Civil's belief in it rests on (claims.ts), for the inspector. */
  provenanceOf: ReadonlyMap<string, Provenance> = new Map(),
  /** Units a previous lift drew that the repository no longer shows: status not-found. */
  notFound: ReadonlySet<string> = new Set(),
): string {
  const entries = (paths: readonly string[]) => {
    const out: Record<string, { role: string; hash?: string }> = {};
    for (const path of [...new Set(paths)].sort(byString)) {
      const content = repo?.[path];
      out[path] = content === undefined ? { role: LIFT_ROLE } : { role: LIFT_ROLE, hash: contentHash(content) };
    }
    return out;
  };

  const body: Record<string, unknown> = {
    apiVersion: 'civil/v1',
    kind: 'Registry',
    ...(liftedFrom
      ? {
          lifted_from: {
            fingerprint: liftedFrom.fingerprint,
            ...(liftedFrom.refinement ? { refinement: liftedFrom.refinement } : {}),
            ...(liftedFrom.removed?.length ? { removed: [...liftedFrom.removed].sort(byString) } : {}),
          },
        }
      : {}),
    units: Object.fromEntries(
      [...units]
        .sort((a, b) => byString(a.id, b.id))
        .map((unit) => {
          const entry: Record<string, unknown> = { kind: unit.kind, source: unit.source };
          if (unit.boundary) entry['boundary'] = unit.boundary;
          if (unit.entrypoint) entry['entrypoint'] = unit.entrypoint;
          if (unit.dependsOn.length > 0) entry['depends_on'] = unit.dependsOn;
          // An extra key the registry readers ignore (registry.ts reads kind, source,
          // depends_on and files); the canvas inspector reads it for a lifted node.
          if (notFound.has(unit.id)) entry['status'] = 'not-found';
          const description = descriptionOf.get(unit.id);
          if (description) entry['description'] = description;
          // How sure Civil is, and the places in the code that say so — a handful,
          // enough to go and look; the files below are the full attribution.
          const believed = provenanceOf.get(unit.id);
          if (believed) {
            entry['confidence'] = believed.confidence;
            const cited = believed.evidence.slice(0, EVIDENCE_SHOWN).map((ev) => (ev.line ? `${ev.file}:${ev.line}` : ev.file));
            if (cited.length > 0) entry['evidence'] = cited;
            // Who said so: the reader, analysts, verifiers — sorted, so the bytes are stable.
            entry['voices'] = [...believed.supporters].sort(byString);
          }
          const files = filesOf.get(unit.id) ?? [];
          if (files.length > 0) entry['files'] = entries(files);
          return [unit.id, entry];
        }),
    ),
  };
  if (shared.length > 0) body['shared'] = { files: entries(shared) };

  const doc = new Document(body);
  doc.commentBefore =
    ' Maintained by Civil — rebuilt by Generate graph from repo from the civil documents\n' +
    " and the repository. The files listed are the repository's own code (role: repo);\n" +
    ' edits here are overwritten; change the canvas or the code instead.';
  return doc.toString({ lineWidth: 0 });
}
