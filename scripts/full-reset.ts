/**
 * Full reset:
 *   - Delete all tenants + teams + user_team + user_tenant
 *   - Delete folder json/<team_id>/*  (keep json/system/)
 *   - Delete tenant-scoped Redis schema keys (keep system + global)
 *   - Delete all users except KEEP_EMAIL (the main super_admin)
 *   - Ensure the remaining user has is_super_admin=true + role_system=admin
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
const APP_NAME = process.env.APP_NAME || 'Mangox API';

const KEEP_EMAIL = 'admin@gmail.cBrjtAWJgS.com';
const JSON_DIR = path.resolve(__dirname, '../json');

(async () => {
  const m = new MongoClient(URI); await m.connect();
  const db = m.db('mangoads');

  // ── 1. Collections cleanup ──
  console.log('\n── DB cleanup ──');
  const collections = ['tenant', 'team', 'user_team', 'user_tenant', 'user_token'];
  for (const c of collections) {
    const r = await db.collection(c).deleteMany({});
    console.log(`  ${c}: deleted ${r.deletedCount}`);
  }

  // ── 2. User cleanup — keep KEEP_EMAIL ──
  console.log('\n── User cleanup ──');
  const allUsers = await db.collection('user').find({}, { projection: { email: 1 } }).toArray();
  const keep = allUsers.find((u: any) => u.email === KEEP_EMAIL);
  if (!keep) {
    console.error(`❌ User '${KEEP_EMAIL}' không tồn tại — abort để không lock-out`);
    await m.close();
    process.exit(1);
  }
  const toDel = allUsers.filter((u: any) => u.email !== KEEP_EMAIL).map((u: any) => u._id);
  if (toDel.length) {
    const r = await db.collection('user').deleteMany({ _id: { $in: toDel } });
    console.log(`  deleted ${r.deletedCount} other users`);
  } else {
    console.log('  no other users to delete');
  }

  // Ensure the remaining user is super_admin
  const r = await db.collection('user').updateOne(
    { _id: keep._id },
    { $set: { is_super_admin: true, role_system: 'admin', is_active: true, updated_at: new Date() } },
  );
  console.log(`  ensured ${KEEP_EMAIL}: is_super_admin=true, role_system=admin (matched=${r.matchedCount})`);

  // ── 3. Folders ──
  console.log('\n── Folder cleanup ──');
  try {
    for (const name of fs.readdirSync(JSON_DIR)) {
      if (name === 'system') continue;
      const full = path.join(JSON_DIR, name);
      if (fs.statSync(full).isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`  rm json/${name}/`);
      }
    }
  } catch (e: any) {
    console.log(`  warn: ${e.message}`);
  }

  // ── 4. Redis schema keys (tenant-scoped only — keep global + system) ──
  console.log('\n── Redis schema cleanup ──');
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD, db: 0 });
  const keys = await redis.keys(`schema:${APP_NAME}:tenant:*`);
  if (keys.length) {
    await redis.del(...keys);
    console.log(`  deleted ${keys.length} tenant-scoped Redis keys`);
  } else {
    console.log('  no tenant Redis keys');
  }
  await redis.quit();

  // ── Final state ──
  console.log('\n══ Final state ══');
  const counts = await Promise.all([
    db.collection('user').countDocuments(),
    db.collection('team').countDocuments(),
    db.collection('tenant').countDocuments(),
    db.collection('user_team').countDocuments(),
    db.collection('user_tenant').countDocuments(),
  ]);
  console.log(`  users:        ${counts[0]}  (giữ ${KEEP_EMAIL})`);
  console.log(`  teams:        ${counts[1]}`);
  console.log(`  tenants:      ${counts[2]}`);
  console.log(`  user_team:    ${counts[3]}`);
  console.log(`  user_tenant:  ${counts[4]}`);
  console.log('\n✅ DONE — login với admin@gmail.cBrjtAWJgS.com / email×5');
  console.log('   Tạo team mới qua /team → tạo tenant → start fresh');

  await m.close();
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
