import type {
  FileMap,
  Skeleton,
  SkeletonAgent,
  SkeletonDatastore,
  SkeletonClient,
  SkeletonProcess,
  SkeletonServer,
  SkeletonService,
} from './skeleton.js';

/**
 * Claims: what Civil believes about a codebase's architecture, one statement at a time
 * (docs/lift-repo.md, "Claims"). Readers and analysts do not write documents — they
 * propose claims, each carrying the evidence it rests on. Claims are checked
 * mechanically, weighed against one another, and only what survives is assembled
 * into the skeleton the mapper turns into civil/ documents.
 *
 * Claims live at the canvas's altitude (owner's call, 2026-10-10): deployables,
 * boundaries, services, agents, background work, clients, and the dependencies
 * between them. Routes, operations, and functions are attributes of those claims,
 * never claims of their own — Civil verifies what the graph shows, nothing smaller.
 *
 * This is what lets analysis be done by several independent agents without the
 * result depending on any one of them: every statement is individually checkable,
 * comparable across runs, and traceable to code.
 */

/** Entities: things the graph draws. */
export type EntityKind = 'server' | 'client' | 'service' | 'agent' | 'process' | 'datastore';
/** Relations: the lines between them. */
export type RelationKind =
  | 'depends-on' //   service → service or datastore
  | 'exposes' //      server → service
  | 'calls' //        client → server, process → service, service → another server
  | 'uses-agent'; //  service → agent

export type ClaimKind = EntityKind | RelationKind;

export interface Evidence {
  /** Repo-relative path. */
  file: string;
  /** 1-based. */
  line?: number;
  /** A short exact excerpt the file must contain, near `line` when given. */
  quote?: string;
}

export interface Claim {
  kind: ClaimKind;
  /** The entity's id; for a relation, its source. */
  subject: string;
  /** A relation's target; absent for entities. */
  object?: string;
  /**
   * The entity's descriptive fields (files, routes, schedule, …), without the fields
   * relations carry. Opaque here: whatever a reader learns to see travels through
   * the claims layer without this file having to change.
   */
  attrs?: Record<string, unknown>;
  evidence: Evidence[];
  /** Who proposed it: "reader", "analyst:<area>", "docs", "verifier:<n>". */
  by: string;
  /** A verifier that finds the evidence does not hold refutes rather than asserts. */
  stance: 'assert' | 'refute';
  /** Why, in a sentence — the proposer's own words, shown beside the node. */
  note?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Belief {
  key: string;
  kind: ClaimKind;
  subject: string;
  object?: string;
  attrs: Record<string, unknown>;
  supporters: string[];
  refuters: string[];
  /** Evidence that passed the mechanical checks, from every supporting claim. */
  evidence: Evidence[];
  /** Mechanical problems found in supporting claims' evidence. */
  issues: string[];
  confidence: Confidence;
  /** Dropped beliefs are kept, so the summary can say what was considered and why not. */
  dropped: boolean;
  notes: string[];
}

export const READER = 'reader';

export const claimKey = (c: Pick<Claim, 'kind' | 'subject' | 'object'>): string =>
  c.object === undefined ? `${c.kind}:${c.subject}` : `${c.kind}:${c.subject}->${c.object}`;

const ENTITY_KINDS: ReadonlySet<string> = new Set(['server', 'client', 'service', 'agent', 'process', 'datastore']);
export const isEntity = (kind: ClaimKind): kind is EntityKind => ENTITY_KINDS.has(kind);

/** Fields that are relations, carried as relation claims instead of attributes. */
const RELATION_FIELDS: Record<EntityKind, readonly string[]> = {
  server: ['exposes'],
  client: ['calls'],
  service: ['dependsOn', 'agents'],
  agent: [],
  process: ['calls'],
  datastore: [],
};

const attrsOf = (kind: EntityKind, entity: object): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    if (key === 'id' || RELATION_FIELDS[kind].includes(key)) continue;
    out[key] = value;
  }
  return out;
};

const sourceEvidence = (entity: { source?: { file: string; line?: number } }): Evidence[] =>
  entity.source ? [{ file: entity.source.file, ...(entity.source.line ? { line: entity.source.line } : {}) }] : [];

/**
 * The deterministic reader's findings, restated as claims. The reader is one voice
 * among several: a strong one, because it reads the code exactly, but not infallible —
 * it can mistake a test double for an agent — so its claims are weighed like any other.
 */
export function claimsFromSkeleton(skeleton: Skeleton, by: string = READER): Claim[] {
  const claims: Claim[] = [];
  const entity = (kind: EntityKind, e: { id: string; source?: { file: string; line?: number } }) =>
    claims.push({ kind, subject: e.id, attrs: attrsOf(kind, e), evidence: sourceEvidence(e), by, stance: 'assert' });
  const relation = (kind: RelationKind, subject: string, object: string, evidence: Evidence[]) =>
    claims.push({ kind, subject, object, evidence, by, stance: 'assert' });

  for (const s of skeleton.servers) {
    entity('server', s);
    for (const target of s.exposes) relation('exposes', s.id, target, sourceEvidence(s));
  }
  for (const c of skeleton.clients) {
    entity('client', c);
    for (const target of c.calls) relation('calls', c.id, target, sourceEvidence(c));
  }
  for (const s of skeleton.services) {
    entity('service', s);
    for (const target of s.dependsOn) relation('depends-on', s.id, target, sourceEvidence(s));
    for (const target of s.agents) relation('uses-agent', s.id, target, sourceEvidence(s));
  }
  for (const a of skeleton.agents) entity('agent', a);
  for (const d of skeleton.datastores ?? []) entity('datastore', d);
  for (const p of skeleton.processes) {
    entity('process', p);
    for (const target of p.calls) relation('calls', p.id, target, sourceEvidence(p));
  }
  return claims;
}

