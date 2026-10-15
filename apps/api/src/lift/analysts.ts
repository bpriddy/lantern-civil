import { createHash } from 'node:crypto';
import { isSampleCode, isTestSupport } from './read.js';
import { claimKey, isEntity, READER, type Claim, type Evidence } from './claims.js';
import { JsonText } from '../http/transpile-routes.js';
import type { FileMap, Skeleton } from './skeleton.js';

/**
 * The agent stage of the repo lift (docs/lift-repo.md, "Claims"): the repository is
 * split into areas, an analyst reads each with read-only tools and proposes claims, a
 * verifier checks each analyst's claims, and every claim comes back here to be weighed
 * with the reader's by claims.ts — one set of rules for every voice. The runner does
 * the model work (runner/analyze.py); this side decides what it is asked and never
 * trusts what comes back: claims are re-validated, and a new entity's skeleton fields
 * are filled only from its own evidence and attributes, never invented.
 *
 * Optional, like the model pass: with no runner, or any failure, the reader's claims
 * stand alone and the lift is exactly what it was.
 */

export type AnalyzeAsk = (body: unknown) => Promise<Record<string, unknown>>;

export interface Area {
  id: string;
  title: string;
  /** Path prefixes ("apps/api/src/billing/") — an area may join small siblings. */
  prefixes: string[];
  hint?: string;
  /** The domain this area is (§21), as the analyst is shown it. */
  domain?: { id: string; name: string; members: string[]; unsure: string[]; surfaces: string[] };
}

/** Files an area holds at most before it is split by its subdirectories. */
export const AREA_MAX_FILES = 80;
/** Siblings smaller than this are joined into one area rather than each getting an analyst. */
export const AREA_MIN_FILES = 12;
/** Analysts per lift at most; past it the smallest neighbours are joined. */
export const AREA_LIMIT = 12;

/**
 * Areas asked at once. With levels a lift has an area per domain and per top-level
 * service — twenty on a large codebase — and the whole lift must finish inside the
 * API's request timeout. The runner takes up to twelve at once (three instances of
 * four), and each call mostly waits on the model.
 */
export const ANALYSIS_CONCURRENCY = 8;

/** With levels, the code outside every domain shares at most this many analysts. */
export const LEFTOVER_LIMIT = 6;

const SOURCE = /\.(ts|tsx|mts|js|jsx|mjs|py|go|rb|java|kt|rs|cs|php)$/;
const INFRA = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|[^/]+\.tf|cloudbuild[^/]*\.ya?ml|Procfile|fly\.toml|app\.ya?ml|serverless\.ya?ml)$/;
const SKIP = /(^|\/)(node_modules|dist|build|\.git|vendor|coverage|\.next)(\/|$)|\.(spec|test)\.[^/]+$|\.d\.ts$/;

const kebab = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'root';

/**
 * Splits a repository into areas an analyst can read within its budget: by directory,
 * splitting any directory over AREA_MAX_FILES into its subdirectories and joining
 * small siblings, so each analyst gets a coherent slice. Infrastructure files
 * (Dockerfiles, Terraform, deploy manifests) are one area of their own, because they
 * say what is deployed and scheduled. Deterministic: the same files give the same areas.
 */
