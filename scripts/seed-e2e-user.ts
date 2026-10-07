/**
 * Seed a super_admin for E2E tests:
 *   email: e2e-test@local
 *   password: Test@1234
 * Idempotent — safe to run multiple times.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcrypt';

const URI = process.env.MONGODB_URL!;
const EMAIL = 'e2e-test@local';
const PASS = 'Test@1234';

(async () => {
  const c = new MongoClient(URI);
  await c.connect();
  const db = c.db('mangoads');
  const hashed = bcrypt.hashSync(PASS, 10);
  const now = new Date();

  const existing = await db.collection('user').findOne({ email: EMAIL });
  if (existing) {
    await db.collection('user').updateOne(
      { _id: existing._id },
      { $set: { password: hashed, is_super_admin: true, role_system: 'admin', is_active: true, updated_at: now } },
    );
    console.log(`updated existing user _id=${existing._id}`);
  } else {
    const r = await db.collection('user').insertOne({
      email: EMAIL,
      username: 'e2etest',
      full_name: 'E2E Test',
      phone: '0900000000',
      password: hashed,
      is_super_admin: true,
      role_system: 'admin',
      role_name: 'admin',
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    console.log(`created user _id=${r.insertedId}`);
  }
  console.log(`login: ${EMAIL} / ${PASS}`);
  await c.close();
})().catch((e) => { console.error(e); process.exit(1); });
