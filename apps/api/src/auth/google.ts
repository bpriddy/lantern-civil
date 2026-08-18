import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Google OIDC, Authorization Code flow with PKCE.
 *
 * This replaces IAP (PRD 12), which the owner dropped in order to share the
 * application. IAP was the entire perimeter, so everything it did implicitly is now
 * explicit here: `state` for CSRF on the callback, `nonce` against id_token replay,
 * and PKCE against code interception. Each is load-bearing; none is ceremony.
 *
 * Endpoints are pinned rather than discovered. They have been stable for a decade,
 * and a discovery fetch would put a network round trip in the path of every boot.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

// Google issues both spellings across its history; accept either.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const jwks = createRemoteJWKSet(JWKS_URL);

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** The transient values that must survive the round trip to Google. */
export interface AuthRequest {
  state: string;
  nonce: string;
  codeVerifier: string;
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

export function beginAuth(): AuthRequest {
  return {
    state: base64url(randomBytes(32)),
    nonce: base64url(randomBytes(32)),
    // RFC 7636 allows 43-128 characters; 32 random bytes lands at 43.
    codeVerifier: base64url(randomBytes(32)),
  };
}

export function authorizationUrl(config: GoogleConfig, request: AuthRequest): string {
  const challenge = base64url(createHash('sha256').update(request.codeVerifier).digest());

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Without this, a returning user is bounced straight through and never gets to
  // pick a different account.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | undefined;
  picture: string | undefined;
}

export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  request: AuthRequest,
): Promise<GoogleProfile> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: request.codeVerifier,
    }),
  });

  if (!response.ok) {
    // Google's error body names the actual problem (redirect_uri_mismatch,
    // invalid_client). Losing it turns a five-minute fix into an afternoon.
    const detail = await response.text().catch(() => '');
    throw new OAuthError(`token exchange failed (${response.status}): ${detail.slice(0, 400)}`);
  }

  const body = (await response.json()) as { id_token?: string };
  if (!body.id_token) throw new OAuthError('token response carried no id_token');

  const { payload } = await jwtVerify(body.id_token, jwks, {
    issuer: ISSUERS,
    audience: config.clientId,
  }).catch((cause: unknown) => {
    throw new OAuthError(`id_token verification failed: ${(cause as Error).message}`);
  });

  // The nonce is why an intercepted id_token cannot be replayed into a fresh login.
  if (payload['nonce'] !== request.nonce) {
    throw new OAuthError('id_token nonce did not match the one issued for this login');
  }

  const sub = payload.sub;
  const email = payload['email'];
  if (typeof sub !== 'string' || typeof email !== 'string') {
    throw new OAuthError('id_token carried no subject or email');
  }

  return {
    sub,
    email,
    emailVerified: payload['email_verified'] === true,
    name: typeof payload['name'] === 'string' ? payload['name'] : undefined,
    picture: typeof payload['picture'] === 'string' ? payload['picture'] : undefined,
  };
}
