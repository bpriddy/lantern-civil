import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PRD 7.2: the contract is read from the source, not duplicated in a manifest.
 *
 * The reading itself is Python (`civil_runtime.discover`) rather than TypeScript,
 * because at M4 the runtime binds arguments to these same functions. One
 * implementation answering "what is this function's contract" is the whole point —
 * a second one in another language is exactly the place the PRD refuses to let the
 * canvas and the runner disagree.
 *
 * Source is passed on stdin, never as a path: the file may exist only as a pending
 * change in Postgres or a blob in GitHub, and CLAUDE.md forbids materialising it.
 */

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

export interface ContractRequest {
  key: string;
  source: string;
  /** Capability targets name the function on the edge (PRD 5) rather than by convention. */
  function?: string | undefined;
}

export type ContractResult = Contract | { error: string };

/** Bounded so a pathological file cannot hold a request open. */
const TIMEOUT_MS = 10_000;

const here = path.dirname(fileURLToPath(import.meta.url));

function runtimeSrc(): string | undefined {
  const candidates = [
    path.resolve(here, '../../../../runtime/src'), // dist/project -> repo root
    path.resolve(here, '../../../runtime/src'),
    path.resolve(process.cwd(), 'runtime/src'),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'civil_runtime', 'discover.py')));
}

/**
 * Discovery is a nicety, not a load-bearing path: without Python the canvas still
 * renders, nodes simply show no discovered ports. So a missing interpreter is
 * reported once and then treated as "no contracts", never as a failed request.
 */
let unavailable: string | undefined;

export async function discoverContracts(
  requests: readonly ContractRequest[],
  options: { python?: string } = {},
): Promise<Map<string, ContractResult>> {
  const out = new Map<string, ContractResult>();
  if (requests.length === 0) return out;

  const src = runtimeSrc();
  if (!src) {
    unavailable ??= 'civil_runtime is not on disk; ports will not be discovered';
    return out;
  }

  const python = options.python ?? process.env['CIVIL_PYTHON'] ?? 'python3';

  const payload = JSON.stringify({
    requests: requests.map((r) => ({ key: r.key, source: r.source, function: r.function ?? null })),
  });

  const stdout = await new Promise<string | undefined>((resolve) => {
    const child = spawn(python, ['-m', 'civil_runtime.discover'], {
      env: { ...process.env, PYTHONPATH: src, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let collected = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => { collected += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', () => {
      clearTimeout(timer);
      unavailable ??= `could not run ${python}; ports will not be discovered`;
      resolve(undefined);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !collected) {
        // Enough of the traceback to name the failing line. 200 characters cut off
        // exactly the part that says what went wrong.
        unavailable ??= `civil_runtime.discover exited ${code}: ${stderr.trim().slice(-600)}`;
        resolve(undefined);
        return;
      }
      resolve(collected);
    });

    child.stdin.end(payload);
  });

  if (!stdout) return out;

  try {
    const parsed = JSON.parse(stdout) as { results?: Record<string, ContractResult> };
    for (const [key, value] of Object.entries(parsed.results ?? {})) out.set(key, value);
  } catch {
    unavailable ??= 'civil_runtime.discover returned unparseable output';
  }

  return out;
}

/** Reported once at boot rather than per request, so logs do not fill with it. */
export function contractDiscoveryProblem(): string | undefined {
  return unavailable;
}
