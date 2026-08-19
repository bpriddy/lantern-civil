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
export interface PendingChange {
  path: string;
  kind: 'add' | 'modify' | 'delete' | 'rename';
  updatedAt: string;
}

export interface ContractPort {
  name: string;
  type: string | null;
  schema: Record<string, unknown> | null;
  required: boolean;
}

export interface Contract {
  name: string;
  description: string | null;
  isAsync: boolean;
  inputs: ContractPort[];
  output: { type: string | null; schema: Record<string, unknown> | null };
}

export type ContractResult = Contract | { error: string };

export const isContract = (c: ContractResult | undefined): c is Contract =>
  c !== undefined && !('error' in c);

export interface ProjectBundle {
  project: {
    id: string;
    name: string;
    defaultBranch: string;
    /** An example has no repository, so it has nowhere to commit to. */
    sourceKind: 'github' | 'local' | 'example';
  };
  compositionPath: string;
  composition: Composition | undefined;
  graphs: Record<string, Graph>;
  agents: Record<string, AgentEntry>;
  diagnostics: Diagnostic[];
  files: string[];
  pending: PendingChange[];
  /** PRD 7.2, keyed `manifestPath:nodeId`. Read from source, never declared. */
  contracts: Record<string, ContractResult>;
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

export interface ExampleDefinition {
  slug: string;
  name: string;
  description: string;
}

/** Quickstarts bundled with Civil. Not repositories — see CLAUDE.md. */
export async function fetchExamples(signal?: AbortSignal): Promise<ExampleDefinition[]> {
  const response = await fetch('/api/examples', { signal: signal ?? null });
  if (!response.ok) return [];
  return ((await response.json()) as { examples: ExampleDefinition[] }).examples;
}

export async function openExample(slug: string): Promise<ProjectSummary> {
  const response = await fetch(`/api/examples/${slug}/open`, { method: 'POST' });
  if (!response.ok) throw new Error(`could not open example: ${response.status}`);
  return ((await response.json()) as { project: ProjectSummary }).project;
}


export interface FileContents {
  path: string;
  content: string;
  language: string;
  pending: 'add' | 'modify' | 'delete' | 'rename' | null;
}

export async function fetchFile(
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileContents> {
  const response = await fetch(
    `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`,
    { signal: signal ?? null },
  );
  if (!response.ok) throw new Error(await describeFailure(response, `could not open ${path}`));
  return (await response.json()) as FileContents;
}

/**
 * The server says what went wrong and, on a 500, returns the request id that finds
 * the stack in the logs. Throwing away both and reporting a bare status turns a
 * traceable failure into a guess.
 */
async function describeFailure(response: Response, prefix: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
    requestId?: string;
  };
  const detail = body.message ?? body.error ?? response.statusText;
  const trace = body.requestId ? ` [${body.requestId}]` : '';
  return `${prefix}: ${response.status} ${detail}${trace}`;
}

/** PRD 7: save writes a pending change. Nothing auto-commits. */
export async function saveFile(projectId: string, path: string, content: string): Promise<void> {
  const response = await fetch(`/api/projects/${projectId}/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) throw new Error(await describeFailure(response, `could not save ${path}`));
}

export async function revertFile(projectId: string, path: string): Promise<void> {
  await fetch(`/api/projects/${projectId}/pending?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
}

export interface CommitResult {
  commit: string;
  url: string;
  files: number;
  reparentedOnto: string | null;
}

export async function commitProject(projectId: string, message: string): Promise<CommitResult> {
  const response = await fetch(`/api/projects/${projectId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { message?: string }).message ?? `commit failed (${response.status})`);
  return body as CommitResult;
}
