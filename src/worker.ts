import environmentCheck from '../tooling/environment-check.ts';
import { createAdminApp, type AdminEnv } from './admin/app.ts';

const admin = createAdminApp();

export default {
  async fetch(request: Request, env: AdminEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return environmentCheck.fetch(request);
    if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/')) return admin(request, env);
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<AdminEnv>;
