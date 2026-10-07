import 'dotenv/config';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcrypt';
(async () => {
  const c = new MongoClient(process.env.MONGODB_URL!);
  await c.connect();
  const u = await c.db('mangoads').collection('user').findOne({ email: 'e2e-test@local' });
  console.log('found:', !!u, 'email:', u?.email, 'is_active:', u?.is_active);
  if (u) {
    console.log('password match:', bcrypt.compareSync('Test@1234', u.password ?? ''));
  }
  await c.close();
})();