export function buildAreas(listed: readonly string[], limit: number = AREA_LIMIT): Area[] {
  const source = listed.filter((p) => SOURCE.test(p) && !SKIP.test(p) && !isTestSupport(p) && !isSampleCode(p)).sort();
  const areas: Area[] = [];

  const split = (prefix: string, paths: string[]): void => {
    if (paths.length <= AREA_MAX_FILES) {
      if (paths.length > 0) areas.push(area([prefix], paths.length));
      return;
    }
    const children = new Map<string, string[]>();
    const loose: string[] = [];
    for (const path of paths) {
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) loose.push(path);
      else {
        const child = `${prefix}${rest.slice(0, slash + 1)}`;
        children.set(child, [...(children.get(child) ?? []), path]);
      }
    }
    // A directory of only one child has nothing to split: descend.
    if (loose.length === 0 && children.size === 1) {
      const [only] = [...children.entries()];
      split(only![0], only![1]);
      return;
    }
    let batch: { prefixes: string[]; count: number } = { prefixes: [], count: 0 };
    const flush = () => {
      if (batch.count > 0) areas.push(area(batch.prefixes, batch.count));
      batch = { prefixes: [], count: 0 };
    };
    for (const [child, childPaths] of [...children.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (childPaths.length > AREA_MAX_FILES) {
        flush();
        split(child, childPaths);
      } else if (childPaths.length < AREA_MIN_FILES || batch.count + childPaths.length <= AREA_MIN_FILES * 2) {
        if (batch.count + childPaths.length > AREA_MAX_FILES) flush();
        batch.prefixes.push(child);
        batch.count += childPaths.length;
      } else {
        flush();
        areas.push(area([child], childPaths.length));
      }
    }
    flush();
    // Files directly in the directory (an app's main.ts, a package's index) travel
    // with the first area under it, where an analyst will look for an entry point.
    if (loose.length > 0) {
      const home = areas.find((a) => a.prefixes.some((p) => p.startsWith(prefix)));
      if (home) home.prefixes.push(...loose);
      else areas.push(area(loose, loose.length));
    }
  };

  const area = (prefixes: string[], count: number): Area => {
    const main = prefixes[0]!;
    const title = prefixes.length === 1 ? main : `${main} (+${prefixes.length - 1} more)`;
    return { id: '', title, prefixes, hint: `${count} source files.` };
  };

  split('', source);

  // Join the smallest neighbours until the limit holds.
  while (areas.length > limit) {
    let best = 0;
    for (let i = 1; i < areas.length - 1; i += 1) {
      const size = (a: Area) => Number(/^(\d+)/.exec(a.hint ?? '')?.[1] ?? 0);
      if (size(areas[i]!) + size(areas[i + 1]!) < size(areas[best]!) + size(areas[best + 1]!)) best = i;
    }
    const [a, b] = [areas[best]!, areas[best + 1]!];
    const count = Number(/^(\d+)/.exec(a.hint ?? '')?.[1] ?? 0) + Number(/^(\d+)/.exec(b.hint ?? '')?.[1] ?? 0);
    areas.splice(best, 2, { id: '', title: `${a.title} + ${b.title}`, prefixes: [...a.prefixes, ...b.prefixes], hint: `${count} source files.` });
  }

  const infra = listed.filter((p) => INFRA.test(p) && !SKIP.test(p) && !isSampleCode(p)).sort();
  if (infra.length > 0) {
    areas.push({
      id: '',
      title: 'Infrastructure and deployment',
      prefixes: infra,
      hint: 'What is deployed as which process, and what runs on a schedule. Claim servers and processes from here; services live in the code areas.',
    });
  }

  const taken = new Set<string>();
  return areas.map((a) => {
    let id = kebab(a.title.replace(/\s*\(\+\d+ more\)$/, '').replace(/\/$/, '').split('/').slice(-2).join('-'));
    for (let n = 2; taken.has(id); n += 1) id = `${kebab(a.title).slice(0, 40)}-${n}`;
    taken.add(id);
    return { ...a, id };
  });
}

/**
 * Areas when the reader found levels (§21): one per domain that holds services
 * directly, one per service drawn at the top (a capability of one service), and the
 * rest of the source by directory as before, with the infrastructure area. Each domain
 * area carries the domain, so its analyst names it, describes it, and places what is
 * unsure. Deterministic: the same skeleton and files give the same areas.
 */
