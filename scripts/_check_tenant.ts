import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
(async () => {
  const c = new MongoClient(process.env.MONGODB_URL!);
  await c.connect();
  const tenants = await c.db('mangoads').collection('tenant').find({}).toArray();
  for (const t of tenants) {
    console.log(`_id=${t._id} slug=${t.slug} team_id=${t.team_id}`);
  }
  await c.close();
})();
