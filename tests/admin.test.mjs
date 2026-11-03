import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAdminApp } from '../src/admin/app.ts';
import { SetupStore } from '../src/admin/store.ts';
import worker from '../src/worker.ts';

// Real in-memory SQLite executing the same migration and SQL as D1. Synthetic data only.
function fixture(t, overrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_setup.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const db = { prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
    };
  } };
  const env = { ADMIN_ORIGIN: 'https://admin.example.test', SETUP_DB: db };
  const calls = [];
  let callback;
  let now = 1_800_000_000_000;
  const methods = {
    async listEnterprises() { calls.push('list'); return { enterprises: [] }; },
    async createSignupUrl(url) { calls.push('signup'); callback = new URL(url); return { name: 'signupUrls/test', url: 'https://play.google.com/work/adminsignup?token=test' }; },
    async createEnterprise(name, token) { calls.push(['create', name, token]); return { name: 'enterprises/test' }; },
    async applyBaselinePolicy(name) { calls.push(['policy', name]); return { name: name + '/policies/terafleet-byod-v1' }; },
    ...overrides,
  };
  const app = createAdminApp({ authorize: async req => {
    if (req.headers.get('test-auth') === 'deny') throw new Error('unauthorized-secret');
    return { sub: req.headers.get('test-sub') ?? 'test-admin' };
  }, api: () => methods, now: () => now });
  const send = (path, method = 'GET', form, headers = {}) => {
    const h = { ...headers };
    if (method === 'POST') {
      h.Origin ??= env.ADMIN_ORIGIN;
      h['Content-Type'] ??= 'application/x-www-form-urlencoded';
    }
    return app(new Request(new URL(path, env.ADMIN_ORIGIN), {
      method, headers: h, ...(method === 'POST' ? { body: new URLSearchParams(form ?? {}).toString() } : {}),
    }), env);
  };
  return { sqlite, env, app, calls, send, store: new SetupStore(db), advance: ms => { now += ms; },
    async begin() {
      const response = await send('/admin/signup', 'POST');
      assert.equal(response.status, 200);
      return { state: callback.searchParams.get('state'), enterpriseToken: 'test-enterprise-token' };
    } };
}

test('all admin routes reject an unauthenticated request before external operations', async t => {
  const f = fixture(t);
  for (const [path, method] of [['/admin', 'GET'], ['/api/enterprises', 'GET'], ['/admin/callback', 'GET'],
    ['/admin/signup', 'POST'], ['/admin/enterprise', 'POST'], ['/admin/policy', 'POST']]) {
    const response = await f.send(path, method, {}, { 'test-auth': 'deny' });
    assert.equal(response.status, 401);
    assert.equal(await response.text(), 'Unauthorized');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(f.calls, []);
});

test('POST requires same-origin provenance and refuses cross-site forms', async t => {
  const f = fixture(t);
  for (const headers of [{ Origin: 'https://other.example.test' }, { Origin: 'null' },
    { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await f.send('/admin/signup', 'POST', {}, headers)).status, 403);
  }
  assert.deepEqual(f.calls, []);
});

test('admin dashboard has restrictive headers and no mutation on GET', async t => {
  const f = fixture(t);
  const response = await f.send('/admin');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  for (const path of ['/admin/signup', '/admin/enterprise', '/admin/policy']) {
    assert.equal((await f.send(path)).status, 404);
  }
  assert.deepEqual(f.calls, []);
});

test('callback GET asks for confirmation; POST creates exactly once and policy targets saved enterprise', async t => {
  const f = fixture(t);
  const form = await f.begin();
  const row = await f.store.get();
  assert.notEqual(row.state_hash, form.state);
  assert.equal(row.state_hash.length, 64);
  const callback = await f.send('/admin/callback?' + new URLSearchParams(form));
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /history.replaceState/);
  assert.deepEqual(f.calls, ['signup']);
  const response = await f.send('/admin/enterprise', 'POST', form);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/admin');
  assert.equal((await f.send('/admin/enterprise', 'POST', form)).status, 409);
  const stored = await f.store.get();
  assert.equal(stored.status, 'created');
  assert.equal(stored.state_hash, null);
  assert.equal(stored.admin_sub, null);
  assert.equal(stored.signup_name, null);
  assert.ok(!JSON.stringify(stored).includes(form.enterpriseToken));
  assert.equal((await f.send('/admin/policy', 'POST', { enterprise: 'enterprises/other' })).status, 200);
  assert.deepEqual(f.calls.at(-1), ['policy', 'enterprises/test']);
});

