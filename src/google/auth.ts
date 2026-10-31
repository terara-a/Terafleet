const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidmanagement';

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface ServiceAccountConfig {
  clientEmail: string;
  privateKey: string;
}

export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Server-side only. Never serialize this instance or log upstream responses. */
export class ServiceAccountTokenProvider implements AccessTokenProvider {
  #cached?: { value: string; expiresAt: number };
  private pending?: Promise<string>;
  #key?: Promise<CryptoKey>;
  readonly #config: ServiceAccountConfig;
  private readonly http: HttpFetch;
  private readonly now: () => number;

  constructor(
    config: ServiceAccountConfig,
    http: HttpFetch = fetch,
    now: () => number = Date.now,
  ) {
    if (!/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(config.clientEmail)
      || !config.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) {
      throw new Error('Invalid Google service account configuration');
    }
    this.#config = { ...config };
    this.http = http;
    this.now = now;
  }

  getAccessToken(): Promise<string> {
    if (this.#cached && this.#cached.expiresAt - this.now() > 60_000) {
      return Promise.resolve(this.#cached.value);
    }
    this.pending ??= this.exchange().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async signingKey(): Promise<CryptoKey> {
    this.#key ??= (async () => {
      const pem = this.#config.privateKey
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
      const bytes = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
      return crypto.subtle.importKey(
        'pkcs8', bytes.buffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
      );
    })();
    return this.#key;
  }

  private async exchange(): Promise<string> {
    try {
      const started = this.now();
      const issuedAt = Math.floor(started / 1000);
      const input = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({
        iss: this.#config.clientEmail, scope: SCOPE, aud: TOKEN_URL,
        iat: issuedAt, exp: issuedAt + 3600,
      })}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5', await this.signingKey(), new TextEncoder().encode(input),
      );
      const response = await this.http(TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${input}.${base64url(new Uint8Array(signature))}`,
        }).toString(),
      });
      if (!response.ok) throw new Error('Token exchange rejected');
      const body = await response.json() as Record<string, unknown> | null;
      if (!body || typeof body.access_token !== 'string' || !body.access_token.trim()
        || /\s/.test(body.access_token)
        || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
        || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in)
        || body.expires_in <= 60) {
        throw new Error('Invalid token response');
      }
      const expiresAt = started + Math.min(body.expires_in, 3600) * 1000;
      if (expiresAt - this.now() <= 60_000) throw new Error('Token already expiring');
      this.#cached = { value: body.access_token, expiresAt };
      return body.access_token;
    } catch {
      // Upstream bodies/errors can contain JWT assertions, keys or tokens.
      throw new Error('Google authentication failed');
    }
  }
}
