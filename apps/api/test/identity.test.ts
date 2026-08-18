import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../dist/config.js';
import { UnauthenticatedError, createIdentityReader } from '../dist/http/identity.js';

/**
 * PRD 2 names two tests that matter, both guarding silent corruption. These guard the
 * auth equivalent: a server that believes it is authenticated when it is not. Every
 * case here fails open if the code is wrong, which is precisely the class of bug you
 * do not notice by clicking.
 */

const base = {
  DATABASE_URL: 'postgres://localhost:5432/civil_test',
  CIVIL_IAP_AUDIENCE: '/projects/1/locations/global/backendServices/2',
};

test('a dev identity in production refuses to boot', () => {
  assert.throws(
    () => loadConfig({ ...base, NODE_ENV: 'production', CIVIL_DEV_IDENTITY: 'me@example.com' }),
    /bypasses IAP entirely/,
  );
});

test('verification without an audience refuses to boot', () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: base.DATABASE_URL, NODE_ENV: 'production' }),
    /CIVIL_IAP_AUDIENCE is unset/,
  );
});

test('production verifies assertions by default', () => {
  const config = loadConfig({ ...base, NODE_ENV: 'production' });
  assert.equal(config.verifyIapJwt, true);
  assert.equal(config.devIdentity, undefined);
});

test('the dev shim produces the same Identity shape as IAP would', async () => {
  const config = loadConfig({ ...base, NODE_ENV: 'development', CIVIL_DEV_IDENTITY: 'me@example.com' });
  const identity = await createIdentityReader(config).read({});
  assert.deepEqual(identity, { subject: 'dev:me@example.com', email: 'me@example.com' });
});

test('unverified mode still requires both identity headers', async () => {
  const config = loadConfig({ ...base, NODE_ENV: 'development', CIVIL_VERIFY_IAP_JWT: 'false' });
  const reader = createIdentityReader(config);

  await assert.rejects(() => reader.read({}), UnauthenticatedError);
  await assert.rejects(
    () => reader.read({ 'x-goog-authenticated-user-email': 'accounts.google.com:me@example.com' }),
    UnauthenticatedError,
  );

  const identity = await reader.read({
    'x-goog-authenticated-user-id': 'accounts.google.com:112233',
    'x-goog-authenticated-user-email': 'accounts.google.com:me@example.com',
  });
  assert.deepEqual(identity, { subject: '112233', email: 'me@example.com' });
});

test('a forged assertion is rejected when verification is on', async () => {
  const config = loadConfig({ ...base, NODE_ENV: 'production' });
  const reader = createIdentityReader(config);

  // Unsigned "none" JWT carrying a plausible identity — the shape an attacker would
  // send if the server merely decoded rather than verified.
  const forged = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({ sub: 'accounts.google.com:1', email: 'attacker@example.com', iss: 'https://cloud.google.com/iap' }),
    ).toString('base64url'),
    '',
  ].join('.');

  await assert.rejects(
    () => reader.read({ 'x-goog-iap-jwt-assertion': forged }),
    UnauthenticatedError,
  );

  // And the plain headers must not be a way around verification.
  await assert.rejects(
    () =>
      reader.read({
        'x-goog-authenticated-user-id': 'accounts.google.com:1',
        'x-goog-authenticated-user-email': 'attacker@example.com',
      }),
    UnauthenticatedError,
  );
});
