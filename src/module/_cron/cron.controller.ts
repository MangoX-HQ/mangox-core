/**
 * Cron reload API (single-tenant) — replaces change streams (no DB watch, no
 * replica set needed).
 *
 *   POST /cron/reload   (auth, admin)  → reload jobs from the cron-job collection
 *
 * Call this after creating/updating/deleting a doc in the `cron-job` collection so cron picks up the new config.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { jwtGuard } from '../..';
import { dynamicCronService } from '../../jobs/cron';
import { AppError } from '../../utils/app-error';

function isAdmin(user: any): boolean {
  return (
    user?.is_super_admin === true ||
    user?.role_system === 'admin' ||
    user?.role_system === 'super_admin' ||
    user?.role_name === 'admin'
  );
}

export async function CronRoutes(app: FastifyInstance) {
  app.post(
    '/cron/reload',
    { preHandler: [jwtGuard.preHandler.bind(jwtGuard)] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const user = (request.headers.user as any) || {};
      if (!isAdmin(user)) {
        throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: 'Chỉ admin được reload cron' });
      }
      const count = await dynamicCronService.reload();
      return { data: { registered: count } };
    },
  );
}
