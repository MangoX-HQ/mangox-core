/**
 * Fastify plugin — wraps each request with a DebugContext.
 * Activates when process.env.DEBUG === 'true'.
 */
import { FastifyInstance } from 'fastify';
import {
  debugStart, enterDebug, debugFinish, dbgStep, dbgMeta, isDebugEnabled,
} from './debug-logger';

export async function registerDebugPlugin(app: FastifyInstance) {
  if (!isDebugEnabled()) {
    console.log('[debug-logger] DISABLED (set DEBUG=true to enable)');
    return;
  }
  console.log('[debug-logger] ENABLED — logging to logs/debug/YYYY-MM-DD/');

  app.addHook('onRequest', async (request) => {
    const ctx = debugStart(request.method, request.url);
    enterDebug(ctx);
    const headerTenant = (request.headers['x-tenant-id'] as string) || undefined;
    if (headerTenant) dbgMeta({ tenant: headerTenant });
    dbgStep('onRequest', {
      ua: (request.headers['user-agent'] as string)?.slice(0, 40),
      ip: request.ip,
    });
  });

  app.addHook('preHandler', async (request) => {
    const u: any = request.headers.user;
    if (u?.email) dbgMeta({ user: u.email });
  });

  app.addHook('onResponse', async (request, reply) => {
    dbgStep('onResponse', { status: reply.statusCode });
    await debugFinish(reply.statusCode);
  });

  app.addHook('onError', async (_req, _reply, err) => {
    dbgStep('!!ERROR', { message: err?.message, code: (err as any)?.code });
  });
}