export function domainAreas(reader: Skeleton, listed: readonly string[]): Area[] {
  const domains = reader.domains ?? [];
  if (domains.length === 0) return buildAreas(listed);
  const services = new Map(reader.services.map((s) => [s.id, s]));
  const prefixesOf = (id: string): string[] => {
    const s = services.get(id);
    if (!s) return [];
    return s.directory ? [`${s.directory}/`] : [...new Set([s.source.file, ...(s.files ?? [])])];
  };
  const areas: Area[] = [];
  for (const d of domains) {
    const prefixes = [...new Set([...d.members.flatMap(prefixesOf), ...d.surfaces.map((x) => `${x}/`)])].sort();
    if (!d.members.some((m) => services.has(m))) continue;
    areas.push({
      id: d.id,
      title: d.name,
      prefixes,
      hint: d.foundation ? 'Part of the shared foundation.' : 'A capability: a product feature and the services behind it.',
      domain: { id: d.id, name: d.name, members: d.members, unsure: d.unsure, surfaces: d.surfaces },
    });
  }
  const placed = new Set(domains.flatMap((d) => d.members));
  for (const s of reader.services) {
    if (s.infrastructure || placed.has(s.id) || prefixesOf(s.id).length === 0) continue;
    areas.push({ id: s.id, title: s.id, prefixes: prefixesOf(s.id), hint: 'A service drawn at the top level.' });
  }
  const claimed = areas.map((a) => a.prefixes).flat();
  const covered = (p: string) => claimed.some((x) => p === x || p.startsWith(x));
  const rest = listed.filter((p) => !covered(p));
  const taken = new Set(areas.map((a) => a.id));
  for (const leftover of buildAreas(rest, LEFTOVER_LIMIT)) {
    let id = leftover.id;
    for (let n = 2; taken.has(id); n += 1) id = `${leftover.id}-${n}`;
    taken.add(id);
    // A directory prefix that also holds a domain's code would hand this analyst that
    // code too: such a prefix becomes the exact files it was meant for.
    const prefixes = leftover.prefixes.flatMap((x) =>
      listed.some((p) => p.startsWith(x) && covered(p))
        ? rest.filter((p) => (p === x || p.startsWith(x)) && (SOURCE.test(p) || INFRA.test(p)) && !SKIP.test(p) && !isTestSupport(p))
        : [x],
    );
    areas.push({ ...leftover, id, prefixes });
  }
  return areas;
}

/** Civil's own documents: what a lift writes, never what it reads as the product. */
export const isCivilDocument = (path: string): boolean => path.startsWith('civil/') || path === 'civil.yaml';

/**
 * Files analysts read beyond what the reader loaded: the reader reads only the
 * frameworks it knows (TypeScript today), but an analyst reads any language, so every
 * other source and infrastructure file is offered too — within the same overall cap,
 * the reader's own selection first.
 */
export function analysisPaths(listed: readonly string[], selected: readonly string[], cap: number): string[] {
  const have = new Set(selected);
  return listed
    .filter((p) => !have.has(p) && (SOURCE.test(p) || INFRA.test(p)) && !SKIP.test(p) && !isTestSupport(p) && !isSampleCode(p) && !isCivilDocument(p))
    .sort()
    .slice(0, Math.max(0, cap - selected.length));
}

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const KINDS = new Set([
  'server', 'client', 'service', 'agent', 'process', 'datastore', 'domain',
  'depends-on', 'exposes', 'calls', 'uses-agent', 'contains',
]);

/**
 * What the runner answered, re-validated: never trusted, because a claim that enters
 * claims.ts is weighed as a voice. Shape only — evidence is checked against the code
 * by claims.ts itself. A voice may not speak as the reader.
 */
export function validateAnswer(answer: Record<string, unknown>, listed: ReadonlySet<string>): { claims: Claim[]; issues: string[] } {
  const claims: Claim[] = [];
  const issues: string[] = [];
  const raw = Array.isArray(answer['claims']) ? answer['claims'] : [];
  for (const item of raw as Record<string, unknown>[]) {
    const kind = item?.['kind'];
    const subject = item?.['subject'];
    const object = item?.['object'];
    const by = item?.['by'];
    if (typeof kind !== 'string' || !KINDS.has(kind) || typeof subject !== 'string' || !ID.test(subject)) {
      issues.push(`malformed claim: ${JSON.stringify(item).slice(0, 100)}`);
      continue;
    }
    if (typeof by !== 'string' || by === READER || !/^(analyst|verifier):/.test(by)) {
      issues.push(`${kind}:${subject}: voice ${String(by)} is not an analyst or verifier`);
      continue;
    }
    const relation = !isEntity(kind as Claim['kind']);
    if (relation && (typeof object !== 'string' || !ID.test(object))) {
      issues.push(`${kind}:${subject}: a relation needs an object`);
      continue;
    }
    const evidence = (Array.isArray(item['evidence']) ? item['evidence'] : [])
      .filter((ev): ev is Evidence => typeof ev?.file === 'string' && listed.has(ev.file))
      .map((ev) => ({
        file: ev.file,
        ...(Number.isInteger(ev.line) && ev.line! > 0 ? { line: ev.line } : {}),
        ...(typeof ev.quote === 'string' && ev.quote ? { quote: ev.quote.slice(0, 200) } : {}),
      }));
    if (evidence.length === 0) {
      issues.push(`${kind}:${subject}: no evidence in the repository`);
      continue;
    }
    const attrs = canonical(item['attrs']);
    claims.push({
      kind: kind as Claim['kind'],
      subject,
      ...(relation ? { object: object as string } : {}),
      ...(attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !relation ? { attrs: attrs as Record<string, unknown> } : {}),
      evidence,
      by,
      stance: item['stance'] === 'refute' ? 'refute' : 'assert',
      ...(typeof item['note'] === 'string' && item['note'] ? { note: item['note'].slice(0, 300) } : {}),
    });
  }
  return { claims, issues };
}

