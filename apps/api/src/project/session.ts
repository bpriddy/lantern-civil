import type { Composition } from '@civil/schema';
import type { ProjectSource } from './source.js';
import type { FileRole } from './transpile.js';

/**
 * What the session substrate is told to run (docs/app-session.md). The API owns
 * everything decidable from the documents — which processes exist, their ports,
 * their commands — and the session service owns supervision. The specs here are
 * exactly the shape its POST /sessions accepts; keeping the derivation pure is what
 * makes it testable without a substrate.
 */

export interface ProcessSpec {
  name: string;
  cwd: string;
  setup?: string[][];
  cmd: string[];
  env?: Record<string, string>;
  port: number | null;
}

/**
 * The session service substitutes this literal in cmd[0] with its shared venv's
 * python — the service owns that venv, so the API never guesses at an interpreter
 * path on a machine it does not run on.
 */
export const SESSION_PYTHON = '$CIVIL_PYTHON';

/**
 * Ports are assigned deterministically, in node-id order, from a per-project base:
 * the preview pane can rely on a client keeping its port across restarts of the
 * same project. The base is offset from this floor by a hash of the project id,
 * because the session service runs several projects at once and a shared floor
 * would hand every project the same first port — the second bind dies.
 */
export const SESSION_PORT_BASE = 42000;

/**
 * 400 blocks of 20 ports: a session may hold up to 20 processes before spilling
 * into the next block, and two projects hashing to one block collide. Improbable,
 * not impossible — acceptable for the local adapter, which owns no port registry.
 */
export const SESSION_PORT_BLOCKS = 400;
export const SESSION_PORTS_PER_SESSION = 20;

/** FNV-1a, 32-bit: stable across processes and platforms, unlike anything seeded. */
export function sessionPortBase(projectId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i += 1) {
    hash ^= projectId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return SESSION_PORT_BASE + ((hash >>> 0) % SESSION_PORT_BLOCKS) * SESSION_PORTS_PER_SESSION;
}

/** 200KB mirrors the transpiler's per-file cap; the count cap is wider because a
 * node frontend is many small files, not a few large ones. */
export const SESSION_FILE_LIMIT = 400;
export const SESSION_FILE_MAX_BYTES = 200 * 1024;

/** Dependency trees and git internals are rebuilt in the session, never shipped to it. */
const SKIPPED_SEGMENTS = new Set(['node_modules', '.git']);

/** Extensions whose content is bytes, not text — the session materializes utf-8. */
const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|ico|icns|bmp|pdf|zip|gz|tgz|tar|woff2?|ttf|otf|eot|mp[34]|mov|avi|wasm|pyc|so|dylib|dll|jar|class|sqlite|db)$/i;

const stem = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

/** Locale-independent, matching the sort the memo key uses. */
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The full project file set the session materializes: everything the overlay lists,
 * under the caps above. The emitted files are merged on top by the caller — they may
 * not be in the overlay yet, and they must travel regardless of any cap.
 */
export async function gatherSessionFiles(source: ProjectSource): Promise<Record<string, string>> {
  const paths = source
    .list()
    .filter((p) => !p.split('/').some((segment) => SKIPPED_SEGMENTS.has(segment)))
    .filter((p) => !BINARY_EXTENSIONS.test(p));
  await source.ensure?.(paths);

  const files: Record<string, string> = {};
  let count = 0;
  for (const path of paths) {
    if (count >= SESSION_FILE_LIMIT) break;
    const content = source.read(path);
    if (content === undefined) continue;
    if (Buffer.byteLength(content, 'utf8') > SESSION_FILE_MAX_BYTES) continue;
    // Binary that dodged the extension list still announces itself.
    if (content.includes('\u0000')) continue;
    files[path] = content;
    count += 1;
  }
  return files;
}

export interface SessionProcess {
  name: string;
  port: number;
}

export interface DerivedProcesses {
  processes: ProcessSpec[];
  /** Client-node processes — the app surfaces the preview pane points at. */
  previews: SessionProcess[];
  /** Emitted boundary servers, likewise addressable. */
  boundaries: SessionProcess[];
}

/**
 * Composition documents plus the transpiler's roles map become process specs:
 * every web client with a dev script runs it (under the $PORT convention,
 * docs/app-session.md), and every file the transpiler marked boundary-server runs
 * under the service's python. Ports count up from the project's port base —
 * clients in node-id order first, then boundary servers — so the same documents
 * always yield the same addresses.
 */
export function deriveProcesses(
  projectId: string,
  composition: Composition | undefined,
  files: Record<string, string>,
  roles: Record<string, FileRole>,
): DerivedProcesses {
  const nodes = composition?.spec.nodes ?? [];
  const processes: ProcessSpec[] = [];
  const previews: SessionProcess[] = [];
  const boundaries: SessionProcess[] = [];
  let nextPort = sessionPortBase(projectId);

  const clients = nodes
    .filter((n) => n.type === 'client' && n.client === 'web' && Boolean(n.dev))
    .sort((a, b) => byString(a.id, b.id));

  for (const node of clients) {
    if (node.type !== 'client' || !node.dev) continue; // narrows for the compiler
    const port = nextPort;
    nextPort += 1;
    const dir = node.path.replace(/\/+$/, '');
    // npm install only when there is a package.json to install from — an empty
    // setup step would just spend a minute saying "up to date" in the log. The
    // session service accepts '.' and './web' as a cwd, so a manifest may spell
    // the path either way; the file set's keys never do, so the lookup normalizes.
    const lookupDir = dir.replace(/^\.\/+/, '').replace(/^\.$/, '');
    const hasPackage = `${lookupDir && `${lookupDir}/`}package.json` in files;
    processes.push({
      name: node.id,
      cwd: dir,
      ...(hasPackage ? { setup: [['npm', 'install']] } : {}),
      // Through a shell so a dev script stays a script ("vite", "next dev -p 3000"),
      // exactly as package.json would run it.
      cmd: ['sh', '-c', node.dev],
      port,
    });
    previews.push({ name: node.id, port });
  }

  const serverFiles = Object.keys(roles)
    .filter((path) => roles[path] === 'boundary-server')
    .sort(byString);

  // One emitted server and one api boundary pair unambiguously; any other count
  // falls back to the file stem, because a guessed pairing would put the wrong
  // node's name on a process log.
  const apiBoundaryIds = nodes
    .filter((n) => n.type === 'boundary' && n.boundary === 'api')
    .map((n) => n.id);

  for (const path of serverFiles) {
    const port = nextPort;
    nextPort += 1;
    const name =
      serverFiles.length === 1 && apiBoundaryIds.length === 1 ? apiBoundaryIds[0]! : stem(path);
    processes.push({
      name,
      cwd: '.',
      cmd: [SESSION_PYTHON, path],
      // The emitted server imports the app's own modules from the workspace root.
      env: { PYTHONPATH: '.' },
      port,
    });
    boundaries.push({ name, port });
  }

  return { processes, previews, boundaries };
}
