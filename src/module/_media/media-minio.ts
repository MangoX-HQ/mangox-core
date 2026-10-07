import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { jwtGuard } from '../..';
import { getPolicies } from '../_setting/setting-mode';
import { AppError } from '../../utils/app-error';
import { mediaMinioService } from './media-minio.service';
import { queueController } from './queue-compress/queue.controller';
import { runWithTenantSlug } from '../../core_v2/adapters/mongodb/tenant-context';
import { TENANT_SLUG } from '../../configs/tenant';

interface OptionsInput {
  databaseType?: string;
  log?: any;
  user_id?: string;
  roles?: string[];
  tenant_id?: string;
}

async function withTenantContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const headerTenantId = (request.headers['x-tenant-id'] as string) || undefined;
  if (!headerTenantId) return fn();
  const slug = TENANT_SLUG || headerTenantId;
  return runWithTenantSlug(slug, headerTenantId, fn);
}

function buildOptions(request: FastifyRequest): OptionsInput {
  const user = request.headers.user as any;
  return {
    databaseType: 'mongodb',
    log: request.log,
    user_id: user?.id || user?._id,
    roles: [user?.role_name ?? 'default'],
    tenant_id: request.headers['x-tenant-id'] as string,
  };
}

const MEDIA_ACTION: Record<string, string> = {
  GET: 'read', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete',
};

/** Gate media permissions via policy (resource:'media') in Redis — super_admin bypasses it. */
async function ensureMediaPolicy(request: FastifyRequest, method: string): Promise<void> {
  const user = (request.headers.user as any) || {};
  if (user.is_super_admin === true || user.role_system === 'admin' || user.role_system === 'super_admin') return;
  const roles = [user.role_name ?? 'default'];
  const action = MEDIA_ACTION[method] ?? method.toLowerCase();
  const policies = await getPolicies({ resource: { $in: ['media'] }, action: { $in: [action] }, role: { $in: roles } });
  if (!policies?.length) {
    throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: `Access denied: media ${action}`, expose: true });
  }
}

class MediaMinioController {
  entity = 'media';

  async getObjectList(request: FastifyRequest) {
    return withTenantContext(request, async () => {
      try {
        const queryData = Object.keys(request.body || {}).length > 0
          ? (request.body as any)
          : (request.query as any) || {};

        const isTrash = queryData.deleteOption === 'move-to-trash';
        if (!queryData.prefix) queryData.prefix = 'root';

        const options = buildOptions(request);
        return mediaMinioService.getList(queryData, queryData.prefix, isTrash, options);
      } catch (error) {
        request.log.error({ error }, '[MediaMinioController] Failed to get media list');
        return { success: false, message: 'Failed to get media list' };
      }
    });
  }

