/**
 * $unset the user.role_system field on every document. After running:
 *   - is_super_admin flag is the sole source of truth for super_admin bypass
 *   - user_team.role_name decides the role per team
 *   - user.role_system disappears from the DB
 *
 * Idempotent — safe to run again.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

(async () => {
  const c = new MongoClient(process.env.MONGODB_URL!);
  await c.connect();
  const db = c.db('mangoads');
  const r = await db.collection('user').updateMany(
    { role_system: { $exists: true } },
    { $unset: { role_system: '' }, $set: { updated_at: new Date() } },
  );
  console.log(`unset role_system from ${r.modifiedCount} user(s)`);
  await c.close();
})();
