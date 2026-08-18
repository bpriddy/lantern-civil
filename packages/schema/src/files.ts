/**
 * Path resolution differs by host: the server reads a git clone, the browser reads a
 * prefetched map. The validator depends on this port instead of either one, which is
 * what lets PRD 6.4's "shared package, imported by server and client" actually hold.
 *
 * Deliberately synchronous — callers preload. A validator that awaits per path turns
 * every diagnostic pass into a waterfall.
 */
export interface ProjectFiles {
  exists(path: string): boolean;
  read(path: string): string | undefined;
  /** Used to check `include` globs on code nodes resolve to something. */
  glob(pattern: string): string[];
}

/** An in-memory implementation, for the browser and for tests. */
export class MemoryFiles implements ProjectFiles {
  constructor(private readonly entries: ReadonlyMap<string, string>) {}

  static from(record: Record<string, string>): MemoryFiles {
    return new MemoryFiles(new Map(Object.entries(record)));
  }

  exists(path: string): boolean {
    if (this.entries.has(path)) return true;
    // Directories are implied by their contents.
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  read(path: string): string | undefined {
    return this.entries.get(path);
  }

  glob(pattern: string): string[] {
    const re = globToRegExp(pattern);
    return [...this.entries.keys()].filter((k) => re.test(k)).sort();
  }
}

/** Supports the subset used in manifests: `**`, `*`, and `?`. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` may match zero directories, so the slash is part of the optional group.
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
