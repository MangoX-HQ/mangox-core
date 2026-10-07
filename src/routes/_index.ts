import { FastifyInstance } from 'fastify';
import { TestErrorRoute } from './test-error.route';
import { MediaMinioRoutes } from '../module/_media/media-minio';
import { EntityUtilRoutes } from '../module/_entity/entity';

import { UserRoutes } from '../module/_user/user.controller';
import { McpRoutes } from '../module/_mcp';
import { AdminRoutes } from './admin.route';
import { AuthRoutes } from '../module/_auth/auth';
import { PrivateDocumentsRoutes } from '../module/_private-documents/private-documents.controller';
import { jwtGuard } from '..';


export async function IndexRoute(app: FastifyInstance) {
  // Login in place — the self-contained DEPLOY version, no login via Studio.
  // Removed /auth/register (no public registration allowed) and /auth/change-tenant
  // (single-tenant, there's no other tenant to switch to).
  await AuthRoutes(app);
  await EntityUtilRoutes(app);
  await UserRoutes(app);
  await McpRoutes(app, jwtGuard);
  await MediaMinioRoutes(app);
  await PrivateDocumentsRoutes(app);
  await AdminRoutes(app);

  // Add test error routes (remove in production)
  if (process.env.NODE_ENV !== 'production') {
    await TestErrorRoute(app);
  }
}
