/**
 * Import tenant data from ve-tinh.mangoads.com.vn → local per-tenant MongoDB.
 *
 * Source : https://ve-tinh.mangoads.com.vn/api/v1
 * Target : mongodb://thaily:Th%40i2004@localhost:10000/{tenant.slug}
 *
 * Usage  :
 *   npx tsx scripts/import-tenants.ts --list
 *   npx tsx scripts/import-tenants.ts --tenant <slug-or-id>
 *   npx tsx scripts/import-tenants.ts --all
 *
 * Optional flags:
 *   --token <bearer>     override Bearer token (default: embedded constant)
 *   --page-size <n>      records per page (default: 200)
 *   --drop               drop target collection before importing
 *   --only <slugs>       comma-separated entity slugs to limit import
 *   --skip <slugs>       comma-separated entity slugs to skip
 *   --dry-run            do not write to MongoDB, just count
 */

import axios, { AxiosInstance } from 'axios';
import { MongoClient } from 'mongodb';

const SOURCE_BASE = 'https://ve-tinh.mangoads.com.vn/api/v1';
const TARGET_HOST = 'mongodb://thaily:Th%40i2004@localhost:10000';
const TARGET_QS = 'authSource=admin&replicaSet=rs0&directConnection=true';

const DEFAULT_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmMjRiZWE5YTBmYzJlZGIzMTY0ZSIsImVtYWlsIjoiYWRtaW5AZ21haWwuY0JyanRBV0pnUy5jb20iLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZV9zeXN0ZW0iOiJhZG1pbiIsInJvbGVfbmFtZSI6ImFkbWluIiwiaWF0IjoxNzc3OTc0NjY3LCJleHAiOjE3NzgwMDM0Njd9.0o1ANXqyCOujdPNl0XvQbFhH0ZjF4ZSSya2CXpHJ1xA';

type Tenant = { _id: string; slug: string; title?: string };
type Entity = {
  _id: string;
  slug: string | null;
  mongodb_collection_name?: string;
  tenant_id?: string | null;
};

interface Args {
  list: boolean;
  all: boolean;
  tenant?: string;
  token: string;
  pageSize: number;
  drop: boolean;
  only?: Set<string>;
  skip?: Set<string>;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    list: false,
    all: false,
    token: DEFAULT_TOKEN,
    pageSize: 200,
    drop: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    switch (v) {
      case '--list': a.list = true; break;
      case '--all': a.all = true; break;
      case '--tenant': a.tenant = argv[++i]; break;
      case '--token': a.token = argv[++i]; break;
      case '--page-size': a.pageSize = parseInt(argv[++i], 10); break;
      case '--drop': a.drop = true; break;
      case '--only': a.only = new Set(argv[++i].split(',').map(s => s.trim())); break;
      case '--skip': a.skip = new Set(argv[++i].split(',').map(s => s.trim())); break;
      case '--dry-run': a.dryRun = true; break;
      case '-h':
      case '--help':
        printHelpAndExit();
        break;
    }
  }
  if (!a.list && !a.all && !a.tenant) printHelpAndExit();
  return a;
}

function printHelpAndExit(): never {
  console.log(`Usage:
  npx tsx scripts/import-tenants.ts --list
  npx tsx scripts/import-tenants.ts --tenant <slug-or-id> [--drop] [--only blog,san-pham]
  npx tsx scripts/import-tenants.ts --all [--drop]

Flags: --token, --page-size, --drop, --only, --skip, --dry-run`);
  process.exit(0);
}

function targetUri(slug: string): string {
  return `${TARGET_HOST}/${encodeURIComponent(slug)}?${TARGET_QS}`;
}

function http(token: string, tenantId: string): AxiosInstance {
  return axios.create({
    baseURL: SOURCE_BASE,
    timeout: 60_000,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-ID': tenantId,
      'X-Requested-With': 'XMLHttpRequest',
      'X-Requested-Store': 'default',
      Accept: 'application/json',
    },
    validateStatus: () => true,
  });
}

