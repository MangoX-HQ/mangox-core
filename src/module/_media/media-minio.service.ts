/**
 * Media service — direct port from current_code with tenant-awareness changes:
 *  - DB ops use `getMediaDb(tenant_id)` → tenant's own database
 *  - Bucket/path constants replaced by `resolveTenantBuckets(tenant_id)` per call
 *  - tenant_id filter added to all DB queries (defense-in-depth when DBs share)
 *  - ClientSession transactions dropped (tenant DB ≠ main DB; sessions don't cross)
 *  - Path = `${publicUrl}/${objectName}` (each bucket has its own r2.dev subdomain)
 *  - Compress job is fired via mediaEventEmitter → BullMQ worker (async),
 *    NOT inline sharp like old code
 */

import { ObjectId } from 'mongodb';
import { appSettings } from '../../configs/app-settings';
import { getCoreUnified } from '../../configs/core';
import { AppError } from '../../utils/app-error';
import { sanitizeHeaderValue } from './helpers/sanitize-header-value';
import { randomBytes, createHash } from 'crypto';
import { resolveTenantBuckets } from './helpers/tenant-bucket';

/**
 * Active Minio client for the CURRENT tenant context (ALS):
 *   - Has a team R2 config → team's Minio client
 *   - Else (system / placeholder team) → global env Minio client
 * Every storage op in this file uses this helper so team isolation works.
 */
async function _minio() {
  return (await resolveTenantBuckets()).client;
}
import { getTenantId } from '../../core_v2/adapters/mongodb/tenant-context';
import { mediaEventEmitter } from './media-events';
import { EventQueueCompress } from './queue-compress/process';

interface OptionsInput {
  databaseType?: string;
  log?: any;
  user_id?: string;
  roles?: string[];
  tenant_id?: string;
}

async function getMediaDb(tenantHint?: string | null) {
  const tenantId = tenantHint || getTenantId() || undefined;
  return getCoreUnified().getInstanceDB('mongodb', tenantId);
}

