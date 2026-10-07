import 'dotenv/config';
import { MongoClient } from 'mongodb';
(async () => {
  const c = new MongoClient(process.env.MONGODB_URL!);
  await c.connect();
  const idx = await c.db('mangoads').collection('tenant').indexes();
  console.log(JSON.stringify(idx, null, 2));
  await c.close();
})();
