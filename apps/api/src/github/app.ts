import { SignJWT, importPKCS8, type KeyLike } from 'jose';

/**
 * PRD 12: a GitHub App, not PATs. Short-lived installation tokens minted server-side,
 * never sent to the browser.
 *
 * Two credentials, two lifetimes. The app JWT is signed with the private key, lives
 * ten minutes, and only identifies Civil itself. An installation token is minted with
 * that JWT, lives an hour, and is what actually touches repository contents. Nothing
 * long-lived ever leaves this process.
 */

const API = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

/** GitHub rejects a JWT older than ten minutes; stop well short of the edge. */
const JWT_TTL_SECONDS = 540;

/** Installation tokens last an hour. Renew early so a long request cannot straddle expiry. */
const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;

export interface GitHubAppConfig {
  appId: string;
  /** PKCS#8 or PKCS#1 PEM, as downloaded from GitHub. */
  privateKey: string;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/**
 * GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); jose wants PKCS#8. Node can
 * convert without a shell out to openssl.
 */
async function loadKey(pem: string): Promise<KeyLike> {
  const normalised = pem.includes('BEGIN RSA PRIVATE KEY')
    ? await toPkcs8(pem)
    : pem;
  return (await importPKCS8(normalised, 'RS256')) as KeyLike;
}

async function toPkcs8(pem: string): Promise<string> {
  const { createPrivateKey } = await import('node:crypto');
  return createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export class GitHubApp {
  private readonly config: GitHubAppConfig;
  private key: Promise<KeyLike> | undefined;
  /** Cached per installation. Minting on every request would be a needless round trip. */
  private readonly tokens = new Map<string, InstallationToken>();

  constructor(config: GitHubAppConfig) {
    this.config = config;
  }

  private async signingKey(): Promise<KeyLike> {
    this.key ??= loadKey(this.config.privateKey);
    return this.key;
  }

  /** Identifies Civil itself. Cannot read repository contents on its own. */
  async appJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      // Backdated by a minute: GitHub rejects a JWT issued in its future, and small
      // clock differences between Cloud Run and GitHub are normal.
      .setIssuedAt(now - 60)
      .setExpirationTime(now + JWT_TTL_SECONDS)
      .setIssuer(this.config.appId)
      .sign(await this.signingKey());
  }

  private async request<T>(path: string, auth: string, init: RequestInit = {}): Promise<T> {
    const send = () =>
      fetch(`${API}${path}`, {
        ...init,
        headers: {
          accept: ACCEPT,
          'x-github-api-version': API_VERSION,
          authorization: auth,
          'user-agent': 'civil',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });

    let response = await send();

    // GitHub throttles bursts separately from the hourly quota and answers 403 or 429
    // with how long to wait. Surfacing that as an error makes a momentary slowdown
    // look like a broken integration; it is a request that has not finished yet.
    const wait = retryDelayMs(response);
    if (wait !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      response = await send();
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GitHubError(response.status, `${init.method ?? 'GET'} ${path}: ${detail.slice(0, 300)}`);
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  async asApp<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(path, `Bearer ${await this.appJwt()}`, init);
  }

  async installationToken(installationId: string): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt.getTime() - Date.now() > TOKEN_RENEW_MARGIN_MS) {
      return cached.token;
    }

    const minted = await this.asApp<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: 'POST' },
    );

    const token: InstallationToken = { token: minted.token, expiresAt: new Date(minted.expires_at) };
    this.tokens.set(installationId, token);
    return token.token;
  }

  /** Everything that touches repository contents goes through here. */
  async asInstallation<T>(installationId: string, path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(path, `Bearer ${await this.installationToken(installationId)}`, init);
  }
}

/**
 * How long to wait before one retry, or undefined if retrying will not help.
 *
 * Only for throttling. A 403 for a permission the app was never granted is
 * permanent, and retrying it wastes the caller's time to reach the same answer, so
 * the distinction is drawn on what GitHub actually says.
 */
function retryDelayMs(response: Response): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;

  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    // Capped: a request that hangs for a minute is worse than one that reports a
    // throttle the caller can act on.
    return Math.min(retryAfter, 5) * 1000;
  }

  // The hourly quota is exhausted rather than a burst throttled — waiting for the
  // reset could be many minutes, which is not a retry, it is a hang.
  if (response.headers.get('x-ratelimit-remaining') === '0') return undefined;

  // A secondary limit without a Retry-After. GitHub asks for at least a minute
  // between retries in that case, but one short pause is the useful middle: enough
  // to clear a brief burst, not enough to hold a request open.
  return 2000;
}

/**
 * A GitHub failure as the client should see it.
 *
 * Letting GitHubError reach the generic error handler produces a 500 saying "internal
 * server error", which is both wrong — nothing internal failed — and useless, because
 * GitHub had already said what was wrong.
 */
export function describeGitHubError(error: GitHubError): {
  status: number;
  code: string;
  message: string;
} {
  if (error.status === 404) {
    return {
      status: 404,
      code: 'github_not_found',
      message: 'GitHub could not find that, or the installation cannot see it.',
    };
  }
  if (error.status === 401) {
    return {
      status: 502,
      code: 'github_unauthorized',
      message: 'GitHub rejected Civil’s credentials. The app may need reinstalling.',
    };
  }
  if (error.status === 403 || error.status === 429) {
    return {
      status: 503,
      code: 'github_throttled',
      message:
        'GitHub is rate limiting Civil. This clears on its own; try again in a moment.',
    };
  }
  return {
    status: 502,
    code: 'github_unreachable',
    message: `GitHub refused the request (${error.status}).`,
  };
}

export interface AppIdentity {
  id: number;
  slug: string;
  name: string;
  permissions: Record<string, string>;
}

export interface Installation {
  id: number;
  account: { login: string; type: string };
  repository_selection: 'all' | 'selected';
}

export interface Repository {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
}
