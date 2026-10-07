/**
 * Ensure R2/MinIO buckets exist for every tenant.
 *
 * For each tenant with a `media.bucket` field, calls minioClient.bucketExists()
 * and minioClient.makeBucket() if missing. Also creates cv_bucket and
 * compress_bucket when configured. Skips when tenant.media is unset.
 *
 * Usage:
 *   npx tsx scripts/ensure-tenant-buckets.ts          # ensure all
 *   npx tsx scripts/ensure-tenant-buckets.ts --tenant aurelia
 *   npx tsx scripts/ensure-tenant-buckets.ts --dry-run
 */

import { MongoClient } from "mongodb";
import * as Minio from "minio";
import "dotenv/config";

const REGION = process.env.MINIO_REGION || "auto";

function parseArgs() {
  const args = { tenant: undefined as string | undefined, dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === "--tenant") args.tenant = process.argv[++i];
    else if (v === "--dry-run") args.dryRun = true;
  }
  return args;
}

function buildMinioClient(): Minio.Client {
  const rawEndpoint = process.env.MINIO_ENDPOINT || "localhost";
  const endPoint = rawEndpoint.replace(/^https?:\/\//, "");
  const portRaw = process.env.MINIO_PORT;
  return new Minio.Client({
    endPoint,
    ...(portRaw ? { port: Number(portRaw) } : {}),
    accessKey: process.env.MINIO_ACCESS_KEY || "",
    secretKey: process.env.MINIO_SECRET_KEY || "",
    useSSL: process.env.MINIO_USE_SSL !== "false",
    region: REGION,
  });
}

async function ensureBucket(
  client: Minio.Client,
  name: string,
  dryRun: boolean,
): Promise<void> {
  if (!name) return;
  const exists = await client.bucketExists(name).catch(() => false);
  if (exists) {
    console.log(`  ✓ ${name} (exists)`);
    return;
  }
  if (dryRun) {
    console.log(`  + ${name} (would create)`);
    return;
  }
  try {
    await client.makeBucket(name, REGION);
    console.log(`  + ${name} (created)`);
  } catch (e: any) {
    console.error(`  ✗ ${name} — ${e?.message || e}`);
  }
}

async function main() {
  const args = parseArgs();
  const mongoUri =
    process.env.MONGODB_URL ||
    `mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true`;

  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  const tenants = await mongo
    .db()
    .collection("tenant")
    .find(args.tenant ? { slug: args.tenant } : {})
    .toArray();
  await mongo.close();

  if (tenants.length === 0) {
    console.error("No tenants found");
    process.exit(1);
  }

  const minioCli = buildMinioClient();
  for (const t of tenants) {
    if (!t.media) {
      console.log(`SKIP ${t.slug} — no media config`);
      continue;
    }
    console.log(`\n=== ${t.slug} ===`);
    await ensureBucket(minioCli, t.media.bucket, args.dryRun);
    if (t.media.cv_bucket) await ensureBucket(minioCli, t.media.cv_bucket, args.dryRun);
    if (t.media.compress_bucket)
      await ensureBucket(minioCli, t.media.compress_bucket, args.dryRun);
  }

  console.log(`\nDone. ${tenants.length} tenant(s) processed.`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
