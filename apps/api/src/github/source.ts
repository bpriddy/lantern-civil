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

/** How many blob fetches run at once during hydration. */
const ENSURE_CONCURRENCY = 16;

/** A blob larger than this is not hydrated into memory; Monaco has no business with
 *  it and a run bundle will stream it another way when that day comes. */
const MAX_ENSURE_BYTES = 2 * 1024 * 1024;

/** Guards against a pathological repo turning one project load into thousands of calls. */
const MAX_PREFETCH_FILES = 300;

/**
 * Loaded trees, keyed by commit.
 *
 * Without this every bundle load re-fetches the tree and every manifest blob, so
 * clicking around a project is dozens of API calls a minute and GitHub eventually
 * answers 403 with a note about scraping. A commit is immutable and content-addressed,
 * so a tree read at a given sha can never become stale — the only call that must stay
 * fresh is resolving the branch to its current sha, which is one request.
 *
 * In memory, and therefore lost when the container recycles. That is correct under
 * CLAUDE.md: it is a cache, reconstructible by asking GitHub again, and nothing here
 * is the only copy of anything.
 */
interface CachedTree {
  entries: TreeEntry[];
  truncated: boolean;
  contents: Map<string, string>;
}

const treeCache = new Map<string, CachedTree>();

/** Bounded so a long-lived instance browsing many repositories cannot grow forever. */
const MAX_CACHED_TREES = 24;

function remember(key: string, value: CachedTree): void {
  // Oldest out first. Insertion order is Map's iteration order.
  if (treeCache.size >= MAX_CACHED_TREES) {
    const oldest = treeCache.keys().next().value;
    if (oldest !== undefined) treeCache.delete(oldest);
  }
  treeCache.set(key, value);
}

export class GitHubSource implements ProjectSource {
  readonly commitSha: string;
  readonly truncated: boolean;
  private readonly paths: Set<string>;
  private readonly blobShas: Map<string, string>;
  private readonly contents: Map<string, string>;
  private readonly sizes: Map<string, number>;
  private readonly app: GitHubApp;
  private readonly installationId: string;
  private readonly owner: string;
  private readonly repo: string;

  private constructor(init: {
    commitSha: string;
    truncated: boolean;
    entries: TreeEntry[];
    contents: Map<string, string>;
    app: GitHubApp;
    installationId: string;
    owner: string;
    repo: string;
  }) {
    this.commitSha = init.commitSha;
    this.truncated = init.truncated;
    this.paths = new Set(init.entries.map((e) => e.path));
    this.blobShas = new Map(init.entries.map((e) => [e.path, e.sha]));
    this.sizes = new Map(init.entries.map((e) => [e.path, e.size ?? 0]));
    this.contents = init.contents;
    this.app = init.app;
    this.installationId = init.installationId;
    this.owner = init.owner;
    this.repo = init.repo;
  }

  /** Resolves a branch to the commit it currently points at. One call. */
  static async resolveHead(
    app: GitHubApp,
    installationId: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const head = await app.asInstallation<{ object: { sha: string } }>(
      installationId,
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return head.object.sha;
  }

  /**
   * Opens a repository at a known commit.
   *
   * Taking a sha rather than a branch is what makes this free after the first read:
   * a commit is immutable, so its tree and blobs can be cached indefinitely and every
   * later request costs nothing. Asking where the branch points is a separate,
   * deliberate act — see resolveHead and the sync route.
   */
  static async load(
    app: GitHubApp,
    installationId: string,
    owner: string,
    repo: string,
    commitSha: string,
  ): Promise<GitHubSource> {

    const cacheKey = `${owner}/${repo}@${commitSha}`;
    const cached = treeCache.get(cacheKey);
    if (cached) {
      return new GitHubSource({
        commitSha,
        truncated: cached.truncated,
        entries: cached.entries,
        contents: cached.contents,
        app,
        installationId,
        owner,
        repo,
      });
    }

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

    const contents = new Map(fetched);
    remember(cacheKey, { entries: blobs, truncated: tree.truncated, contents });

    return new GitHubSource({
      commitSha,
      truncated: tree.truncated,
      entries: blobs,
      contents,
      app,
      installationId,
      owner,
      repo,
    });
  }

  /**
   * Hydrates the sync cache for these paths. Blobs are immutable, and `contents` is
   * the same Map the commit's cache entry holds, so anything fetched here is fetched
   * once per commit per container — later loads at this sha read it for free.
   */
  async ensure(paths: readonly string[]): Promise<void> {
    const wanted = [...new Set(paths)].filter(
      (path) =>
        !this.contents.has(path) &&
        this.blobShas.has(path) &&
        (this.sizes.get(path) ?? 0) <= MAX_ENSURE_BYTES,
    );

    for (let at = 0; at < wanted.length; at += ENSURE_CONCURRENCY) {
      await Promise.all(
        wanted.slice(at, at + ENSURE_CONCURRENCY).map(async (path) => {
          const blob = await this.app.asInstallation<{ content: string; encoding: string }>(
            this.installationId,
            `/repos/${this.owner}/${this.repo}/git/blobs/${this.blobShas.get(path)}`,
          );
          const text =
            blob.encoding === 'base64'
              ? Buffer.from(blob.content, 'base64').toString('utf8')
              : blob.content;
          this.contents.set(path, text);
        }),
      );
    }
  }

  /** The blob sha a pending change records as its base, for per-file divergence. */
  blobShaFor(path: string): string | undefined {
    return this.blobShas.get(path);
  }

  exists(path: string): boolean {
    // The repository root. A git tree has no entry for it, but the source having
    // loaded at all proves it is there — and callers ask, because that is how a
    // project checks its source is still readable.
    if (path === '' || path === '.' || path === '/') return true;

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
