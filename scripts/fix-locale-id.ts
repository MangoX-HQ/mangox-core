/**
 * Set `locale_id` = `_id` (string) for every record in given collections.
 * Used after seed when local _ids differ from prod _ids but locale_id was
 * preserved → orphan reference. Local has 1 locale (vi) so each record is
 * its own primary; locale_id should equal own _id.
 *
 * Usage:
 *   npx tsx scripts/fix-locale-id.ts --tenant vang-thien-long --dry-run
 *   npx tsx scripts/fix-locale-id.ts --tenant vang-thien-long
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';

const COLLECTIONS = ['category', 'post-type-content', 'page', 'tag', 'tag-group'];

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

  const tc = new MongoClient(tenant.database.uri);
  await tc.connect();
  const tdb = tc.db();

  for (const coll of COLLECTIONS) {
    const recs = await tdb.collection(coll).find({}).project({ _id: 1, locale_id: 1, slug: 1 }).toArray();
    let fixed = 0;
    let ok = 0;
    for (const r of recs) {
      const idStr = String(r._id);
      if (r.locale_id === idStr) { ok++; continue; }
      if (!args.dryRun) {
        await tdb.collection(coll).updateOne({ _id: r._id }, { $set: { locale_id: idStr } });
      }
      fixed++;
    }
    console.log(`  ${coll.padEnd(22)} fixed=${fixed} alreadyOK=${ok} total=${recs.length}`);
  }

  await tc.close();
  await m.close();
  console.log('\nDone.');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
