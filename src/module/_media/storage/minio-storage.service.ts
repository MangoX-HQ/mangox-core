import { Readable } from 'stream';
import { IStorageService } from './storage.interface';
import { resolveTenantBuckets } from '../helpers/tenant-bucket';
import { appSettings } from '../../../configs/app-settings';

/**
 * Team-aware Minio client: automatically picks the team's R2 if the tenant context has a team_id,
 * else falls back to the global Minio client from env.
 */
async function client() {
  return (await resolveTenantBuckets()).client;
}

export class MinioStorageService implements IStorageService {
  async putObject(bucketName: string, objectName: string, data: Buffer | Readable, size: number, metadata?: Record<string, string>): Promise<any> {
    return (await client()).putObject(bucketName, objectName, data, size, metadata);
  }

  async getObject(bucketName: string, objectName: string): Promise<Readable> {
    return (await client()).getObject(bucketName, objectName);
  }

  async removeObject(bucketName: string, objectName: string): Promise<void> {
    await (await client()).removeObject(bucketName, objectName);
  }

  async statObject(bucketName: string, objectName: string): Promise<{ size: number; metaData: Record<string, string> }> {
    const stat = await (await client()).statObject(bucketName, objectName);
    return { size: stat.size, metaData: stat.metaData as Record<string, string> };
  }

  getPublicUrl(bucketName: string, objectName: string): string {
    return `${appSettings.minio.public}/${bucketName}/${objectName}`;
  }
}
