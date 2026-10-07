import 'dotenv/config';
import { MongoClient } from 'mongodb';
(async () => {
  const c = new MongoClient(process.env.MONGODB_URL!);
  await c.connect();
  const db = c.db('mangoads');
  const [ut, um] = await Promise.all([
    db.collection('user_tenant').countDocuments(),
    db.collection('user_team').countDocuments(),
  ]);
  console.log(`user_tenant count: ${ut}`);
  console.log(`user_team count:   ${um}`);
  if (ut > 0) {
    const sample = await db.collection('user_tenant').findOne();
    console.log('user_tenant sample:', JSON.stringify(sample, null, 2));
  }
  await c.close();
})();