test('simultaneous enterprise confirmations result in only one create call', async t => {
  const f = fixture(t);
  const form = await f.begin();
  const responses = await Promise.all([f.send('/admin/enterprise', 'POST', form), f.send('/admin/enterprise', 'POST', form)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [303, 409]);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'create').length, 1);
});

test('simultaneous signup requests reserve the singleton state atomically', async t => {
  const f = fixture(t);
  const responses = await Promise.all([f.send('/admin/signup', 'POST'), f.send('/admin/signup', 'POST')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(f.calls, ['signup']);
});

test('rejects expired, mismatched and different-principal callbacks and confirmations', async t => {
  const f = fixture(t);
  const form = await f.begin();
  for (const [input, headers] of [[{ ...form, state: '0'.repeat(64) }, {}], [form, { 'test-sub': 'other-admin' }]]) {
    assert.equal((await f.send('/admin/callback?' + new URLSearchParams(input), 'GET', undefined, headers)).status, 409);
    assert.equal((await f.send('/admin/enterprise', 'POST', input, headers)).status, 409);
  }
  f.advance(3600_001);
  assert.equal((await f.send('/admin/enterprise', 'POST', form)).status, 409);
  assert.equal((await f.send('/admin/callback?' + new URLSearchParams(form))).status, 409);
  assert.deepEqual(f.calls, ['signup']);
  assert.equal((await f.send('/admin/signup', 'POST')).status, 200);
});

test('uncertain creation outcome enters needs_review and cannot be retried', async t => {
  let attempts = 0;
  const f = fixture(t, { async createEnterprise() { attempts++; throw new Error('secret-token-or-upstream-body'); } });
  const form = await f.begin();
  const response = await f.send('/admin/enterprise', 'POST', form);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('secret-token'));
  assert.equal((await f.store.get()).status, 'needs_review');
  assert.equal((await f.send('/admin/enterprise', 'POST', form)).status, 409);
  assert.equal((await f.send('/admin/signup', 'POST')).status, 409);
  assert.equal(attempts, 1);
});

test('signup preparation failures can restart without creating an enterprise', async t => {
  const f = fixture(t, { async createSignupUrl() { throw new Error('secret'); } });
  assert.equal((await f.send('/admin/signup', 'POST')).status, 502);
  assert.equal((await f.store.get()).status, 'idle');
});

test('rejects missing or duplicate callback fields and escapes token content in the confirmation form', async t => {
  const f = fixture(t);
  const form = await f.begin();
  assert.equal((await f.send('/admin/callback?state=' + form.state)).status, 400);
  const duplicate = new URLSearchParams(form); duplicate.append('state', form.state);
  assert.equal((await f.send('/admin/callback?' + duplicate)).status, 400);
  const dangerous = new URLSearchParams({ ...form, enterpriseToken: '\"><svg/onload=x>' });
  const response = await f.send('/admin/callback?' + dangerous);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!html.includes('<svg'));
  assert.match(html, /&quot;&gt;&lt;svg/);
});

test('invalid form encoding and oversized streamed form are rejected', async t => {
  const f = fixture(t);
  assert.equal((await f.send('/admin/signup', 'POST', {}, { 'Content-Type': 'application/json' })).status, 400);
  assert.equal((await f.send('/admin/signup', 'POST', { large: 'x'.repeat(20_000) })).status, 400);
  assert.deepEqual(f.calls, []);
});

test('policy cannot be applied before setup and read-only listing does not create state', async t => {
  const f = fixture(t);
  assert.equal((await f.send('/admin/policy', 'POST')).status, 409);
  const response = await f.send('/api/enterprises');
  assert.deepEqual(await response.json(), { enterprises: [] });
  assert.equal((await f.store.get()).status, 'idle');
  assert.deepEqual(f.calls, ['list']);
});

test('missing production configuration fails closed, with no local authentication bypass', async () => {
  const response = await worker.fetch(new Request('http://127.0.0.1:8787/admin'), {});
  assert.equal(response.status, 503);
  const configuredOrigin = await worker.fetch(new Request('https://admin.example.test/admin'), {
    ADMIN_ORIGIN: 'https://admin.example.test',
  });
  assert.equal(configuredOrigin.status, 401);
  assert.equal((await worker.fetch(new Request('https://admin.example.test/not-found'), {})).status, 404);
});
