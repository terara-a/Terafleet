import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceAccountTokenProvider } from '../src/google/auth.ts';
import { AndroidManagementClient, AndroidManagementError } from '../src/google/android-management.ts';

// Ephemeral test-only key; never store real credentials or device information.
const keys = await crypto.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
}, true, ['sign', 'verify']);
const der = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
const config = {
  clientEmail: 'test@example-project.iam.gserviceaccount.com',
  privateKey: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`,
};
const tokenResponse = () => Response.json({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 });
const tokens = { getAccessToken: async () => 'test-token' };

test('JWT exchange signs the intended claims and uses the fixed OAuth endpoint', async () => {
  const now = 1_800_000_000_000;
  const provider = new ServiceAccountTokenProvider(config, async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, payload, signature] = body.get('assertion').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
      iss: config.clientEmail, scope: 'https://www.googleapis.com/auth/androidmanagement',
      aud: url, iat: now / 1000, exp: now / 1000 + 3600,
    });
    assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey,
      Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${payload}`)), true);
    return tokenResponse();
  }, () => now);
  assert.equal(await provider.getAccessToken(), 'test-token');
});

test('concurrent requests share one exchange, cache tokens and refresh before expiry', async () => {
  let calls = 0;
  let now = 1_800_000_000_000;
  const provider = new ServiceAccountTokenProvider(config, async () => {
    calls++; return tokenResponse();
  }, () => now);
  await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
  await provider.getAccessToken();
  assert.equal(calls, 1);
  now += 3_541_000;
  await provider.getAccessToken();
  assert.equal(calls, 2);
});

test('OAuth failures do not leak upstream contents and can be retried', async () => {
  let calls = 0;
  const provider = new ServiceAccountTokenProvider(config, async () => {
    calls++;
    return calls === 1 ? new Response('secret-jwt-or-token', { status: 403 }) : tokenResponse();
  });
  await assert.rejects(provider.getAccessToken(), { message: 'Google authentication failed' });
  assert.equal(await provider.getAccessToken(), 'test-token');
});

test('network and key import errors are redacted', async () => {
  const provider = new ServiceAccountTokenProvider(config, async () => { throw new Error('secret-token'); });
  await assert.rejects(provider.getAccessToken(), { message: 'Google authentication failed' });
  const invalidKey = new ServiceAccountTokenProvider({ ...config,
    privateKey: '-----BEGIN PRIVATE KEY-----not-a-key-----END PRIVATE KEY-----',
  }, async () => { throw new Error('must not reach network'); });
  await assert.rejects(invalidKey.getAccessToken(), { message: 'Google authentication failed' });
});

for (const body of [null, {}, { access_token: '', token_type: 'Bearer', expires_in: 3600 },
  { access_token: 'header\ninjection', token_type: 'Bearer', expires_in: 3600 },
  { access_token: 'secret', token_type: 'Basic', expires_in: 3600 },
  { access_token: 'secret', token_type: 'Bearer', expires_in: 0 },
  { access_token: 'secret', token_type: 'Bearer', expires_in: '3600' }]) {
  test(`rejects invalid OAuth response ${JSON.stringify(body)}`, async () => {
    const provider = new ServiceAccountTokenProvider(config, async () => Response.json(body));
    await assert.rejects(provider.getAccessToken(), { message: 'Google authentication failed' });
  });
}

test('expired tokens caused by a slow exchange are rejected', async () => {
  let now = 1_800_000_000_000;
  const provider = new ServiceAccountTokenProvider(config, async () => {
    now += 3_600_000; return tokenResponse();
  }, () => now);
  await assert.rejects(provider.getAccessToken(), { message: 'Google authentication failed' });
});

test('rejects invalid service account configuration', () => {
  assert.throws(() => new ServiceAccountTokenProvider({ ...config, clientEmail: 'invalid' }));
  assert.throws(() => new ServiceAccountTokenProvider({ ...config, privateKey: '' }));
});

test('provider serialization does not expose the private key or cached access token', async () => {
  const provider = new ServiceAccountTokenProvider(config, async () => tokenResponse());
  await provider.getAccessToken();
  const serialized = JSON.stringify(provider);
  assert.ok(!serialized.includes('PRIVATE KEY'));
  assert.ok(!serialized.includes('test-token'));
  assert.ok(!serialized.includes(config.clientEmail));
});

test('enterprise list is a read-only authenticated request with encoded pagination', async () => {
  const client = new AndroidManagementClient('example-project', tokens, async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://androidmanagement.googleapis.com');
    assert.equal(parsed.pathname, '/v1/enterprises');
    assert.equal(parsed.searchParams.get('projectId'), 'example-project');
    assert.equal(parsed.searchParams.get('pageToken'), 'next+/=&');
    assert.equal(parsed.searchParams.get('pageSize'), '10');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ enterprises: [{ name: 'enterprises/test', enterpriseDisplayName: 'Example',
      ignoredField: 'not returned' }], nextPageToken: 'next' });
  });
  assert.deepEqual(await client.listEnterprises({ pageSize: 10, pageToken: 'next+/=&' }), {
    enterprises: [{ name: 'enterprises/test', enterpriseDisplayName: 'Example' }], nextPageToken: 'next',
  });
});

test('an empty project returns an empty list', async () => {
  const client = new AndroidManagementClient('example-project', tokens, async () => Response.json({}));
  assert.deepEqual(await client.listEnterprises(), { enterprises: [] });
});

test('invalid project and pagination fail before authentication or networking', async () => {
  const forbidden = { getAccessToken: async () => { throw new Error('must not authenticate'); } };
  assert.throws(() => new AndroidManagementClient('https://untrusted.example', forbidden));
  const client = new AndroidManagementClient('example-project', forbidden);
  for (const pageSize of [0, 101, 1.5, NaN]) {
    await assert.rejects(client.listEnterprises({ pageSize }), /pageSize/);
  }
});

test('API errors retain HTTP status without leaking the response body', async () => {
  const client = new AndroidManagementClient('example-project', tokens,
    async () => new Response('secret-response', { status: 403 }));
  await assert.rejects(client.listEnterprises(), error => {
    assert.ok(error instanceof AndroidManagementError);
    assert.equal(error.status, 403);
    assert.equal(error.message, 'Android Management API request failed');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('API network failures are redacted', async () => {
  const client = new AndroidManagementClient('example-project', tokens,
    async () => { throw new Error('secret-network-error'); });
  await assert.rejects(client.listEnterprises(), { message: 'Android Management API request failed' });
});

for (const body of [null, [], { enterprises: null }, { enterprises: [{ name: 'devices/test' }] },
  { enterprises: [{ name: 'enterprises/test', enterpriseDisplayName: 42 }] }, { nextPageToken: 1 }]) {
  test(`rejects malformed enterprise response ${JSON.stringify(body)}`, async () => {
    const client = new AndroidManagementClient('example-project', tokens, async () => Response.json(body));
    await assert.rejects(client.listEnterprises(), AndroidManagementError);
  });
}
