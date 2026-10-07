/**
 * Single-tenant bucket resolver for MinIO storage.
 *
 * Single-bucket model: ONE physical bucket (global env) + ONE public domain.
 * Per-tenant isolation by object-key prefix (= env TENANT slug). Team-scoped R2
 * has been removed in the single-tenant runtime — always use the global MinIO client.
 */

import * as Minio from 'minio';
import { appSettings } from "../../../configs/app-settings";
import { getTenantSlug } from "../../../core_v2/adapters/mongodb/tenant-context";
import { minioClient } from './minio.config';

export interface TenantBuckets {
  client: Minio.Client;
  isTeamScoped: boolean;
  bucket: string;
  cvBucket: string;
  compressBucket: string;
  publicUrl: string;
  cvPublicUrl: string;
  compressPublicUrl: string;
  /**
   * Object-key prefix (= tenant slug). Every object key = `${prefix}/<name>`.
   * Empty when there's no tenant context.
   */
  prefix: string;
}

function singleBucketLegacy(prefix: string): TenantBuckets {
  const bucket = appSettings.minio.bucketName || "";
  const pub = appSettings.minio.public || "";
  // Separate CV/form-builder bucket (MINIO_CV_BUCKET_NAME). If not set → use the
  // main bucket (previous behavior). cvPublicUrl: prefers MINIO_CV_PUBLIC, otherwise derives from
  // publicUrl by replacing the last bucket segment (.../hcmvif → .../hcmvif-form-builder).
  const cvBucket = (appSettings.minio as any).cv?.bucketName || bucket;
  const cvPub = (appSettings.minio as any).cv?.public
    || (cvBucket !== bucket ? pub.replace(/[^/]+$/, cvBucket) : pub);
  return {
    client: minioClient,
    isTeamScoped: false,
    bucket,
    cvBucket,
    compressBucket: bucket,
    publicUrl: pub,
    cvPublicUrl: cvPub,
    compressPublicUrl: pub,
    prefix,
  };
}

export async function resolveTenantBuckets(
  _tenantIdHint?: string | null,
): Promise<TenantBuckets> {
  const prefix = getTenantSlug() || "";
  return singleBucketLegacy(prefix);
}

/** Kept for signature compatibility with old call sites — single-tenant doesn't cache, so this is a no-op. */
export function invalidateTenantBuckets(_tenantId?: string): void {
  /* no-op */
}
