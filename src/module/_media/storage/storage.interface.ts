import { Readable } from 'stream';

export interface IStorageService {
  putObject(bucketName: string, objectName: string, data: Buffer | Readable, size: number, metadata?: Record<string, string>): Promise<any>;
  getObject(bucketName: string, objectName: string): Promise<Readable>;
  removeObject(bucketName: string, objectName: string): Promise<void>;
  statObject(bucketName: string, objectName: string): Promise<{ size: number; metaData: Record<string, string> }>;
  getPublicUrl(bucketName: string, objectName: string): string;
}
