/**
 * Remap `category` references in post-type-content records from production _ids
 * to local _ids. v2's POST endpoint generated new _ids during seed, so existing
 * records (tin-tuc, san-pham, chinh-sach, page) still point at production IDs.
 *
 * Strategy:
 *   1. Fetch all categories from production → map prod_id → slug
 *   2. Build local map slug → local_id (same tenant DB)
 *   3. Combine → prod_id → local_id
 *   4. Walk every record with `category` field and rewrite to local_id
 *
 * Usage:
 *   npx tsx scripts/remap-category-ids.ts --tenant vang-thien-long --dry-run
 *   npx tsx scripts/remap-category-ids.ts --tenant vang-thien-long
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const PROD_BASE = 'https://ve-tinh-all-new.mangoads.com.vn/api/v1';
const PROD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc5MDk1MjYyLCJleHAiOjE3NzkxMjQwNjJ9.v2Md9zP8SYUVSrHXw6ShpmDJQ6bppM8FnBuPBf-jG0A';
const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

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

async function fetchProdCategories(tenantId: string): Promise<Array<{ _id: string; slug: string; post_type?: string }>> {
  // Pull all category records, all post types
  const out: any[] = [];
  for (const pt of ['tin-tuc', 'san-pham', 'chinh-sach']) {
    const res = await fetch(`${PROD_BASE}/category?limit=500&post_type=${pt}&locale=vi`, {
      headers: { Authorization: `Bearer ${PROD_TOKEN}`, 'X-Tenant-ID': tenantId, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`PROD category?post_type=${pt} → ${res.status}`);
    const json: any = await res.json();
    out.push(...(json.data || []));
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.tenant) { console.error('Required: --tenant'); process.exit(1); }
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'} | tenant: ${args.tenant}\n`);

  const m = new MongoClient(MAIN_URI);
  await m.connect();
  const tenant = await m.db().collection('tenant').findOne({ slug: args.tenant });
  if (!tenant) { console.error('Tenant not found'); await m.close(); process.exit(1); }
  const tenantId = String(tenant._id);

  // 1. prod categories: map prod_id → slug
  console.log('=== Step 1: fetch production categories ===');
  const prodCats = await fetchProdCategories(tenantId);
  const prodIdToSlug = new Map<string, string>();
  for (const c of prodCats) prodIdToSlug.set(String(c._id), c.slug);
  console.log(`  ${prodCats.length} production categories`);

  // 2. local categories: map slug → local_id
  const tc = new MongoClient(tenant.database.uri);
  await tc.connect();
  const tdb = tc.db();
  const localCats = await tdb.collection('category').find({}).project({ _id: 1, slug: 1 }).toArray();
  const slugToLocalId = new Map<string, string>();
  for (const c of localCats) slugToLocalId.set(c.slug, String(c._id));
  console.log(`  ${localCats.length} local categories\n`);

  // 3. Combine maps
  const prodToLocal = new Map<string, string>();
  let dangling = 0;
  for (const [prodId, slug] of prodIdToSlug) {
    const localId = slugToLocalId.get(slug);
    if (localId) prodToLocal.set(prodId, localId);
    else dangling++;
  }
  console.log(`=== Step 2: built remap (prod_id → local_id): ${prodToLocal.size} entries, ${dangling} prod slugs without local match ===\n`);

  // 4. Walk records that have `category` and rewrite
  console.log('=== Step 3: rewrite records ===');
  const colls = ['post-type-content', 'page'];
  for (const cn of colls) {
    const recs = await tdb.collection(cn).find({ category: { $exists: true, $ne: null } }).toArray();
    let fixed = 0;
    let unchanged = 0;
    for (const r of recs) {
      const cat = r.category;
      if (!cat) continue;
      let newCat: any;
      let touched = false;
      if (Array.isArray(cat)) {
        newCat = cat.map((id: any) => {
          const sid = String(id);
          const local = prodToLocal.get(sid);
          if (local && local !== sid) { touched = true; return local; }
          return sid;
        });
      } else if (typeof cat === 'string') {
        const local = prodToLocal.get(cat);
        if (local && local !== cat) { touched = true; newCat = local; }
      }
      if (touched) {
        if (!args.dryRun) await tdb.collection(cn).updateOne({ _id: r._id }, { $set: { category: newCat } });
        fixed++;
      } else {
        unchanged++;
      }
    }
    console.log(`  ${cn.padEnd(22)} fixed=${fixed} unchanged=${unchanged} total=${recs.length}`);
  }

  await tc.close();
  await m.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
