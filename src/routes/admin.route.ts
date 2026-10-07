/**
 * Admin / infra routes for single-tenant deploy.
 *
 * POST /admin/reload — "reload json from redis": reloads the schema from Redis into the
 * in-memory cache (entity relationships + MCP action cache) + flushes the query cache, with NO
 * need to restart the container. Called after the control-plane reseeds Redis for the tenant.
 *
 * Auth: super_admin JWT (RS256 SSO or HS256) OR header `x-reload-token`
 * matching env RELOAD_TOKEN (for the control-plane to call without a user token).
 */

import { FastifyInstance } from 'fastify';
import { verifyToken } from '../configs/jwt-verify';
import { isSuperAdmin } from '../module/_auth/types';
import { getCoreUnified } from '../configs/core';
import { getTenantScope } from '../configs/tenant';
import { AppError } from '../utils/app-error';

export async function AdminRoutes(app: FastifyInstance) {
  app.post('/admin/reload', async (request) => {
    // ── Auth: infra token OR super_admin ────────────────────────────────────
    const reloadToken = process.env.RELOAD_TOKEN;
    const provided = request.headers['x-reload-token'] as string | undefined;
    let authed = !!(reloadToken && provided && provided === reloadToken);
    if (!authed) {
      try {
        const authz = (request.headers['authorization'] as string) || '';
        const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
        const user: any = token ? verifyToken(token) : null;
        authed = !!(user && isSuperAdmin(user));
      } catch {
        authed = false;
      }
    }
    if (!authed) {
      throw AppError.forbidden('Yêu cầu super_admin token hoặc header x-reload-token');
    }

    // ── Reload ──────────────────────────────────────────────────────────────
    const started = Date.now();
    const { getEntityConfigLoader } = await import('../configs/core/bootstrap');
    await getEntityConfigLoader().reloadAll();

    let cacheFlushed = false;
    try {
      const core: any = getCoreUnified();
      const cm = core.getCacheManager?.();
      if (cm?.flushAll) {
        await cm.flushAll();
        cacheFlushed = true;
      }
    } catch {
      /* cache optional */
    }

    try {
      const { mcpService } = await import('../module/_mcp');
      (mcpService as any).clearCache?.();
    } catch {
      /* mcp optional */
    }

    return {
      message: 'Schema reloaded from Redis',
      scope: getTenantScope(),
      cache_flushed: cacheFlushed,
      took_ms: Date.now() - started,
    };
  });
}
