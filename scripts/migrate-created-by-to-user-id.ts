/**
 * Migrate records whose created_by/updated_by stores user_tenant._id
 * into the new convention where they store user._id directly.
 *
 * Also backfills MAIN.user_tenant.{username,full_name,email,phone}
 * (those fields existed only in tenant DB before this fix).
 *
 * Steps:
 *   1. Backfill MAIN.user_tenant denormalize fields from user collection.
 *   2. Build a map  user_tenant._id (string) → user_id.
 *   3. For every tenant, walk every collection and rewrite created_by /
 *      updated_by that match a user_tenant._id → corresponding user_id.
 *
 * Usage:
 *   npx tsx scripts/migrate-created-by-to-user-id.ts            # all tenants
 *   npx tsx scripts/migrate-created-by-to-user-id.ts --tenant vang-thien-long
 *   npx tsx scripts/migrate-created-by-to-user-id.ts --dry-run  # report only
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';
const TENANT_HOST = 'mongodb://thaily:Th%40i2004@localhost:10000';
const TENANT_QS = 'authSource=admin&replicaSet=rs0&directConnection=true';

interface Args {
  tenant?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args: Args = { dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === '--dry-run') args.dryRun = true;
    else if (v === '--tenant') args.tenant = process.argv[++i];
  }
  return args;
}

async function backfillMainDenormalize(main: MongoClient, dryRun: boolean): Promise<number> {
  const ut = main.db().collection('user_tenant');
  const users = main.db().collection('user');

  const toFix = await ut
    .find({ $or: [{ username: { $exists: false } }, { username: null }] })
    .toArray();
  console.log(`[main] user_tenant rows needing denormalize backfill: ${toFix.length}`);

  let fixed = 0;
  for (const r of toFix) {
    let user: any = null;
    try {
      user = await users.findOne({ _id: new ObjectId(r.user_id) });
    } catch {}
    if (!user) {
      console.log(`  - user_tenant=${r._id} user_id=${r.user_id} → user not found (skip)`);
      continue;
    }
    if (dryRun) {
      console.log(`  + ${r._id} ← username=${user.username}, full_name=${user.full_name}`);
    } else {
      await ut.updateOne(
        { _id: r._id },
        {
          $set: {
            username: user.username,
            full_name: user.full_name,
            email: user.email,
            phone: user.phone,
          },
        },
      );
    }
    fixed++;
  }
  return fixed;
}

async function buildUtIdToUserIdMap(main: MongoClient): Promise<Map<string, string>> {
  const ut = await main.db().collection('user_tenant').find({}, { projection: { user_id: 1 } }).toArray();
  const m = new Map<string, string>();
  for (const r of ut) m.set(String(r._id), String(r.user_id));
  return m;
}

async function listTenants(main: MongoClient, only?: string): Promise<any[]> {
  const f: any = {};
  if (only) f.slug = only;
  return main.db().collection('tenant').find(f).toArray();
}

/**
 * Resolve a fallback user_id for orphan created_by/updated_by values.
 * Strategy: pick an admin user_tenant row for this tenant from MAIN.user_tenant.
 * If multiple admins, prefer the one with role_name='admin'.
 */
async function resolveTenantFallback(main: MongoClient, tenantId: string): Promise<string | null> {
  const ut = main.db().collection('user_tenant');
  // Try admin first
  let row = await ut.findOne(
    { tenant_id: tenantId, role_name: 'admin', is_active: { $ne: false } },
    { projection: { user_id: 1 } },
  );
  if (!row) {
    // Any active member
    row = await ut.findOne(
      { tenant_id: tenantId, is_active: { $ne: false } },
      { projection: { user_id: 1 } },
    );
  }
  return row?.user_id ? String(row.user_id) : null;
}

async function migrateTenant(
  main: MongoClient,
  tenant: any,
  utIdMap: Map<string, string>,
  dryRun: boolean,
): Promise<void> {
  const uri = tenant.database?.uri;
  if (!uri || tenant.database?.type !== 'mongodb') {
    console.log(`[${tenant.slug}] not a MongoDB tenant — skipping`);
    return;
  }

  const fallback = await resolveTenantFallback(main, String(tenant._id));
  console.log(`[${tenant.slug}] fallback user_id for orphans: ${fallback ?? '(none — orphans left as-is)'}`);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collections = await db.listCollections().toArray();

  // Build set of all user._id values from MAIN to detect records already on the new convention.
  const userIds = new Set(
    (await main.db().collection('user').find({}, { projection: { _id: 1 } }).toArray()).map((u) => String(u._id)),
  );

  // A value "needs migration" if it's set AND it's not already a known user._id.
  const needsMigration = (v: any) => v && typeof v === 'string' && !userIds.has(v);

  let totalFixed = 0;
  let totalOrphan = 0;
  for (const c of collections) {
    if (c.name.startsWith('system.')) continue;
    const coll = db.collection(c.name);
    const candidates = await coll
      .find({ $or: [{ created_by: { $exists: true, $ne: null } }, { updated_by: { $exists: true, $ne: null } }] })
      .toArray();
    if (candidates.length === 0) continue;

    let fixed = 0;
    let orphan = 0;
    for (const doc of candidates) {
      const upd: any = {};

      if (needsMigration(doc.created_by)) {
        const mapped = utIdMap.get(String(doc.created_by));
        if (mapped) upd.created_by = mapped;
        else if (fallback) { upd.created_by = fallback; orphan++; }
      }
      if (needsMigration(doc.updated_by)) {
        const mapped = utIdMap.get(String(doc.updated_by));
        if (mapped) upd.updated_by = mapped;
        else if (fallback) { upd.updated_by = fallback; orphan++; }
      }

      if (Object.keys(upd).length === 0) continue;
      if (!dryRun) {
        await coll.updateOne({ _id: doc._id }, { $set: upd });
      }
      fixed++;
    }
    if (fixed > 0) {
      console.log(`  ${c.name.padEnd(30)} → ${fixed} records ${dryRun ? '(would update)' : 'updated'}${orphan ? ` (${orphan} via fallback)` : ''}`);
      totalFixed += fixed;
      totalOrphan += orphan;
    }
  }
  console.log(`[${tenant.slug}] total: ${totalFixed} records ${dryRun ? '(would update)' : 'updated'}${totalOrphan ? ` — ${totalOrphan} via fallback admin` : ''}`);

  await client.close();
}

async function main() {
  const args = parseArgs();
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'}${args.tenant ? ` (only ${args.tenant})` : ''}\n`);

  const m = new MongoClient(MAIN_URI);
  await m.connect();

  console.log('=== Step 1: Backfill MAIN.user_tenant denormalize ===');
  const denormFixed = await backfillMainDenormalize(m, args.dryRun);
  console.log(`  Fixed ${denormFixed} rows\n`);

  console.log('=== Step 2: Build user_tenant._id → user_id map ===');
  const utIdMap = await buildUtIdToUserIdMap(m);
  console.log(`  Map has ${utIdMap.size} entries\n`);

  console.log('=== Step 3: Migrate created_by/updated_by in tenant DBs ===');
  const tenants = await listTenants(m, args.tenant);
  for (const t of tenants) {
    console.log(`\n--- ${t.slug} ---`);
    await migrateTenant(m, t, utIdMap, args.dryRun);
  }

  await m.close();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
