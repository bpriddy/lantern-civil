import { parse } from 'yaml';
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

/**
 * The paths planAgentDissolution reads — graph docs (to find agent nodes), plus every
 * agents/ and prompts/ file — ensured up front so a lazy (github) source has them local.
 */
export function dissolutionInputs(source: ProjectSource): string[] {
  return source
    .list()
    .filter(
      (p) =>
        /^(civil\/)?graphs\/[^/]+\.ya?ml$/.test(p) ||
        p.startsWith('agents/') ||
        p.startsWith('prompts/'),
    );
}

// ---------------------------------------------------------------------------
// agent.yaml dissolution (docs/emitted-code.md)
// ---------------------------------------------------------------------------

/**
 * Moving a project from the agent.yaml world to the emitted-code world
 * (docs/emitted-code.md): each agent node's prompt becomes an app asset at
 * prompts/<node-id>.md, the agent.yaml is deleted, and the referencing graph node
 * drops its ref (keeping a display name). A pinned model or a non-default turn budget
 * has no home in the graph any more — under the contract they are literal kwargs in the
 * emitted code — so the plan surfaces them as warnings rather than dropping them
 * silently. Planned as reviewable pending changes, exactly like planMigration.
 */
export interface AgentDissolutionPlan {
  /** A prompt file relocated to prompts/<node-id>.md. */
  moves: DocMove[];
  /** agent.yaml files, now unreferenced, to delete. */
  deletes: string[];
  /** Graph documents rewritten in place (from === to): the agent node drops its ref. */
  rewrites: DocMove[];
  /** Config the graph can no longer carry — a pinned model / non-default turn budget. */
  warnings: string[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Parse loosely — the agent.yaml is on its way out, so its exact schema is moot. */
function looseParse(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  try {
    return asObject(parse(source));
  } catch {
    return undefined;
  }
}

/**
 * Drop the `ref: <ref>` from an agent node — replaced in place with `name: <name>`
 * when a name is to be added, else removed whole. A text rewrite, so comments and
 * layout survive (PRD 6.5). Flow style (`{ ..., ref: x }`) loses the comma-led token;
 * block style loses the whole `ref:` line.
 */
export function dissolveAgentRef(content: string, ref: string, name: string | undefined): string {
  const val = `['"]?${escapeRe(ref)}['"]?`;
  if (name !== undefined) {
    return content.replace(new RegExp(`ref:(\\s*)${val}`), (_m, gap: string) => `name:${gap}${name}`);
  }
  const flow = new RegExp(`,\\s*ref:\\s*${val}`);
  if (flow.test(content)) return content.replace(flow, '');
  return content.replace(new RegExp(`^[^\\S\\n]*ref:\\s*${val}[^\\S\\n]*\\n`, 'm'), '');
}

/** The graph documents at the conventional top-level layout, root or civil/. */
function allGraphDocs(source: ProjectSource): string[] {
  return source.list().filter((p) => /^(civil\/)?graphs\/[^/]+\.ya?ml$/.test(p));
}

/**
 * The dissolution plan, or null when no agent node references an agent.yaml to dissolve.
 */
export function planAgentDissolution(source: ProjectSource): AgentDissolutionPlan | null {
  const moves: DocMove[] = [];
  const deletes = new Set<string>();
  const rewrites: DocMove[] = [];
  const warnings: string[] = [];
  const movedTo = new Set<string>();

  for (const graphPath of allGraphDocs(source)) {
    const content = source.read(graphPath);
    if (content === undefined) continue;
    const nodes = asObject(looseParse(content)?.['spec'])?.['nodes'];
    if (!Array.isArray(nodes)) continue;

    let rewritten = content;
    let changed = false;
    for (const raw of nodes) {
      const node = asObject(raw);
      if (!node || node['type'] !== 'agent' || typeof node['id'] !== 'string') continue;
      const id = node['id'];
      const nodeName = node['name'];
      const nodeHasName = typeof nodeName === 'string' && nodeName.length > 0;

      let name = nodeHasName ? (nodeName as string) : undefined;
      let promptFile: string | undefined;

      const ref = node['ref'];
      if (typeof ref === 'string') {
        deletes.add(ref);
        const agent = looseParse(source.read(ref));
        const spec = asObject(agent?.['spec']) ?? {};
        if (typeof spec['promptFile'] === 'string') promptFile = spec['promptFile'];
        const metaName = asObject(agent?.['metadata'])?.['name'];
        if (!name && typeof metaName === 'string') name = metaName;
        if (spec['model'] !== undefined) {
          warnings.push(
            `agent "${id}" pinned model "${String(spec['model'])}"; agent.yaml no longer carries it — set it as the Engine(model=...) literal in the emitted agent module`,
          );
        }
        if (spec['maxTurns'] !== undefined && spec['maxTurns'] !== 8) {
          warnings.push(
            `agent "${id}" set maxTurns ${String(spec['maxTurns'])}; edit the max_turns literal in the emitted agent module (the default is 8)`,
          );
        }
        // The node drops its ref, gaining a display name when the agent.yaml named
        // one and the node did not already carry its own.
        rewritten = dissolveAgentRef(rewritten, ref, nodeHasName ? undefined : name);
        changed = true;
      }

      const target = `prompts/${id}.md`;
      if (promptFile && promptFile !== target && !movedTo.has(target)) {
        const promptContent = source.read(promptFile);
        if (promptContent !== undefined) {
          moves.push({ from: promptFile, to: target, content: promptContent });
          movedTo.add(target);
        }
      }
    }
    if (changed) rewrites.push({ from: graphPath, to: graphPath, content: rewritten });
  }

  if (moves.length === 0 && deletes.size === 0 && rewrites.length === 0) return null;
  return { moves, deletes: [...deletes], rewrites, warnings };
}
