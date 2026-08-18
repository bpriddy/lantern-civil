import type {
  Agent,
  Composition,
  Diagnostic,
  Graph,
} from '@civil/schema';

export interface ProjectSummary {
  id: string;
  name: string;
  sourceKind: 'github' | 'local';
  defaultBranch: string;
}

export interface AgentEntry {
  ref: string;
  agent: Agent;
  prompt: string | undefined;
}

/**
 * The whole project in one payload. PRD 7 wants child manifests prefetched when the
 * parent renders so descent is "a continuous transform, not a page load" — having
 * every graph already in memory is what makes that true rather than aspirational.
 */
export interface ProjectBundle {
  project: { id: string; name: string; defaultBranch: string };
  compositionPath: string;
  composition: Composition | undefined;
  graphs: Record<string, Graph>;
  agents: Record<string, AgentEntry>;
  diagnostics: Diagnostic[];
  files: string[];
}

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const response = await fetch('/api/projects', { signal: signal ?? null });
  if (!response.ok) throw new Error(`projects: ${response.status}`);
  return ((await response.json()) as { projects: ProjectSummary[] }).projects;
}

export async function fetchBundle(id: string, signal?: AbortSignal): Promise<ProjectBundle> {
  const response = await fetch(`/api/projects/${id}/bundle`, { signal: signal ?? null });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `bundle: ${response.status}`);
  }
  return (await response.json()) as ProjectBundle;
}

/** PRD 6.4: diagnostics render on the offending node. This is the lookup that does it. */
export function diagnosticsByNode(diagnostics: Diagnostic[], file: string): Map<string, Diagnostic[]> {
  const map = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    if (d.file !== file || !d.nodeId) continue;
    const list = map.get(d.nodeId) ?? [];
    list.push(d);
    map.set(d.nodeId, list);
  }
  return map;
}
