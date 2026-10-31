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

/** Read-only API client. Does not expose enrollment, policy or device mutations. */
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
}
