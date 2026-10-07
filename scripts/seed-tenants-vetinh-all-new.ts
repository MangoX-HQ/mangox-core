/**
 * Seed 4 tenants from ve-tinh-all-new.mangoads.com.vn into local main MongoDB.
 *
 * For each tenant, inserts/upserts a `tenant` collection record with:
 *   database: {
 *     uri:  mongodb://thaily:Th%40i2004@localhost:10000/<slug>?authSource=admin&replicaSet=rs0&directConnection=true
 *     name: <slug>
 *     type: 'mongodb'
 *   }
 *
 * Entities for each tenant are written separately to backend/json/<slug>/entity/*.json.
 *
 * Usage:
 *   npx tsx scripts/seed-tenants-vetinh-all-new.ts          # upsert all 4
 *   npx tsx scripts/seed-tenants-vetinh-all-new.ts --drop   # drop existing tenant collection first
 *   MONGODB_URL=... npx tsx scripts/seed-tenants-vetinh-all-new.ts
 */

import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const MAIN_DB_NAME = "mangoads";
const TARGET_HOST = "mongodb://thaily:Th%40i2004@localhost:10000";
const TARGET_QS = "authSource=admin&replicaSet=rs0&directConnection=true";

const TENANTS = [
  {
    _id: "6a01c2d9bfde3dfb3ca1d910",
    slug: "aurelia",
    title: "Aurelia",
    domain: "aurelia-time.com",
    status: "1",
    type_site: "Thương mại điện tử",
    description:
      "Maison đồng hồ cơ khí cao cấp lấy cảm hứng từ truyền thống chế tác đồng hồ Thụy Sĩ",
  },
  {
    _id: "69fc4b15bfde3dfb3ca1c4ca",
    slug: "furnio",
    title: "Furnio",
    domain: "furnio.vn",
    status: "1",
    type_site: "Nội thất",
    description: "Showroom nội thất cao cấp online",
  },
  {
    _id: "69f861ad85bd47d07dbcc51c",
    slug: "asymora-studio",
    title: "Asymora Studio",
    domain: "asymora.studio",
    status: "1",
    type_site: "Portfolio",
    description: "Creative studio cao cấp, showcase portfolio dự án",
  },
  {
    _id: "69eada499e0eb6435ce0bda7",
    slug: "vang-thien-long",
    title: "Vàng Thiên Long",
    domain: "vang-thienlong.vn",
    status: "1",
    type_site: "Tài chính",
    description:
      "Thương hiệu vàng miếng, trang sức vàng cao cấp + giá vàng real-time",
  },
];

function targetUri(slug: string): string {
  return `${TARGET_HOST}/${encodeURIComponent(slug)}?${TARGET_QS}`;
}

function mainUri(): string {
  return (
    process.env.MONGODB_URL ||
    `${TARGET_HOST}/${MAIN_DB_NAME}?${TARGET_QS}`
  );
}

async function main() {
  const drop = process.argv.includes("--drop");
  const uri = mainUri();
  console.log(`[seed] Connecting to main DB: ${uri.replace(/Th%40i2004/, "***")}`);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const col = db.collection("tenant");

  if (drop) {
    console.log(`[seed] --drop flag set, dropping 'tenant' collection`);
    await col.drop().catch(() => {});
  }

  const now = new Date();
  for (const t of TENANTS) {
    const doc = {
      _id: new ObjectId(t._id),
      slug: t.slug,
      title: t.title,
      domain: t.domain,
      status: t.status,
      type_site: t.type_site,
      description: t.description,
      database: {
        uri: targetUri(t.slug),
        name: t.slug,
        type: "mongodb",
      },
      media: {
        bucket: t.slug,
        cv_bucket: `${t.slug}-cv`,
        compress_bucket: `${t.slug}-compress`,
        // public URLs are populated by scripts/enable-r2-public-access.ts
        // after R2 buckets are created (r2.dev managed domain per bucket).
        public_url: "",
        cv_public_url: "",
        compress_public_url: "",
      },
      created_at: now,
      updated_at: now,
    } as any;

    const result = await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
    console.log(
      `[seed] ${t.slug.padEnd(20)} _id=${t._id} upserted=${result.upsertedCount} modified=${result.modifiedCount}`,
    );
  }

  console.log(`\n[seed] Done. ${TENANTS.length} tenants registered.`);
  console.log(`[seed] Entities for each tenant are in backend/json/<slug>/entity/`);
  console.log(`[seed] Restart server (or flush Redis schema cache) to load entities.`);

  await client.close();
}

main().catch((err) => {
  console.error("[seed] FAILED:", err);
  process.exit(1);
});
