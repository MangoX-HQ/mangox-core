/**
 * Seed dependent entities for the page admin UI: templates, layout, menu,
 * tag-group, form-builder. Pulls entity definitions from production and
 * data via the reference chain rooted at local pages.
 *
 *   page.templates[]            → templates._id
 *   templates.header/footer/sidebar[]  → layout._id (populated objects)
 *   layout.data.menu (or similar) → menu._id
 *   tag-group, form-builder      → fetched flat (standalone collections)
 *
 * Steps:
 *   1. For each (templates, layout, menu, tag-group, form-builder):
 *        - Pull entity definition from prod /entity
 *        - Save json/<tenant>/entity/<name>.json × 4 tenants
 *        - Create json/<tenant>/resource/<name>.json   (is_tenant: true)
 *        - Create json/<tenant>/policy/<name>-admin.json
 *   2. Pull data via chain into target tenant DB (upsert by _id, set collection_name)
 *
 * Usage:
 *   npx tsx scripts/seed-page-deps.ts --tenant vang-thien-long --dry-run
 *   npx tsx scripts/seed-page-deps.ts --tenant vang-thien-long
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const PROD_BASE = 'https://ve-tinh-all-new.mangoads.com.vn/api/v1';
const PROD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc4NTU0NzY1LCJleHAiOjE3Nzg1ODM1NjV9.D-Fx8ng4qX85PeytlwwNS0XaUC6frQEEVvNNb3ImxH0';
const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

const ALL_TENANTS = ['aurelia', 'asymora-studio', 'furnio', 'vang-thien-long'];
const TARGET_ENTITIES = ['templates', 'layout', 'menu', 'tag-group', 'form-builder'];

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

async function fetchProd(path: string, tenantId: string): Promise<any[]> {
  const res = await fetch(`${PROD_BASE}${path}`, {
    headers: { Authorization: `Bearer ${PROD_TOKEN}`, 'X-Tenant-ID': tenantId, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`PROD ${path} → ${res.status}`);
  const json: any = await res.json();
  return Array.isArray(json) ? json : json?.data ?? [];
}

function isPopulatedRelation(v: any): boolean {
  return v && typeof v === 'object' && typeof v._id === 'string' && 'created_at' in v && 'tenant_id' in v;
}

/** Walk obj. For arrays of populated relations, record each `_id` into `collected` keyed by hint.
 *  Returns the same shape but with relation arrays/objects replaced by raw id strings. */
function flattenAndCollect(o: any, collected: Map<string, Set<string>>, hint?: string): any {
  if (Array.isArray(o)) {
    return o.map((i) => {
      if (isPopulatedRelation(i)) {
        if (hint) {
          if (!collected.has(hint)) collected.set(hint, new Set());
          collected.get(hint)!.add(i._id);
        }
        return i._id;
      }
      return flattenAndCollect(i, collected, hint);
    });
  }
  if (o && typeof o === 'object' && !(o instanceof Date)) {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      if (isPopulatedRelation(v)) {
        if (hint) {
          if (!collected.has(hint)) collected.set(hint, new Set());
          collected.get(hint)!.add((v as any)._id);
        }
        out[k] = (v as any)._id;
      } else {
        out[k] = flattenAndCollect(v, collected, hint);
      }
    }
    return out;
  }
  return o;
}

const ADMIN_USER_ID = '68bff24bea9a0fc2edb3164e';

function cleanForInsert(rec: any, collectionName: string): any {
  const collected = new Map<string, Set<string>>();
  const clean = flattenAndCollect({ ...rec }, collected);
  // Production audit fields point at prod user_tenant._ids (dangling locally).
  // Drop them and re-attribute to local admin user._id with current timestamps.
  const now = new Date();
  clean.created_at = clean.created_at ? new Date(clean.created_at) : now;
  clean.updated_at = clean.updated_at ? new Date(clean.updated_at) : now;
  clean.created_by = ADMIN_USER_ID;
  clean.updated_by = ADMIN_USER_ID;
  if (typeof clean._id === 'string') {
    try { clean._id = new ObjectId(clean._id); } catch {}
  }
  clean.collection_name = collectionName;
  return clean;
}

async function bulkUpsert(coll: any, records: any[], collectionName: string, dryRun: boolean): Promise<number> {
  if (records.length === 0 || dryRun) return records.length;
  let n = 0;
  for (const r of records) {
    const clean = cleanForInsert(r, collectionName);
    await coll.replaceOne({ _id: clean._id }, clean, { upsert: true });
    n++;
  }
  return n;
}

async function fetchByIds(name: string, ids: string[], tenantId: string): Promise<any[]> {
  if (ids.length === 0) return [];
  const out: any[] = [];
  const BATCH = 50;
  for (let i = 0; i < ids.length; i += BATCH) {
    const list = `[${ids.slice(i, i + BATCH).join(',')}]`;
    out.push(...(await fetchProd(`/${name}?_id=in.${encodeURIComponent(list)}&limit=${BATCH}`, tenantId)));
  }
  return out;
}

function writeJson(path: string, data: any) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

