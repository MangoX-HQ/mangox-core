import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../utils/app-error';
import { getCoreUnified, ICoreUnified } from '../configs/core';
import { ObjectId } from 'mongodb';



export class ModeHandler {

  public async getWithModeHandler(
    request: FastifyRequest,
    method: string,
    collectionName?: string,
    data?: any,
    isMany: boolean = false
  ) {
    try {
      const db = await getCoreUnified().getInstanceDB('mongodb');

      const user = request.headers.user as any;

      if (!user) {
        throw new Error('User not found in request. JWT authentication may have failed.');
      }
      if (!user._id && !user.id) {
        throw new Error('User ID not found in user object.');
      }
      const userId = user._id || user.id;

      const userRoles = [user.role_name];

      const _collectionName = (request.params as any).entityName ?? collectionName;

      const rolepermission = await db.collection('rolepermission').findOne({
        role_base: { $in: userRoles },
        entity: _collectionName,
      });

      const scope = rolepermission?.permission.find((p: any) => p.action === method);

      if (scope && scope.scope === 'self') {
        await this.handleSelfScope(db, scope, userId, method, request, data, isMany);
      }
    } catch (error) {
      throw new AppError({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: error instanceof Error ? error.message : 'Mode handling failed',
      });
    }
  }

  private async handleSelfScope(
    db: any,
    scope: any,
    userId: string,
    method: string,
    request: FastifyRequest,
    data?: any,
    isMany: boolean = false
  ): Promise<any> {

    switch (method) {
      case 'GET':
        return this.handleGETSelfScope(scope, userId, request);
      case 'PUT':
      case 'PATCH':
        return await this.handlePUTPATCHSelfScope(scope, userId, request, db, data, isMany);
      case 'DELETE':
        return await this.handleDELETESelfScope(scope, userId, request, db, isMany);
      default:
    }

    return { owner_id: new ObjectId(userId) };
  }

  private handleGETSelfScope(scope: any, userId: string, request: FastifyRequest) {
    (request.query as any).created_by = userId;
  }

  private async handlePUTPATCHSelfScope(scope: any, userId: string, request: FastifyRequest, db: any, data?: any, isMany: boolean = false) {
    if (!isMany) {
      const curData = await db.collection((request.params as any).entityName)
        .findOne({ _id: new ObjectId((request.params as any).id) });

      if (curData?.created_by !== userId) {
        throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: 'Permission denied: Cannot modify this record.' });
      }
    } else {
      const ids = data?.map((item: any) => item._id);
      const records = await db.collection((request.params as any).entityName)
        .find({ _id: { $in: ids?.map((id: string) => new ObjectId(id)) } })
        .toArray();

      const newData = data.filter((item: any) => {
        const record = records.find((rec: any) => rec._id.toString() === item._id);
        return record?.created_by === userId;
      });
      if (newData.length === 0) {
        throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: 'Permission denied: Cannot modify any of the specified records.' });
      }
      data.length = 0;
      data.push(...newData);
    }
  }

  private async handleDELETESelfScope(scope: any, userId: string, request: FastifyRequest, db: any, isMany: boolean = false) {
    if (!isMany) {
      const curData = await db.collection((request.params as any).entityName)
        .findOne({ _id: new ObjectId((request.params as any).id) });

      if (curData?.created_by !== userId) {
        throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: 'Permission denied: Cannot delete this record.' });
      }
    } else {
      const ids: string = ((request.query as any).ids);

      const idsArray = ids.split(',')?.map((id: string) => id.trim());

      if (!idsArray || !Array.isArray(idsArray) || idsArray.length === 0) {
        throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'No IDs provided for deletion.' });
      }

      const records = await db.collection((request.params as any).entityName)
        .find({ _id: { $in: idsArray?.map((id: string) => new ObjectId(id)) } })
        .toArray();

      const newIds = records
        .filter((record: any) => record.created_by === userId)
        ?.map((record: any) => record._id.toString());

      if (newIds.length === 0) {
        throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: 'Permission denied: Cannot delete any of the specified records.' });
      }
      (request.query as any).ids = newIds.join(',');
    }
  }
}

export const modeHandler = new ModeHandler();