/** An attribute object with its keys sorted, recursively: a claim reads the same however it was stored. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;

const pascal = (id: string): string => id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * Fills a new entity's skeleton fields from what its own claim carries — the files it
 * names, its first piece of evidence as its source — so claims.ts can assemble it.
 * Only for entities the reader did not find: for those it did, the reader's exact
 * fields win and an analyst's attributes only add. Nothing is invented: a process
 * whose schedule no voice gave says so ("@unknown") rather than guessing a cron.
 */
export function normalizeClaims(claims: readonly Claim[], reader: Skeleton): Claim[] {
  const known = new Set([
    ...reader.servers.map((e) => `server:${e.id}`),
    ...reader.clients.map((e) => `client:${e.id}`),
    ...reader.services.map((e) => `service:${e.id}`),
    ...reader.agents.map((e) => `agent:${e.id}`),
    ...reader.processes.map((e) => `process:${e.id}`),
    ...(reader.datastores ?? []).map((e) => `datastore:${e.id}`),
    ...(reader.domains ?? []).map((e) => `domain:${e.id}`),
  ]);
  const onlyServer = reader.servers.length === 1 ? reader.servers[0]!.id : undefined;
  return claims.map((claim) => {
    if (!isEntity(claim.kind) || claim.stance !== 'assert' || known.has(claimKey(claim))) return claim;
    const attrs = claim.attrs ?? {};
    const first = claim.evidence[0]!;
    const source = { file: first.file, ...(first.line ? { line: first.line } : {}) };
    const files = strings(attrs['files']);
    const directory = files.find((f) => f.endsWith('/**'))?.slice(0, -3);
    const plainFiles = files.filter((f) => !f.endsWith('/**'));
    const filled: Record<string, unknown> = (() => {
      switch (claim.kind) {
        case 'server':
          return { path: typeof attrs['path'] === 'string' ? attrs['path'] : first.file.split('/').slice(0, -1).join('/'), framework: attrs['framework'] ?? 'unknown', globalPrefix: null, routes: [], source };
        case 'client':
          return { path: typeof attrs['path'] === 'string' ? attrs['path'] : first.file.split('/').slice(0, -1).join('/'), framework: attrs['framework'] ?? 'unknown', devScript: null, source };
        case 'service':
          return {
            server: typeof attrs['server'] === 'string' ? attrs['server'] : (onlyServer ?? 'server'),
            moduleClass: typeof attrs['label'] === 'string' ? attrs['label'] : pascal(claim.subject),
            source,
            controllers: [],
            providers: [],
            infrastructure: false,
            files: plainFiles.length > 0 ? plainFiles : [first.file],
            ...(directory ? { directory } : {}),
          };
        case 'agent':
          return {
            files: plainFiles.length > 0 ? plainFiles : [first.file],
            tools: Array.isArray(attrs['tools'])
              ? (attrs['tools'] as { name?: unknown; file?: unknown }[])
                  .filter((t) => typeof t?.name === 'string' && typeof t?.file === 'string')
                  .map((t) => ({ name: t.name as string, file: t.file as string }))
              : [],
            source,
          };
        case 'datastore':
          return { engine: typeof attrs['engine'] === 'string' && attrs['engine'] ? attrs['engine'].toLowerCase() : null, source };
        case 'domain':
          // A domain a voice proposes holds what its contains claims put in it.
          return { name: typeof attrs['name'] === 'string' && attrs['name'] ? attrs['name'] : claim.subject, members: [], surfaces: [], unsure: [], source };
        default:
          return { schedule: typeof attrs['schedule'] === 'string' && attrs['schedule'] ? attrs['schedule'] : '@unknown', source };
      }
    })();
    return { ...claim, attrs: { ...attrs, ...filled } };
  });
}

