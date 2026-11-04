import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createAccessVerifier } from '../src/admin/access.ts';

const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const config = { teamDomain: 'example.cloudflareaccess.com', audience: 'test-audience', adminEmail: 'admin@example.test' };
const verify = createAccessVerifier(config, createLocalJWKSet({ keys: [jwk] }));

async function token(overrides = {}, key = keys.privateKey, algorithm = 'RS256') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: 'test-admin', email: 'admin@example.test', type: 'app',
    iss: 'https://example.cloudflareaccess.com', aud: 'test-audience', iat: now, exp: now + 600,
    ...overrides }).setProtectedHeader({ alg: algorithm, kid: 'test-key' }).sign(key);
}
const request = assertion => new Request('https://admin.example.test/admin', {
  headers: { 'Cf-Access-Jwt-Assertion': assertion },
});

test('verifies a signed Access app token for the configured person', async () => {
  assert.deepEqual(await verify(request(await token())), { sub: 'test-admin' });
});

test('ignores spoofed authenticated-user headers without a signed assertion', async () => {
  const req = new Request('https://admin.example.test/admin', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.test' },
  });
  await assert.rejects(verify(req), { message: 'Unauthorized' });
});

for (const [description, claims] of [
  ['wrong audience', { aud: 'another-app' }],
  ['wrong issuer', { iss: 'https://another.cloudflareaccess.com' }],
  ['wrong administrator', { email: 'other@example.test' }],
  ['service token', { type: 'service' }],
  ['empty subject', { sub: '' }],
  ['expired token', { exp: 1 }],
  ['missing expiry', { exp: undefined }],
  ['missing email', { email: undefined }],
  ['future issue time', { iat: Math.floor(Date.now() / 1000) + 600 }],
  ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 600 }],
]) {
  test(`rejects ${description}`, async () => {
    await assert.rejects(verify(request(await token(claims))), { message: 'Unauthorized' });
  });
}

test('rejects tokens signed with another key or algorithm', async () => {
  const other = await generateKeyPair('RS256');
  await assert.rejects(verify(request(await token({}, other.privateKey))), { message: 'Unauthorized' });
  const hmac = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(verify(request(await token({}, hmac, 'HS256'))), { message: 'Unauthorized' });
});

test('rejects malformed and oversized assertions', async () => {
  for (const value of ['not-a-jwt', 'x'.repeat(16_385)]) {
    await assert.rejects(verify(request(value)), { message: 'Unauthorized' });
  }
});

test('rejects invalid Access configuration without fetching a remote URL', () => {
  for (const teamDomain of ['https://example.cloudflareaccess.com', 'example.test', 'example.cloudflareaccess.com/path']) {
    assert.throws(() => createAccessVerifier({ ...config, teamDomain }));
  }
  assert.throws(() => createAccessVerifier({ ...config, audience: '' }));
});
