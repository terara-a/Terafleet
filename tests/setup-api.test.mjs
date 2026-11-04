import test from 'node:test';
import assert from 'node:assert/strict';
import { AndroidManagementClient, AndroidManagementError } from '../src/google/android-management.ts';

const tokens = { getAccessToken: async () => 'test-token' };

test('signup URL creation pins project and callback and accepts Google signup destinations', async () => {
  for (const host of ['play.google.com', 'enterprise.google.com']) {
    const client = new AndroidManagementClient('example-project', tokens, async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://androidmanagement.googleapis.com');
      assert.equal(url.pathname, '/v1/signupUrls');
      assert.equal(url.searchParams.get('projectId'), 'example-project');
      assert.equal(url.searchParams.get('callbackUrl'), 'https://admin.example.test/admin/callback?state=test');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      return Response.json({ name: 'signupUrls/test', url: `https://${host}/signup?token=test` });
    });
    assert.equal((await client.createSignupUrl('https://admin.example.test/admin/callback?state=test')).name, 'signupUrls/test');
  }
});

test('signup rejects untrusted redirect destinations and malformed names', async () => {
  for (const result of [
    { name: 'signupUrls/test', url: 'https://untrusted.example/signup' },
    { name: 'signupUrls/test', url: 'https://play.google.com.untrusted.example/' },
    { name: 'signupUrls/test', url: 'javascript:alert(1)' },
    { name: 'signupUrls/test', url: 'https://user@play.google.com/' },
    { name: 'enterprises/test', url: 'https://play.google.com/signup' },
  ]) {
    const client = new AndroidManagementClient('example-project', tokens, async () => Response.json(result));
    await assert.rejects(client.createSignupUrl('https://admin.example.test/admin/callback'), AndroidManagementError);
  }
});

test('enterprise creation uses the customer-managed flow without accepting terms on the users behalf', async () => {
  const client = new AndroidManagementClient('example-project', tokens, async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, '/v1/enterprises');
    assert.equal(url.searchParams.get('enterpriseToken'), 'test+/=&');
    assert.equal(url.searchParams.get('signupUrlName'), 'signupUrls/test');
    assert.equal(url.searchParams.get('agreementAccepted'), null);
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { enterpriseDisplayName: 'Terafleet PoC' });
    return Response.json({ name: 'enterprises/test', ignored: 'not returned' });
  });
  assert.deepEqual(await client.createEnterprise('signupUrls/test', 'test+/=&'), { name: 'enterprises/test' });
});

test('baseline policy changes only the fixed app list under the specified enterprise', async () => {
  const client = new AndroidManagementClient('example-project', tokens, async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, '/v1/enterprises/test/policies/terafleet-byod-v1');
    assert.equal(url.searchParams.get('updateMask'), 'applications');
    assert.equal(init.method, 'PATCH');
    assert.deepEqual(JSON.parse(init.body), {
      applications: [{ packageName: 'com.android.chrome', installType: 'AVAILABLE' }],
    });
    return Response.json({ name: 'enterprises/test/policies/terafleet-byod-v1' });
  });
  assert.deepEqual(await client.applyBaselinePolicy('enterprises/test'), { name: 'enterprises/test/policies/terafleet-byod-v1' });
});

test('invalid setup inputs fail before networking', async () => {
  const client = new AndroidManagementClient('example-project', tokens, async () => { throw new Error('must not call network'); });
  await assert.rejects(client.createSignupUrl('http://admin.example.test/callback'), /Invalid signup callback/);
  await assert.rejects(client.createEnterprise('signupUrls/../other', 'test'), /Invalid enterprise signup/);
  await assert.rejects(client.createEnterprise('signupUrls/test', ''), /Invalid enterprise signup/);
  await assert.rejects(client.applyBaselinePolicy('enterprises/test/devices/other'), /Invalid enterprise name/);
});

test('setup API errors never expose token-bearing URL or response details', async () => {
  for (const http of [
    async () => { throw new Error('https://example.test/?enterpriseToken=secret'); },
    async () => new Response('secret-jwt', { status: 400 }),
    async () => new Response('invalid-json-secret'),
    async () => Response.json({ name: 'devices/invalid' }),
  ]) {
    const client = new AndroidManagementClient('example-project', tokens, http);
    await assert.rejects(client.createEnterprise('signupUrls/test', 'test'), {
      message: 'Android Management API request failed',
    });
  }
});
