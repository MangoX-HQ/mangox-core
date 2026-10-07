/**
 * Fix `category.post_type` field:
 *   - Local seeded data has prod entity ObjectId (e.g. '69eadda49e0eb6435ce0c004')
 *   - Prod stores slug ('chinh-sach', 'san-pham', 'tin-tuc')
 * Remap prod _id → slug.
 *
 * Also: delete test records (aaa, cccc, ddd); insert missing vang-mieng-9999.
 *
 * Usage:
 *   npx tsx scripts/fix-category-post-type.ts --tenant vang-thien-long --dry-run
 *   npx tsx scripts/fix-category-post-type.ts --tenant vang-thien-long
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

const PROD_BASE = 'https://ve-tinh-all-new.mangoads.com.vn/api/v1';
const PROD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc4ODM3NDQ5LCJleHAiOjE3Nzg4NjYyNDl9.wfxcwCgNQY9Ht4eJX72ar2EkfQRGXQIqv-S2m7tq49A';

// prod entity _id → slug (taken from the diff against prod /api/v1/category?select=*)
const ID_TO_SLUG: Record<string, string> = {
  '69eadda49e0eb6435ce0c004': 'chinh-sach',
  '69eadda49e0eb6435ce0c006': 'san-pham',
  '69eadda59e0eb6435ce0c008': 'tin-tuc',
};

// Fallback mapping (from prior prod fetch of vang-thien-long categories).
// Used when prod cache missing AND prod API token expired.
const PROD_SLUG_TO_POST_TYPE_FALLBACK: Record<string, string[]> = {
  'bao-hanh': ['chinh-sach'],
  'bao-mat': ['chinh-sach'],
  'bong-tai': ['san-pham'],
  'day-chuyen': ['san-pham'],
  'dieu-khoan': ['chinh-sach'],
  'doi-tra': ['chinh-sach'],
  'gia-vang': ['tin-tuc'],
  'kien-thuc-dau-tu': ['tin-tuc'],
  'kim-cuong-dau-tu': ['san-pham'],
  'lac-tay': ['san-pham'],
  'mat-day-chuyen': ['san-pham'],
  'nhan': ['san-pham'],
  'phan-tich-thi-truong': ['tin-tuc'],
  'qua-tang-cuoi-hoi': ['san-pham'],
  'thanh-toan': ['chinh-sach'],
  'tin-thuong-hieu': ['tin-tuc'],
  'trang-suc-vang': ['san-pham'],
  'van-chuyen': ['chinh-sach'],
  'vang-dau-tu': ['san-pham'],
  'vang-mieng': ['san-pham'],
  'vang-mieng-1-chi': ['san-pham'],
  'vang-mieng-1-luong': ['san-pham'],
  'vang-mieng-24k': ['san-pham'],
  'vang-mieng-9999': ['san-pham'],
  'vang-mieng-sjc': ['san-pham'],
  'vang-nhan-tron-tron': ['san-pham'],
  'vong-co': ['san-pham'],
  'xu-huong-trang-suc': ['tin-tuc'],
};

async function fetchProdSlugToPostType(tenantId: string): Promise<Map<string, string[]>> {
  // 1. Try cached snapshot (avoids token expiry)
  const cacheFp = '/tmp/prod_category_raw.json';
  try {
    if (require('fs').existsSync(cacheFp)) {
      const raw = JSON.parse(require('fs').readFileSync(cacheFp, 'utf-8'));
      const map = new Map<string, string[]>();
      for (const c of (raw?.data || [])) {
        if (c?.slug && Array.isArray(c.post_type)) map.set(c.slug, c.post_type);
      }
      if (map.size > 0) return map;
    }
  } catch {}
  // 2. Try live prod (if token still works)
  try {
    const res = await fetch(`${PROD_BASE}/category?limit=200&select=*`, {
      headers: { Authorization: `Bearer ${PROD_TOKEN}`, 'X-Tenant-ID': tenantId, Accept: 'application/json' },
    });
    if (res.ok) {
      const raw: any = await res.json();
      const map = new Map<string, string[]>();
      for (const c of (raw?.data || [])) {
        if (c?.slug && Array.isArray(c.post_type)) map.set(c.slug, c.post_type);
      }
      if (map.size > 0) return map;
    }
  } catch {}
  // 3. Fallback hardcoded mapping
  console.log('  (using fallback hardcoded prod mapping — prod API token expired)');
  return new Map(Object.entries(PROD_SLUG_TO_POST_TYPE_FALLBACK));
}
const TEST_SLUGS = ['aaa', 'cccc', 'ddd'];
const ADMIN_USER_ID = '68bff24bea9a0fc2edb3164e';

const VANG_MIENG_9999_PARENT_SLUG = 'vang-mieng'; // parent in prod is 69eadda59e0eb6435ce0c00c → vang-mieng

interface Args { tenant?: string; dryRun: boolean; }
function parseArgs(): Args {
  const a: Args = { dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--tenant') a.tenant = process.argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs();
  if (!args.tenant) { console.error('Usage: --tenant <slug> [--dry-run]'); process.exit(1); }
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'} | tenant: ${args.tenant}\n`);

  const m = new MongoClient(MAIN_URI);
  await m.connect();
  const tenant = await m.db().collection('tenant').findOne({ slug: args.tenant });
  if (!tenant) { console.error('Tenant not found'); await m.close(); process.exit(1); }
  const tenantId = String(tenant._id);

  const tc = new MongoClient(tenant.database.uri);
  await tc.connect();
  const tdb = tc.db();

  // 1. Remap post_type — handles 3 cases:
  //    (a) ObjectId entries → map via ID_TO_SLUG
  //    (b) null/missing → look up prod by slug
  //    (c) already a clean slug → leave alone
  console.log('=== Step 1: remap category.post_type ===');
  const prodSlugToPt = await fetchProdSlugToPostType(tenantId);
  console.log(`  prod slug→post_type map: ${prodSlugToPt.size}`);
  const cats = await tdb.collection('category').find({}).toArray();
  let remapped = 0;
  let restoredFromProd = 0;
  let alreadyOK = 0;
  let noProdMatch = 0;
  for (const c of cats) {
    let pt = c.post_type;
    let newPt: any = null;
    let reason = '';

    if (Array.isArray(pt) && pt.length > 0) {
      newPt = pt.map((v: any) => ID_TO_SLUG[String(v)] ?? v);
      if (JSON.stringify(newPt) === JSON.stringify(pt)) {
        alreadyOK++;
        continue;
      }
      reason = 'remap-id';
    } else {
      const prodPt = prodSlugToPt.get(c.slug);
      if (prodPt && prodPt.length > 0) {
        newPt = prodPt;
        reason = 'restore-from-prod';
      } else {
        noProdMatch++;
        continue;
      }
    }

    if (!args.dryRun) {
      await tdb.collection('category').updateOne({ _id: c._id }, { $set: { post_type: newPt } });
    }
    if (reason === 'restore-from-prod') restoredFromProd++;
    else remapped++;
    console.log(`  ${c.slug.padEnd(28)} ${JSON.stringify(pt)} → ${JSON.stringify(newPt)}  [${reason}]`);
  }
  console.log(`  remapped=${remapped}  restoredFromProd=${restoredFromProd}  alreadyOK=${alreadyOK}  noProdMatch=${noProdMatch}\n`);

  // 2. Delete test records
  console.log('=== Step 2: delete test records ===');
  for (const slug of TEST_SLUGS) {
    const rec = await tdb.collection('category').findOne({ slug });
    if (!rec) { console.log(`  ${slug}: not present`); continue; }
    if (!args.dryRun) {
      await tdb.collection('category').deleteOne({ _id: rec._id });
      await tdb.collection('seopath').deleteMany({ related_id: { $in: [String(rec._id), rec._id] } }).catch(() => {});
    }
    console.log(`  deleted ${slug} (${rec._id})`);
  }
  console.log();

  // 3. Insert vang-mieng-9999 if missing
  console.log('=== Step 3: insert vang-mieng-9999 ===');
  const existing = await tdb.collection('category').findOne({ slug: 'vang-mieng-9999' });
  if (existing) {
    console.log('  already exists, skip');
  } else {
    const parent = await tdb.collection('category').findOne({ slug: VANG_MIENG_9999_PARENT_SLUG });
    const now = new Date();
    const doc: any = {
      is_root: false,
      title: 'Vàng miếng 9999',
      slug: 'vang-mieng-9999',
      parent_id: parent ? String(parent._id) : null,
      parent_id_obj: parent ? parent._id : null,
      post_type: ['san-pham'],
      locale: 'vi',
      languages: ['vi'],
      status: '1',
      tenant_id: tenantId,
      collection_name: 'category',
      created_by: ADMIN_USER_ID,
      updated_by: ADMIN_USER_ID,
      created_at: now,
      updated_at: now,
    };
    if (!args.dryRun) {
      const res = await tdb.collection('category').insertOne(doc);
      doc._id = res.insertedId;
      await tdb.collection('category').updateOne({ _id: res.insertedId }, { $set: { locale_id: String(res.insertedId) } });
    }
    console.log(`  inserted vang-mieng-9999 (parent=${parent?.slug ?? 'none'})`);
  }

  await tc.close();
  await m.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
