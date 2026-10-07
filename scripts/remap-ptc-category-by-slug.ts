/**
 * Rebuild post-type-content.category from PROD as source of truth.
 *
 * Why: every category re-seed regenerates local category _ids, so any id
 * stored in ptc.category (prod id OR a previous-gen local id) goes stale.
 * Deterministic fix = join by slug:
 *   prod ptc (by ptc.slug) → prod category _id → prod category slug
 *     → current local category _id
 *
 * Usage:
 *   npx tsx scripts/remap-ptc-category-by-slug.ts --tenant vang-thien-long --dry-run
 *   npx tsx scripts/remap-ptc-category-by-slug.ts --tenant vang-thien-long
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

const PROD_BASE = 'https://ve-tinh-all-new.mangoads.com.vn/api/v1';
const PROD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc5MDk1MjYyLCJleHAiOjE3NzkxMjQwNjJ9.v2Md9zP8SYUVSrHXw6ShpmDJQ6bppM8FnBuPBf-jG0A';
const TENANT_ID = '69eada499e0eb6435ce0bda7';
const POST_TYPES = ['tin-tuc', 'san-pham', 'chinh-sach'];

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

async function prodGet(path: string): Promise<any[]> {
  const res = await fetch(`${PROD_BASE}${path}`, {
    headers: { Authorization: `Bearer ${PROD_TOKEN}`, 'X-Tenant-ID': TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`PROD ${path} → ${res.status}`);
  const j: any = await res.json();
  return j?.data ?? [];
}

async function main() {
  const args = parseArgs();
  if (!args.tenant) { console.error('Usage: --tenant <slug> [--dry-run]'); process.exit(1); }
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'} | tenant: ${args.tenant}\n`);

  const m = new MongoClient(MAIN_URI);
  await m.connect();
  const tenant = await m.db().collection('tenant').findOne({ slug: args.tenant });
  if (!tenant) { console.error('Tenant not found'); await m.close(); process.exit(1); }

  // 1. prod category _id → slug
  const prodCatIdToSlug = new Map<string, string>();
  for (const pt of POST_TYPES) {
    for (const c of await prodGet(`/category?limit=500&post_type=${pt}&locale=vi&select=*`)) {
      if (c?._id && c?.slug) prodCatIdToSlug.set(String(c._id), c.slug);
    }
  }
  console.log(`prod category id→slug: ${prodCatIdToSlug.size}`);

  // 2. current local category slug → _id
  const tc = new MongoClient(tenant.database.uri);
  await tc.connect();
  const tdb = tc.db();
  const localCats = await tdb.collection('category').find({}).project({ _id: 1, slug: 1 }).toArray();
  const slugToLocalCatId = new Map<string, string>();
  for (const c of localCats) if (c.slug) slugToLocalCatId.set(c.slug, String(c._id));
  console.log(`local category slug→id: ${slugToLocalCatId.size}`);

  // 3. prod ptc slug → [local category _id...]
  const ptcSlugToLocalCats = new Map<string, string[]>();
  let prodPtc = 0;
  for (const pt of POST_TYPES) {
    for (const p of await prodGet(`/post-type-content?limit=500&post_type=${pt}&locale=vi&select=*`)) {
      if (!p?.slug) continue;
      prodPtc++;
      const prodCats = Array.isArray(p.category) ? p.category : (p.category ? [p.category] : []);
      const localIds: string[] = [];
      for (const pcId of prodCats) {
        const slug = prodCatIdToSlug.get(String(pcId));
        const localId = slug ? slugToLocalCatId.get(slug) : undefined;
        if (localId) localIds.push(localId);
      }
      if (localIds.length > 0) ptcSlugToLocalCats.set(p.slug, localIds);
    }
  }
  console.log(`prod ptc fetched: ${prodPtc}, with resolvable category: ${ptcSlugToLocalCats.size}\n`);

  // 4. rewrite local ptc.category by slug
  const recs = await tdb.collection('post-type-content').find({}).project({ _id: 1, slug: 1, category: 1 }).toArray();
  let fixed = 0, same = 0, noMatch = 0;
  for (const r of recs) {
    const want = ptcSlugToLocalCats.get(r.slug);
    if (!want) { noMatch++; continue; }
    const cur = Array.isArray(r.category) ? r.category.map(String) : (r.category ? [String(r.category)] : []);
    if (JSON.stringify(cur) === JSON.stringify(want)) { same++; continue; }
    if (!args.dryRun) {
      await tdb.collection('post-type-content').updateOne({ _id: r._id }, { $set: { category: want } });
    }
    fixed++;
  }
  console.log(`post-type-content: fixed=${fixed} alreadySame=${same} noProdMatch=${noMatch} total=${recs.length}`);

  await tc.close();
  await m.close();
  console.log('\nDone.');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
