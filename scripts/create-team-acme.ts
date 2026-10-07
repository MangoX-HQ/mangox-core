/**
 * Create team "acme" via HTTP POST /team (goes through validateTeamInfra, pinging all 3).
 *  - Mongo: user-provided URI (cluster0 atlas)
 *  - Redis: same as system (localhost:10002)
 *  - R2: same as env MINIO (real R2 endpoint)
 */
import 'dotenv/config';

const API = process.env.API_HOST || 'http://localhost:5555';
const EMAIL = 'admin@gmail.cBrjtAWJgS.com';
const PASS = EMAIL.repeat(5);

const TEAM_BODY = {
  title: 'Acme Corp',
  slug: 'acme',
  description: 'Team mới, tạo lại từ default reset',
  plan: 'enterprise',
  mongodb: {
    uri: 'mongodb+srv://lyvinhthai321:Th%40i2004@cluster0.7kes8.mongodb.net/',
    db_prefix: 'acme',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '10002'),
    password: process.env.REDIS_PASSWORD || 'Th@i2004',
    db: 0,
    key_prefix: 'acme:',
  },
  r2: {
    endpoint: process.env.MINIO_ENDPOINT!,
    region: process.env.MINIO_REGION || 'auto',
    access_key: process.env.MINIO_ACCESS_KEY!,
    secret_key: process.env.MINIO_SECRET_KEY!,
    bucket: process.env.MINIO_BUCKET_NAME!,
    public_url: process.env.MINIO_PUBLIC,
  },
  quota: { max_tenants: -1, max_storage_mb: -1, max_users: -1 },
};

(async () => {
  // login
  console.log('LOGIN…');
  const loginRes = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const loginJson: any = await loginRes.json();
  const token = loginJson?.data?.accessToken;
  if (!token) { console.error('login fail', loginJson); process.exit(1); }
  console.log('  token OK');

  // POST /team
  console.log('\nPOST /team body:');
  console.log(JSON.stringify(
    { ...TEAM_BODY, mongodb: { ...TEAM_BODY.mongodb, uri: 'mongodb+srv://***' },
      redis: { ...TEAM_BODY.redis, password: '***' },
      r2: { ...TEAM_BODY.r2, access_key: '***', secret_key: '***' } },
    null, 2,
  ));

  console.log('\nPinging infra (Mongo Atlas, Redis, R2)…');
  const t0 = Date.now();
  const res = await fetch(`${API}/api/v1/team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(TEAM_BODY),
  });
  const json: any = await res.json();
  const took = Date.now() - t0;
  console.log(`HTTP ${res.status} (${took}ms)`);

  if (res.status === 200) {
    const data = json?.data?.data || json?.data;
    console.log(`✅ Team created: _id=${data?._id} slug=${data?.slug}`);
    console.log(`\nNext step: POST /tenant với team_id=${data?._id}`);
  } else {
    console.log('❌ FAIL:');
    console.log(JSON.stringify(json, null, 2));
  }
})().catch((e) => { console.error('CRASH:', e); process.exit(1); });
