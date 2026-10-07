import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { IStorageService } from './storage.interface';
import { appSettings } from '../../../configs/app-settings';
import { AppError } from '../../../utils/app-error';

export class LocalStorageService implements IStorageService {
  private basePath: string;
  private publicUrl: string;

  constructor() {
    this.basePath = process.env.LOCAL_STORAGE_PATH || path.join(process.cwd(), 'uploads');
    this.publicUrl = process.env.LOCAL_STORAGE_PUBLIC_URL || `http://localhost:${appSettings.port}/uploads`;
  }

  private getFilePath(bucketName: string, objectName: string): string {
    return path.join(this.basePath, bucketName, objectName);
  }

  private ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async putObject(bucketName: string, objectName: string, data: Buffer | Readable, size: number, metadata?: Record<string, string>): Promise<any> {
    const filePath = this.getFilePath(bucketName, objectName);
    this.ensureDir(filePath);

    if (Buffer.isBuffer(data)) {
      fs.writeFileSync(filePath, data);
    } else {
      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(filePath);
        data.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    }

    // Save metadata as a sidecar JSON file
    if (metadata && Object.keys(metadata).length > 0) {
      const metaPath = filePath + '.meta.json';
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    }

    return { etag: '', versionId: null };
  }

  async getObject(bucketName: string, objectName: string): Promise<Readable> {
    const filePath = this.getFilePath(bucketName, objectName);
    if (!fs.existsSync(filePath)) {
      throw AppError.notFound('File', objectName);
    }
    return fs.createReadStream(filePath);
  }

  async removeObject(bucketName: string, objectName: string): Promise<void> {
    const filePath = this.getFilePath(bucketName, objectName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    // Remove metadata file if exists
    const metaPath = filePath + '.meta.json';
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }
  }

  async statObject(bucketName: string, objectName: string): Promise<{ size: number; metaData: Record<string, string> }> {
    const filePath = this.getFilePath(bucketName, objectName);
    if (!fs.existsSync(filePath)) {
      throw AppError.notFound('File', objectName);
    }

    const stats = fs.statSync(filePath);
    let metaData: Record<string, string> = {};

    const metaPath = filePath + '.meta.json';
    if (fs.existsSync(metaPath)) {
      metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    }

    return { size: stats.size, metaData };
  }

  getPublicUrl(bucketName: string, objectName: string): string {
    return `${this.publicUrl}/${bucketName}/${objectName}`;
  }
}