/**
 * Entity resolution: the same thing named twice is one thing. Independent voices name
 * what they find independently — one analyst's "runner" is another's "civil-runner" —
 * and left alone that draws a duplicate and drops every relation that used the other
 * name (found on a real repository, 2026-10-11). So before weighing, each entity a
 * voice proposes is anchored in the code — the path, files, and first piece of evidence
 * it names — and a new name whose anchors fall within an earlier entity's of the same
 * kind becomes an alias of it. The reader's names win, then the earliest voice's; an
 * entity matching two others equally is ambiguous and left as it is, never guessed.
 * Location alone decides only for deployables (servers, clients): two cannot live at
 * one path. Services, agents, and processes can share a file — two agents defined side
 * by side are two agents — so for them the names must also be related, one containing
 * the other as a whole word ("runner" and "civil-runner"), before they are merged.
 *
 * A relation may name an end nobody claimed ("web calls api" where the server is
 * "civil-api"): it is matched by name only when exactly one entity contains it as a
 * whole word; otherwise it stays unknown and claims.ts drops the line.
 */
export function resolveEntities(claims: readonly Claim[], reader: Skeleton): { claims: Claim[]; aliases: Record<string, string> } {
  interface Canon { kind: string; id: string; anchors: string[] }
  const canon: Canon[] = [];
  const dirOf = (file: string) => file.split('/').slice(0, -1).join('/');
  const norm = (paths: readonly unknown[]) =>
    paths.filter((p): p is string => typeof p === 'string' && p.length > 0).map((p) => p.replace(/\/\*\*$/, '').replace(/\/$/, ''));
  const add = (kind: string, id: string, anchors: string[]) => canon.push({ kind, id, anchors: [...new Set(anchors)] });

  for (const s of reader.servers) add('server', s.id, norm([s.path, s.source.file]));
  for (const c of reader.clients) add('client', c.id, norm([c.path, c.source.file]));
  for (const s of reader.services) add('service', s.id, norm([s.source.file, ...(s.files ?? []), ...s.controllers.map((x) => x.file), ...s.providers.map((x) => x.file), ...(s.directory ? [s.directory] : [])]));
  for (const a of reader.agents) add('agent', a.id, norm([a.source.file, ...a.files]));
  for (const p of reader.processes) add('process', p.id, norm([p.source.file]));
  for (const d of reader.datastores ?? []) add('datastore', d.id, norm([d.source.file]));
  for (const d of reader.domains ?? []) add('domain', d.id, norm([d.source.file]));

  /** a lies within b: the same path, or under one of b's directories. */
  const within = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || (b.includes('.') && dirOf(b) === a);
  const score = (anchors: string[], target: Canon) => anchors.filter((a) => target.anchors.some((b) => within(a, b) || within(b, a))).length;

  const aliases: Record<string, string> = {};
  for (const claim of claims) {
    if (!isEntity(claim.kind) || claim.stance !== 'assert') continue;
    if (aliases[claim.subject] || canon.some((c) => c.kind === claim.kind && c.id === claim.subject)) continue;
    const attrs = claim.attrs ?? {};
    const anchors = norm([attrs['path'], ...strings(attrs['files']), claim.evidence[0]?.file]);
    const deployable = claim.kind === 'server' || claim.kind === 'client';
    const related = (a: string, b: string) => {
      const words = (id: string) => new Set(id.split(/[-_]/));
      const [wa, wb] = [words(a), words(b)];
      return [...wa].every((w) => wb.has(w)) || [...wb].every((w) => wa.has(w));
    };
    const ranked = canon
      .filter((c) => c.kind === claim.kind && (deployable || related(c.id, claim.subject)))
      .map((c) => ({ c, n: score(anchors, c) }))
      .filter((r) => r.n > 0)
      .sort((x, y) => y.n - x.n);
    if (ranked.length > 0 && (ranked.length === 1 || ranked[0]!.n > ranked[1]!.n)) {
      aliases[claim.subject] = ranked[0]!.c.id;
    } else if (ranked.length === 0) {
      add(claim.kind, claim.subject, anchors);
    }
  }

  const ids = new Set([...canon.map((c) => c.id)]);
  const byName = (name: string): string | undefined => {
    if (ids.has(name)) return name;
    const word = new RegExp(`(^|-)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-|$)`);
    const hits = [...ids].filter((id) => word.test(id));
    return hits.length === 1 ? hits[0] : undefined;
  };
  const resolve = (id: string, relationEnd: boolean): string => aliases[id] ?? (relationEnd ? byName(id) ?? id : id);

  return {
    aliases,
    claims: claims.map((claim) => {
      const relation = !isEntity(claim.kind);
      const subject = resolve(claim.subject, relation);
      const object = claim.object === undefined ? undefined : resolve(claim.object, true);
      if (subject === claim.subject && object === claim.object) return claim;
      return { ...claim, subject, ...(object !== undefined ? { object } : {}) };
    }),
  };
}

