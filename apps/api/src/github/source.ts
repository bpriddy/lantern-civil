import type { ProjectSource } from '../project/source.js';
import type { GitHubApp } from './app.js';

/**
 * A ProjectSource backed by a GitHub repository, with no clone and no working tree
 * (CLAUDE.md: nothing on the container filesystem may be the only copy of anything).
 *
 * ProjectFiles is deliberately synchronous — a validator that awaits per path turns
 * every diagnostic pass into a waterfall. GitHub is not. The reconciliation is to
 * prefetch: one call for the whole tree, then the manifest surface in parallel, after
 * which every read is memory-speed.
 *
 * That is the same prefetch PRD 7 already asks for so descent is instant, so it costs
 * nothing extra.
 */

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

/**
 * Files whose contents the canvas and validator actually need: manifests, JSON
 * Schemas, and agent prompts. Source files are listed but not fetched — the tree
 * tells us they exist, which is all `exists`, `list`, and `glob` require, and Monaco
 * fetches a file's body when you open it.
 */
const PREFETCH = /\.(ya?ml|json|md)$/i;

/** Guards against a pathological repo turning one project load into thousands of calls. */
const MAX_PREFETCH_FILES = 300;

export class GitHubSource implements ProjectSource {
  readonly commitSha: string;
  readonly truncated: boolean;
  private readonly paths: Set<string>;
  private readonly blobShas: Map<string, string>;
  private readonly contents: Map<string, string>;

  private constructor(init: {
    commitSha: string;
    truncated: boolean;
    entries: TreeEntry[];
    contents: Map<string, string>;
  }) {
    this.commitSha = init.commitSha;
    this.truncated = init.truncated;
    this.paths = new Set(init.entries.map((e) => e.path));
    this.blobShas = new Map(init.entries.map((e) => [e.path, e.sha]));
    this.contents = init.contents;
  }

  static async load(
    app: GitHubApp,
    installationId: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitHubSource> {
    const head = await app.asInstallation<{ object: { sha: string } }>(
      installationId,
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`,
    );
    const commitSha = head.object.sha;

    const tree = await app.asInstallation<{ tree: TreeEntry[]; truncated: boolean }>(
      installationId,
      `/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
    );

    const blobs = tree.tree.filter((e) => e.type === 'blob');
    const wanted = blobs.filter((e) => PREFETCH.test(e.path)).slice(0, MAX_PREFETCH_FILES);

    // Blobs are immutable and content-addressed, so these are independent and safe to
    // run together.
    const fetched = await Promise.all(
      wanted.map(async (entry) => {
        const blob = await app.asInstallation<{ content: string; encoding: string }>(
          installationId,
          `/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
        );
        const text =
          blob.encoding === 'base64'
            ? Buffer.from(blob.content, 'base64').toString('utf8')
            : blob.content;
        return [entry.path, text] as const;
      }),
    );

    return new GitHubSource({
      commitSha,
      truncated: tree.truncated,
      entries: blobs,
      contents: new Map(fetched),
    });
  }

  /** The blob sha a pending change records as its base, for per-file divergence. */
  blobShaFor(path: string): string | undefined {
    return this.blobShas.get(path);
  }

  exists(path: string): boolean {
    if (this.paths.has(path)) return true;
    // Directories are implied by their contents; git trees have no empty directories.
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const p of this.paths) if (p.startsWith(prefix)) return true;
    return false;
  }

  read(path: string): string | undefined {
    return this.contents.get(path);
  }

  glob(pattern: string): string[] {
    const re = globToRegExp(pattern);
    return [...this.paths].filter((p) => re.test(p)).sort();
  }

  list(): string[] {
    return [...this.paths].sort();
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
