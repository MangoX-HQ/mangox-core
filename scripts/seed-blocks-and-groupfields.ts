/**
 * Pull block-content + group-field from ve-tinh-all-new production into local
 * tenant DB, driven by the existing page `blocks_position` references.
 *
 * Walk:
 *   1. Local pages → unique block-content IDs (from `blocks_position`)
 *   2. Fetch each block-content from production → distinct `groupfield_id`s
 *   3. Fetch each group-field from production
 *   4. Insert both sets into local tenant DB (preserves `_id` so refs stay intact).
 *
 * Usage:
 *   npx tsx scripts/seed-blocks-and-groupfields.ts --tenant vang-thien-long --dry-run
 *   npx tsx scripts/seed-blocks-and-groupfields.ts --tenant vang-thien-long
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const PROD_BASE = 'https://ve-tinh-all-new.mangoads.com.vn/api/v1';
const PROD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc4NTU0NzY1LCJleHAiOjE3Nzg1ODM1NjV9.D-Fx8ng4qX85PeytlwwNS0XaUC6frQEEVvNNb3ImxH0';
const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

interface Args { tenant?: string; dryRun: boolean; }

function parseArgs(): Args {
  const args: Args = { dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === '--dry-run') args.dryRun = true;
    else if (v === '--tenant') args.tenant = process.argv[++i];
  }
  return args;
}

async function fetchProd(path: string, tenantId: string): Promise<any[]> {
  const res = await fetch(`${PROD_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${PROD_TOKEN}`,
      'X-Tenant-ID': tenantId,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`PROD ${path} → ${res.status} ${await res.text().catch(() => '')}`);
  const json: any = await res.json();
  return Array.isArray(json) ? json : json?.data ?? [];
}

/** Strip populated relation objects back to ID strings. Same heuristic as seed-vetinh-content. */
function isPopulatedRelation(v: any): boolean {
  return v && typeof v === 'object' && typeof v._id === 'string' && 'created_at' in v && 'tenant_id' in v;
}
function flattenRelations(o: any): any {
  if (Array.isArray(o)) return o.map((i) => (isPopulatedRelation(i) ? i._id : flattenRelations(i)));
  if (o && typeof o === 'object' && !(o instanceof Date)) {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) out[k] = isPopulatedRelation(v) ? (v as any)._id : flattenRelations(v);
    return out;
  }
  return o;
}

const ADMIN_USER_ID = '68bff24bea9a0fc2edb3164e';

/** Convert string _id to ObjectId so duplicates merge on insertOne.
 *  Re-attribute audit fields to local admin (prod user_tenant._ids would dangle). */
function withObjectId(rec: any): any {
  const clean = flattenRelations({ ...rec });
  const now = new Date();
  clean.created_at = clean.created_at ? new Date(clean.created_at) : now;
  clean.updated_at = clean.updated_at ? new Date(clean.updated_at) : now;
  clean.created_by = ADMIN_USER_ID;
  clean.updated_by = ADMIN_USER_ID;
  if (typeof clean._id === 'string') {
    try { clean._id = new ObjectId(clean._id); } catch {}
  }
  return clean;
}

async function bulkUpsert(coll: any, records: any[], collectionName: string, dryRun: boolean): Promise<number> {
  if (records.length === 0) return 0;
  if (dryRun) return records.length;
  let n = 0;
  for (const r of records) {
    const clean = withObjectId(r);
    // v2 always tags the polymorphic discriminator on every record so list/read
    // can filter by logical entity. Direct-insert paths must add it manually
    // since they bypass core-service.create().
    clean.collection_name = collectionName;
    await coll.replaceOne({ _id: clean._id }, clean, { upsert: true });
    n++;
  }
  return n;
}

async function main() {
  const args = parseArgs();
  if (!args.tenant) { console.error('Required: --tenant'); process.exit(1); }

  const m = new MongoClient(MAIN_URI);
  await m.connect();
  const tenant = await m.db().collection('tenant').findOne({ slug: args.tenant });
  if (!tenant) { console.error(`Tenant '${args.tenant}' not found`); await m.close(); process.exit(1); }
  const tenantId = String(tenant._id);
  console.log(`Tenant: ${tenant.slug} (_id=${tenantId})`);
  console.log(`Mode:   ${args.dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  const tenantClient = new MongoClient(tenant.database.uri);
  await tenantClient.connect();
  const tdb = tenantClient.db();

  // 1. Collect block-content IDs from local pages
  console.log('=== Step 1: collect block IDs from local pages ===');
  const pages = await tdb.collection('page').find({}).project({ blocks_position: 1, title: 1 }).toArray();
  const blockIds = new Set<string>();
  for (const p of pages) {
    for (const id of (p.blocks_position || [])) blockIds.add(String(id));
  }
  console.log(`  ${pages.length} pages → ${blockIds.size} unique block-content IDs`);

  // 2. Fetch block-content from prod (batch by 50 ids)
  console.log('\n=== Step 2: fetch block-content from prod ===');
  const blockArr = Array.from(blockIds);
  const blocks: any[] = [];
  const BATCH = 50;
  for (let i = 0; i < blockArr.length; i += BATCH) {
    const batch = blockArr.slice(i, i + BATCH);
    const list = `[${batch.join(',')}]`;
    const url = `/block-content?_id=in.${encodeURIComponent(list)}&limit=${BATCH}`;
    const got = await fetchProd(url, tenantId);
    blocks.push(...got);
    console.log(`  batch ${i / BATCH + 1}: requested ${batch.length}, got ${got.length}`);
  }
  console.log(`  total fetched: ${blocks.length}/${blockIds.size}`);

  // 3. Extract distinct groupfield_id
  const groupIds = new Set<string>();
  for (const b of blocks) {
    if (b.groupfield_id) groupIds.add(String(b.groupfield_id));
  }
  console.log(`  distinct groupfield_id: ${groupIds.size}`);

  // 4. Fetch group-field from prod
  console.log('\n=== Step 3: fetch group-field from prod ===');
  const groupArr = Array.from(groupIds);
  const groups: any[] = [];
  for (let i = 0; i < groupArr.length; i += BATCH) {
    const batch = groupArr.slice(i, i + BATCH);
    const list = `[${batch.join(',')}]`;
    const url = `/group-field?_id=in.${encodeURIComponent(list)}&limit=${BATCH}`;
    const got = await fetchProd(url, tenantId);
    groups.push(...got);
    console.log(`  batch ${i / BATCH + 1}: requested ${batch.length}, got ${got.length}`);
  }
  console.log(`  total fetched: ${groups.length}/${groupIds.size}`);

  // 5. Insert into tenant DB (upsert by _id, preserve refs)
  console.log('\n=== Step 4: insert into tenant DB ===');
  const blockN = await bulkUpsert(tdb.collection('block-content'), blocks, 'block-content', args.dryRun);
  console.log(`  block-content: ${blockN} ${args.dryRun ? 'would upsert' : 'upserted'}`);
  const groupN = await bulkUpsert(tdb.collection('group-field'), groups, 'group-field', args.dryRun);
  console.log(`  group-field:   ${groupN} ${args.dryRun ? 'would upsert' : 'upserted'}`);

  await tenantClient.close();
  await m.close();
  console.log('\nDone.');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
