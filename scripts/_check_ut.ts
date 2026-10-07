import 'dotenv/config';
import { MongoClient } from 'mongodb';
(async () => {
  const c = new MongoClient(process.env.MONGODB_URL!);
  await c.connect();
  const db = c.db('mangoads');
  const docs = await db.collection('user_team').find({}).toArray();
  console.log(`user_team docs in mangoads.user_team: ${docs.length}`);
  for (const d of docs) console.log(JSON.stringify(d));
  await c.close();
})();
