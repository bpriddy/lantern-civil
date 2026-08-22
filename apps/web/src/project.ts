import type {
  Agent,
  Composition,
  Diagnostic,
  Graph,
} from '@civil/schema';

/**
 * Every API call, with caching off.
 *
 * The server sends `cache-control: no-store`, but that only governs responses it
 * actually gets to send. A 404 or 410 already sitting in the browser cache keeps
 * being served without the request ever reaching the server, so a transient failure
 * survives a reload and the application looks permanently broken while the server is
 * healthy. Asking for fresh data on the client is what recovers from that.
 */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, cache: 'no-store' });
}

/**
 * Cancelling a request is not a failure.
 *
 * Every load here aborts on cleanup, and React runs cleanup immediately in
 * development, so an uncaught abort is guaranteed rather than rare. Treating it as an
 * error would also mean showing the user a message about something they did not do.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export interface ProjectSummary {
  id: string;
  name: string;
  headSha?: string | null;
  sourceKind: 'github' | 'local' | 'example';
  defaultBranch: string;
  repoOwner: string | null;
  repoName: string | null;
  exampleSlug: string | null;
}

export interface RepositorySummary {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
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
  const response = await apiFetch('/api/projects', { signal: signal ?? null });
  if (!response.ok) throw new Error(`projects: ${response.status}`);
  return ((await response.json()) as { projects: ProjectSummary[] }).projects;
}

export async function fetchBundle(id: string, signal?: AbortSignal): Promise<ProjectBundle> {
  const response = await apiFetch(`/api/projects/${id}/bundle`, { signal: signal ?? null });
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
  const response = await apiFetch('/api/examples', { signal: signal ?? null });
  if (!response.ok) return [];
  return ((await response.json()) as { examples: ExampleDefinition[] }).examples;
}

export async function openExample(slug: string): Promise<ProjectSummary> {
  const response = await apiFetch(`/api/examples/${slug}/open`, { method: 'POST' });
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
  const response = await apiFetch(
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
  const response = await apiFetch(`/api/projects/${projectId}/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) throw new Error(await describeFailure(response, `could not save ${path}`));
}

export async function revertFile(projectId: string, path: string): Promise<void> {
  const response = await apiFetch(
    `/api/projects/${projectId}/pending?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' },
  );
  // fetch resolves on any HTTP status. Without this check a failed revert — expired
  // session, row already gone — reported success, and undo told the user it had
  // undone something it had not.
  if (!response.ok && response.status !== 404) {
    throw new Error(await describeFailure(response, 'could not revert'));
  }
}

export interface CommitResult {
  commit: string;
  url: string;
  files: number;
  reparentedOnto: string | null;
}

export async function commitProject(projectId: string, message: string): Promise<CommitResult> {
  const response = await apiFetch(`/api/projects/${projectId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { message?: string }).message ?? `commit failed (${response.status})`);
  return body as CommitResult;
}


/** Repositories the connected installation can reach — GitHub decides, not Civil. */
export async function fetchRepositories(
  signal?: AbortSignal,
): Promise<{ total: number; repositories: RepositorySummary[] } | { error: string }> {
  const response = await apiFetch('/api/github/repositories', { signal: signal ?? null });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { error: (body as { message?: string; error?: string }).message
      ?? (body as { error?: string }).error
      ?? `could not list repositories (${response.status})` };
  }
  return body as { total: number; repositories: RepositorySummary[] };
}

export async function openRepository(
  repo: RepositorySummary,
): Promise<ProjectSummary> {
  const response = await apiFetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoOwner: repo.owner, repoName: repo.name, name: repo.name }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { message?: string }).message ?? `could not open ${repo.fullName}`);
  }
  return (body as { project: ProjectSummary }).project;
}

export async function removeProject(projectId: string): Promise<void> {
  await apiFetch(`/api/projects/${projectId}`, { method: 'DELETE' });
}


