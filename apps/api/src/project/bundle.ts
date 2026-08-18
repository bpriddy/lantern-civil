import {
  validateProject,
  zAgent,
  zGraph,
  zProject,
  type Agent,
  type Composition,
  type Diagnostic,
  type Graph,
} from '@civil/schema';
import { parse } from 'yaml';
import { validateComposition } from '@civil/schema';
import type { ProjectSource } from './source.js';

/**
 * Everything the editor needs to render a project at every altitude, in one response.
 *
 * PRD 7 asks for child manifests to be prefetched when the parent renders so descent
 * is instant — "a continuous transform, not a page load". Sending the whole set makes
 * descent a local state change with no network in the path at all, which is the only
 * way a 250ms transform is honest rather than a spinner with an animation on top.
 *
 * This is affordable because PRD 2 scopes Civil to one user and ordinary projects. If
 * a project ever gets big enough for this to hurt, the seam to make it lazy is the
 * graphs map, not the shape of the response.
 */
export interface AgentEntry {
  ref: string;
  agent: Agent;
  /** Resolved so the inspector and semantic zoom (PRD 7) do not each refetch it. */
  prompt: string | undefined;
}

export interface ProjectBundle {
  compositionPath: string;
  composition: Composition | undefined;
  graphs: Record<string, Graph>;
  agents: Record<string, AgentEntry>;
  /** Every diagnostic for the whole project, already attributed to file and node. */
  diagnostics: Diagnostic[];
  files: string[];
}

const parseYaml = (source: ProjectSource, path: string): unknown => {
  const raw = source.read(path);
  if (raw === undefined) return undefined;
  try {
    return parse(raw);
  } catch {
    // A YAML syntax error surfaces as a diagnostic from the validator rather than an
    // exception here, so one broken file cannot blank the whole canvas.
    return undefined;
  }
};

/** PRD 6.1 names civil.yaml as project config; it decides which file is the canvas. */
export function compositionPathFor(source: ProjectSource): string {
  const raw = parseYaml(source, 'civil.yaml');
  const parsed = zProject.safeParse(raw);
  return parsed.success ? parsed.data.spec.composition : 'app.yaml';
}

export function loadBundle(source: ProjectSource): ProjectBundle {
  const compositionPath = compositionPathFor(source);

  // The shared validator walks the project and reports every diagnostic. Doing this
  // first means the parse below never has to decide what is wrong, only what is there.
  const { diagnostics, graphFiles } = validateProject(compositionPath, {
    files: source,
    loadDoc: (p) => parseYaml(source, p),
  });

  const compositionResult = validateComposition(
    parseYaml(source, compositionPath),
    compositionPath,
    source,
  );

  const graphs: Record<string, Graph> = {};
  const agents: Record<string, AgentEntry> = {};

  for (const path of graphFiles) {
    const parsed = zGraph.safeParse(parseYaml(source, path));
    if (!parsed.success) continue;
    graphs[path] = parsed.data;

    for (const node of parsed.data.spec.nodes) {
      if (node.type !== 'agent' || agents[node.ref]) continue;
      const agentDoc = zAgent.safeParse(parseYaml(source, node.ref));
      if (!agentDoc.success) continue;
      agents[node.ref] = {
        ref: node.ref,
        agent: agentDoc.data,
        prompt: source.read(agentDoc.data.spec.promptFile),
      };
    }
  }

  return {
    compositionPath,
    composition: compositionResult.doc,
    graphs,
    agents,
    diagnostics,
    files: source.list(),
  };
}
