/**
 * Pull page / category / post-type-content from ve-tinh-all-new production
 * and seed into local backend (port 5555).
 *
 * Uses 2 separate tokens:
 *   PROD_TOKEN  — production backend (ve-tinh-all-new.mangoads.com.vn)
 *   LOCAL_TOKEN — local backend
 *
 * Tenant id stays the same (vang-thien-long: 69eada499e0eb6435ce0bda7).
 *
 * Strategy:
 *   1. Fetch page, category(tin-tuc, san-pham, chinh-sach), post-type-content(...)
 *   2. POST each record to local. Preserves `_id` so relations survive.
 *   3. Categories: flat fetch (no tree=true) so order doesn't matter for FK.
 *
 * Usage:
 *   npx tsx scripts/seed-vetinh-content.ts
 *   npx tsx scripts/seed-vetinh-content.ts --dry-run     # just count, don't POST
 *   npx tsx scripts/seed-vetinh-content.ts --only=page   # subset
 */

const PROD_BASE = 'https://ve-tinh-all-new.mangoads.com.vn/api/v1';
const LOCAL_BASE = 'http://localhost:5555/api/v1';
const TENANT_ID = '69eada499e0eb6435ce0bda7';

const PROD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc5MDk1MjYyLCJleHAiOjE3NzkxMjQwNjJ9.v2Md9zP8SYUVSrHXw6ShpmDJQ6bppM8FnBuPBf-jG0A';
const LOCAL_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicGhvbmUiOiIxMTMiLCJpYXQiOjE3Nzg1NTUzNjZ9.q6RMNXw1SEZHa2YlbPMytWbdqB5KD2SOB9cbFbhbsbw';

const POST_TYPES = ['tin-tuc', 'san-pham', 'chinh-sach'];

interface Args {
  dryRun: boolean;
  only?: string;
}

function parseArgs(): Args {
  const args: Args = { dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === '--dry-run') args.dryRun = true;
    else if (v.startsWith('--only=')) args.only = v.slice(7);
  }
  return args;
}

async function fetchProd(path: string): Promise<any[]> {
  const url = `${PROD_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${PROD_TOKEN}`,
      'X-Tenant-ID': TENANT_ID,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`PROD ${path} → ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json: any = await res.json();
  return Array.isArray(json) ? json : json?.data ?? [];
}

/**
 * Production API returns relations populated (`templates: [{...}]`).
 * Local schema expects refs as ID strings (`templates: ["6a02953..."]`).
 * Walk record and replace populated relation objects with their `_id` string.
 */
/**
 * A populated relation looks like a full document: has `_id` + `created_at` + `tenant_id`.
 * An embedded object (tags, languages…) has `_id` but NOT both timestamp+tenant fields.
 * We only flatten the former.
 */
function isPopulatedRelation(item: any): boolean {
  return (
    item &&
    typeof item === 'object' &&
    typeof item._id === 'string' &&
    'created_at' in item &&
    'tenant_id' in item
  );
}

function flattenRelations(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map((item) => {
      if (isPopulatedRelation(item)) return item._id;
      return flattenRelations(item);
    });
  }
  if (obj && typeof obj === 'object' && !(obj instanceof Date)) {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      // Scalar single-relation field (`category: {<full doc>}`) → just _id string
      if (isPopulatedRelation(v)) {
        out[k] = (v as any)._id;
      } else {
        out[k] = flattenRelations(v);
      }
    }
    return out;
  }
  return obj;
}

async function postLocal(collection: string, record: any): Promise<{ ok: boolean; status: number; body: string }> {
  // Strip fields that the API will set itself or that conflict with local DB.
  const clean = flattenRelations({ ...record });
  delete clean.created_at;
  delete clean.updated_at;
  delete clean.created_by;
  delete clean.updated_by;
  // Keep _id so relations across collections survive.

  const res = await fetch(`${LOCAL_BASE}/${collection}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LOCAL_TOKEN}`,
      'X-Tenant-ID': TENANT_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(clean),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

async function seedCollection(
  label: string,
  prodPath: string,
  localCollection: string,
  dryRun: boolean,
  transform?: (rec: any) => void,
): Promise<void> {
  console.log(`\n=== ${label} ===`);
  let records: any[];
  try {
    records = await fetchProd(prodPath);
  } catch (e: any) {
    console.error(`  ✗ fetch failed: ${e.message}`);
    return;
  }
  console.log(`  Fetched ${records.length} records from prod`);

  if (dryRun) {
    if (records[0]) console.log(`  Sample _id=${records[0]._id} keys=${Object.keys(records[0]).slice(0, 8).join(',')}…`);
    return;
  }

  let ok = 0, fail = 0;
  const errs: string[] = [];
  for (const rec of records) {
    if (transform) transform(rec);
    const id = rec._id;
    const result = await postLocal(localCollection, rec);
    if (result.ok) {
      ok++;
    } else {
      fail++;
      if (errs.length < 5) errs.push(`  ${id}: ${result.status} ${result.body.slice(0, 200)}`);
    }
  }
  console.log(`  Local POST: ${ok} ok, ${fail} failed`);
  if (errs.length) {
    console.log('  First errors:');
    errs.forEach((e) => console.log(e));
  }
}

async function main() {
  const args = parseArgs();
  console.log(`Tenant: ${TENANT_ID} (vang-thien-long)`);
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (args.only) console.log(`Only: ${args.only}`);

  // Page
  if (!args.only || args.only === 'page') {
    await seedCollection('Page', '/page?locale=vi&limit=500', 'page', args.dryRun);
  }

  // Tag (flat — keeps tag_group relation as id array)
  if (!args.only || args.only === 'tag') {
    await seedCollection('Tag', '/tag?locale=vi&limit=500', 'tag', args.dryRun);
  }

  // Category (per post type) — flat, no tree=true.
  // Inject post_type from the loop param: prod response often hides it
  // behind policy / populated relations, but we already know the slug.
  if (!args.only || args.only === 'category') {
    for (const pt of POST_TYPES) {
      await seedCollection(
        `Category (${pt})`,
        `/category?limit=500&post_type=${pt}&locale=vi`,
        'category',
        args.dryRun,
        (rec) => {
          rec.post_type = [pt];
        },
      );
    }
  }

  // post-type-content — fetched from prod via `post-type-content?post_type=X`
  // but POSTed to local via logical entity name `/X` (v2 routes by collection name).
  if (!args.only || args.only === 'post-type-content') {
    for (const pt of POST_TYPES) {
      await seedCollection(
        `${pt} (from post-type-content)`,
        `/post-type-content?locale=vi&post_type=${pt}&limit=500`,
        pt,
        args.dryRun,
        (rec) => {
          rec.post_type = pt;
        },
      );
    }
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
