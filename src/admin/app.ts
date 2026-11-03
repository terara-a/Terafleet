import { createAccessVerifier, type AdminIdentity } from './access.ts';
import { SetupStore } from './store.ts';
import { AndroidManagementClient } from '../google/android-management.ts';
import { ServiceAccountTokenProvider } from '../google/auth.ts';

export interface AdminEnv {
  ADMIN_ORIGIN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  ADMIN_EMAIL: string;
  GOOGLE_CLOUD_PROJECT: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  SETUP_DB: D1Database;
}

interface Dependencies {
  authorize?: (request: Request, env: AdminEnv) => Promise<AdminIdentity>;
  api?: (env: AdminEnv) => Pick<AndroidManagementClient,
    'listEnterprises' | 'createSignupUrl' | 'createEnterprise' | 'applyBaselinePolicy'>;
  now?: () => number;
}

const escape = (value: string) => value.replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function headers(nonce?: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}`,
  });
}

function message(text: string, status = 200): Response {
  const h = headers(); h.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(text, { status, headers: h });
}

function page(content: string, scrubUrl = false): Response {
  const nonce = crypto.randomUUID();
  const h = headers(nonce); h.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terafleet 管理</title>${scrubUrl
    ? `<script nonce="${nonce}">history.replaceState(null,'','/admin/callback')</script>` : ''}<body><h1>Terafleet 管理</h1>${content}</body></html>`, { headers: h });
}

function redirect(path: string): Response {
  const h = headers(); h.set('Location', path);
  return new Response(null, { status: 303, headers: h });
}

function origin(env: AdminEnv): string {
  const url = new URL(env.ADMIN_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== env.ADMIN_ORIGIN) throw new Error('Invalid admin origin');
  return url.origin;
}

async function hash(state: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))),
    b => b.toString(16).padStart(2, '0')).join('');
}

function callbackValues(params: URLSearchParams): { state: string; token: string } | undefined {
  const state = params.get('state');
  const token = params.get('enterpriseToken');
  if (params.getAll('state').length !== 1 || params.getAll('enterpriseToken').length !== 1
    || !state || !/^[a-f0-9]{64}$/.test(state) || !token || token.length > 4096 || /\s/.test(token)) return;
  return { state, token };
}

async function readForm(request: Request): Promise<URLSearchParams | undefined> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return;
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); return; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

