/**
 * Approval count API — counts posts by the user's rules + posts the user created, for 1 entity (post-type).
 *
 *   GET /approval/count/:entity   (auth)  header: x-tenant-id
 *   → { entity, rules: [{ code, title, count }], my_posts }
 *
 * - rules: for each rule-code the user's role holds → count posts currently in that status.
 * - my_posts: number of posts the user created (created_by) in that entity.
 * Post-type data lives in `mongodb_save_data` (e.g. post-type-content), discriminator `post_type`.
 *
 * Single-tenant: db = _systemDb (getTenantDb), scope = env (getTenantScope).
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { jwtGuard } from '../..';
import { runWithTenantSlug, getTenantDb, getTenantScope } from '../../core_v2/adapters/mongodb/tenant-context';
import { TENANT_SLUG } from '../../configs/tenant';
import { getApprovalOperations } from '../../core_v2';
import { schemaManager } from '../../core_v2/schema/manager';
import { AppError } from '../../utils/app-error';

async function withTenantContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const headerTenantId = (request.headers['x-tenant-id'] as string) || undefined;
  if (!headerTenantId) return fn();
  const slug = TENANT_SLUG || headerTenantId;
  return runWithTenantSlug(slug, headerTenantId, fn);
}

export async function ApprovalRoutes(app: FastifyInstance) {
  app.get<{ Params: { entity: string } }>(
    '/approval/count/:entity',
    { preHandler: [jwtGuard.preHandler.bind(jwtGuard)] },
    async (request: FastifyRequest<{ Params: { entity: string } }>, _reply: FastifyReply) => {
      return withTenantContext(request, async () => {
        const entity = request.params.entity;
        const user = (request.headers.user as any) || {};
        const userId = user.id || user._id;
        const isAdmin =
          user.is_super_admin === true ||
          user.role_system === 'admin' ||
          user.role_system === 'super_admin' ||
          user.role_name === 'admin';

        const scope = getTenantScope();
        const db = getTenantDb();
        if (!db) throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'Thiếu tenant context (x-tenant-id)' });

        // Entity config → physical collection + discriminator
        const ent: any = await schemaManager.getEntity(entity);
        if (!ent) throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: `Entity '${entity}' không tồn tại` });
        const physical = ent.mongodb_save_data || ent.collection_name || entity;
        const baseMatch: Record<string, any> = {};
        if (physical !== (ent.collection_name || entity)) {
          baseMatch[ent.use_posttype ? 'post_type' : 'collection_name'] = ent.collection_name || entity;
        }

        // Tenant's rule docs
        const ruleMap = (await schemaManager.getAll('rule', scope)) ?? {};
        const allRules = Object.values(ruleMap) as any[];

        // Rule-codes the user holds: admin → all; otherwise → role.rule (via getPermissions)
        let ruleCodes: string[];
        if (isAdmin) {
          ruleCodes = allRules.map((r) => String(r.code)).filter(Boolean);
        } else {
          const ops = getApprovalOperations();
          const perms = ops ? await ops.getPermissions(entity, [user.role_name ?? 'default']) : [];
          ruleCodes = Array.from(new Set(perms.flatMap((p: any) => p.rule || []).map(String)));
        }

        const coll = db.collection(physical);

        // Count by status (only the rule-codes the user holds)
        const byCode: Record<string, number> = {};
        if (ruleCodes.length) {
          const agg = await coll.aggregate([
            { $match: { ...baseMatch, status_approve: { $in: ruleCodes } } },
            { $group: { _id: '$status_approve', count: { $sum: 1 } } },
          ]).toArray();
          for (const x of agg) byCode[String(x._id)] = x.count;
        }
        const rules = ruleCodes.map((code) => {
          const rd = allRules.find((r) => String(r.code) === code);
          return { code, title: rd?.title ?? code, count: byCode[code] || 0 };
        });

        // My posts (posts the user created)
        const my_posts = userId
          ? await coll.countDocuments({ ...baseMatch, created_by: userId })
          : 0;

        return { data: { entity, rules, my_posts } };
      });
    },
  );
}