export interface AnalysisReport {
  areas: number;
  claims: number;
  /** By voice kind: how many claims analysts and verifiers made. */
  analystClaims: number;
  verifierClaims: number;
  issues: string[];
  note: string | null;
  /** Areas whose answer was reused from the memo rather than asked again. */
  cachedAreas?: number;
  /** Names a voice used for something already named: proposed → canonical. */
  aliases?: Record<string, string>;
}

/**
 * Asks the runner's analysts and verifiers about the repository and returns their
 * claims, validated and normalised, ready to be weighed with the reader's. Any failure
 * returns no claims and a note — the lift continues on the reader's word alone.
 */
/**
 * A cache of what the agents said about one area, keyed by the area's fingerprint. A
 * memo in the CLAUDE.md sense — reconstructible by asking again — kept so agents never
 * reword what has not changed: an Update over unchanged code proposes nothing.
 */
export interface AreaMemo {
  get(fingerprint: string): Promise<Claim[] | undefined>;
  put(fingerprint: string, areaId: string, claims: readonly Claim[]): Promise<void>;
  /** The area's most recent answer under any fingerprint — the fallback when asking fails. */
  latest(areaId: string): Promise<Claim[] | undefined>;
}

export interface AnalyzeOptions {
  memo?: AreaMemo;
  /**
   * What makes an answer stale besides the code: the runner's analyze prompt version
   * and model. Unknown means "do not trust the memo" — nothing is reused.
   */
  version?: string;
  /** Called as each area finishes, analysed or reused. */
  progress?: (done: number, total: number) => void;
  /** Areas analysed at once; each is one runner call. */
  concurrency?: number;
}

/**
 * The fingerprint of an area: its paths, its files' content, the reader's claims that
 * touch it (what the analyst is shown), and the version. Any change to these is a
 * reason to ask again; nothing else is. An analyst may follow an import outside its
 * area, so a change there can leave a memo slightly stale — the next change inside the
 * area refreshes it; asking every area on every Update would reword everything instead.
 */
