/**
 * Normalize parent_id / parent_id_obj after seed (seed POST bypasses the
 * parent plugin so parent_id_obj ends up as a string instead of ObjectId).
 *
 * Convention (matches core_v2 parent.plugin.ts):
 *   - has parent  → parent_id: [<idStr>], parent_id_obj: ObjectId(idStr), is_root: false
 *   - no parent   → parent_id: [],        parent_id_obj: null,            is_root: true
 *
 * Usage:
 *   npx tsx scripts/fix-parent-id-obj.ts --tenant vang-thien-long --dry-run
 *   npx tsx scripts/fix-parent-id-obj.ts --tenant vang-thien-long
 *   npx tsx scripts/fix-parent-id-obj.ts --tenant vang-thien-long --collections category,post-type-content
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

const PROD_BASE = 'https://ve-tinh-all-new.mangoads.com.vn/api/v1';
const PROD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc5MDk1MjYyLCJleHAiOjE3NzkxMjQwNjJ9.v2Md9zP8SYUVSrHXw6ShpmDJQ6bppM8FnBuPBf-jG0A';
const TENANT_ID = '69eada499e0eb6435ce0bda7';

interface Args { tenant?: string; dryRun: boolean; collections: string[]; }
function parseArgs(): Args {
  const a: Args = { dryRun: false, collections: ['category'] };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--tenant') a.tenant = process.argv[++i];
    else if (v === '--collections') a.collections = process.argv[++i].split(',').map((s) => s.trim());
  }
  return a;
}

/** prod category _id → slug (across all post types). For parent remap. */
async function buildProdIdToSlug(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const pt of ['tin-tuc', 'san-pham', 'chinh-sach']) {
    const res = await fetch(`${PROD_BASE}/category?limit=500&post_type=${pt}&locale=vi&select=*`, {
      headers: { Authorization: `Bearer ${PROD_TOKEN}`, 'X-Tenant-ID': TENANT_ID, Accept: 'application/json' },
    });
    if (!res.ok) { console.warn(`  prod category?post_type=${pt} → ${res.status} (skip remap)`); continue; }
    const j: any = await res.json();
    for (const c of (j.data || [])) if (c?._id && c?.slug) map.set(String(c._id), c.slug);
  }
  return map;
}

function firstId(pid: any): string | null {
  if (!pid) return null;
  if (Array.isArray(pid)) return pid.length > 0 ? String(pid[0]) : null;
  if (typeof pid === 'string') return pid || null;
  return String(pid);
}

async function main() {
  const args = parseArgs();
  if (!args.tenant) { console.error('Usage: --tenant <slug> [--dry-run] [--collections a,b]'); process.exit(1); }
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'} | tenant: ${args.tenant} | collections: ${args.collections.join(',')}\n`);

  const m = new MongoClient(MAIN_URI);
  await m.connect();
  const tenant = await m.db().collection('tenant').findOne({ slug: args.tenant });
  if (!tenant) { console.error('Tenant not found'); await m.close(); process.exit(1); }

  const tc = new MongoClient(tenant.database.uri);
  await tc.connect();
  const tdb = tc.db();

  // Build prod_id → slug, then slug → local _id, so a parent_id pointing at
  // a (dead) prod _id can be remapped to the local _id of the same slug.
  const prodIdToSlug = await buildProdIdToSlug();
  console.log(`  prod id→slug map: ${prodIdToSlug.size}\n`);

  for (const coll of args.collections) {
    const recs = await tdb.collection(coll).find({}).project({ _id: 1, slug: 1, parent_id: 1, parent_id_obj: 1, is_root: 1 }).toArray();
    const slugToLocalId = new Map<string, string>();
    for (const r of recs) if (r.slug) slugToLocalId.set(r.slug, String(r._id));
    let fixedParent = 0, fixedRoot = 0, remapped = 0, dangling = 0, ok = 0;

    for (const r of recs) {
      let idStr = firstId(r.parent_id);

      // Remap dead prod parent _id → local _id via slug
      if (idStr) {
        const existsLocally = recs.some((x) => String(x._id) === idStr);
        if (!existsLocally) {
          const slug = prodIdToSlug.get(idStr);
          const localId = slug ? slugToLocalId.get(slug) : undefined;
          if (localId) { idStr = localId; remapped++; }
          else dangling++;
        }
      }

      let target: any;
      let needs = false;

      if (idStr && ObjectId.isValid(idStr)) {
        const wantObj = !(r.parent_id_obj instanceof ObjectId) || String(r.parent_id_obj) !== idStr;
        const wantArr = !(Array.isArray(r.parent_id) && r.parent_id.length === 1 && String(r.parent_id[0]) === idStr);
        const wantRoot = r.is_root !== false;
        if (wantObj || wantArr || wantRoot) {
          target = { parent_id: [idStr], parent_id_obj: new ObjectId(idStr), is_root: false };
          needs = true;
          fixedParent++;
        }
      } else {
        const wantArr = !(Array.isArray(r.parent_id) && r.parent_id.length === 0);
        const wantNull = r.parent_id_obj !== null;
        const wantRoot = r.is_root !== true;
        if (wantArr || wantNull || wantRoot) {
          target = { parent_id: [], parent_id_obj: null, is_root: true };
          needs = true;
          fixedRoot++;
        }
      }

      if (needs) {
        if (!args.dryRun) await tdb.collection(coll).updateOne({ _id: r._id }, { $set: target });
      } else {
        ok++;
      }
    }
    console.log(`  ${coll.padEnd(22)} fixedParent=${fixedParent} fixedRoot=${fixedRoot} remapped=${remapped} dangling=${dangling} alreadyOK=${ok} total=${recs.length}`);
  }

  await tc.close();
  await m.close();
  console.log('\nDone.');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