async function listTenants(token: string): Promise<Tenant[]> {
  // any X-Tenant-ID with admin privileges works for listing
  const client = http(token, '69cb58498953817b3ac960bc');
  const out: Tenant[] = [];
  let page = 1;
  const limit = 500;
  while (true) {
    const r = await client.get('/tenant', { params: { limit, page } });
    if (r.status !== 200) throw new Error(`tenant list ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    const data: Tenant[] = r.data?.data ?? [];
    out.push(...data);
    const total = r.data?.meta?.total ?? out.length;
    if (out.length >= total || data.length < limit) break;
    page++;
  }
  return out;
}

async function listEntities(token: string, tenantId: string): Promise<Entity[]> {
  const client = http(token, tenantId);
  const out: Entity[] = [];
  let page = 1;
  const limit = 500;
  while (true) {
    const r = await client.get('/entity', { params: { limit, page } });
    if (r.status !== 200) throw new Error(`entity list ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    const data: Entity[] = r.data?.data ?? [];
    out.push(...data);
    const total = r.data?.meta?.total ?? out.length;
    if (out.length >= total || data.length < limit) break;
    page++;
  }
  return out;
}

async function* fetchRecords(
  client: AxiosInstance,
  slug: string,
  pageSize: number,
): AsyncGenerator<{ records: any[]; total: number; page: number; lastPage: number }> {
  let page = 1;
  while (true) {
    const r = await client.get(`/${encodeURIComponent(slug)}`, { params: { limit: pageSize, page } });
    if (r.status !== 200) {
      throw new Error(`GET /${slug}?page=${page} → ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    const records: any[] = r.data?.data ?? [];
    const total = r.data?.meta?.total ?? records.length;
    const lastPage = r.data?.meta?.last_page ?? 1;
    yield { records, total, page, lastPage };
    if (records.length < pageSize || page >= lastPage) break;
    page++;
  }
}

async function importTenant(tenant: Tenant, args: Args): Promise<void> {
  if (!tenant.slug) {
    console.warn(`SKIP tenant ${tenant._id} — no slug`);
    return;
  }
  console.log(`\n=== Tenant: ${tenant.slug} (${tenant._id}) — ${tenant.title ?? ''} ===`);

  const entities = await listEntities(args.token, tenant._id);
  const queryable = entities
    .filter(e => !!e.slug)
    .filter(e => !args.only || args.only.has(e.slug!))
    .filter(e => !args.skip || !args.skip.has(e.slug!));

  console.log(`Entities: ${entities.length} total → ${queryable.length} queryable`);

  if (args.dryRun) {
    for (const e of queryable) {
      console.log(`  [dry] ${e.slug} → coll=${e.mongodb_collection_name ?? e.slug}`);
    }
    return;
  }

  const client = new MongoClient(targetUri(tenant.slug));
  await client.connect();
  try {
    const db = client.db();
    const httpClient = http(args.token, tenant._id);

    for (const e of queryable) {
      const collName = e.mongodb_collection_name || e.slug!;
      const coll = db.collection(collName);

      if (args.drop) {
        try { await coll.drop(); } catch (_) { /* not exist */ }
      }

      let count = 0;
      let total = 0;
      try {
        for await (const { records, total: t, page, lastPage } of fetchRecords(httpClient, e.slug!, args.pageSize)) {
          total = t;
          if (records.length === 0) break;
          const ops = records.map((doc: any) => ({
            replaceOne: {
              filter: { _id: doc._id },
              replacement: doc,
              upsert: true,
            },
          }));
          if (ops.length) {
            await coll.bulkWrite(ops, { ordered: false });
          }
          count += records.length;
          process.stdout.write(`  ${e.slug} (${collName}): page ${page}/${lastPage} · ${count}/${total}\r`);
        }
        console.log(`  ${e.slug} (${collName}): ${count}/${total} records imported`.padEnd(80, ' '));
      } catch (err: any) {
        console.error(`  ${e.slug} (${collName}): FAILED — ${err?.message ?? err}`);
      }
    }
  } finally {
    await client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const tenants = await listTenants(args.token);
    console.log(`Total tenants: ${tenants.length}`);
    for (const t of tenants) console.log(`  ${t.slug.padEnd(40)} ${t._id}  ${t.title ?? ''}`);
    return;
  }

  const all = await listTenants(args.token);
  const targets: Tenant[] = args.all
    ? all
    : all.filter(t => t.slug === args.tenant || t._id === args.tenant);

  if (targets.length === 0) {
    console.error(`No tenant matched "${args.tenant}". Use --list to see available tenants.`);
    process.exit(1);
  }

  console.log(`Importing ${targets.length} tenant(s)…`);
  for (const t of targets) {
    try {
      await importTenant(t, args);
    } catch (err: any) {
      console.error(`Tenant ${t.slug}: FAILED — ${err?.message ?? err}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
