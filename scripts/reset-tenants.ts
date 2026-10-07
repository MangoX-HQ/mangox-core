/**
 * Reset tenants:
 *   1. Delete all tenants in the DB + folder json/<team>/<slug>/ + Redis schema keys
 *   2. Update default team.mongodb.uri = the URI provided by the user
 *
 * Do NOT delete teams or user_team. Just clean up tenants so they can be recreated.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

const URI = process.env.MONGODB_URL!;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = parseInt(process.env.REDIS_DB || '0');
const APP_NAME = process.env.APP_NAME || 'Mangox API';

const NEW_MONGO_URI = 'mongodb+srv://lyvinhthai321:Th%40i2004@cluster0.7kes8.mongodb.net/';
const JSON_DIR = path.resolve(__dirname, '../json');

(async () => {
  const m = new MongoClient(URI); await m.connect();
  const db = m.db('mangoads');

  // 1. List & delete tenants
  const tenants = await db.collection('tenant').find({}).toArray();
  console.log(`Found ${tenants.length} tenant(s):`);
  for (const t of tenants) console.log(`  - ${t.slug} (team_id=${t.team_id})`);

  if (tenants.length > 0) {
    const ids = tenants.map((t) => t._id);
    const r = await db.collection('tenant').deleteMany({ _id: { $in: ids } });
    console.log(`Deleted ${r.deletedCount} tenant docs`);

    // Folders
    for (const t of tenants) {
      if (!t.team_id || !t.slug) continue;
      const dir = path.join(JSON_DIR, String(t.team_id), t.slug);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`  rm folder: ${String(t.team_id)}/${t.slug}/`);
      }
    }

    // Redis schema keys (composite scope team_id:slug)
    const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD, db: 0 });
    for (const t of tenants) {
      const scope = `${t.team_id}:${t.slug}`;
      const keys = await redis.keys(`schema:${APP_NAME}:tenant:${scope}:*`);
      if (keys.length) {
        await redis.del(...keys);
        console.log(`  redis del ${keys.length} keys for ${scope}`);
      }
    }
    await redis.quit();

    // Cleanup user_tenant orphan rows
    const utDel = await db.collection('user_tenant').deleteMany({ tenant_id: { $in: ids.map(String) } });
    console.log(`Deleted ${utDel.deletedCount} user_tenant rows`);

    // Clear assigned_tenants in user_team membership
    const idsStr = ids.map(String);
    const utClear = await db.collection('user_team').updateMany(
      { assigned_tenants: { $in: idsStr } },
      { $pull: { assigned_tenants: { $in: idsStr } } as any, $set: { updated_at: new Date() } },
    );
    console.log(`Cleared assigned_tenants in ${utClear.modifiedCount} user_team rows`);

    // Clear tenant_roles entries
    const trClear = await db.collection('user_team').updateMany(
      { 'tenant_roles.tenant_id': { $in: idsStr } },
      { $pull: { tenant_roles: { tenant_id: { $in: idsStr } } } as any, $set: { updated_at: new Date() } },
    );
    console.log(`Cleared tenant_roles in ${trClear.modifiedCount} user_team rows`);
  }

  // 2. Update default team Mongo URI
  const team = await db.collection('team').findOne({ slug: 'default' });
  if (!team) {
    console.log('⚠ default team không tồn tại');
  } else {
    const r = await db.collection('team').updateOne(
      { _id: team._id },
      {
        $set: {
          'mongodb.uri': NEW_MONGO_URI,
          'mongodb.db_prefix': '',
          updated_at: new Date(),
        },
      },
    );
    console.log(`Updated default team mongo URI (matched=${r.matchedCount} modified=${r.modifiedCount})`);
    console.log(`  uri=${NEW_MONGO_URI}`);
  }

  console.log('\n✅ DONE — tenants cleaned, default team mongo updated');
  console.log('Note: redis + r2 vẫn placeholder — bạn fill khi tạo team mới hoặc PUT default team');

  await m.close();
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