export function areaFingerprint(area: Area, files: FileMap, readerClaims: readonly Claim[], version: string): string {
  const hash = createHash('sha256').update(version).update('\0');
  const inside = (p: string) => area.prefixes.some((x) => p.startsWith(x));
  for (const prefix of [...area.prefixes].sort()) hash.update(prefix).update('\0');
  for (const path of Object.keys(files).filter(inside).sort()) hash.update(path).update('\0').update(files[path]!).update('\0');
  const touching = readerClaims.filter((c) => c.evidence.some((ev) => inside(ev.file)));
  hash.update(JSON.stringify(touching));
  if (area.domain) hash.update('\0').update(JSON.stringify(area.domain));
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Asks the runner's analysts and verifiers about the repository, one area per call,
 * reusing what an unchanged area was told before. Returns their claims, validated,
 * resolved and normalised, ready to be weighed with the reader's. A failed area is
 * reported and the rest still count; with no runner, nothing is asked and the lift
 * continues on the reader's word alone.
 */
export async function analyzeRepository(
  ask: AnalyzeAsk | undefined,
  files: FileMap,
  listed: readonly string[],
  readerClaims: readonly Claim[],
  reader: Skeleton,
  opts: AnalyzeOptions = {},
): Promise<{ claims: Claim[]; report: AnalysisReport }> {
  const empty = (note: string): { claims: Claim[]; report: AnalysisReport } => ({
    claims: [],
    report: { areas: 0, claims: 0, analystClaims: 0, verifierClaims: 0, issues: [], note },
  });
  if (!ask) return empty('Agent analysis was skipped: no runner is configured.');
  // Sample code is another project, and civil/ is Civil's own description of this
  // one — the lift's output, not its input: analysts neither read nor cite either.
  // (Reading civil/ made each Update's documents a reason to re-ask the next.)
  const product = listed.filter((p) => !isSampleCode(p) && !isCivilDocument(p));
  const productSet = new Set(product);
  const areas = domainAreas(reader, product);
  if (areas.length === 0) return empty('Agent analysis was skipped: no source files to read.');
  const sent = Object.fromEntries(Object.entries(files).filter(([p]) => !isSampleCode(p) && !isCivilDocument(p)));

  const raw: Claim[] = [];
  const issues: string[] = [];
  const failed: string[] = [];
  const stale: string[] = [];
  let cached = 0;
  let done = 0;
  const total = areas.length;
  opts.progress?.(0, total);

  // The repository is the bulk of every request and the same in each: serialised once,
  // with each request's own fields spliced in (JsonText).
  const shared = JSON.stringify({ files: sent, index: product }).slice(0, -1);
  const body = (fields: Record<string, unknown>) =>
    new JsonText(`${shared},${JSON.stringify(fields).slice(1)}`);

  const one = async (area: Area): Promise<void> => {
    const fingerprint = opts.version ? areaFingerprint(area, sent, readerClaims, opts.version) : undefined;
    const remembered = fingerprint ? await opts.memo?.get(fingerprint) : undefined;
    if (remembered) {
      cached += 1;
      raw.push(...remembered);
    } else {
      try {
        const answer = await ask(body({ claims: readerClaims, areas: [area] }));
        const valid = validateAnswer(answer, productSet);
        raw.push(...valid.claims);
        issues.push(...valid.issues);
        if (fingerprint) await opts.memo?.put(fingerprint, area.id, valid.claims);
      } catch (error) {
        // A failed call does not undo what this area was last found to be: its last
        // answer stands (said in the note), as the model pass falls back to its record.
        const last = await opts.memo?.latest(area.id);
        if (last) {
          raw.push(...last);
          stale.push(`${area.id} (${(error as Error).message.slice(0, 160)})`);
        } else failed.push(`${area.id} (${(error as Error).message.slice(0, 160)})`);
      }
    }
    done += 1;
    opts.progress?.(done, total);
  };
  // A small pool: each area is one runner call holding the model for a minute or two.
  const queue = [...areas];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? ANALYSIS_CONCURRENCY, queue.length) }, async () => {
    for (let area = queue.shift(); area; area = queue.shift()) await one(area);
  });
  await Promise.all(workers);

  // Claims arrive in completion order; weigh them in area order so the result does
  // not depend on which call finished first.
  const order = new Map(areas.map((a, i) => [a.id, i]));
  const areaOf = (c: Claim) => order.get(c.by.slice(c.by.indexOf(':') + 1)) ?? areas.length;
  raw.sort((a, b) => areaOf(a) - areaOf(b));

  const { claims: resolved, aliases } = resolveEntities(raw, reader);
  const normalized = normalizeClaims(resolved, reader);


  return {
    claims: normalized,
    report: {
      areas: total,
      cachedAreas: cached,
      claims: normalized.length,
      analystClaims: normalized.filter((c) => c.by.startsWith('analyst:')).length,
      verifierClaims: normalized.filter((c) => c.by.startsWith('verifier:')).length,
      issues,
      note:
        [
          failed.length
            ? `${failed.length} of ${total} areas could not be analysed: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '; ...' : ''}. The rest were.`
            : '',
          stale.length
            ? `${stale.length} area${stale.length === 1 ? '' : 's'} could not be asked again and kept ${stale.length === 1 ? 'its' : 'their'} last answer: ${stale.slice(0, 3).join('; ')}${stale.length > 3 ? '; ...' : ''}.`
            : '',
        ]
          .filter(Boolean)
          .join(' ') || null,
      aliases,
    },
  };
}
