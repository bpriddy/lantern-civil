import { posix } from 'node:path';
import { civilId } from './read.js';
import type { FileMap, Skeleton, SkeletonRoute } from './skeleton.js';

/**
 * Schedules the code does not declare. A NestJS app scheduled from outside — a cloud
 * scheduler posting to one of its routes every five minutes — has no @Cron to read;
 * the schedule is written down in the repository's infrastructure instead, and that
 * is where this reads it (docs/lift-repo.md).
 *
 * Terraform's `google_cloud_scheduler_job` today: its `schedule` and the path its
 * `http_target.uri` ends in, matched against the routes the reader found. A job is a
 * process only when both are fixed in the text and the path is a route some service
 * serves — a schedule held in a variable, or a path no route matches, is reported in
 * `unresolved`, never drawn as a guess.
 *
 * Text only, like the rest of the reader: no HCL evaluator, no `terraform` binary. The
 * interpolations it can see through are the module's own string `locals`; anything
 * else in a uri (the target service's url) stands for "the host" and is dropped.
 */

const SCHEDULER_JOB = /resource\s+"google_cloud_scheduler_job"\s+"([^"]+)"\s*\{/g;

/** The text of a `{ … }` block starting at `open`, ignoring braces inside strings and comments. */
function blockAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      // Skip a string; `${` inside one opens no block that matters here.
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** `name = "value"` inside every `locals { }` block of a directory's .tf files. */
function localsOf(files: FileMap, dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.tf') || posix.dirname(path) !== dir) continue;
    for (const m of text.matchAll(/(^|\n)\s*locals\s*\{/g)) {
      const body = blockAt(text, m.index! + m[0].length - 1);
      for (const line of body.split('\n')) {
        const a = /^\s*([A-Za-z_][\w-]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(line);
        if (a) out.set(a[1]!, a[2]!);
      }
    }
  }
  return out;
}

const attr = (body: string, name: string): string | undefined =>
  new RegExp(`(^|\\n)\\s*${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(body)?.[2];

/**
 * The path a scheduler uri ends in. `${local.x}` is read from the module's locals; any
 * other interpolation is the host part and everything up to it is dropped.
 */
function pathOfUri(uri: string, locals: ReadonlyMap<string, string>): string | undefined {
  const HOST = '\u0000';
  let text = uri;
  for (let pass = 0; pass < 3 && text.includes('${'); pass += 1)
    text = text.replace(/\$\{\s*local\.([\w-]+)\s*\}/g, (whole, name: string) => locals.get(name) ?? HOST);
  text = text.replace(/\$\{[^}]*\}/g, HOST);
  let path = text.includes(HOST) ? text.slice(text.lastIndexOf(HOST) + 1) : text.replace(/^[a-z]+:\/\/[^/]*/i, '');
  path = path.split(/[?#]/)[0]!;
  return path.startsWith('/') ? path : undefined;
}

const routeMatches = (route: SkeletonRoute, method: string, path: string): boolean => {
  if (route.method !== method && route.method !== 'ALL') return false;
  const pattern = route.path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}/?$`).test(path);
};

/** Adds the scheduler jobs the repository's Terraform declares as processes. */
export function readSchedulerJobs(files: FileMap, skeleton: Skeleton): void {
  if (!skeleton.servers.length) return;
  const taken = new Set(
    [...skeleton.clients, ...skeleton.servers, ...skeleton.services, ...skeleton.agents, ...skeleton.processes].map((e) => e.id),
  );
  const tf = Object.keys(files)
    .filter((p) => p.endsWith('.tf'))
    .sort();
  for (const path of tf) {
    const text = files[path]!;
    const locals = localsOf(files, posix.dirname(path));
    for (const m of text.matchAll(SCHEDULER_JOB)) {
      const name = m[1]!;
      const line = text.slice(0, m.index).split('\n').length;
      const body = blockAt(text, m.index! + m[0].length - 1);
      const where = { file: path, line };
      const schedule = attr(body, 'schedule');
      const uri = attr(body, 'uri');
      const method = (attr(body, 'http_method') ?? 'POST').toUpperCase();
      if (!schedule || !uri) {
        skeleton.unresolved.push({ ...where, reason: `scheduler job "${name}": its schedule or uri is not a fixed string; not drawn` });
        continue;
      }
      const target = pathOfUri(uri, locals);
      if (!target) {
        skeleton.unresolved.push({ ...where, reason: `scheduler job "${name}": cannot read the path its uri calls; not drawn` });
        continue;
      }
      let hit: { route: SkeletonRoute; server: string } | undefined;
      for (const server of skeleton.servers) {
        const route = server.routes.find((r) => routeMatches(r, method, target));
        if (route) {
          hit = { route, server: server.id };
          break;
        }
      }
      const service = hit
        ? (skeleton.services.find((s) => s.server === hit!.server && s.controllers.some((c) => c.name === hit!.route.controller && c.file === hit!.route.source.file)) ??
          skeleton.services.find((s) => s.controllers.some((c) => c.name === hit!.route.controller && c.file === hit!.route.source.file)))
        : undefined;
      if (!hit || !service) {
        skeleton.unresolved.push({ ...where, reason: `scheduler job "${name}" calls ${method} ${target}, which no route the reader found serves; not drawn` });
        continue;
      }
      // Named by what it calls — "/internal/reports/nightly" is reports-nightly — since a
      // resource's own name is often a placeholder ("this", "main").
      const segments = target.split('/').filter(Boolean);
      const wanted = civilId((segments.length > 1 ? segments.slice(1) : segments).join('-') || name);
      let id = wanted;
      if (taken.has(id)) id = civilId(`${wanted}-job`);
      for (let n = 2; taken.has(id); n += 1) id = civilId(`${wanted}-job-${n}`);
      taken.add(id);
      skeleton.processes.push({ id, schedule, calls: [service.id], source: where, route: `${hit.route.method} ${hit.route.path}` });
    }
  }
}
