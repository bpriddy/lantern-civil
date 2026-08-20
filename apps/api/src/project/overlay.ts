import type { PendingChange } from './pending.js';
import type { ProjectSource } from './source.js';

/**
 * A project source with uncommitted work applied on top.
 *
 * This is a source rather than a special case inside the loader, which means the
 * validator, the bundle, and both canvases see pending edits without knowing pending
 * edits exist. PRD 6.4's shared validator runs against edited manifests for free, so
 * a broken YAML you have not committed yet still renders its diagnostic on the node
 * that caused it.
 *
 * The composition is one-way on purpose: reads consult the overlay, then the base.
 * Nothing here writes — saving goes through pending.ts to Postgres, because the base
 * source may be a GitHub repository and is never Civil's to mutate.
 */
export class OverlaySource implements ProjectSource {
  private readonly base: ProjectSource;
  /** Keyed by path after the change, matching the pending_changes primary key. */
  private readonly changes: Map<string, PendingChange>;
  /** Paths that a rename moved away from; they read as absent. */
  private readonly renamedAway: Set<string>;

  constructor(base: ProjectSource, changes: readonly PendingChange[]) {
    this.base = base;
    this.changes = new Map(changes.map((c) => [c.path, c]));
    this.renamedAway = new Set(
      changes.flatMap((c) => (c.kind === 'rename' && c.fromPath ? [c.fromPath] : [])),
    );
  }

  private isGone(path: string): boolean {
    const change = this.changes.get(path);
    return change?.kind === 'delete' || this.renamedAway.has(path);
  }

  exists(path: string): boolean {
    if (this.isGone(path)) return false;
    if (this.changes.has(path)) return true;
    // Directories are implied by their contents, pending contents included — the
    // same rule every base source applies. Without this, a scaffolded
    // web/index.html leaves the client's `path: web` "not existing" until the
    // commit, and a node that validates only after committing breaks the promise
    // that pending edits behave like real ones.
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const [p, change] of this.changes) {
      if (change.kind !== 'delete' && p.startsWith(prefix)) return true;
    }
    return this.base.exists(path);
  }

  read(path: string): string | undefined {
    if (this.isGone(path)) return undefined;

    const change = this.changes.get(path);
    if (change) {
      if (change.content !== null) return change.content;
      // A pure rename carries no content: the bytes are still whatever the old path
      // held at HEAD.
      if (change.kind === 'rename' && change.fromPath) return this.base.read(change.fromPath);
      // content_ref means the body is in GCS. Not wired yet (see pending.ts); reading
      // through would silently show an empty file, so it is undefined instead.
      if (change.contentRef !== null) return undefined;
    }

    return this.base.read(path);
  }

  glob(pattern: string): string[] {
    // Base matches minus anything removed, plus pending files the pattern also covers.
    // Code nodes declare `include` globs (PRD 6.3), so a newly added step file has to
    // match before it is committed or the node would look empty.
    const re = globToRegExp(pattern);
    const out = new Set(this.base.glob(pattern).filter((p) => !this.isGone(p)));
    for (const [path, change] of this.changes) {
      if (change.kind === 'delete') continue;
      if (re.test(path)) out.add(path);
    }
    return [...out].sort();
  }

  list(): string[] {
    const out = new Set(this.base.list().filter((p) => !this.isGone(p)));
    for (const [path, change] of this.changes) {
      if (change.kind === 'delete') continue;
      out.add(path);
    }
    return [...out].sort();
  }

  /** What the tree should badge, and what the commit indicator counts (PRD 7). */
  status(): Map<string, PendingChange['kind']> {
    const map = new Map<string, PendingChange['kind']>();
    for (const [path, change] of this.changes) map.set(path, change.kind);
    return map;
  }
}

/** Same subset the schema package supports: `**`, `*`, `?`. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}
