/**
 * Move `page` records from MAIN.page → TENANT.page.
 *
 * Pages were originally written to MAIN DB because the `page` entity sat in
 * `json/system/entity/`. Now that we moved it to per-tenant entity, existing
 * records need to relocate to the correct tenant DB and gain a `tenant_id` field.
 *
 * Strategy:
 *   - Records have tenant_id=undefined (legacy bug), so we can't auto-assign.
 *   - Default: route all to the tenant passed via --to.
 *
 * Usage:
 *   npx tsx scripts/migrate-pages-to-tenant.ts --to vang-thien-long --dry-run
 *   npx tsx scripts/migrate-pages-to-tenant.ts --to vang-thien-long
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

interface Args {
  to?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args: Args = { dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === '--dry-run') args.dryRun = true;
    else if (v === '--to') args.to = process.argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  if (!args.to) {
    console.error('Required: --to <tenant_slug>');
    process.exit(1);
  }
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'} | target tenant: ${args.to}\n`);

  const main = new MongoClient(MAIN_URI);
  await main.connect();

  const tenant = await main.db().collection('tenant').findOne({ slug: args.to });
  if (!tenant) {
    console.error(`Tenant '${args.to}' not found`);
    await main.close();
    process.exit(1);
  }
  const tenantId = String(tenant._id);
  const tenantUri = tenant.database?.uri;
  console.log(`Tenant: _id=${tenantId} slug=${tenant.slug} dbUri=${tenantUri ? 'mongodb' : 'no'}\n`);

  const records = await main.db().collection('page').find({}).toArray();
  console.log(`Found ${records.length} pages in MAIN.page`);

  if (records.length === 0) {
    await main.close();
    return;
  }

  if (args.dryRun) {
    for (const r of records) {
      console.log(`  - ${r._id} ${r.title} (slug=${r.slug})`);
    }
    console.log('\nWould move all to tenant DB + set tenant_id, then delete from MAIN.');
    await main.close();
    return;
  }

  const tenantClient = new MongoClient(tenantUri);
  await tenantClient.connect();
  const tcoll = tenantClient.db().collection('page');

  let moved = 0;
  let skipped = 0;
  for (const r of records) {
    const exists = await tcoll.findOne({ _id: r._id });
    if (exists) {
      console.log(`  ! ${r._id} already exists in tenant — skipped`);
      skipped++;
      continue;
    }
    const newDoc = { ...r, tenant_id: tenantId };
    await tcoll.insertOne(newDoc);
    await main.db().collection('page').deleteOne({ _id: r._id });
    console.log(`  ✓ ${r._id} ${r.title}`);
    moved++;
  }
  console.log(`\nMoved: ${moved}, Skipped: ${skipped}`);

  await tenantClient.close();
  await main.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
