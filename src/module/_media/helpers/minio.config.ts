import * as Minio from 'minio';
import { appSettings } from '../../../configs/app-settings';
import { getTenantSlug } from '../../../core_v2/adapters/mongodb/tenant-context';

interface IUploadedMulterFileMinio {
    fieldName: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    buffer: Buffer;
    size: number;
}

// Strip protocol so Cloudflare R2 endpoint like "https://<acct>.r2.cloudflarestorage.com" works
const rawEndpoint = appSettings.minio.endpoint || 'localhost';
const endPoint = rawEndpoint.replace(/^https?:\/\//, '');
const portRaw = appSettings.minio.port;
const port = portRaw ? Number(portRaw) : undefined;

const minioClient = new Minio.Client({
    endPoint,
    ...(port ? { port } : {}),
    accessKey: appSettings.minio.accessKey,
    secretKey: appSettings.minio.secretKey,
    useSSL: appSettings.minio.useSSL !== false,
    region: appSettings.minio.region || 'auto',
});

export { minioClient, IUploadedMulterFileMinio };

/**
 * Active R2 client + bucket for the CURRENT tenant context (AsyncLocalStorage):
 *   - Has team_id (post-migration) → team's R2 client + team's bucket
 *   - No team / system → fallback to the global minioClient + default bucket
 *
 * `objectKey(rel)` builds the path per convention:
 *   - team-scoped: <tenant_slug>/<rel>
 *   - global:      <rel>
 *
 * Use this in media services instead of importing `minioClient` directly when
 * team isolation is needed.
 */
export interface ActiveMinio {
  client: Minio.Client;
  bucket: string;
  isTeamScoped: boolean;
  objectKey: (rel: string) => string;
  publicUrl?: string;
}

export async function getActiveMinio(defaultBucket?: string): Promise<ActiveMinio> {
  // Single-tenant: always the global MinIO client; object key namespaced by the env slug.
  const tenantSlug = getTenantSlug();
  return {
    client: minioClient,
    bucket: defaultBucket ?? appSettings.minio.bucketName ?? 'default',
    isTeamScoped: false,
    objectKey: (rel) => {
      const clean = rel.replace(/^\/+/, '');
      return tenantSlug ? `${tenantSlug}/${clean}` : clean;
    },
  };
}

