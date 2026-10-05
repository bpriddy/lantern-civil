#!/usr/bin/env node
/**
 * DEVELOPMENT ONLY — never a server path, never imported by the API.
 *
 * Runs the repository lift (docs/lift-repo.md) over a directory on this machine and
 * writes the civil/ documents it proposes to an output directory, so the reader and
 * mapper can be evaluated on real repositories without a project, a database, or the
 * browser. The server never reads the disk like this (CLAUDE.md: no local file storage
 * on the server path); it reads through the project source into the same in-memory
 * file map this script builds, and lands the result as pending changes.
 *
 * Usage (after `npm run build --workspace @civil/api`):
 *
 *   node apps/api/scripts/lift-dir.mjs <repo-dir> <out-dir> [--runner <url>] [--name <project name>]
 *
 * - The repository is only read (lazily, file by file, through a minimal source). Documents go to <out-dir>/civil/…, plus
 *   <out-dir>/skeleton.json (what the reader found) and <out-dir>/report.json.
 * - civil/ files already in <out-dir> are treated as the project's existing documents,
 *   so a second run is "Update graph from repo" and should rewrite nothing.
 * - --runner <url> adds the model pass through that runner's POST /lift/refine;
 *   without it the result is the deterministic reader's, as on a server with no runner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
// The same orchestration the route runs (select with selectLiftPaths → read → refine →
// map), so what this prints is what the product would propose.
const { liftRepository } = await import(path.join(dist, 'lift/index.js'));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[(i += 1)];
    else positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    console.error('usage: lift-dir.mjs <repo-dir> <out-dir> [--runner <url>] [--name <project name>]');
    process.exit(2);
  }
  return { repoDir: path.resolve(positional[0]), outDir: path.resolve(positional[1]), ...flags };
}

/** Every file under root, repo-relative with forward slashes — the source's list(). */
function listFiles(root) {
  // The same directories a project source never lists (project/source.ts IGNORED).
  const ignored = new Set(['.git', 'node_modules', '.civil', '__pycache__', '.venv', 'dist']);
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/** The runner's /lift/refine, called the way the API's callRunner does (no auth locally). */
const askRunner = (runnerUrl) => async (body) => {
  const response = await fetch(`${runnerUrl.replace(/\/$/, '')}/lift/refine`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`runner answered ${response.status}`), { body: parsed });
  return parsed;
};

const args = parseArgs(process.argv.slice(2));
const started = performance.now();

// The project as the route would see it: the repository's files, with civil/ taken
// from the output directory (the "pending" documents an earlier run left there).
// Reads are synchronous and lazy, like LocalSource; nothing here ever writes the repo.
const repoFiles = listFiles(args.repoDir).filter((p) => !p.startsWith('civil/'));
const outCivil = fs.existsSync(path.join(args.outDir, 'civil'))
  ? listFiles(args.outDir).filter((p) => p.startsWith('civil/'))
  : [];
const fromOut = new Set(outCivil);
const listed = [...repoFiles, ...outCivil].sort();
const readFile = (p) => {
  const full = path.join(fromOut.has(p) ? args.outDir : args.repoDir, p);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined;
};
const source = {
  list: () => listed,
  read: readFile,
  exists: (p) => readFile(p) !== undefined,
  glob: () => [],
};
const existing = Object.fromEntries(outCivil.map((p) => [p, readFile(p)]));

let result;
try {
  result = await liftRepository(source, {
    projectName: args.name ?? path.basename(args.repoDir),
    ask: args.runner ? askRunner(args.runner) : undefined,
  });
} catch (error) {
  // Refused before any work (a Python project, documents at the root): the route
  // answers 422 with the same words; nothing was written.
  if (error?.name !== 'LiftRefusal') throw error;
  console.error(`refused (${error.code}): ${error.message}`);
  process.exit(3);
}
const mapped = result;

// Write only what differs, and say which, so a re-run's "nothing changed" is visible.
const changed = [];
for (const [p, content] of Object.entries(mapped.files).sort()) {
  if (existing[p] === content) continue;
  fs.mkdirSync(path.dirname(path.join(args.outDir, p)), { recursive: true });
  fs.writeFileSync(path.join(args.outDir, p), content);
  changed.push(p);
}
const s = result.skeleton;
const report = {
  filesListed: result.filesListed,
  filesRead: result.filesRead,
  filesDropped: result.filesDropped,
  totalMs: Math.round(performance.now() - started),
  servers: s.servers.length,
  routes: s.servers.reduce((n, server) => n + server.routes.length, 0),
  services: s.services.length,
  infrastructure: s.services.filter((svc) => svc.infrastructure).length,
  agents: s.agents.length,
  processes: s.processes.length,
  clients: s.clients.length,
  unresolved: s.unresolved.length,
  // Whether the model's names and classes are in: true after a fresh model pass and
  // after reusing the one the registry recorded for unchanged code.
  modelPass: /\n  refinement:/.test(mapped.files['civil/registry.yaml'] ?? '') ? 'applied' : 'not applied',
  note: result.note,
  diagnostics: mapped.diagnostics,
  documents: Object.keys(mapped.files).sort(),
  changed,
};
fs.mkdirSync(args.outDir, { recursive: true });
fs.writeFileSync(path.join(args.outDir, 'skeleton.json'), `${JSON.stringify(s, null, 2)}\n`);
fs.writeFileSync(path.join(args.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(mapped.summary);
console.log(JSON.stringify({ ...report, documents: report.documents.length }, null, 2));
