/**
 * Migrate media → single-bucket model.
 *
 * Before: per-tenant R2 bucket + object key `<tenant_id>/<name>`.
 * After:  ONE global bucket (MINIO_BUCKET_NAME), object key `<slug>/<name>`.
 *
 * Per-tenant data lives in its OWN Mongo db (tenant.database.{uri,name}).
 * This script: read `tenant` collection from core db → for each tenant open
 * its db → for each `media` doc copy R2 object to global bucket under
 * `<slug>/...` and rewrite { bucketName, fileName, path }.
 *
 * SAFE: dry-run by default. R2 source objects are NEVER deleted.
 *
 *   tsx scripts/migrate-media-single-bucket.ts                      # dry-run, all tenants
 *   tsx scripts/migrate-media-single-bucket.ts --tenant=<idOrSlug>  # dry-run, one
 *   tsx scripts/migrate-media-single-bucket.ts --tenant=vang-thien-long --execute
 */
import * as fs from 'fs';
import * as path from 'path';
import * as Minio from 'minio';
import { MongoClient, ObjectId, Db } from 'mongodb';

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as any;
  const p = path.resolve(__dirname, '../.env');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

async function main() {
  const E = loadEnv();
  const args = process.argv.slice(2);
  const EXECUTE = args.includes('--execute');
  const tenantArg = (args.find((a) => a.startsWith('--tenant=')) || '').split('=')[1] || null;

  const GLOBAL_BUCKET = E.MINIO_BUCKET_NAME;
  const GLOBAL_PUB = (E.MINIO_PUBLIC || '').replace(/\/+$/, '');
  if (!GLOBAL_BUCKET) throw new Error('MINIO_BUCKET_NAME missing');

  const minio = new Minio.Client({
    endPoint: (E.MINIO_ENDPOINT || '').replace(/^https?:\/\//, ''),
    accessKey: E.MINIO_ACCESS_KEY!,
    secretKey: E.MINIO_SECRET_KEY!,
    useSSL: E.MINIO_USE_SSL !== 'false',
    region: E.MINIO_REGION || 'auto',
  });

  const core = new MongoClient(E.MONGODB_URL!);
  await core.connect();
  const coreDb: Db = core.db();

  const tq: any = {};
  if (tenantArg) {
    const or: any[] = [{ slug: tenantArg }];
    try { or.push({ _id: new ObjectId(tenantArg) }); } catch {}
    tq.$or = or;
  }
  const tenants = await coreDb.collection('tenant').find(tq).toArray();
  if (tenantArg && tenants.length === 0) throw new Error(`tenant not found: ${tenantArg}`);

  const totals = { tenants: 0, total: 0, willMigrate: 0, skipped: 0, copyFail: 0, noDb: 0 };
  const report: any[] = [];

  for (const t of tenants) {
    const slug: string = t.slug || String(t._id);
    const tid = String(t._id);
    const dbCfg = t.database;
    if (!dbCfg?.uri || !dbCfg?.name) { totals.noDb++; report.push({ slug, skipped: 'no database config' }); continue; }

    const tc = new MongoClient(dbCfg.uri);
    let perTenant = { slug, total: 0, willMigrate: 0, skipped: 0, copyFail: 0, sample: [] as any[] };
    try {
      await tc.connect();
      const tdb = tc.db(dbCfg.name);
      const cursor = tdb.collection('media').find({});
      for await (const doc of cursor) {
        perTenant.total++; totals.total++;
        const oldBucket: string = doc.bucketName;
        const oldKey: string = doc.fileName;
        if (!oldKey) { perTenant.skipped++; totals.skipped++; continue; }

        // Only MAIN media. compress (*-compress) / cv (*-cv) are left as-is
        // — not re-run/copied; they keep their own slug-compress / slug-cv
        // folders separately.
        if (oldBucket && (/-compress$/.test(oldBucket) || /-cv$/.test(oldBucket))) {
          perTenant.skipped++; totals.skipped++; continue;
        }

        const segs = String(oldKey).split('/');
        const newKey =
          segs[0] === tid ? [slug, ...segs.slice(1)].join('/')
          : segs[0] === slug ? oldKey
          : `${slug}/${oldKey}`;

        if (oldBucket === GLOBAL_BUCKET && newKey === oldKey) { perTenant.skipped++; totals.skipped++; continue; }

        if (perTenant.sample.length < 5)
          perTenant.sample.push({ from: `${oldBucket}/${oldKey}`, to: `${GLOBAL_BUCKET}/${newKey}`, type: doc.type });

        if (EXECUTE) {
          if (doc.type !== 'FOLDER') {
            try {
              await minio.copyObject(
                GLOBAL_BUCKET, newKey, `/${oldBucket}/${oldKey}`,
                new (Minio as any).CopyConditions(),
              );
            } catch (e: any) {
              perTenant.copyFail++; totals.copyFail++;
              console.warn(`[copy-fail][${slug}] ${oldBucket}/${oldKey}: ${e?.message}`);
              continue;
            }
          }
          await tdb.collection('media').updateOne(
            { _id: doc._id },
            {
              $set: {
                bucketName: GLOBAL_BUCKET,
                fileName: newKey,
                ...(doc.type === 'FOLDER' ? {} : { path: `${GLOBAL_PUB}/${newKey}` }),
                // rollback safety: original values, set once (source R2 kept too)
                ...(doc._premigrate
                  ? {}
                  : { _premigrate: { bucketName: oldBucket, fileName: oldKey, path: doc.path ?? null } }),
              },
            },
          );
        }
        perTenant.willMigrate++; totals.willMigrate++;
      }
    } finally {
      await tc.close().catch(() => {});
    }
    totals.tenants++;
    report.push(perTenant);
  }

  console.log(JSON.stringify({
    mode: EXECUTE ? 'EXECUTE' : 'DRY-RUN',
    tenantFilter: tenantArg || '(all)',
    globalBucket: GLOBAL_BUCKET, globalPublic: GLOBAL_PUB,
    totals, report,
  }, null, 2));

  await core.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