class MediaMinioService {
  async move(fileIds: string[], folderId: string, options: OptionsInput): Promise<any> {
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'fileIds must be a non-empty array' });
    }
    if (!folderId) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'folderId is required' });
    }

    const db = await getMediaDb(options.tenant_id);
    const tenantFilter = options.tenant_id ? { tenant_id: options.tenant_id } : {};

    const listFiles = await db
      .collection('media')
      .find({
        _id: { $in: fileIds.map((id) => new ObjectId(id)) },
        deleted_at: { $exists: false },
        type: 'FILE',
        ...tenantFilter,
      })
      .toArray();

    const folder = await db.collection('media').findOne({
      _id: new ObjectId(folderId),
      deleted_at: { $exists: false },
      type: 'FOLDER',
      ...tenantFilter,
    });

    if (listFiles.length === 0) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Files not found' });
    }
    if (!folder) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Folder not found' });
    }

    const targetFolderName = folder.name;
    const { bucket, compressBucket } = await resolveTenantBuckets(options.tenant_id);

    const filesToMove: Array<{ oldPath: string; newPath: string; file: any }> = [];
    const renameFolder = listFiles.map((file) => {
      const splitName = file.name.split('/');
      const nameFile = splitName.pop();
      const fullPath = targetFolderName + '/' + nameFile;

      filesToMove.push({
        oldPath: file.fileName || file.name,
        newPath: fullPath,
        file: file,
      });

      return {
        _id: file._id.toString(),
        name: fullPath,
        fileName: fullPath,
        folder: targetFolderName,
        is_root: false,
      };
    });

    try {
      await this.moveFilesOnMinio(filesToMove, bucket);
      await this.moveCompressedImagesForFiles(filesToMove, compressBucket);
      const now = new Date(appSettings.timeZoneMongoDB.getCurrentTime());

      for (const fileUpdate of renameFolder) {
        await db.collection('media').updateOne(
          { _id: new ObjectId(fileUpdate._id) },
          {
            $set: {
              name: fileUpdate.name,
              fileName: fileUpdate.fileName,
              folder: fileUpdate.folder,
              is_root: fileUpdate.is_root,
              updated_at: now,
            },
          },
        );
      }
      console.log(`[INFO] Successfully moved ${filesToMove.length} files to folder "${targetFolderName}"`);
    } catch (error: any) {
      console.error('[ERROR] [MediaMinioService] Failed to move files:', error);
      throw new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message: `Failed to move files: ${error.message}`, expose: false });
    }

    return {
      success: true,
      message: 'Files moved successfully',
      data: renameFolder,
    };
  }

  private async moveFilesOnMinio(
    filesToMove: Array<{ oldPath: string; newPath: string; file: any }>,
    bucket: string,
  ): Promise<void> {
    for (const { oldPath, newPath } of filesToMove) {
      try {
        await (await _minio()).copyObject(bucket, newPath, `/${bucket}/${oldPath}`);
        console.log(`[INFO] Copied file on MinIO: ${oldPath} → ${newPath}`);
      } catch (error: any) {
        console.error(`[ERROR] Failed to copy ${oldPath} to ${newPath}:`, error);
        throw new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message: `Failed to copy file ${oldPath} to ${newPath}: ${error.message}`, expose: false });
      }
    }

    const oldPaths = filesToMove.map((f) => f.oldPath);
    if (oldPaths.length > 0) {
      try {
        await (await _minio()).removeObjects(bucket, oldPaths);
        console.log(`[INFO] Deleted ${oldPaths.length} old files from MinIO`);
      } catch (error: any) {
        console.error('[ERROR] Failed to delete old files from MinIO:', error);
        throw new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message: `Failed to delete old files: ${error.message}`, expose: false });
      }
    }
  }

  private async moveCompressedImagesForFiles(
    filesToMove: Array<{ oldPath: string; newPath: string; file: any }>,
    compressBucket: string,
  ): Promise<void> {
    if (!compressBucket) return;

    const imageFiles = filesToMove.filter((f) => f.file.mimeType && f.file.mimeType.startsWith('image/'));
    if (imageFiles.length === 0) return;

    console.log(`[INFO] Moving compressed images for ${imageFiles.length} image files`);

    for (const { oldPath, newPath } of imageFiles) {
      try {
        const objectsStream = (await _minio()).listObjects(compressBucket, `${oldPath}/`, true);

        const compressedObjects: string[] = [];
        await new Promise((resolve, reject) => {
          objectsStream.on('data', (obj: any) => {
            if (obj.name) compressedObjects.push(obj.name);
          });
          objectsStream.on('end', resolve);
          objectsStream.on('error', reject);
        });

        for (const oldCompressedPath of compressedObjects) {
          const newCompressedPath = oldCompressedPath.replace(
            new RegExp(`^${this.escapeRegex(oldPath)}`),
            newPath,
          );
          try {
            await (await _minio()).copyObject(compressBucket, newCompressedPath, `/${compressBucket}/${oldCompressedPath}`);
          } catch (error: any) {
            console.warn(`[WARN] Failed to copy compressed image ${oldCompressedPath}:`, error);
          }
        }

        if (compressedObjects.length > 0) {
          try {
            await (await _minio()).removeObjects(compressBucket, compressedObjects);
            console.log(`[INFO] Moved ${compressedObjects.length} compressed versions for ${oldPath}`);
          } catch (error: any) {
            console.warn(`[WARN] Failed to delete old compressed images for ${oldPath}:`, error);
          }
        }
      } catch (error: any) {
        console.warn(`[WARN] Failed to move compressed images for ${oldPath}:`, error);
      }
    }
  }

  /**
   * List media items for a given folder via direct DB query (NOT MinIO listObjects).
   * Returns FOLDER + FILE rows so UI can render folders.
   */
  async getList(queryData: any, folder: string, isTrash: boolean = false, options: OptionsInput) {
    const db = await getMediaDb(options.tenant_id);
    const { publicUrl, prefix, bucket, cvBucket } = await resolveTenantBuckets(options.tenant_id);

    // Single-bucket model: do NOT filter by bucketName. Data is already
    // isolated by the per-tenant Mongo DB (getMediaDb), and FOLDER docs keep
    // their legacy bucketName (= slug) since they have no R2 object — filtering
    // by the global bucket would hide them and break folder navigation.
    const filter: any = {
      is_root: folder === 'root',
      folder: folder.endsWith('/') ? folder.slice(0, -1) : folder,
    };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;
    // Hide files uploaded from form-builder (separate cvBucket) from the media dashboard.
    if (cvBucket && cvBucket !== bucket) filter.bucketName = { $ne: cvBucket };

    // Tenant isolation enforced by the slug object-key prefix, derived
    // SERVER-SIDE from tenant context (resolveTenantBuckets) — never trusting
    // frontend body (bucket_name/prefix). Applied to every branch
    // (list/search/trash). FOLDER docs have no fileName, so allow them.
    if (prefix) {
      filter.$or = [
        { type: 'FOLDER' },
        { fileName: { $regex: `^${this.escapeRegex(prefix)}/` } },
      ];
    }

    if (queryData?.search) {
      const searchTerm = queryData.search.split(':').pop() || queryData.search;
      filter.name = { $regex: this.escapeRegex(searchTerm), $options: 'i' };
      delete filter.is_root;
      delete filter.folder;
    }

    if (isTrash) {
      delete filter.is_root;
      filter.deleted_at = { $exists: true, $ne: null };
      const isAdmin = options.roles?.includes('admin');
      if (!isAdmin) {
        filter.deleted_by = options.user_id;
      }
    } else {
      filter.deleted_at = { $exists: false };
    }

    const page = parseInt(queryData?.page) || 1;
    const limit = parseInt(queryData?.limit) || 50;
    const skip = (page - 1) * limit;

    const total = await db.collection('media').countDocuments(filter);
    const docs = await db
      .collection('media')
      .find(filter)
      .sort({ type: -1, created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const data = docs.map((item: any) => ({
      ...item,
      name: item.type === 'FOLDER' ? item.name + '/' : item.name,
      path: item.type === 'FOLDER' ? undefined : `${publicUrl}/${item.fileName}`,
    }));

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  async createObject(data: any, file: any, tenant_id?: string, created_by?: string, opts?: { cv?: boolean }): Promise<any> {
    if (!tenant_id) throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: '[ERROR] [MediaMinioService] Tenant ID is required' });
    try {
      const { title, alt } = data;
      const { mimetype } = file;
      if (!this.isValidMimetype(mimetype)) throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: '[ERROR] [MediaMinioService] This file type is not supported' });

      const now = new Date(appSettings.timeZoneMongoDB.getCurrentTime());
      const fileBuffer = await file.toBuffer();
      const size = fileBuffer.length;

      // opts.cv: file uploaded from FORM-BUILDER → goes into a separate bucket (cvBucket) to keep it apart
      // from the media dashboard. Not compressed (private doc). Otherwise uses the main bucket.
      const _bkt = await resolveTenantBuckets(tenant_id);
      const bucket = opts?.cv ? _bkt.cvBucket : _bkt.bucket;
      const publicUrl = opts?.cv ? _bkt.cvPublicUrl : _bkt.publicUrl;

      const objectName = title;
      if (objectName.endsWith('.folderkeeper')) {
        await this.ensureFolderExists(objectName, now, tenant_id, bucket);
      } else {
        await this.ensureParentFolders(objectName, now, tenant_id, bucket);
      }
      const mediaRecord = await this.createMediaRecord(objectName, mimetype, size, alt, title, tenant_id, now, bucket, created_by);
      const uploadResult = await this.uploadToMinio(mediaRecord.finalObjectName, fileBuffer, size, mimetype, alt, title, tenant_id, mediaRecord.insertedId, bucket);
      if (!opts?.cv) {
        mediaEventEmitter.emit(EventQueueCompress.CREATE, {
          id: mediaRecord.insertedId.toString(),
          fileName: mediaRecord.finalObjectName,
          tenant_id,
        });
      }
      await this.updateMediaEtag(mediaRecord.insertedId, uploadResult.etag, tenant_id);
      return {
        ...uploadResult,
        _id: mediaRecord.insertedId,
        objectName: mediaRecord.finalObjectName,
        name: title,
        path: `${publicUrl}/${mediaRecord.finalObjectName}`,
      };
    } catch (error) {
      console.error('[ERROR] [MediaMinioService] Error in create: ', error);
      throw error;
    }
  }

  async copyObject(source: string[], destination: string, options: OptionsInput): Promise<any> {
    const db = await getMediaDb(options.tenant_id);
    const tenantFilter = options.tenant_id ? { tenant_id: options.tenant_id } : {};

    const destinationFolder = await db.collection('media').findOne({
      name: destination,
      type: 'FOLDER',
      deleted_at: { $exists: false },
      ...tenantFilter,
    });

    if (!destinationFolder) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: `Destination folder "${destination}" not found` });
    }

    const destinationFolderName = destinationFolder.name;

    const sourceFiles = await db
      .collection('media')
      .find({
        _id: { $in: source.map((id) => new ObjectId(id)) },
        type: 'FILE',
        deleted_at: { $exists: false },
        ...tenantFilter,
      })
      .toArray();

    if (sourceFiles.length === 0) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Source files not found' });
    }

    console.log(`[INFO] Found ${sourceFiles.length} source files to copy`);

    try {
      const copiedItems: any[] = [];
      const errors: string[] = [];

      for (const sourceFile of sourceFiles) {
        try {
          const fileResult = await this.copyFile(sourceFile, destinationFolderName, options.tenant_id);
          copiedItems.push(fileResult);
        } catch (error: any) {
          const errorMsg = `Failed to copy "${sourceFile.name}": ${error.message}`;
          errors.push(errorMsg);
          console.error(`[ERROR] ${errorMsg}`, error);
        }
      }

      console.log(`[INFO] Successfully copied ${copiedItems.length} files to "${destinationFolderName}"`);

      return {
        success: true,
        message: 'Files copied successfully',
        data: copiedItems,
        stats: {
          filesCopied: copiedItems.length,
          totalCopied: copiedItems.length,
          errors: errors.length > 0 ? errors : undefined,
        },
      };
    } catch (error: any) {
      console.error('[ERROR] [MediaMinioService] Failed to copy objects:', error);
      throw new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message: `Failed to copy objects: ${error.message}`, expose: false });
    }
  }

  private async copyFile(sourceFile: any, destinationFolder: string, tenant_id?: string): Promise<any> {
    const mimetype = sourceFile.mimeType || 'application/octet-stream';

    const originalFileName = sourceFile.name.split('/').pop();
    const newName = destinationFolder + '/' + originalFileName;
    const alt = sourceFile.metadata?.alt || '';

    const { bucket, publicUrl } = await resolveTenantBuckets(tenant_id);

    const stream = await (await _minio()).getObject(bucket, sourceFile.fileName);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const fileBuffer = Buffer.concat(chunks);
    const size = fileBuffer.length;
    const now = new Date(appSettings.timeZoneMongoDB.getCurrentTime());

    const mediaRecord = await this.createMediaRecord(newName, mimetype, size, alt, newName, tenant_id, now, bucket);
    const uploadResult = await this.uploadToMinio(mediaRecord.finalObjectName, fileBuffer, size, mimetype, alt, newName, tenant_id, mediaRecord.insertedId, bucket);
    mediaEventEmitter.emit(EventQueueCompress.CREATE, {
      id: mediaRecord.insertedId.toString(),
      fileName: mediaRecord.finalObjectName,
      tenant_id,
    });
    await this.updateMediaEtag(mediaRecord.insertedId, uploadResult.etag, tenant_id);

    console.log(`[INFO] Copied file on MinIO: ${sourceFile.fileName} → ${mediaRecord.finalObjectName}`);

    return {
      _id: mediaRecord.insertedId.toString(),
      name: newName,
      fileName: mediaRecord.finalObjectName,
      path: `${publicUrl}/${mediaRecord.finalObjectName}`,
      type: 'FILE',
    };
  }

  private isValidMimetype(mimetype: string): boolean {
    const PROCESSABLE_MIMETYPES = new Set([
      // Images
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/avif',
      'image/heif', 'image/heic', 'image/gif', 'image/bmp', 'image/tiff',
      'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon',
      // Documents
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'text/csv', 'application/rtf',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
      // Video
      'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
      'video/webm', 'video/x-flv', 'video/x-ms-wmv', 'video/mpeg', 'video/3gpp',
      // Audio
      'audio/mpeg', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/ogg',
      'audio/aac', 'audio/flac', 'audio/x-m4a', 'audio/mp4', 'audio/webm',
      // Archives
      'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
      'application/x-tar', 'application/gzip', 'application/x-bzip2',
      // Data / Source
      'application/json', 'application/xml', 'text/xml', 'application/x-yaml',
      'text/yaml', 'text/html', 'text/css', 'text/javascript',
      'application/javascript', 'application/x-javascript',
    ]);

    return PROCESSABLE_MIMETYPES.has(mimetype.toLowerCase().trim());
  }

  private async ensureFolderExists(
    objectName: string,
    now: Date,
    tenant_id: string,
    bucket: string,
  ): Promise<void> {
    const folderPath = objectName.split('/').slice(0, -1).join('/');
    const db = await getMediaDb(tenant_id);

    const existing = await db.collection('media').findOne({
      name: folderPath,
      bucketName: bucket,
      tenant_id,
    });

    if (existing) {
      throw new AppError({ statusCode: 409, code: 'CONFLICT', message: 'This folder already exists. Please choose another name.' });
    }

    const parentFolder = folderPath.split('/').length === 1 ? 'root' : folderPath.split('/').slice(0, -1).join('/');
    await db.collection('media').insertOne({
      type: 'FOLDER',
      bucketName: bucket,
      is_root: folderPath.split('/').length === 1,
      folder: parentFolder,
      lastModified: now,
      created_at: now,
      tenant_id,
      updated_at: now,
      name: folderPath,
    });
  }

  private async ensureParentFolders(
    objectName: string,
    now: Date,
    tenant_id: string,
    bucket: string,
  ): Promise<void> {
    const pathParts = objectName.split('/').slice(0, -1);
    if (pathParts.length === 0) return;

    const db = await getMediaDb(tenant_id);

    for (let i = 0; i < pathParts.length; i++) {
      const folderPath = pathParts.slice(0, i + 1).join('/');
      const existing = await db.collection('media').findOne({
        name: folderPath,
        type: 'FOLDER',
        bucketName: bucket,
        tenant_id,
      });
      if (existing) continue;

      const parentFolder = i === 0 ? 'root' : pathParts.slice(0, i).join('/');
      await db.collection('media').insertOne({
        type: 'FOLDER',
        bucketName: bucket,
        is_root: i === 0,
        folder: parentFolder,
        lastModified: now,
        created_at: now,
        tenant_id,
        updated_at: now,
        name: folderPath,
      });
    }
  }

  private async generateUniqueFileName(
    objectName: string,
    db: any,
    tenant_id: string | undefined,
    bucket: string,
  ): Promise<string> {
    // Single-bucket model: object-key prefix = tenant SLUG folder (not id).
    const { prefix } = await resolveTenantBuckets(tenant_id);
    const tenantPrefix = prefix ? `${prefix}/` : '';

    if (objectName.startsWith('public/')) {
      const finalName = `${tenantPrefix}${objectName}`;
      const existing = await db.collection('media').findOne({
        fileName: finalName,
        deleted_at: { $exists: false },
        ...(tenant_id ? { tenant_id } : {}),
      });
      if (existing) {
        throw new AppError({ statusCode: 409, code: 'CONFLICT', message: `File "${objectName}" already exists in public folder` });
      }
      return finalName;
    }

    const lastDotIndex = objectName.lastIndexOf('.');
    const extension = lastDotIndex > 0 ? objectName.substring(lastDotIndex) : '';
    const hash = createHash('sha256').update(`${objectName}-${Date.now()}-${randomBytes(8).toString('hex')}`).digest('hex');

    return `${tenantPrefix}${hash}${extension}`;
  }

  private async createMediaRecord(
    objectName: string,
    mimetype: string,
    size: number,
    alt: string,
    title: string,
    tenant_id: string | undefined,
    now: Date,
    bucket: string,
    created_by?: string,
  ): Promise<{ insertedId: any; finalObjectName: string }> {
    const db = await getMediaDb(tenant_id);

    let finalObjectName: string;
    if (objectName.endsWith('.folderkeeper')) {
      // Keep folderkeeper name intact so it lives at the folder path
      finalObjectName = objectName;
    } else {
      finalObjectName = decodeURIComponent(await this.generateUniqueFileName(objectName, db, tenant_id, bucket));
    }

    const pathParts = objectName.split('/');
    const isRoot = pathParts.length === 1;
    const folder = isRoot ? 'root' : pathParts.slice(0, -1).join('/');
    const result = await db.collection('media').insertOne({
      mimeType: mimetype,
      bucketName: bucket,
      created_at: now,
      updated_at: now,
      lastModified: now,
      contentDisposition: 'inline',
      is_root: isRoot,
      folder,
      metadata: {
        alt: sanitizeHeaderValue(alt) || '',
        originalName: sanitizeHeaderValue(title) || '',
        tenantId: tenant_id,
      },
      size,
      type: 'FILE',
      fileName: finalObjectName,
      name: objectName,
      tenant_id,
      created_by: created_by || '',
    });
    return { insertedId: result.insertedId, finalObjectName };
  }

  private async uploadToMinio(
    objectName: string,
    fileBuffer: Buffer,
    size: number,
    mimetype: string,
    alt: string,
    title: string,
    tenant_id: string | undefined,
    mediaId: any,
    bucket: string,
  ) {
    return (await _minio()).putObject(bucket, objectName, fileBuffer, size, {
      'Content-Type': mimetype,
      'Content-Disposition': 'inline',
      'X-Amz-Meta-Alt': sanitizeHeaderValue(alt) || '',
      'X-Amz-Meta-Original-Name': sanitizeHeaderValue(title) || '',
      'X-Amz-Meta-Tenant-Id': tenant_id || '',
      'X-Amz-Meta-Id': mediaId.toString() || '',
    });
  }

  private async updateMediaEtag(mediaId: any, etag: string, tenant_id?: string): Promise<void> {
    const db = await getMediaDb(tenant_id);
    await db.collection('media').updateOne(
      { _id: new ObjectId(mediaId.toString()) },
      { $set: { etag } },
    );
  }

  /**
   * Queue compress job for an existing file (manual re-compress trigger).
   */
  async createCompress(fileName: string, tenant_id?: string) {
    mediaEventEmitter.emit(EventQueueCompress.CREATE, {
      fileName,
      tenant_id,
    });
    return { message: 'Compress job queued' };
  }

  /**
   * BACKFILL: scans the `media` collection, enqueues a compress job for EVERY image (or by folder).
   * only_missing (defaults to true in the controller) → only images never compressed (the worker hasn't
   * stamped image_compressed_at). Idempotent. Returns the number of jobs enqueued.
   */
  async recompressAll(
    tenant_id: string | undefined,
    opts: { folder?: string; limit?: number; onlyMissing?: boolean } = {},
  ): Promise<{ queued: number; scanned: number }> {
    const db = await getMediaDb(tenant_id);
    const filter: any = {
      type: 'FILE',
      mimeType: { $regex: '^image/' },
      deleted_at: { $exists: false },
    };
    if (tenant_id) filter.tenant_id = tenant_id;
    if (opts.onlyMissing) filter.image_compressed_at = { $exists: false };
    if (opts.folder) {
      const f = opts.folder.endsWith('/') ? opts.folder.slice(0, -1) : opts.folder;
      filter.$or = [{ folder: f }, { folder: { $regex: `^${this.escapeRegex(f)}/` } }];
    }

    const limit = Math.min(opts.limit ?? 100000, 100000);
    const cursor = db
      .collection('media')
      .find(filter, { projection: { fileName: 1, name: 1 } })
      .limit(limit);

    let queued = 0;
    let scanned = 0;
    for await (const doc of cursor as any) {
      scanned++;
      const fileName = doc.fileName || doc.name;
      if (!fileName) continue;
      mediaEventEmitter.emit(EventQueueCompress.CREATE, {
        id: doc._id?.toString?.(),
        fileName,
        tenant_id,
      });
      queued++;
    }
    console.log(`[media.recompressAll] tenant=${tenant_id} folder=${opts.folder ?? '*'} → queued ${queued}/${scanned}`);
    return { queued, scanned };
  }

  async createCV(data: any, file: any, tenant_id?: string) {
    const { title, alt, folder } = data;
    const { mimetype } = file;
    const fileBuffer = await file.toBuffer();
    let objectName = title;
    if (folder) {
      const folderPrefix = folder.endsWith('/') ? folder : `${folder}/`;
      objectName = `${folderPrefix}${title}`;
    }
    if (mimetype !== 'application/pdf') {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'Invalid file type. Only PDF files are allowed for CV.' });
    }
    if (!objectName.toLowerCase().endsWith('.pdf')) {
      objectName = objectName + '.pdf';
    }
    const { cvBucket, cvPublicUrl } = await resolveTenantBuckets(tenant_id);
    objectName = await this.createUniqueFilenameCV(objectName, cvBucket);
    const media_db_result = await this.createInDb(folder || '', objectName, mimetype, cvBucket, tenant_id);
    const id = media_db_result.insertedId.toString();
    const result = await (await _minio()).putObject(cvBucket, objectName, fileBuffer, file.size, {
      'Content-Type': mimetype,
      'Content-Disposition': 'inline',
      'X-Amz-Meta-Alt': sanitizeHeaderValue(alt) || '',
      'X-Amz-Meta-Original-Name': sanitizeHeaderValue(title) || '',
      'X-Amz-Meta-Tenant-Id': tenant_id || '',
      'X-Amz-Meta-Id': id,
    });
    return {
      ...result,
      id,
      objectName,
      path: `${cvPublicUrl}/${objectName}`,
    };
  }

  async deleteCV(id: string, tenant_id?: string) {
    const db = await getMediaDb(tenant_id);
    const { cvBucket } = await resolveTenantBuckets(tenant_id);
    const filter: any = { _id: new ObjectId(id), bucketName: cvBucket };
    if (tenant_id) filter.tenant_id = tenant_id;
    const media = await db.collection('media').findOneAndDelete(filter);
    if (!media) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Media not found' });
    }
    try {
      await (await _minio()).removeObject(cvBucket, media.fileName);
    } catch (err) {
      console.warn(`[media.deleteCV] removeObject failed for ${cvBucket}/${media.fileName}`, err);
    }
    return {
      message: 'Object deleted successfully',
      objectName: media.fileName,
    };
  }

  async getCV(id: string, tenant_id?: string): Promise<any> {
    try {
      const db = await getMediaDb(tenant_id);
      const { cvBucket } = await resolveTenantBuckets(tenant_id);
      const filter: any = { _id: new ObjectId(id), bucketName: cvBucket };
      if (tenant_id) filter.tenant_id = tenant_id;
      const media = await db.collection('media').findOne(filter);

      if (!media) {
        throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'CV media not found' });
      }

      const stat = await (await _minio()).statObject(cvBucket, media.fileName);
      const stream = await (await _minio()).getObject(cvBucket, media.fileName);
      return {
        stream,
        contentType: stat.metaData['content-type'] || 'application/pdf',
        filename: media.fileName.split('/').pop() || 'file.pdf',
      };
    } catch (error) {
      console.error('[ERROR] [MediaMinioService] Error streaming CV: ', error);
      throw new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Failed to stream file', expose: false });
    }
  }

  async createInDb(disk: string, filename: string, mimeType: string, bucket: string, tenant_id?: string) {
    const db = await getMediaDb(tenant_id);
    const now = new Date(appSettings.timeZoneMongoDB.getCurrentTime());
    return await db.collection('media').insertOne({
      disk,
      fileName: filename,
      mimeType,
      bucketName: bucket,
      tenant_id,
      created_at: now,
      updated_at: now,
    });
  }

  async changeFolderName(oldFolder: string, newFolder: string, tenant_id?: string) {
    // Old code used `mc mv` shell command — drop here since R2 doesn't support mc.
    // Just rename in DB; physical move is handled by renameFolderComplete.
    if (!oldFolder.endsWith('/')) oldFolder += '/';
    if (!newFolder.endsWith('/')) newFolder += '/';

    const db = await getMediaDb(tenant_id);
    const filter: any = { fileName: { $regex: `^${this.escapeRegex(oldFolder)}` } };
    if (tenant_id) filter.tenant_id = tenant_id;

    const updateResult = await db.collection('media').updateMany(filter, [
      {
        $set: {
          fileName: {
            $concat: [
              newFolder,
              {
                $substr: [
                  '$fileName',
                  { $strLenCP: oldFolder },
                  { $subtract: [{ $strLenCP: '$fileName' }, { $strLenCP: oldFolder }] },
                ],
              },
            ],
          },
        },
      },
    ]);
    return {
      message: 'Folder name changed successfully',
      updateResult,
    };
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async createUniqueFilenameCV(objectName: string, cvBucket: string) {
    objectName = objectName.normalize('NFD').replace(/[̀-ͯ]/g, '');
    objectName = objectName.replace(/\s+/g, '-');
    objectName = objectName.replace(/[^a-zA-Z0-9\-_.\/]/g, '');
    const lastDotIndex = objectName.lastIndexOf('.');
    const baseName = lastDotIndex > 0 ? objectName.substring(0, lastDotIndex) : objectName;
    const extension = lastDotIndex > 0 ? objectName.substring(lastDotIndex) : '';
    let _objectName = baseName;
    try {
      await (await _minio()).statObject(cvBucket, `${_objectName}${extension}`);
      for (let i = 0; i < 5; i++) {
        _objectName = `${baseName}-${Math.random().toString(36).substring(2, 15)}-${Date.now()}${extension}`;
        try {
          await (await _minio()).statObject(cvBucket, _objectName);
          if (i === 4) {
            throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'Duplicate object name' });
          }
        } catch (error) {
          return _objectName;
        }
      }
    } catch (error) {
      // statObject throws when file doesn't exist → name is unique
    }
    return objectName;
  }

  async softDeleteObject(id: string, options: OptionsInput) {
    const db = await getMediaDb(options.tenant_id);
    const filter: any = { _id: new ObjectId(id) };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;
    const result = await db.collection('media').findOne(filter);
    if (!result) throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Object not found' });

    const now = new Date(appSettings.timeZoneMongoDB.getCurrentTime());
    if (result.type === 'FOLDER') {
      await this.softDeleteFolderCascade(result.name, options);
    }
    await db.collection('media').updateOne(filter, {
      $set: { deleted_at: now, deleted_by: options.user_id },
    });
    return { message: 'Object soft-deleted', _id: id };
  }

  async deleteObject(id: string, options: OptionsInput) {
    const db = await getMediaDb(options.tenant_id);
    const filter: any = { _id: new ObjectId(id) };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;
    const result = await db.collection('media').findOne(filter);
    if (!result) throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: '[ERROR] [MediaMinioService] Object not found' });

    if (result.type === 'FOLDER') {
      await this.deleteFolderCascade(result.name, options);
    } else {
      // Best-effort remove from storage
      try {
        const { bucket } = await resolveTenantBuckets(options.tenant_id);
        await (await _minio()).removeObject(bucket, result.fileName);
      } catch (err) {
        console.warn(`[deleteObject] removeObject failed`, err);
      }
    }
    await db.collection('media').deleteOne(filter);
    return { message: 'Object deleted', _id: id };
  }

  async destroyObject(id: string, options: OptionsInput) {
    const db = await getMediaDb(options.tenant_id);
    const filter: any = { _id: new ObjectId(id) };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;
    const result = await db.collection('media').findOne(filter);

    if (!result) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: '[ERROR] [MediaMinioService] Object not found' });
    }

    if (!result.deleted_at) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: '[ERROR] [MediaMinioService] Object is not in trash. Please move to trash first.' });
    }

    if (result.type === 'FOLDER') {
      await this.destroyFolderCascade(result.name, options);
    } else {
      try {
        const { bucket } = await resolveTenantBuckets(options.tenant_id);
        await (await _minio()).removeObject(bucket, result.fileName);
      } catch (err) {
        console.warn(`[destroyObject] removeObject failed`, err);
      }
    }
    await db.collection('media').deleteOne(filter);
    return { message: 'Object destroyed', _id: id };
  }

  private async destroyFolderCascade(folderName: string, options: OptionsInput) {
    const db = await getMediaDb(options.tenant_id);
    const escapedFolderName = this.escapeRegex(folderName);
    const tenantFilter = options.tenant_id ? { tenant_id: options.tenant_id } : {};

    const records = await db
      .collection('media')
      .find({
        deleted_at: { $exists: true, $ne: null },
        $or: [
          { folder: folderName },
          { folder: { $regex: `^${escapedFolderName}/`, $options: 'i' } },
          { name: { $regex: `^${escapedFolderName}/`, $options: 'i' }, type: 'FOLDER' },
        ],
        ...tenantFilter,
      })
      .toArray();

    const { bucket } = await resolveTenantBuckets(options.tenant_id);
    for (const record of records) {
      if (record.type === 'FILE') {
        try {
          await (await _minio()).removeObject(bucket, record.fileName);
        } catch (err) {
          console.warn(`[destroyFolderCascade] removeObject failed for ${record.fileName}`, err);
        }
      }
      await db.collection('media').deleteOne({ _id: record._id });
    }

    console.log(`[INFO] Destroyed ${records.length} items in folder "${folderName}"`);
    return { message: 'Folder destroyed successfully', destroyedCount: records.length };
  }

  async emptyTrash(options: OptionsInput): Promise<{
    success: boolean;
    message: string;
    destroyedCount: number;
    errorCount?: number;
    errors?: string[];
  }> {
    const db = await getMediaDb(options.tenant_id);
    const isAdmin = options.roles?.includes('admin');

    const query: any = {
      deleted_at: { $exists: true, $ne: null },
    };
    if (options.tenant_id) query.tenant_id = options.tenant_id;
    if (!isAdmin) query.deleted_by = options.user_id;

    const trashItems = await db.collection('media').find(query).toArray();

    if (trashItems.length === 0) {
      return {
        success: true,
        message: 'Trash is already empty',
        destroyedCount: 0,
      };
    }

    let destroyedCount = 0;
    let errorCount = 0;
    const errors: string[] = [];
    const { bucket } = await resolveTenantBuckets(options.tenant_id);

    for (const item of trashItems) {
      try {
        if (item.type === 'FOLDER') {
          await this.destroyFolderCascade(item.name, options);
        } else {
          try {
            await (await _minio()).removeObject(bucket, item.fileName);
          } catch (err) {
            console.warn(`[emptyTrash] removeObject failed for ${item.fileName}`, err);
          }
        }
        await db.collection('media').deleteOne({ _id: item._id });
        destroyedCount++;
      } catch (err) {
        errorCount++;
        const message = `Failed to destroy ${item.type} ${item._id}`;
        errors.push(message);
        console.error('[EMPTY_TRASH_ERROR]', { message, error: err, itemId: item._id, type: item.type });
      }
    }

    if (errorCount > 0) {
      return {
        success: true,
        message: `Trash emptied with ${errorCount} error(s)`,
        destroyedCount,
        errorCount,
        errors: errors.slice(0, 10),
      };
    }

    return {
      success: true,
      message: 'Trash emptied successfully',
      destroyedCount,
    };
  }

  private async softDeleteFolderCascade(folderName: string, options: OptionsInput) {
    const now = new Date(appSettings.timeZoneMongoDB.getCurrentTime());
    const db = await getMediaDb(options.tenant_id);
    const filter: any = {
      folder: { $regex: `^${this.escapeRegex(folderName)}`, $options: 'i' },
      is_root: false,
    };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;

    await db.collection('media').updateMany(filter, {
      $set: { deleted_at: now, deleted_by: options.user_id },
    });
    return { message: 'Folder soft-deleted' };
  }

  private async deleteFolderCascade(folderName: string, options: OptionsInput) {
    const db = await getMediaDb(options.tenant_id);
    const filter: any = {
      folder: { $regex: `^${this.escapeRegex(folderName)}`, $options: 'i' },
      is_root: false,
    };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;

    const records = await db.collection('media').find(filter).toArray();
    const { bucket } = await resolveTenantBuckets(options.tenant_id);

    for (const record of records) {
      if (record.type === 'FILE') {
        try {
          await (await _minio()).removeObject(bucket, record.fileName);
        } catch (err) {
          console.warn(`[deleteFolderCascade] removeObject failed for ${record.fileName}`, err);
        }
      }
      await db.collection('media').deleteOne({ _id: record._id });
    }
    return { message: 'Folder deleted', deletedCount: records.length };
  }

  async restoreObject(id: string, options: OptionsInput) {
    const db = await getMediaDb(options.tenant_id);
    const filter: any = { _id: new ObjectId(id) };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;
    const record = await db.collection('media').findOne(filter);

    if (!record) throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: '[ERROR] [MediaMinioService] Please check the id' });
    if (!record.deleted_at) throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: '[ERROR] [MediaMinioService] This item is not in trash' });

    if (record.type === 'FOLDER') {
      await this.restoreFolderCascade(record.name, options);
    } else {
      await this.restoreParentFolders(record.folder, options);
    }
    return db.collection('media').updateOne(filter, { $unset: { deleted_at: '', deleted_by: '' } });
  }

  private async restoreFolderCascade(folderName: string, options: OptionsInput) {
    const db = await getMediaDb(options.tenant_id);
    const escapedFolderName = this.escapeRegex(folderName);
    const filter: any = {
      deleted_at: { $exists: true, $ne: null },
      $or: [
        { folder: folderName },
        { folder: { $regex: `^${escapedFolderName}/`, $options: 'i' } },
        { name: { $regex: `^${escapedFolderName}/`, $options: 'i' }, type: 'FOLDER' },
      ],
    };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;
    const records = await db.collection('media').find(filter).toArray();

    for (const record of records) {
      await db.collection('media').updateOne(
        { _id: record._id },
        { $unset: { deleted_at: '', deleted_by: '' } },
      );
    }
    console.log(`[INFO] Restored folder "${folderName}" with ${records.length} items`);
    return { message: 'Folder restored successfully', restoredCount: records.length };
  }

  private async restoreParentFolders(folderPath: string, options: OptionsInput) {
    if (!folderPath || folderPath === 'root') return;

    const db = await getMediaDb(options.tenant_id);

    const parts = folderPath.split('/');
    const folderPaths: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      folderPaths.push(parts.slice(0, i).join('/'));
    }

    const filter: any = {
      type: 'FOLDER',
      name: { $in: folderPaths },
      deleted_at: { $exists: true, $ne: null },
    };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;

    const deletedParentFolders = await db.collection('media').find(filter).toArray();
    for (const folder of deletedParentFolders) {
      await db.collection('media').updateOne(
        { _id: folder._id },
        { $unset: { deleted_at: '', deleted_by: '' } },
      );
    }
    if (deletedParentFolders.length > 0) {
      console.log(`[INFO] Restored ${deletedParentFolders.length} parent folders for path "${folderPath}"`);
    }
    return { restoredFolders: deletedParentFolders.length };
  }

  async renameFolderComplete(oldFolderId: string, newFolderName: string, options: OptionsInput): Promise<any> {
    const db = await getMediaDb(options.tenant_id);

    const folderQuery: any = { _id: new ObjectId(oldFolderId), type: 'FOLDER' };
    if (options.tenant_id) folderQuery.tenant_id = options.tenant_id;
    const folderRecord = await db.collection('media').findOne(folderQuery);

    if (!folderRecord) throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: `Folder with ID "${oldFolderId}" not found` });
    if (folderRecord.deleted_at) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: `Folder "${folderRecord.name}" is in trash. Please restore it first.` });
    }

    const oldFolderName = folderRecord.name;
    const oldFolder = oldFolderName.endsWith('/') ? oldFolderName.slice(0, -1) : oldFolderName;
    const newFolder = newFolderName.endsWith('/') ? newFolderName.slice(0, -1) : newFolderName;

    console.log(`[INFO] Starting folder rename: ID=${oldFolderId}, "${oldFolder}" → "${newFolder}"`);

    await this.validateFolderRename(oldFolder, newFolder, options);

    const { subfolders, files } = await this.getItemsInFolder(oldFolder, options);

    console.log(`[INFO] Found ${subfolders.length} subfolders and ${files.length} files to rename`);

    const { bucket, compressBucket } = await resolveTenantBuckets(options.tenant_id);

    try {
      await this.updateFolderMetadataInMongo(oldFolder, newFolder, folderRecord, subfolders, files, options);
      console.log('[INFO] DB metadata updated');
    } catch (error) {
      console.error('[ERROR] Failed to update folder metadata in DB:', error);
      throw new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Failed to update folder metadata in database', expose: false });
    }

    try {
      if (files.length > 0) {
        await this.moveFilesInMinio(oldFolder, newFolder, files, bucket);
      }
      console.log('[INFO] MinIO files moved');
    } catch (error) {
      console.error('[ERROR] Failed to move files in MinIO:', error);
      throw new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Failed to move files in storage. DB updated but files may be inconsistent.', expose: false });
    }

    try {
      await this.moveCompressedImagesForFolder(oldFolder, newFolder, files, compressBucket);
      console.log('[INFO] Compressed images moved');
    } catch (error) {
      console.warn('[WARN] Failed to move compressed images (non-critical):', error);
    }

    return {
      success: true,
      message: 'Folder renamed successfully',
      folderId: oldFolderId,
      oldFolderName: oldFolder,
      newFolderName: newFolder,
      stats: { foldersUpdated: 1 + subfolders.length, filesUpdated: files.length },
    };
  }

  private async validateFolderRename(oldFolder: string, newFolder: string, options: OptionsInput): Promise<void> {
    if (!newFolder) throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'New folder name cannot be empty' });
    if (oldFolder === newFolder) throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'New folder name must be different from old name' });

    const folderNameRegex = /^[a-zA-Z0-9_\-\/]+$/;
    if (!folderNameRegex.test(newFolder)) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'Folder name contains invalid characters. Only letters, numbers, underscores, hyphens, and forward slashes are allowed.' });
    }

    const db = await getMediaDb(options.tenant_id);
    const { bucket } = await resolveTenantBuckets(options.tenant_id);
    const filter: any = { name: newFolder, type: 'FOLDER', bucketName: bucket };
    if (options.tenant_id) filter.tenant_id = options.tenant_id;

    const newFolderRecord = await db.collection('media').findOne(filter);
    if (newFolderRecord) throw new AppError({ statusCode: 409, code: 'CONFLICT', message: `Folder "${newFolder}" already exists` });
  }

  private async getItemsInFolder(folderName: string, options: OptionsInput): Promise<{ subfolders: any[]; files: any[] }> {
    const db = await getMediaDb(options.tenant_id);
    const { bucket } = await resolveTenantBuckets(options.tenant_id);
    const tenantFilter = options.tenant_id ? { tenant_id: options.tenant_id } : {};

    const subfolders = await db.collection('media').find({
      type: 'FOLDER',
      name: { $regex: `^${this.escapeRegex(folderName)}/` },
      bucketName: bucket,
      deleted_at: { $exists: false },
      ...tenantFilter,
    }).toArray();

    const files = await db.collection('media').find({
      type: 'FILE',
      $or: [
        { folder: folderName },
        { folder: { $regex: `^${this.escapeRegex(folderName)}/` } },
      ],
      bucketName: bucket,
      deleted_at: { $exists: false },
      ...tenantFilter,
    }).toArray();

    console.log(`[INFO] getItemsInFolder("${folderName}"): found ${files.length} files and ${subfolders.length} subfolders`);
    return { subfolders, files };
  }

  private async updateFolderMetadataInMongo(
    oldFolder: string,
    newFolder: string,
    folderRecord: any,
    subfolders: any[],
    files: any[],
    options: OptionsInput,
  ): Promise<void> {
    const db = await getMediaDb(options.tenant_id);
    const now = new Date(appSettings.timeZoneMongoDB.getCurrentTime());

    await db.collection('media').updateOne(
      { _id: folderRecord._id },
      { $set: { name: newFolder, updated_at: now } },
    );

    for (const subfolder of subfolders) {
      const oldName = subfolder.name;
      const newName = oldName.replace(new RegExp(`^${this.escapeRegex(oldFolder)}`), newFolder);

      const nameParts = newName.split('/');
      const newParentFolder = nameParts.length === 1 ? 'root' : nameParts.slice(0, -1).join('/');

      await db.collection('media').updateOne(
        { _id: subfolder._id },
        { $set: { name: newName, folder: newParentFolder, updated_at: now } },
      );
    }

    for (const file of files) {
      const oldFileName = file.fileName;
      const oldFolderPath = file.folder;

      const newFileName = oldFileName.replace(new RegExp(`^${this.escapeRegex(oldFolder)}`), newFolder);
      const newFolderPath = oldFolderPath === oldFolder
        ? newFolder
        : oldFolderPath.replace(new RegExp(`^${this.escapeRegex(oldFolder)}`), newFolder);

      await db.collection('media').updateOne(
        { _id: file._id },
        { $set: { fileName: newFileName, folder: newFolderPath, name: newFileName, updated_at: now } },
      );
    }
  }

  private async moveFilesInMinio(oldFolder: string, newFolder: string, files: any[], bucket: string): Promise<void> {
    for (const file of files) {
      const oldPath = file.fileName;
      const newPath = oldPath.replace(new RegExp(`^${this.escapeRegex(oldFolder)}`), newFolder);

      try {
        await (await _minio()).copyObject(bucket, newPath, `/${bucket}/${oldPath}`);
        console.log(`[INFO] Copied: ${oldPath} → ${newPath}`);
      } catch (error) {
        console.error(`[ERROR] Failed to copy ${oldPath} to ${newPath}:`, error);
        throw error;
      }
    }

    const objectsToDelete = files.map((f) => f.fileName);
    if (objectsToDelete.length > 0) {
      try {
        await (await _minio()).removeObjects(bucket, objectsToDelete);
        console.log(`[INFO] Deleted ${objectsToDelete.length} old files from MinIO`);
      } catch (error) {
        console.error('[ERROR] Failed to delete old files from MinIO:', error);
        throw error;
      }
    }
  }

  private async moveCompressedImagesForFolder(
    oldFolder: string,
    newFolder: string,
    files: any[],
    compressBucket: string,
  ): Promise<void> {
    if (!compressBucket) return;

    const imageFiles = files.filter((f) => f.mimeType && f.mimeType.startsWith('image/'));
    if (imageFiles.length === 0) return;

    console.log(`[INFO] Moving compressed images for ${imageFiles.length} image files`);

    for (const file of imageFiles) {
      const oldFileName = file.fileName;
      const newFileName = oldFileName.replace(new RegExp(`^${this.escapeRegex(oldFolder)}`), newFolder);

      try {
        const objectsStream = (await _minio()).listObjects(compressBucket, `${oldFileName}/`, true);

        const compressedObjects: string[] = [];
        await new Promise((resolve, reject) => {
          objectsStream.on('data', (obj: any) => {
            if (obj.name) compressedObjects.push(obj.name);
          });
          objectsStream.on('end', resolve);
          objectsStream.on('error', reject);
        });

        for (const oldCompressedPath of compressedObjects) {
          const newCompressedPath = oldCompressedPath.replace(
            new RegExp(`^${this.escapeRegex(oldFileName)}`),
            newFileName,
          );
          await (await _minio()).copyObject(compressBucket, newCompressedPath, `/${compressBucket}/${oldCompressedPath}`);
        }

        if (compressedObjects.length > 0) {
          await (await _minio()).removeObjects(compressBucket, compressedObjects);
        }

        console.log(`[INFO] Moved ${compressedObjects.length} compressed versions for ${oldFileName}`);
      } catch (error) {
        console.warn(`[WARN] Failed to move compressed images for ${oldFileName}:`, error);
      }
    }
  }

  // ============================================================================
  // Compatibility shims for v2 callers (REST adapter, MCP service, form-builder).
  // ============================================================================

  /** Alias for old caller using `.create(...)`. */
  async create(data: any, file: any, tenant_id?: string, created_by?: string, opts?: { cv?: boolean }): Promise<any> {
    return this.createObject(data, file, tenant_id, created_by, opts);
  }

  /**
   * Upload a raw Buffer wrapped as a fake multipart file. Used by the REST
   * adapter (federated upload) and MCP service.
   */
  async uploadBuffer(
    buffer: Buffer,
    filename: string,
    mimetype: string,
    tenant_id?: string,
    created_by?: string,
  ): Promise<{ id: string; objectName: string; path: string; mimetype: string; size: number }> {
    const fakeFile = {
      mimetype,
      size: buffer.length,
      fields: {},
      toBuffer: async () => buffer,
    };
    const result = await this.createObject(
      { title: filename, alt: filename },
      fakeFile,
      tenant_id,
      created_by,
    );
    return {
      id: result._id?.toString?.() ?? result.id,
      objectName: result.objectName,
      path: result.path,
      mimetype,
      size: buffer.length,
    };
  }

  /**
   * Flat list of media items with pagination — used by MCP service.
   * Wraps `getList()` by querying root + recursive-style search.
   */
  async listObjects(
    _prefix?: string,
    _recursive: boolean = true,
    page: number = 1,
    limit: number = 20,
    search: string[] = [],
    tenant_id?: string,
  ): Promise<{ data: any[]; pagination: any }> {
    const searchTerm = search[0]?.split(':')?.pop() || '';
    const options: OptionsInput = {
      databaseType: 'mongodb',
      tenant_id,
      roles: ['admin'],
    };
    return this.getList(
      { search: searchTerm, page, limit },
      'root',
      false,
      options,
    );
  }

  /** Alias for old MCP caller using `.delete(id)` — performs soft-delete. */
  async delete(id: string, tenant_id?: string): Promise<any> {
    const options: OptionsInput = {
      databaseType: 'mongodb',
      tenant_id: tenant_id || getTenantId() || undefined,
      roles: ['admin'],
    };
    return this.softDeleteObject(id, options);
  }
}

export const mediaMinioService = new MediaMinioService();