  async createObject(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      await ensureMediaPolicy(request, 'POST');
      const file = await (request as any).file();
      let data = {} as any;
      data.title = file.fields['media[0][title]'].value;
      data.alt = file.fields['media[0][alt]'].value;
      data.folder = file.fields['media[0][folder]']?.value;
      const user = request.headers.user as any;
      const created_by = user?.id || user?._id || '';
      const result = await mediaMinioService.createObject(
        data,
        file,
        request.headers['x-tenant-id'] as string,
        created_by,
      );
      if (result?.statusCode) reply.statusCode = result.statusCode;
      return result;
    });
  }

  async reCompressObjects(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      await ensureMediaPolicy(request, 'POST');
      try {
        const tenant_id = request.headers['x-tenant-id'] as string;
        const body = request.body as any;
        const file_name = body?.file_name;
        if (file_name) {
          await mediaMinioService.createCompress(file_name, tenant_id);
        }
        return { success: true, message: 'Compress job queued' };
      } catch (error) {
        console.error('[ERROR] [MediaMinioController] Failed to recompress entity: ', error);
        return { success: false, message: 'Failed to recompress entity' };
      }
    });
  }

  /**
   * BULK backfill: scans the media collection → queues compression for all images. Optional body/query:
   * { folder?, limit?, only_missing? }. only_missing=true BY DEFAULT (only compresses images never
   * compressed before); only_missing=false to recompress everything (overwrite).
   */
  async reCompressAll(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      await ensureMediaPolicy(request, 'POST');
      try {
        const tenant_id = request.headers['x-tenant-id'] as string;
        const body = (request.body as any) || {};
        const q = (request.query as any) || {};
        const folder = body.folder ?? q.folder ?? undefined;
        const limit = Number(body.limit ?? q.limit) || undefined;
        const onlyMissing = String(body.only_missing ?? q.only_missing ?? 'true').toLowerCase() !== 'false';
        const result = await mediaMinioService.recompressAll(tenant_id, { folder, limit, onlyMissing });
        return { success: true, message: 'Bulk compress queued', ...result };
      } catch (error) {
        console.error('[ERROR] [MediaMinioController] Failed to bulk recompress: ', error);
        return { success: false, message: 'Failed to bulk recompress' };
      }
    });
  }

  async deleteObject(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      const user = request.headers.user as any;
      await ensureMediaPolicy(request, 'DELETE');

      const { ids, deleteOption } = request.query as any;
      const listIds = (ids || '').split(',').filter(Boolean);
      const options = buildOptions(request);

      const deleteActions: Record<string, (id: string) => Promise<any>> = {
        'move-to-trash': (id) => mediaMinioService.softDeleteObject(id, options),
        'folder-and-contents': (id) => mediaMinioService.deleteObject(id, options),
        'destroy': (id) => mediaMinioService.destroyObject(id, options),
      };

      const action = deleteActions[deleteOption];
      if (!action) {
        await Promise.all(listIds.map((id: string) => mediaMinioService.softDeleteObject(id, options)));
        return { success: true, message: 'Object deleted successfully' };
      }

      try {
        await Promise.all(listIds.map(action));
        const actionMessage = deleteOption === 'destroy' ? 'Objects destroyed permanently' : 'Object deleted successfully';
        return { success: true, message: actionMessage };
      } catch (error: any) {
        console.error('[ERROR] [MediaMinioController] Failed to delete object: ', error);
        reply.statusCode = error.statusCode || 500;
        return { success: false, message: error.message || 'Failed to delete object' };
      }
    });
  }

  async restoreObject(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      const user = request.headers.user as any;
      await ensureMediaPolicy(request, 'PUT');

      const body: any = request.body || {};
      const queryIds = (request.query as any)?.ids;
      const ids: string[] = Array.isArray(body.ids)
        ? body.ids
        : body.id
          ? [body.id]
          : queryIds
            ? String(queryIds).split(',').filter(Boolean)
            : [];

      if (ids.length === 0) return { success: false, message: 'No ids provided' };

      const options = buildOptions(request);
      const results = await Promise.all(ids.map((id: string) => mediaMinioService.restoreObject(id, options)));
      return { success: true, results };
    });
  }

  async renameFolder(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      const user = request.headers.user as any;
      await ensureMediaPolicy(request, 'PUT');

      const { oldFolderId, newFolderName } = request.body as any;

      if (!oldFolderId || !newFolderName) {
        reply.statusCode = 400;
        return { success: false, message: 'Both oldFolderId and newFolderName are required' };
      }

      const options = buildOptions(request);
      try {
        return await mediaMinioService.renameFolderComplete(oldFolderId, newFolderName, options);
      } catch (error: any) {
        console.error('[ERROR] [MediaMinioController] Failed to rename folder:', error);
        reply.statusCode = error.statusCode || 500;
        return { success: false, message: error.message || 'Failed to rename folder' };
      }
    });
  }

  async moveObjects(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      const user = request.headers.user as any;
      await ensureMediaPolicy(request, 'PUT');

      const { fileIds, folderId } = request.body as any;
      const options = buildOptions(request);
      return await mediaMinioService.move(fileIds, folderId, options);
    });
  }

  async copyObjects(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      const user = request.headers.user as any;
      await ensureMediaPolicy(request, 'PUT');

      const { source, destination } = request.body as any;

      if (!source || !Array.isArray(source) || source.length === 0) {
        reply.statusCode = 400;
        return { success: false, message: 'source must be a non-empty array' };
      }
      if (!destination) {
        reply.statusCode = 400;
        return { success: false, message: 'destination is required' };
      }

      const options = buildOptions(request);
      try {
        return await mediaMinioService.copyObject(source, destination, options);
      } catch (error: any) {
        console.error('[ERROR] [MediaMinioController] Failed to copy objects:', error);
        reply.statusCode = error.statusCode || 500;
        return { success: false, message: error.message || 'Failed to copy objects' };
      }
    });
  }

  async emptyTrash(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      const user = request.headers.user as any;
      await ensureMediaPolicy(request, 'DELETE');
      const options = buildOptions(request);
      try {
        return await mediaMinioService.emptyTrash(options);
      } catch (error: any) {
        console.error('[ERROR] [MediaMinioController] Failed to empty trash:', error);
        reply.statusCode = error.statusCode || 500;
        return { success: false, message: error.message || 'Failed to empty trash' };
      }
    });
  }

  async changeFolderName(request: FastifyRequest, reply: FastifyReply) {
    return withTenantContext(request, async () => {
      const message = request.body as any;
      const tenant_id = request.headers['x-tenant-id'] as string;
      return await mediaMinioService.changeFolderName(message.oldName, message.newName, tenant_id);
    });
  }
}

export async function MediaMinioRoutes(app: FastifyInstance) {
  const controller = new MediaMinioController();

  app.get(
    '/media-minio',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.getObjectList.bind(controller),
  );

  app.post(
    '/media-minio-direct',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.getObjectList.bind(controller),
  );

  app.post(
    '/media-minio',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.createObject.bind(controller),
  );

  app.post(
    '/media-minio-recompress',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.reCompressObjects.bind(controller),
  );

  app.post(
    '/media-minio-recompress-all',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.reCompressAll.bind(controller),
  );

  app.post(
    '/media-minio/restore',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.restoreObject.bind(controller),
  );

  app.delete(
    '/media-minio',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.deleteObject.bind(controller),
  );

  app.put(
    '/media-minio/rename-folder',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.renameFolder.bind(controller),
  );

  app.put(
    '/media-minio/copy',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.copyObjects.bind(controller),
  );

  app.put(
    '/media-minio/move',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.moveObjects.bind(controller),
  );

  app.put(
    '/media-minio/change-folder-name',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.changeFolderName.bind(controller),
  );

  app.delete(
    '/media-minio/empty-trash',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.emptyTrash.bind(controller),
  );

  // ===== Queue Management Routes =====
  app.get('/queue/health', queueController.healthCheck.bind(queueController));
  app.get(
    '/queue/status',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    queueController.getStatus.bind(queueController),
  );
  app.get(
    '/queue/failed',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    queueController.getFailedJobs.bind(queueController) as any,
  );
  app.post(
    '/queue/retry/:queueType/:jobId',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    queueController.retryJob.bind(queueController) as any,
  );
  app.post(
    '/queue/cleanup',
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    queueController.cleanupJobs.bind(queueController),
  );
  app.get('/queue/metrics', queueController.getMetrics.bind(queueController));
}
