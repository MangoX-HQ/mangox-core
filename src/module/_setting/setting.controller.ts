/**
 * Setting routes — administers the schema (entity/policy/resource/action/...) IN PLACE.
 *
 * Self-administered DEPLOY version: the tenant's own admin can edit schema/policy, no
 * Studio needed. Different from the backend-tenant version (read-only, waiting for Studio to seed it).
 *
 *   GET  → any logged-in user
 *   POST/PUT/PATCH/DELETE → admin only (requireAdmin)
 *
 * Data source: `json/` files via JsonSettingAdapter → jsonStore.
 * Every mutation writes to `json/<TEAM_ID>/<TENANT>/<type>/<slug>.json` (copy-on-write:
 * NEVER touches `json/system/`), then jsonStore emits 'change' → schemaSync
 * syncs to Redis immediately, no restart needed.
 *
 * Single-tenant, so `x-tenant-id` is not resolved — scope is always the env `<TEAM_ID>/<TENANT>`.
 */

import { FastifyInstance } from 'fastify';
import { jwtGuard } from '../..';
import { JsonSettingAdapter, ALLOWED_TYPES } from './setting.adapter';
import { getTenantScope } from '../../configs/tenant';
import { isSystemAdmin } from '../_auth/types';
import { AppError } from '../../utils/app-error';

const RESERVED_PARAMS = ['page', 'limit', 'select'];

/**
 * Writing schema is only for this tenant's own admin (self-administered deploy —
 * no Studio on top). Single-tenant, so there's no need to resolve x-tenant-id →
 * scope is always the env `<TEAM_ID>/<TENANT>`.
 */
async function requireAdmin(request: any, _reply: any): Promise<void> {
  const user = (request.headers as any)?.user;
  if (!user) throw AppError.unauthorized();
  const ok = !!user.is_super_admin || isSystemAdmin(user.role_system) || user.role_name === 'admin';
  if (!ok) throw AppError.forbidden('Chỉ admin mới được sửa schema/policy');
}

export async function SettingRoutes(app: FastifyInstance) {
  const readPreHandler = { preHandler: [jwtGuard.preHandler.bind(jwtGuard)] };
  const writePreHandler = {
    preHandler: [jwtGuard.preHandler.bind(jwtGuard), requireAdmin],
  };

  for (const type of ALLOWED_TYPES) {
    // ── GET list — any logged-in user ─────────────────────────────────────
    app.get<{ Querystring: Record<string, string> }>(
      `/${type}`,
      readPreHandler,
      async (request, _reply) => {
        const adapter = new JsonSettingAdapter(getTenantScope() || null);
        const query = request.query;
        const filters: Record<string, string> = {};
        for (const [key, value] of Object.entries(query)) {
          if (!RESERVED_PARAMS.includes(key) && typeof value === 'string') {
            filters[key] = value;
          }
        }
        return adapter.list(type, {
          page: parseInt(query.page || '1', 10),
          limit: parseInt(query.limit || '10', 10),
          select: query.select,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        });
      },
    );

    // ── GET detail ────────────────────────────────────────────────────────
    app.get<{ Params: { slug: string } }>(
      `/${type}/:slug`,
      readPreHandler,
      async (request, _reply) => {
        const adapter = new JsonSettingAdapter(getTenantScope() || null);
        const { slug } = request.params;
        const data = await adapter.getBySlug(type, slug);
        if (!data) throw AppError.notFound(type, slug);
        return { data };
      },
    );

    // ── POST — create new (writes json/<TEAM_ID>/<TENANT>/<type>/<slug>.json) ───
    app.post<{ Body: any; Querystring: Record<string, string> }>(
      `/${type}`,
      writePreHandler,
      async (request, _reply) => {
        const adapter = new JsonSettingAdapter(getTenantScope() || null);
        const gen = String(request.query?.gen ?? '').toLowerCase() === 'true';
        const data = await adapter.create(type, request.body, { gen });
        if (!data) throw AppError.conflict(type, 'slug is required or already exists');
        return { data };
      },
    );

    // ── PUT — replace entirely (slug in system → creates an override in tenant scope) ─
    app.put<{ Params: { slug: string }; Body: any }>(
      `/${type}/:slug`,
      writePreHandler,
      async (request, _reply) => {
        const adapter = new JsonSettingAdapter(getTenantScope() || null);
        const { slug } = request.params;
        const data = await adapter.replace(type, slug, request.body);
        if (!data) throw AppError.notFound(type, slug);
        return { data };
      },
    );

    // ── PATCH — partial update ────────────────────────────────────────────
    app.patch<{ Params: { slug: string }; Body: any }>(
      `/${type}/:slug`,
      writePreHandler,
      async (request, _reply) => {
        const adapter = new JsonSettingAdapter(getTenantScope() || null);
        const { slug } = request.params;
        const data = await adapter.patch(type, slug, request.body);
        if (!data) throw AppError.notFound(type, slug);
        return { data };
      },
    );

    // ── DELETE bulk — only deletes files in tenant scope, system is read-only ─
    app.delete<{ Querystring: Record<string, string> }>(
      `/${type}`,
      writePreHandler,
      async (request, _reply) => {
        const adapter = new JsonSettingAdapter(getTenantScope() || null);
        const idsParam = (request.query as any).ids;
        if (!idsParam) throw AppError.badRequest('ids query param is required', 'IDS_REQUIRED');
        const ids = typeof idsParam === 'string' ? idsParam.split(',') : [idsParam];
        const deleted = await adapter.deleteMany(type, ids);
        if (deleted.length === 0) throw AppError.notFound(type);
        return { data: deleted };
      },
    );

    // ── DELETE single ────────────────────────────────────────────────────
    app.delete<{ Params: { slug: string } }>(
      `/${type}/:slug`,
      writePreHandler,
      async (request, _reply) => {
        const adapter = new JsonSettingAdapter(getTenantScope() || null);
        const { slug } = request.params;
        const deleted = await adapter.delete(type, slug);
        if (!deleted) throw AppError.notFound(type, slug);
        return { message: `${slug} deleted` };
      },
    );
  }
}