/**
 * Checks a claim's evidence against the code, mechanically — no model. The file must
 * be in the repository, the line inside it, and a quote must actually appear (near the
 * line, when one is given). A claim whose evidence does not hold cannot raise
 * confidence, however plausible it reads.
 */
export function checkEvidence(claim: Claim, files: FileMap, listed?: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  if (claim.stance === 'assert' && claim.evidence.length === 0) {
    issues.push(`${claimKey(claim)}: no evidence`);
  }
  for (const ev of claim.evidence) {
    const content = files[ev.file];
    if (content === undefined) {
      // Listed but not read (past the reader's cap) is unverifiable, not wrong.
      if (!listed?.has(ev.file)) issues.push(`${claimKey(claim)}: ${ev.file} is not in the repository`);
      continue;
    }
    const lines = content.split('\n');
    if (ev.line !== undefined && (ev.line < 1 || ev.line > lines.length)) {
      issues.push(`${claimKey(claim)}: ${ev.file} has no line ${ev.line}`);
      continue;
    }
    if (ev.quote) {
      const window =
        ev.line === undefined
          ? content
          : lines.slice(Math.max(0, ev.line - 4), ev.line + 3).join('\n');
      const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
      if (!squash(window).includes(squash(ev.quote))) {
        issues.push(
          `${claimKey(claim)}: ${ev.file}${ev.line ? `:${ev.line}` : ''} does not contain "${ev.quote.slice(0, 80)}"`,
        );
      }
    }
  }
  return issues;
}

/**
 * Weighs every claim about the same thing into one belief. The rules, in order:
 *
 * - Evidence that fails the mechanical check counts for nothing.
 * - Dropped: refuted (with sound evidence) by at least as many voices as support it —
 *   unless the reader supports it and no refuter showed evidence, because a
 *   refutation that cites nothing does not outweigh code read exactly.
 * - High: the reader supports it with sound evidence, or two independent voices do.
 * - Medium: one non-reader voice supports it with sound evidence.
 * - Low: supported, but with refuters or with evidence problems.
 *
 * A relation whose endpoints are not both believed entities is dropped: the graph
 * draws no line to nothing.
 */
