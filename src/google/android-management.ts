import type { AccessTokenProvider, HttpFetch } from './auth.ts';

export interface Enterprise {
  name: string;
  enterpriseDisplayName?: string;
}

export interface EnterprisePage {
  enterprises: Enterprise[];
  nextPageToken?: string;
}

export class AndroidManagementError extends Error {
  readonly status?: number;
  constructor(status?: number) {
    super('Android Management API request failed');
    this.name = 'AndroidManagementError';
    this.status = status;
  }
}

export function isEnterpriseName(value: string): boolean {
  return /^enterprises\/[A-Za-z0-9_-]+$/.test(value);
}

/** Setup operations only. No enrollment tokens, device commands or deletion. */
export class AndroidManagementClient {
  private readonly projectId: string;
  private readonly tokens: AccessTokenProvider;
  private readonly http: HttpFetch;
  constructor(
    projectId: string,
    tokens: AccessTokenProvider,
    http: HttpFetch = fetch,
  ) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
      throw new Error('Invalid Google Cloud project ID');
    }
    this.projectId = projectId;
    this.tokens = tokens;
    this.http = http;
  }

  async listEnterprises(options: { pageSize?: number; pageToken?: string } = {}): Promise<EnterprisePage> {
    const size = options.pageSize ?? 100;
    if (!Number.isInteger(size) || size < 1 || size > 100) {
      throw new Error('pageSize must be an integer between 1 and 100');
    }
    const url = new URL('https://androidmanagement.googleapis.com/v1/enterprises');
    url.searchParams.set('projectId', this.projectId);
    url.searchParams.set('pageSize', String(size));
    if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);
    const token = await this.tokens.getAccessToken();
    let response: Response;
    try {
      response = await this.http(url.toString(), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new AndroidManagementError();
    }
    if (!response.ok) throw new AndroidManagementError(response.status);
    try {
      const body = await response.json() as Record<string, unknown> | null;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || (body.enterprises !== undefined && !Array.isArray(body.enterprises))
        || (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string')) {
        throw new Error('Invalid enterprise response');
      }
      const enterprises = ((body.enterprises ?? []) as unknown[]).map(value => {
        if (!value || typeof value !== 'object') throw new Error('Invalid enterprise');
        const entry = value as Record<string, unknown>;
        if (typeof entry.name !== 'string' || !/^enterprises\/[A-Za-z0-9_-]+$/.test(entry.name)
          || (entry.enterpriseDisplayName !== undefined && typeof entry.enterpriseDisplayName !== 'string')) {
          throw new Error('Invalid enterprise');
        }
        return { name: entry.name, ...(entry.enterpriseDisplayName !== undefined
          ? { enterpriseDisplayName: entry.enterpriseDisplayName as string } : {}) };
      });
      return { enterprises, ...(body.nextPageToken !== undefined
        ? { nextPageToken: body.nextPageToken as string } : {}) };
    } catch {
      throw new AndroidManagementError(response.status);
    }
  }

  private async setupRequest(url: URL, method: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.tokens.getAccessToken();
    let status: number | undefined;
    try {
      const response = await this.http(url.toString(), {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      if (!response.ok) throw new Error('Setup request rejected');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid response');
      return result as Record<string, unknown>;
    } catch {
      // Signup tokens may appear in upstream URLs or error descriptions.
      throw new AndroidManagementError(status);
    }
  }

  async createSignupUrl(callback: string): Promise<{ name: string; url: string }> {
    const callbackUrl = new URL(callback);
    if (callbackUrl.protocol !== 'https:' || callbackUrl.username || callbackUrl.password) {
      throw new Error('Invalid signup callback');
    }
    const url = new URL('https://androidmanagement.googleapis.com/v1/signupUrls');
    url.searchParams.set('projectId', this.projectId);
    url.searchParams.set('callbackUrl', callbackUrl.toString());
    const result = await this.setupRequest(url, 'POST');
    try {
      if (typeof result.name !== 'string' || !/^signupUrls\/[A-Za-z0-9_-]+$/.test(result.name)
        || typeof result.url !== 'string') throw new Error('Invalid signup response');
      const signupUrl = new URL(result.url);
      if (signupUrl.protocol !== 'https:' || signupUrl.username || signupUrl.password || signupUrl.port
        || !['enterprise.google.com', 'play.google.com'].includes(signupUrl.hostname)) {
        throw new Error('Invalid signup destination');
      }
      return { name: result.name, url: signupUrl.toString() };
    } catch {
      throw new AndroidManagementError();
    }
  }

  async createEnterprise(signupUrlName: string, enterpriseToken: string): Promise<Enterprise> {
    if (!/^signupUrls\/[A-Za-z0-9_-]+$/.test(signupUrlName)
      || !enterpriseToken || enterpriseToken.length > 4096 || /\s/.test(enterpriseToken)) {
      throw new Error('Invalid enterprise signup');
    }
    const url = new URL('https://androidmanagement.googleapis.com/v1/enterprises');
    url.searchParams.set('projectId', this.projectId);
    url.searchParams.set('signupUrlName', signupUrlName);
    url.searchParams.set('enterpriseToken', enterpriseToken);
    // The administrator accepts Google's terms in the signup UI, not here.
    const result = await this.setupRequest(url, 'POST', { enterpriseDisplayName: 'Terafleet PoC' });
    if (typeof result.name !== 'string' || !isEnterpriseName(result.name)) throw new AndroidManagementError();
    return { name: result.name };
  }

  async applyBaselinePolicy(enterprise: string): Promise<{ name: string }> {
    if (!isEnterpriseName(enterprise)) throw new Error('Invalid enterprise name');
    const name = `${enterprise}/policies/terafleet-byod-v1`;
    const url = new URL(`https://androidmanagement.googleapis.com/v1/${name}`);
    url.searchParams.set('updateMask', 'applications');
    const result = await this.setupRequest(url, 'PATCH', {
      applications: [{ packageName: 'com.android.chrome', installType: 'AVAILABLE' }],
    });
    if (result.name !== name) throw new AndroidManagementError();
    return { name };
  }
}
