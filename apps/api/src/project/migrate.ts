import type { ProjectSource } from './source.js';
import { CIVIL_DIR, civilYamlPath, compositionPathFor } from './bundle.js';

/**
 * Moving a project's documents into civil/ (delta 19). The documents relocate; the
 * refs among them gain the civil/ prefix so every path stays repo-root-relative,
 * uniform with the code refs that do not move. This plans the move as content the
 * caller lands as reviewable pending changes — never a silent rewrite of the repo.
 *
 * agents/ stays at the root for now: prompts become runtime-loaded app assets under
 * the emitted-code contract, and civil/ is never read at runtime, so agents move
 * with the later agent-dissolution step, not here. Their refs (agents/...) are left
 * untouched by the rewrite below, which only ever prefixes graph refs.
 */

export interface DocMove {
  from: string;
  to: string;
  content: string;
}

export interface MigrationPlan {
  moves: DocMove[];
}

/**
 * Prefix the civil-document refs that point within civil/ — a graph ref (impl.graph
 * or a subgraph node's ref, always under graphs/) and, in the project document, the
 * composition path. Everything else — code (entrypoint, include, a client path),
 * agents, io schemas — is left exactly as written, because it does not move. A text
 * rewrite, not a re-serialisation, so comments and layout survive (PRD 6.5).
 */
export function rewriteCivilRefs(content: string, isProjectDoc: boolean): string {
  // graph: graphs/x.yaml  and  ref: graphs/x.yaml  ->  civil/graphs/x.yaml
  // The value stops at whitespace or a YAML flow terminator ( } ] , ), and an
  // optional quote is preserved around it.
  let out = content.replace(
    /\b(graph|ref):(\s*)(['"]?)(graphs\/[^\s'"}\],]+)/g,
    (_m, key: string, gap: string, quote: string, value: string) =>
      `${key}:${gap}${quote}${CIVIL_DIR}/${value}`,
  );
  if (isProjectDoc) {
    // composition: app.yaml -> composition: civil/app.yaml (the composition moves too).
    out = out.replace(
      /\b(composition:)(\s*)(['"]?)([^\s'"}\],]+)/g,
      (_m, key: string, gap: string, quote: string, value: string) =>
        value.startsWith(`${CIVIL_DIR}/`) ? _m : `${key}${gap}${quote}${CIVIL_DIR}/${value}`,
    );
  }
  return out;
}

/** The graph documents at the conventional top-level layout, root or civil/. */
function graphDocs(source: ProjectSource): string[] {
  return source.list().filter((p) => /^graphs\/[^/]+\.ya?ml$/.test(p));
}

/**
 * The move set for a legacy (root-document) project, or null when there is nothing
 * to do — the project is already migrated (civil/civil.yaml present) or is not a
 * Civil project (no civil.yaml at all).
 */
export function planMigration(source: ProjectSource): MigrationPlan | null {
  if (source.exists(`${CIVIL_DIR}/civil.yaml`)) return null; // already migrated
  if (!source.exists('civil.yaml')) return null; // not a Civil project

  const compositionPath = compositionPathFor(source); // legacy: the root composition
  const docs = new Set<string>(['civil.yaml']);
  if (source.exists(compositionPath)) docs.add(compositionPath);
  for (const g of graphDocs(source)) docs.add(g);

  const moves: DocMove[] = [];
  for (const from of docs) {
    const content = source.read(from);
    if (content === undefined) continue;
    moves.push({
      from,
      to: `${CIVIL_DIR}/${from}`,
      content: rewriteCivilRefs(content, from === 'civil.yaml'),
    });
  }
  return { moves };
}

/** The document paths a plan needs read before it can be built (github is lazy). */
export function migrationInputs(source: ProjectSource): string[] {
  return ['civil.yaml', civilYamlPath(source), compositionPathFor(source), ...graphDocs(source)];
}