export function reconcile(claims: readonly Claim[], files: FileMap, listed?: ReadonlySet<string>): Belief[] {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const key = claimKey(claim);
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }

  const beliefs: Belief[] = [];
  for (const [key, group] of groups) {
    const first = group[0]!;
    const supporters: string[] = [];
    const refuters: string[] = [];
    const evidence: Evidence[] = [];
    const issues: string[] = [];
    const notes: string[] = [];
    let attrs: Record<string, unknown> = {};
    let readerSound = false;
    let refuterSound = false;

    for (const claim of group) {
      const problems = checkEvidence(claim, files, listed);
      const sound = problems.length === 0;
      if (claim.note) notes.push(`${claim.by}: ${claim.note}`);
      if (claim.stance === 'refute') {
        if (!refuters.includes(claim.by)) refuters.push(claim.by);
        if (sound && claim.evidence.length > 0) refuterSound = true;
        continue;
      }
      if (!supporters.includes(claim.by)) supporters.push(claim.by);
      issues.push(...problems);
      if (sound) {
        evidence.push(...claim.evidence);
        if (claim.by === READER) readerSound = true;
      }
      // The reader's attributes are exact; others fill only what it left unset.
      attrs = claim.by === READER ? { ...attrs, ...claim.attrs } : { ...claim.attrs, ...attrs };
    }

    const soundSupporters = new Set(
      group
        .filter((c) => c.stance === 'assert' && checkEvidence(c, files, listed).length === 0)
        .map((c) => c.by),
    );
    const dropped =
      supporters.length === 0 ||
      soundSupporters.size === 0 ||
      (refuters.length >= supporters.length && !(readerSound && !refuterSound));
    const confidence: Confidence =
      refuters.length > 0 || issues.length > 0
        ? 'low'
        : readerSound || soundSupporters.size >= 2
          ? 'high'
          : 'medium';

    beliefs.push({
      key,
      kind: first.kind,
      subject: first.subject,
      ...(first.object !== undefined ? { object: first.object } : {}),
      attrs,
      supporters,
      refuters,
      evidence: dedupeEvidence(evidence),
      issues,
      confidence,
      dropped,
      notes,
    });
  }

  // No line to nothing: a relation needs both ends believed.
  const live = new Set(beliefs.filter((b) => isEntity(b.kind) && !b.dropped).map((b) => b.subject));
  for (const b of beliefs) {
    if (isEntity(b.kind) || b.dropped) continue;
    if (!live.has(b.subject) || !live.has(b.object!)) {
      b.dropped = true;
      b.issues.push(`${b.key}: an end of this relation is not a believed entity`);
    }
  }
  return beliefs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const dedupeEvidence = (evidence: Evidence[]): Evidence[] => {
  const seen = new Set<string>();
  return evidence.filter((ev) => {
    const k = `${ev.file}:${ev.line ?? ''}:${ev.quote ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** What each drawn entity rests on — for the inspector, by entity id. */
export interface Provenance {
  confidence: Confidence;
  supporters: string[];
  evidence: Evidence[];
  notes: string[];
}

/**
 * Assembles believed claims back into a skeleton — the shape the mapper, Update's
 * merge, and the registry already understand, so nothing downstream changes. The
 * reader's skeleton supplies what claims do not carry (unresolved findings,
 * frameworks); everything drawn comes from beliefs.
 */
export function toSkeleton(
  beliefs: readonly Belief[],
  base: Skeleton,
): { skeleton: Skeleton; provenance: Record<string, Provenance>; dropped: Belief[] } {
  const live = beliefs.filter((b) => !b.dropped);
  const targets = (kind: RelationKind, subject: string) =>
    live
      .filter((b) => b.kind === kind && b.subject === subject)
      .map((b) => b.object!)
      .sort();
  const entities = <T>(kind: EntityKind, build: (b: Belief) => T): T[] =>
    live.filter((b) => b.kind === kind).map(build);
  // Order follows the base skeleton where the entity came from it, so a pure
  // round trip reproduces it exactly; new entities follow, sorted by id.
  const ordered = <T extends { id: string }>(items: T[], baseItems: readonly { id: string }[]): T[] => {
    const rank = new Map(baseItems.map((item, i) => [item.id, i]));
    return items.sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  };
  const keepOrder = (ids: string[], baseIds: readonly string[] | undefined) => {
    if (!baseIds) return ids;
    const rank = new Map(baseIds.map((id, i) => [id, i]));
    return [...ids].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || (a < b ? -1 : a > b ? 1 : 0));
  };
  const baseOf = <T extends { id: string }>(items: readonly T[], id: string) => items.find((i) => i.id === id);

  const skeleton: Skeleton = {
    ...base,
    servers: ordered(
      entities('server', (b) => ({
        ...(b.attrs as Omit<SkeletonServer, 'id' | 'exposes'>),
        id: b.subject,
        exposes: keepOrder(targets('exposes', b.subject), baseOf(base.servers, b.subject)?.exposes),
      })) as SkeletonServer[],
      base.servers,
    ),
    clients: ordered(
      entities('client', (b) => ({
        ...(b.attrs as Omit<SkeletonClient, 'id' | 'calls'>),
        id: b.subject,
        calls: keepOrder(targets('calls', b.subject), baseOf(base.clients, b.subject)?.calls),
      })) as SkeletonClient[],
      base.clients,
    ),
    services: ordered(
      entities('service', (b) => ({
        ...(b.attrs as Omit<SkeletonService, 'id' | 'dependsOn' | 'agents'>),
        id: b.subject,
        // A service's call into another server is a dependency the mapper draws as a
        // calls edge; claims may state it either way.
        dependsOn: keepOrder(
          [...new Set([...targets('depends-on', b.subject), ...targets('calls', b.subject)])].sort(),
          baseOf(base.services, b.subject)?.dependsOn,
        ),
        agents: keepOrder(targets('uses-agent', b.subject), baseOf(base.services, b.subject)?.agents),
      })) as SkeletonService[],
      base.services,
    ),
    agents: ordered(
      entities('agent', (b) => ({ ...(b.attrs as Omit<SkeletonAgent, 'id'>), id: b.subject })) as SkeletonAgent[],
      base.agents,
    ),
    processes: ordered(
      entities('process', (b) => ({
        ...(b.attrs as Omit<SkeletonProcess, 'id' | 'calls'>),
        id: b.subject,
        calls: keepOrder(targets('calls', b.subject), baseOf(base.processes, b.subject)?.calls),
      })) as SkeletonProcess[],
      base.processes,
    ),
  };
  // Present only when some voice found a store or the base had the field, so a
  // skeleton from before datastores existed still round-trips exactly.
  const stores = ordered(
    entities('datastore', (b) => ({ ...(b.attrs as Omit<SkeletonDatastore, 'id'>), id: b.subject })) as SkeletonDatastore[],
    base.datastores ?? [],
  );
  if (stores.length > 0 || base.datastores !== undefined) skeleton.datastores = stores;

  const provenance: Record<string, Provenance> = {};
  for (const b of live) {
    if (!isEntity(b.kind)) continue;
    provenance[b.subject] = {
      confidence: b.confidence,
      supporters: b.supporters,
      evidence: b.evidence,
      notes: b.notes,
    };
  }
  return { skeleton, provenance, dropped: beliefs.filter((b) => b.dropped) };
}
