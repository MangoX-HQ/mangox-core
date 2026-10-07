/**
 * Clone all media from ve-tinh-all-new production into local:
 *   - Download each FILE object from prod public R2
 *   - Re-upload to local R2 bucket `vang-thien-long` with the SAME object key
 *   - Upsert the media DB record into local tenant DB, keeping `_id`,
 *     switching `bucketName` → vang-thien-long, rebuilding `path`, fresh etag
 *   - FOLDER records: DB-only upsert (no R2 object)
 *
 * Usage:
 *   npx tsx scripts/clone-media-vetinh.ts --tenant vang-thien-long --dry-run
 *   npx tsx scripts/clone-media-vetinh.ts --tenant vang-thien-long --limit 20
 *   npx tsx scripts/clone-media-vetinh.ts --tenant vang-thien-long
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import * as Minio from 'minio';
import * as crypto from 'crypto';

const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

const PROD_BASE = 'https://ve-tinh-all-new.mangoads.com.vn/api/v1';
const PROD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc5MDk1MjYyLCJleHAiOjE3NzkxMjQwNjJ9.v2Md9zP8SYUVSrHXw6ShpmDJQ6bppM8FnBuPBf-jG0A';

// Prod public R2 base (from media-minio-direct listing `path`)
const PROD_PUBLIC_BASE = 'https://pub-a55a56c478d74ea5b9e5aa0548a4496e.r2.dev';
const PROD_BUCKET = 've-tinh';

const TENANT_ID = '69eada499e0eb6435ce0bda7';

interface Args { tenant: string; dryRun: boolean; limit?: number; }
function parseArgs(): Args {
  const a: Args = { tenant: 'vang-thien-long', dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--tenant') a.tenant = process.argv[++i];
    else if (v === '--limit') a.limit = Number(process.argv[++i]);
  }
  return a;
}

async function prodGet(path: string): Promise<any> {
  const res = await fetch(`${PROD_BASE}${path}`, {
    headers: { Authorization: `Bearer ${PROD_TOKEN}`, 'X-Tenant-ID': TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`PROD ${path} → ${res.status}`);
  return res.json();
}

async function fetchAllProdMedia(): Promise<any[]> {
  const PAGE = 200;
  const first: any = await prodGet(`/media?limit=${PAGE}&page=1&select=*`);
  const lastPage = first?.meta?.last_page ?? 1;
  const out: any[] = [...(first?.data ?? [])];
  for (let p = 2; p <= lastPage; p++) {
    const j: any = await prodGet(`/media?limit=${PAGE}&page=${p}&select=*`);
    out.push(...(j?.data ?? []));
  }
  return out;
}

async function main() {
  const args = parseArgs();
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'} | tenant: ${args.tenant}${args.limit ? ` | limit ${args.limit}` : ''}\n`);

  const m = new MongoClient(MAIN_URI);
  await m.connect();
  const tenant = await m.db().collection('tenant').findOne({ slug: args.tenant });
  if (!tenant) { console.error('Tenant not found'); await m.close(); process.exit(1); }
  const localBucket: string = tenant.media?.bucket || args.tenant;
  const localPublicBase: string = (tenant.media?.public_url || '').replace(/\/$/, '');
  if (!localPublicBase) { console.error('tenant.media.public_url missing'); await m.close(); process.exit(1); }

  const tc = new MongoClient(tenant.database.uri);
  await tc.connect();
  const tdb = tc.db();

  const endPoint = (process.env.MINIO_ENDPOINT || '').replace(/^https?:\/\//, '');
  const minio = new Minio.Client({
    endPoint,
    accessKey: process.env.MINIO_ACCESS_KEY || '',
    secretKey: process.env.MINIO_SECRET_KEY || '',
    useSSL: process.env.MINIO_USE_SSL !== 'false',
    region: process.env.MINIO_REGION || 'auto',
  });

  console.log('Fetching prod media list…');
  let records = await fetchAllProdMedia();
  console.log(`  ${records.length} media records from prod`);
  if (args.limit) records = records.slice(0, args.limit);

  let files = 0, folders = 0, uploaded = 0, skipped = 0, failed = 0;
  const errs: string[] = [];

  for (const rec of records) {
    const isFile = rec.type === 'FILE' && rec.fileName;
    const localRec: any = {
      ...rec,
      _id: rec._id,
      bucketName: localBucket,
      tenant_id: TENANT_ID,
    };

    if (isFile) {
      files++;
      // Local r2.dev managed domain maps directly to the bucket — do NOT
      // prefix the bucket name in the public path.
      localRec.path = `${localPublicBase}/${rec.fileName}`;
      if (!args.dryRun) {
        try {
          const dlUrl = `${PROD_PUBLIC_BASE}/${PROD_BUCKET}/${rec.fileName}`;
          const resp = await fetch(dlUrl);
          if (!resp.ok) throw new Error(`download ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const putRes: any = await minio.putObject(
            localBucket,
            rec.fileName,
            buf,
            buf.length,
            { 'Content-Type': rec.mimeType || 'application/octet-stream' },
          );
          localRec.etag = (putRes?.etag || '').replace(/"/g, '') ||
            crypto.createHash('md5').update(buf).digest('hex');
          localRec.size = rec.size ?? buf.length;
          uploaded++;
        } catch (e: any) {
          failed++;
          if (errs.length < 8) errs.push(`  ${rec._id} ${rec.fileName}: ${e.message}`);
          continue;
        }
      }
    } else {
      folders++;
    }

    if (!args.dryRun) {
      let oid: any = rec._id;
      try { oid = new ObjectId(rec._id); } catch {}
      localRec._id = oid;
      await tdb.collection('media').replaceOne({ _id: oid }, localRec, { upsert: true });
    }
  }

  console.log(`\n  files=${files} folders=${folders} uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
  if (errs.length) { console.log('  errors:'); errs.forEach((e) => console.log(e)); }

  await tc.close();
  await m.close();
  console.log('\nDone.');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
