/**
 * Drop legacy index `unique_slug_tenant` on the tenant collection (compound on
 * (tenant_id, collection_name, slug) — wrong because tenant docs don't have those 2 fields,
 * causing collisions when 2 tenants share the same slug in different teams).
 *
 * Replace with a compound unique index (team_id, slug) — per-team uniqueness enforced by the DB.
 *
 * Idempotent.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URL!;

(async () => {
  const c = new MongoClient(URI);
  await c.connect();
  const coll = c.db('mangoads').collection('tenant');

  const indexes = await coll.indexes();
  const legacy = indexes.find((i) => i.name === 'unique_slug_tenant');
  if (legacy) {
    await coll.dropIndex('unique_slug_tenant');
    console.log('✓ dropped legacy index unique_slug_tenant');
  } else {
    console.log('  legacy index already dropped (skip)');
  }

  const compoundName = 'unique_team_slug';
  const compound = indexes.find((i) => i.name === compoundName);
  if (!compound) {
    await coll.createIndex(
      { team_id: 1, slug: 1 },
      {
        unique: true,
        name: compoundName,
        partialFilterExpression: { slug: { $type: 'string' }, team_id: { $type: 'string' } },
      },
    );
    console.log('✓ created compound unique index (team_id, slug)');
  } else {
    console.log('  compound index already exists (skip)');
  }

  console.log('\nFinal indexes:');
  for (const i of await coll.indexes()) {
    console.log(`  ${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' UNIQUE' : ''}`);
  }
  await c.close();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
