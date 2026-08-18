import fs from 'node:fs';
import path from 'node:path';
import type { ProjectFiles } from '@civil/schema';

/**
 * PRD 6.1: the repo is the truth and everything the canvas shows is a projection of
 * files in git. This is the port that reads those files.
 *
 * A GitHub-backed implementation arrives with the App installation (PRD 12). A local
 * directory is the same thing with the clone step already done, which is what lets
 * M1's canvas work proceed without waiting on an account action.
 */
export interface ProjectSource extends ProjectFiles {
  /** Every file in the project, project-relative, sorted. Feeds the tree in PRD 7. */
  list(): string[];
}

/** Directories that are never part of a project's manifest surface. */
const IGNORED = new Set(['.git', 'node_modules', '.civil', '__pycache__', '.venv', 'dist']);

export class LocalSource implements ProjectSource {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Every read goes through here. A project-relative path is attacker-influenced the
   * moment a project can be created by any signed-in user, and `..` in a manifest ref
   * would otherwise read anything the service account can reach. Resolving and then
   * checking containment catches traversal, absolute paths, and symlink escapes alike.
   */
  private resolve(relative: string): string | undefined {
    const target = path.resolve(this.root, relative);
    const contained = target === this.root || target.startsWith(this.root + path.sep);
    if (!contained) return undefined;

    // realpath so a symlink pointing outside the project cannot smuggle a read out.
    try {
      const real = fs.realpathSync(target);
      if (real !== this.root && !real.startsWith(this.root + path.sep)) return undefined;
      return real;
    } catch {
      // Does not exist yet: containment already checked on the lexical path.
      return target;
    }
  }

  exists(relative: string): boolean {
    const resolved = this.resolve(relative);
    return resolved !== undefined && fs.existsSync(resolved);
  }

  read(relative: string): string | undefined {
    const resolved = this.resolve(relative);
    if (!resolved) return undefined;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return undefined;
      return fs.readFileSync(resolved, 'utf8');
    } catch {
      return undefined;
    }
  }

  glob(pattern: string): string[] {
    // Anchored to the project root, so a pattern cannot escape it either.
    try {
      return fs
        .globSync(pattern, { cwd: this.root })
        .map((f) => f.split(path.sep).join('/'))
        .filter((f) => !f.split('/').some((segment) => IGNORED.has(segment)))
        .sort();
    } catch {
      return [];
    }
  }

  list(): string[] {
    const out: string[] = [];

    const walk = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED.has(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
        else if (entry.isFile()) out.push(relative);
      }
    };

    walk(this.root, '');
    return out.sort();
  }
}