/** Dependencies are code-level test seams, never selected by a request or env bypass flag. */
export function createAdminApp(deps: Dependencies = {}) {
  const authCache = new WeakMap<AdminEnv, ReturnType<typeof createAccessVerifier>>();
  const apiCache = new WeakMap<AdminEnv, AndroidManagementClient>();
  const now = deps.now ?? Date.now;
  function api(env: AdminEnv) {
    if (deps.api) return deps.api(env);
    let client = apiCache.get(env);
    if (!client) {
      client = new AndroidManagementClient(env.GOOGLE_CLOUD_PROJECT,
        new ServiceAccountTokenProvider({ clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY }));
      apiCache.set(env, client);
    }
    return client;
  }

  return async (request: Request, env: AdminEnv): Promise<Response> => {
    try {
      const expectedOrigin = origin(env);
      const url = new URL(request.url);
      if (url.origin !== expectedOrigin) return message('Not found', 404);
      let identity: AdminIdentity;
      try {
        if (deps.authorize) identity = await deps.authorize(request, env);
        else {
          let verify = authCache.get(env);
          if (!verify) { verify = createAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN,
            audience: env.ACCESS_AUDIENCE, adminEmail: env.ADMIN_EMAIL }); authCache.set(env, verify); }
          identity = await verify(request);
        }
      } catch { return message('Unauthorized', 401); }

      if (request.method !== 'GET' && request.method !== 'POST') return message('Method not allowed', 405);
      if (request.method === 'POST' && (request.headers.get('Origin') !== expectedOrigin
        || request.headers.get('Sec-Fetch-Site') === 'cross-site')) return message('Forbidden', 403);
      const store = new SetupStore(env.SETUP_DB);

      if (request.method === 'GET' && url.pathname === '/api/enterprises') {
        const result = await api(env).listEnterprises({ pageToken: url.searchParams.get('pageToken') ?? undefined });
        const h = headers(); h.set('Content-Type', 'application/json');
        return new Response(JSON.stringify(result), { headers: h });
      }

      if (request.method === 'GET' && url.pathname === '/admin') {
        const state = await store.get();
        return page(`<p>登録状態: ${escape(state.status)}</p><p><a href="/api/enterprises">Google の Enterprise 一覧（読み取り）</a></p>${state.status === 'created'
          ? `<p>Enterprise: ${escape(state.enterprise_name ?? '')}</p><p>固定ポリシーのアプリ一覧を仕事用 Chrome のみにします。既にこのポリシーを利用する端末には変更が反映されます。新たな端末登録は行いません。</p><form method="post" action="/admin/policy"><button>最小ポリシーを作成・更新</button></form>`
          : `<p>Google の登録画面で規約・管理者を確認後、この管理画面で Enterprise 作成を確定します。</p><form method="post" action="/admin/signup"><button>Google の登録画面を準備</button></form>`}<p>creating / needs_review の場合は Google 側の結果を確認してください。登録の自動再試行は行いません。</p>`);
      }

      if (request.method === 'POST' && url.pathname === '/admin/signup') {
        if (!await readForm(request)) return message('Invalid form', 400);
        const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
        const digest = await hash(state);
        if (!await store.start(digest, identity.sub, now())) return message('Setup is already in progress or complete', 409);
        try {
          const callback = new URL('/admin/callback', expectedOrigin); callback.searchParams.set('state', state);
          const signup = await api(env).createSignupUrl(callback.toString());
          await store.awaiting(digest, signup.name);
          return page(`<p>登録画面は 1 時間以内に使用してください。</p><p><a rel="noreferrer" href="${escape(signup.url)}">Google の登録画面へ進む</a></p>`);
        } catch {
          await store.cancelStart(digest);
          return message('Signup preparation failed', 502);
        }
      }

      if (request.method === 'GET' && url.pathname === '/admin/callback') {
        const input = callbackValues(url.searchParams);
        if (!input) return message('Invalid callback', 400);
        const state = await store.get();
        if (state.status !== 'awaiting_signup' || state.state_hash !== await hash(input.state)
          || state.admin_sub !== identity.sub || !state.expires_at || state.expires_at <= now()) {
          return message('Signup state is invalid or expired', 409);
        }
        return page(`<p>Google の登録内容を使用して Enterprise を作成します。端末登録は行いません。</p><form method="post" action="/admin/enterprise"><input type="hidden" name="state" value="${escape(input.state)}"><input type="hidden" name="enterpriseToken" value="${escape(input.token)}"><button>Enterprise 作成を確定</button></form>`, true);
      }

      if (request.method === 'POST' && url.pathname === '/admin/enterprise') {
        const form = await readForm(request);
        const input = form && callbackValues(form);
        if (!input) return message('Invalid signup confirmation', 400);
        const digest = await hash(input.state);
        // Validate local configuration before claiming the one-time operation.
        const client = api(env);
        if (!await store.claim(digest, identity.sub, now())) return message('Signup state is invalid or already used', 409);
        try {
          const state = await store.get();
          if (!state.signup_name) throw new Error('Missing signup');
          const enterprise = await client.createEnterprise(state.signup_name, input.token);
          await store.complete(digest, enterprise.name);
          return redirect('/admin');
        } catch {
          // A timeout can happen after Google created the enterprise. Never blindly retry.
          await store.needsReview(digest);
          return message('Enterprise creation outcome requires manual review; do not retry automatically', 502);
        }
      }

      if (request.method === 'POST' && url.pathname === '/admin/policy') {
        if (!await readForm(request)) return message('Invalid form', 400);
        const state = await store.get();
        if (state.status !== 'created' || !state.enterprise_name) return message('Enterprise setup is incomplete', 409);
        await api(env).applyBaselinePolicy(state.enterprise_name);
        return page('<p>固定ポリシーを作成・更新しました。実機への登録や適用は確認していません。</p><p><a href="/admin">管理画面へ戻る</a></p>');
      }
      return message('Not found', 404);
    } catch {
      // Do not log request URLs, claims, D1 rows, or upstream error bodies.
      return message('Service unavailable; check configuration and setup state', 503);
    }
  };
}