function makeResource(name: string) {
  return {
    title: name,
    slug: name,
    entity: [name],
    is_tenant: true,
    mongorest: '',
    action: ['list', 'read', 'create', 'update', 'delete'],
  };
}

function makePolicy(name: string) {
  return {
    title: `policy ${name} admin`,
    slug: `policy-${name}-admin`,
    resource: [name],
    action: ['list', 'read', 'delete', 'update', 'create'],
    role: ['admin'],
    root_entity: [name],
    condition: 'select=*,created_by(username,full_name),updated_by(username,full_name)',
    data: [],
    condition_context: null,
    condtion_body: '',
    code_context: '',
    code: '',
    piority: '0',
  };
}

async function ensureEntityFiles(name: string, anyTenantId: string, dryRun: boolean): Promise<void> {
  // Pull entity from prod and write JSON for every tenant (only entity differs by content).
  const entities = await fetchProd(`/entity?mongodb_collection_name=eq.%22${name}%22`, anyTenantId);
  if (entities.length === 0) {
    console.log(`  ⚠ entity '${name}' not found on production`);
    return;
  }
  const ent = entities[0];
  for (const k of ['_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'tenant_id']) delete ent[k];
  ent.databaseType = 'mongodb';
  ent.collection_name = name;
  ent.mongodb_save_data = name;

  for (const t of ALL_TENANTS) {
    const entityPath = `json/${t}/entity/${name}.json`;
    const resourcePath = `json/${t}/resource/${name}.json`;
    const policyPath = `json/${t}/policy/${name}-admin.json`;
    if (dryRun) {
      console.log(`  + would write ${entityPath}, ${resourcePath}, ${policyPath}`);
    } else {
      writeJson(entityPath, ent);
      writeJson(resourcePath, makeResource(name));
      writeJson(policyPath, makePolicy(name));
    }
  }
  if (!dryRun) console.log(`  ✓ entity/resource/policy written for ${ALL_TENANTS.length} tenants`);
}

async function main() {
  const args = parseArgs();
  if (!args.tenant) { console.error('Required: --tenant'); process.exit(1); }
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'} | tenant for data pull: ${args.tenant}\n`);

  const m = new MongoClient(MAIN_URI);
  await m.connect();
  const tenant = await m.db().collection('tenant').findOne({ slug: args.tenant });
  if (!tenant) { console.error('Tenant not found'); await m.close(); process.exit(1); }
  const tenantId = String(tenant._id);

  // === Step 1: entity + resource + policy for all 5 ===
  console.log('=== Step 1: entity/resource/policy ===');
  for (const name of TARGET_ENTITIES) {
    console.log(`\n--- ${name} ---`);
    await ensureEntityFiles(name, tenantId, args.dryRun);
  }

  // === Step 2: data ===
  console.log('\n=== Step 2: data pull ===');
  const tc = new MongoClient(tenant.database.uri);
  await tc.connect();
  const tdb = tc.db();

  // 2a. templates from page refs
  const pages = await tdb.collection('page').find({}).project({ templates: 1 }).toArray();
  const tmplIds = new Set<string>();
  for (const p of pages) for (const t of (p.templates || [])) tmplIds.add(String(t));
  console.log(`\ntemplates: ${tmplIds.size} unique IDs from local pages`);
  const tmplRecs = await fetchByIds('templates', [...tmplIds], tenantId);
  console.log(`  fetched: ${tmplRecs.length}`);

  // 2b. layout — flat fetch (standalone collection in production)
  const layoutRecs = await fetchProd(`/layout?limit=200`, tenantId);
  console.log(`\nlayout: fetched ${layoutRecs.length}`);

  // 2c. menu — flat fetch
  const menuRecs = await fetchProd(`/menu?limit=200`, tenantId);
  console.log(`menu: fetched ${menuRecs.length}`);

  // 2d. Standalone collections — pull flat (capped)
  const tagGroups = await fetchProd(`/tag-group?limit=200`, tenantId);
  console.log(`\ntag-group: fetched ${tagGroups.length}`);

  const forms = await fetchProd(`/form-builder?limit=200`, tenantId);
  console.log(`form-builder: fetched ${forms.length}`);

  // 2e. Insert into tenant DB
  console.log('\n=== Step 3: insert ===');
  const t1 = await bulkUpsert(tdb.collection('templates'), tmplRecs, 'templates', args.dryRun);
  console.log(`  templates:    ${t1} ${args.dryRun ? 'would upsert' : 'upserted'}`);
  const t2 = await bulkUpsert(tdb.collection('layout'), layoutRecs, 'layout', args.dryRun);
  console.log(`  layout:       ${t2}`);
  const t3 = await bulkUpsert(tdb.collection('menu'), menuRecs, 'menu', args.dryRun);
  console.log(`  menu:         ${t3}`);
  const t4 = await bulkUpsert(tdb.collection('tag-group'), tagGroups, 'tag-group', args.dryRun);
  console.log(`  tag-group:    ${t4}`);
  const t5 = await bulkUpsert(tdb.collection('form-builder'), forms, 'form-builder', args.dryRun);
  console.log(`  form-builder: ${t5}`);

  await tc.close();
  await m.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
