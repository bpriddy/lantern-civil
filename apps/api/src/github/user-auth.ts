import { randomBytes } from 'node:crypto';

/**
 * GitHub's user-to-server flow, used for exactly one purpose: proving which GitHub
 * account a Civil user is, so we know which installation they may use.
 *
 * Why this is needed at all: sign-in is Google, so Civil has no idea who you are on
 * GitHub. Without this step the only way to pick an installation is "use the one that
 * exists", which would hand every stranger who signs in write access to the owner's
 * repositories. That is not an access-control nicety — it is giving away someone
 * else's repos.
 *
 * The user token is used immediately, then discarded. Nothing about it is stored:
 * once we know the installation id, every subsequent call uses an installation token
 * minted from the private key (PRD 12). One fewer long-lived credential to leak.
 */

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';

export interface UserAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

export function beginUserAuth(): { state: string } {
  // GitHub does not support PKCE for Apps, so `state` is the whole of the CSRF
  // defence on the callback. It is not optional.
  return { state: randomBytes(32).toString('base64url') };
}

export function userAuthorizationUrl(config: UserAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface GitHubUser {
  login: string;
  id: number;
}

export interface LinkedInstallation {
  installationId: number;
  account: string;
  repositorySelection: 'all' | 'selected';
}

/**
 * Exchanges the code, reads the account, and returns the installations that account
 * can actually reach. The token never leaves this function.
 */
export async function completeUserAuth(
  config: UserAuthConfig,
  code: string,
): Promise<{ user: GitHubUser; installations: LinkedInstallation[] }> {
  const tokenResponse = await fetch(TOKEN, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    throw new GitHubAuthError(`token exchange failed: ${tokenResponse.status}`);
  }

  // GitHub answers 200 with an error body rather than an error status.
  const body = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!body.access_token) {
    throw new GitHubAuthError(body.error_description ?? body.error ?? 'no access token returned');
  }

  const token = body.access_token;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'civil',
  };

  const userResponse = await fetch(`${API}/user`, { headers });
  if (!userResponse.ok) throw new GitHubAuthError(`could not read the GitHub account: ${userResponse.status}`);
  const user = (await userResponse.json()) as GitHubUser;

  // Asking GitHub which installations THIS user can reach is the whole point: it is
  // GitHub, not Civil, deciding what they are entitled to.
  const installationsResponse = await fetch(`${API}/user/installations`, { headers });
  if (!installationsResponse.ok) {
    throw new GitHubAuthError(`could not list installations: ${installationsResponse.status}`);
  }
  const installations = (await installationsResponse.json()) as {
    installations: { id: number; account: { login: string }; repository_selection: 'all' | 'selected' }[];
  };

  return {
    user: { login: user.login, id: user.id },
    installations: installations.installations.map((i) => ({
      installationId: i.id,
      account: i.account.login,
      repositorySelection: i.repository_selection,
    })),
  };
}
