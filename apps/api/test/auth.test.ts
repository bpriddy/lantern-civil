import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, redirectUri } from '../dist/config.js';
import { authorizationUrl, beginAuth } from '../dist/auth/google.js';
import { safeReturnTo } from '../dist/http/auth-routes.js';

/**
 * PRD 2 names two tests that matter, both guarding silent corruption. These guard
 * the auth equivalent: every case here fails OPEN if the code is wrong — an
 * unauthenticated production server, an open redirect, a login with no CSRF
 * protection. None of them is something you would notice by clicking.
 */

const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://localhost:5432/civil_test',
  CIVIL_PUBLIC_URL: 'https://civil.example.com',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  SESSION_SECRET: 'x'.repeat(32),
};

// --- boot-time refusals ----------------------------------------------------

test('a dev identity in production refuses to boot', () => {
  assert.throws(
    () => loadConfig({ ...prod, CIVIL_DEV_IDENTITY: 'me@example.com' }),
    /without any credential check/,
  );
});

test('production refuses to boot without OAuth credentials', () => {
  const { GOOGLE_CLIENT_SECRET: _omitted, ...withoutSecret } = prod;
  assert.throws(() => loadConfig(withoutSecret), /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
});

test('production refuses to boot without a session secret', () => {
  const { SESSION_SECRET: _omitted, ...withoutSecret } = prod;
  assert.throws(() => loadConfig(withoutSecret), /SESSION_SECRET is required/);
});

test('production refuses to boot without a public url', () => {
  const { CIVIL_PUBLIC_URL: _omitted, ...withoutUrl } = prod;
  assert.throws(() => loadConfig(withoutUrl), /CIVIL_PUBLIC_URL is required/);
});

test('a short session secret is rejected before it can weaken a signature', () => {
  assert.throws(() => loadConfig({ ...prod, SESSION_SECRET: 'too-short' }), /Invalid environment/);
});

test('development refuses to boot when nobody could sign in', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'development', DATABASE_URL: prod.DATABASE_URL }),
    /nobody could sign in/,
  );
});

test('a valid production config resolves the redirect Google will be told about', () => {
  const config = loadConfig(prod);
  assert.equal(redirectUri(config), 'https://civil.example.com/auth/google/callback');
  assert.equal(config.devIdentity, undefined);
});

// --- open redirect ---------------------------------------------------------

test('returnTo accepts only same-origin paths', () => {
  assert.equal(safeReturnTo('/app/classify'), '/app/classify');
  assert.equal(safeReturnTo('/'), '/');

  // Each of these would otherwise let the sign-in endpoint launder an attacker's
  // destination through Civil's origin.
  assert.equal(safeReturnTo('https://evil.test'), '/');
  assert.equal(safeReturnTo('//evil.test'), '/', 'protocol-relative is still off-site');
  assert.equal(safeReturnTo('javascript:alert(1)'), '/');
  assert.equal(safeReturnTo(undefined), '/');
  assert.equal(safeReturnTo(42), '/');
});

// --- authorization request -------------------------------------------------

test('the authorization url carries PKCE, state, and nonce', () => {
  const request = beginAuth();
  const url = new URL(
    authorizationUrl(
      { clientId: 'client-id', clientSecret: 'unused', redirectUri: 'https://civil.example.com/auth/google/callback' },
      request,
    ),
  );

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), request.state);
  assert.equal(url.searchParams.get('nonce'), request.nonce);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

  // The challenge must be the hash, never the verifier itself — sending the verifier
  // is a PKCE implementation that provides no protection at all.
  const challenge = url.searchParams.get('code_challenge');
  assert.ok(challenge);
  assert.notEqual(challenge, request.codeVerifier);
});

test('each login gets fresh, unpredictable values', () => {
  const a = beginAuth();
  const b = beginAuth();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.codeVerifier, b.codeVerifier);
  // RFC 7636 requires 43-128 characters.
  assert.ok(a.codeVerifier.length >= 43 && a.codeVerifier.length <= 128);
});

// --- what the session guard covers -----------------------------------------

test('the guard covers the data and nothing else', async () => {
  const { isGuarded } = await import('../dist/http/server.js');

  // Guarded: everything a signed-out visitor must not read.
  assert.equal(isGuarded('/api/me'), true);
  assert.equal(isGuarded('/api/projects'), true);
  assert.equal(isGuarded('/api/projects/abc/bundle?path=app.yaml'), true);

  // Public: the shell and its assets. Guarding these does not protect anything —
  // the bundle holds no secrets — and it makes the sign-in screen unreachable,
  // because the browser gets a JSON 401 instead of an app that can render one.
  assert.equal(isGuarded('/'), false);
  assert.equal(isGuarded('/assets/index-abc123.js'), false);
  assert.equal(isGuarded('/assets/index-abc123.css'), false);

  // Public: how a session is obtained, and how Cloud Run probes the container.
  assert.equal(isGuarded('/auth/google/start'), false);
  assert.equal(isGuarded('/auth/google/callback?code=x&state=y'), false);

  // Guarded: linking GitHub attaches an installation to an EXISTING account, so it
  // needs a session rather than creating one. Public here would let an
  // unauthenticated caller drive the link.
  assert.equal(isGuarded('/auth/github/start'), true);
  assert.equal(isGuarded('/auth/github/callback?code=x&state=y'), true);
  assert.equal(isGuarded('/healthz'), false);
  assert.equal(isGuarded('/readyz'), false);

  // A deep SPA route is shell, not data — it must fall through to index.html.
  assert.equal(isGuarded('/projects/abc/classify'), false);

  // Not fooled by a query string that merely mentions /api/.
  assert.equal(isGuarded('/?next=/api/me'), false);
});