export type ManifestOp =
  | { op: 'addNode'; node: Record<string, unknown> }
  | { op: 'setLayout'; id: string; x: number; y: number }
  | { op: 'addEdge'; edge: Record<string, unknown> }
  | { op: 'removeEdge'; id: string }
  | { op: 'removeNode'; id: string; cascadeEdges?: boolean }
  | { op: 'updateNode'; id: string; patch: Record<string, unknown> }
  | { op: 'updateEdge'; id: string; patch: Record<string, unknown> }
  | { op: 'renameNode'; from: string; to: string; updateReferences?: boolean };

export interface ApplyOutcome {
  summary: string;
  /** The file before the ops, and whether that state was itself a pending edit —
   *  exactly what undoing this application needs. */
  previous: string;
  hadPending: boolean;
}

/**
 * PRD 7.1: the client never constructs YAML. It posts ops and the server applies
 * them — which is also why an agent needs no separate write path.
 */
export async function applyOps(
  projectId: string,
  manifestPath: string,
  ops: ManifestOp[],
): Promise<ApplyOutcome> {
  const response = await apiFetch(`/api/projects/${projectId}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: manifestPath, ops }),
  });
  if (!response.ok) throw new Error(await describeFailure(response, 'could not apply'));
  return (await response.json()) as ApplyOutcome;
}

export interface DiffFile {
  path: string;
  kind: 'add' | 'modify' | 'delete' | 'rename';
  /** What HEAD says, or null when the file is new. */
  base: string | null;
  /** What the pending edit says, or null when the change is a delete. */
  current: string | null;
}

/** PRD 7: the commit indicator shows a count and a diff preview. This is the preview. */
export async function fetchDiff(
  projectId: string,
  signal?: AbortSignal,
): Promise<{ branch: string; files: DiffFile[] }> {
  const response = await apiFetch(`/api/projects/${projectId}/diff`, signal ? { signal } : {});
  if (!response.ok) throw new Error(await describeFailure(response, 'could not load the diff'));
  return (await response.json()) as { branch: string; files: DiffFile[] };
}


/** Adds Civil to a repository that does not have it yet. Writes pending changes. */
export async function initializeProject(
  projectId: string,
): Promise<{ files: string[]; summary: string }> {
  const response = await apiFetch(`/api/projects/${projectId}/initialize`, { method: 'POST' });
  if (!response.ok) throw new Error(await describeFailure(response, 'could not add Civil'));
  return (await response.json()) as { files: string[]; summary: string };
}


export interface TranspileResult {
  /** Every emitted path, now sitting in pending changes. */
  files: string[];
  /** The emission was replayed from the memo — same inputs, same bytes. */
  cached: boolean;
  /** civil/patterns.md was re-analyzed before emitting. */
  patternsRefreshed: boolean;
}

/** Turns the civil documents into code. Emitted files land as pending changes. */
export async function transpileProject(projectId: string): Promise<TranspileResult> {
  const response = await apiFetch(`/api/projects/${projectId}/transpile`, { method: 'POST' });
  if (!response.ok) {
    // A 422 carries the validator's issues — the actionable half of the failure.
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      issues?: string[];
    };
    const issues =
      Array.isArray(body.issues) && body.issues.length > 0 ? ` — ${body.issues.join('; ')}` : '';
    throw new Error(
      `${body.message ?? body.error ?? `could not transpile (${response.status})`}${issues}`,
    );
  }
  return (await response.json()) as TranspileResult;
}


/**
 * Picks up whatever has been pushed since. Civil edits against a pinned commit, so
 * advancing is something you ask for rather than something it does behind you.
 */
export async function syncProject(
  projectId: string,
): Promise<{ headSha: string; moved: boolean; summary: string }> {
  const response = await apiFetch(`/api/projects/${projectId}/sync`, { method: 'POST' });
  if (!response.ok) throw new Error(await describeFailure(response, 'could not sync'));
  return (await response.json()) as { headSha: string; moved: boolean; summary: string };
}


// ---- runs (PRD 8, 9.1) -----------------------------------------------------

export interface RunSummary {
  id: string;
  graphPath: string;
  status: 'queued' | 'running' | 'finished' | 'partial' | 'failed' | 'cancelled';
  eventSeq: number;
  error: string | null;
  createdAt: string;
}

export interface RunEvent {
  seq: number;
  type: string;
  nodeId: string | null;
  graphPath: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/** Starts a run of a graph. The answer is a job, not a result (PRD 8.2). */
export async function startRun(
  projectId: string,
  graph: string,
  input: unknown,
): Promise<RunSummary> {
  const response = await apiFetch(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ graph, input }),
  });
  if (!response.ok) throw new Error(await describeFailure(response, 'could not start the run'));
  return ((await response.json()) as { run: RunSummary }).run;
}

/** Events after a seq — reconnecting is a range read, not a resubscription. */
export async function fetchRunEvents(
  projectId: string,
  runId: string,
  after: number,
  signal?: AbortSignal,
): Promise<{ status: RunSummary['status']; eventSeq: number; events: RunEvent[] }> {
  const response = await apiFetch(
    `/api/projects/${projectId}/runs/${runId}/events?after=${after}`,
    signal ? { signal } : {},
  );
  if (!response.ok) throw new Error(await describeFailure(response, 'could not read the run'));
  const body = (await response.json()) as {
    run: { status: RunSummary['status']; eventSeq: number };
    events: RunEvent[];
  };
  return { status: body.run.status, eventSeq: body.run.eventSeq, events: body.events };
}

export async function cancelRun(projectId: string, runId: string): Promise<void> {
  const response = await apiFetch(`/api/projects/${projectId}/runs/${runId}/cancel`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(await describeFailure(response, 'could not cancel'));
}


// ---- the app session (docs/app-session.md) ---------------------------------

export interface SessionPreview {
  /** The client node this process serves. */
  name: string;
  /** Locally reachable directly — proxying belongs to the deployed adapter. */
  url: string;
}

export interface SessionProcess {
  name: string;
  running: boolean;
  /** Null while the process has not exited — including before it has started. */
  exitCode: number | null;
  port: number | null;
}

export interface SessionStatus {
  processes: SessionProcess[];
  previews: SessionPreview[];
  /** Boundary servers running in the session — the app even when no client is. */
  boundaries: SessionPreview[];
  /** Bumps on every write-through; the preview remounts when it moves, because
   *  an iframe cannot be trusted to hear the dev server's own reload push. */
  filesVersion?: number;
}

export interface SessionLogLine {
  seq: number;
  /** Which process said it — every process shares one log, tagged. */
  proc: string;
  line: string;
}

/**
 * Composition Run: transpile, materialise, start every process. One session per
 * project — asking again restarts rather than stacking.
 */
export async function startSession(projectId: string): Promise<{
  sessionId: string;
  previews: SessionPreview[];
  boundaries: SessionPreview[];
}> {
  const response = await apiFetch(`/api/projects/${projectId}/session`, { method: 'POST' });
  if (!response.ok) throw new Error(await describeFailure(response, 'could not start the app'));
  return (await response.json()) as {
    sessionId: string;
    previews: SessionPreview[];
    boundaries: SessionPreview[];
  };
}

/** Undefined is "no session" — a state the poll meets routinely, not a failure. */
export async function getSession(
  projectId: string,
  signal?: AbortSignal,
): Promise<SessionStatus | undefined> {
  const response = await apiFetch(`/api/projects/${projectId}/session`, signal ? { signal } : {});
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(await describeFailure(response, 'could not read the session'));
  return (await response.json()) as SessionStatus;
}

/** Lines after a seq — the same range-read shape as run events (PRD 8.2). */
export async function getSessionLogs(
  projectId: string,
  after: number,
  signal?: AbortSignal,
): Promise<{ lines: SessionLogLine[]; last: number }> {
  const response = await apiFetch(
    `/api/projects/${projectId}/session/logs?after=${after}`,
    signal ? { signal } : {},
  );
  if (!response.ok) throw new Error(await describeFailure(response, 'could not read the logs'));
  return (await response.json()) as { lines: SessionLogLine[]; last: number };
}

export async function stopSession(projectId: string): Promise<void> {
  const response = await apiFetch(`/api/projects/${projectId}/session`, { method: 'DELETE' });
  // A 404 is a session already gone — which is what stopping wanted.
  if (!response.ok && response.status !== 404) {
    throw new Error(await describeFailure(response, 'could not stop the app'));
  }
}
