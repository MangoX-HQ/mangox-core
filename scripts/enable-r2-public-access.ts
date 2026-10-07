/**
 * Enable R2 managed `r2.dev` public access for each tenant bucket
 * and write the assigned public URLs back into `tenant.media`.
 *
 * For every tenant doc:
 *   media.bucket          → media.public_url
 *   media.cv_bucket       → media.cv_public_url
 *   media.compress_bucket → media.compress_public_url
 *
 * Usage:
 *   npx tsx scripts/enable-r2-public-access.ts          # all tenants
 *   npx tsx scripts/enable-r2-public-access.ts --tenant aurelia
 *   npx tsx scripts/enable-r2-public-access.ts --dry-run
 *
 * Requires env:
 *   MINIO_ENDPOINT (used to extract Cloudflare account_id)
 *   CLOUDFLARE_API_TOKEN
 */

import { MongoClient } from "mongodb";
import "dotenv/config";

function parseArgs() {
  const args = { tenant: undefined as string | undefined, dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === "--tenant") args.tenant = process.argv[++i];
    else if (v === "--dry-run") args.dryRun = true;
  }
  return args;
}

function extractAccountId(endpoint: string): string {
  const m = endpoint.match(/https?:\/\/([a-f0-9]{32})\.r2\.cloudflarestorage\.com/i);
  if (!m) throw new Error(`Cannot extract account_id from MINIO_ENDPOINT=${endpoint}`);
  return m[1];
}

async function enableManagedDomain(
  accountId: string,
  token: string,
  bucket: string,
): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/domains/managed`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled: true }),
  });
  const json: any = await res.json();
  if (!res.ok || !json.success) {
    const err = json.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(err);
  }
  const domain: string = json.result?.domain;
  if (!domain) throw new Error("API returned no domain");
  return `https://${domain}`;
}

async function main() {
  const args = parseArgs();
  const endpoint = process.env.MINIO_ENDPOINT;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!endpoint) throw new Error("MINIO_ENDPOINT is not set");
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set");

  const accountId = extractAccountId(endpoint);
  console.log(`[r2] Account ID: ${accountId}`);
  console.log(`[r2] Mode: ${args.dryRun ? "DRY RUN" : "LIVE"}\n`);

  const mongoUri =
    process.env.MONGODB_URL ||
    `mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true`;

  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  const col = mongo.db().collection("tenant");
  const tenants = await col
    .find(args.tenant ? { slug: args.tenant } : {})
    .toArray();

  if (tenants.length === 0) {
    console.error("No tenants found");
    await mongo.close();
    process.exit(1);
  }

  for (const t of tenants) {
    if (!t.media) {
      console.log(`SKIP ${t.slug} — no media config`);
      continue;
    }
    console.log(`=== ${t.slug} ===`);

    const updates: Record<string, string> = {};
    const tasks: Array<{ key: string; bucket: string; field: string }> = [
      { key: "main", bucket: t.media.bucket, field: "public_url" },
      { key: "cv", bucket: t.media.cv_bucket, field: "cv_public_url" },
      { key: "compress", bucket: t.media.compress_bucket, field: "compress_public_url" },
    ];

    for (const task of tasks) {
      if (!task.bucket) {
        console.log(`  - ${task.key}: (no bucket configured)`);
        continue;
      }
      try {
        const publicUrl = await enableManagedDomain(accountId, token, task.bucket);
        console.log(`  ✓ ${task.key.padEnd(8)} ${task.bucket.padEnd(35)} → ${publicUrl}`);
        updates[`media.${task.field}`] = publicUrl;
      } catch (e: any) {
        console.error(`  ✗ ${task.key.padEnd(8)} ${task.bucket.padEnd(35)} — ${e.message}`);
      }
    }

    if (!args.dryRun && Object.keys(updates).length > 0) {
      await col.updateOne({ _id: t._id }, { $set: updates });
      console.log(`  → DB updated with ${Object.keys(updates).length} URLs`);
    }
    console.log("");
  }

  await mongo.close();
  console.log(`Done. ${tenants.length} tenant(s) processed.`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
