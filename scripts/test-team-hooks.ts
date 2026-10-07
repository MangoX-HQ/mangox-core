/**
 * E2E test for the hook system: validate POST /team + POST /tenant
 * (schema-driven mongorest path) going through beforeInsert hooks.
 *
 * Scenarios:
 *   T1. POST /team missing mongodb       → 400 TEAM_INFRA_REQUIRED
 *   T2. POST /team with fake Mongo URI       → 400 TEAM_INFRA_PING_FAILED (service=mongodb)
 *   T3. POST /team Mongo OK + fake Redis → 400 (service=redis)
 *   T4. POST /team Mongo+Redis OK + fake R2 → 400 (service=r2)
 *   T5. POST /tenant missing team_id      → 400 TENANT_TEAM_REQUIRED
 *   T6. POST /tenant team_id doesn't exist → 404 TEAM_NOT_FOUND
 *   T7. POST /tenant duplicate slug within a team → 409 TENANT_SLUG_DUPLICATE
 *
 * Cleanup: delete every doc that was created (removed when conditions allow, otherwise a small leak).
 */

import 'dotenv/config';

const API = process.env.API_HOST || 'http://localhost:5555';
const EMAIL = 'admin@gmail.cBrjtAWJgS.com';
const PASS = EMAIL.repeat(5);
const TS = Date.now();

let PASS_COUNT = 0, FAIL = 0;
const ok = (m: string) => { console.log(`  ✓ ${m}`); PASS_COUNT++; };
const bad = (m: string, d?: any) => {
  console.log(`  ✗ ${m}`);
  if (d !== undefined) console.log(`    ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 300)}`);
  FAIL++;
};
const sec = (s: string) => console.log(`\n── ${s} ──`);

async function api(method: string, path: string, body?: any, token?: string): Promise<{ status: number; data: any }> {
  const headers: any = { 'content-type': 'application/json', 'x-requested-store': 'default' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${API}/api/v1${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

const createdTeamIds: string[] = [];
const createdTenantIds: string[] = [];

(async () => {
  // ── LOGIN ─────────────────────────────────────────────────────────────
  sec('LOGIN super_admin');
  const login = await api('POST', '/auth/login', { email: EMAIL, password: PASS });
  if (login.status !== 200) {
    bad(`login fail (${login.status})`, login.data);
    process.exit(1);
  }
  const token = login.data?.data?.accessToken;
  if (!token) { bad('no accessToken'); process.exit(1); }
  ok(`logged in, role_system=admin`);

  // ── T1: missing mongodb ────────────────────────────────────────────────
  sec('T1: POST /team thiếu mongodb → 400 TEAM_INFRA_REQUIRED');
  const t1 = await api('POST', '/team', {
    title: `T1-${TS}`, slug: `t1-${TS}`,
  }, token);
  if (t1.status === 400) {
    const msg = t1.data?.message || t1.data?.data?.message || '';
    const fields = t1.data?.fields || t1.data?.data?.fields || [];
    if (/mongodb|redis|r2/i.test(msg) || fields.some((f: any) => /mongodb|redis|r2/i.test(f.field || f.message || ''))) {
      ok(`reject required infra field`);
    } else bad(`status 400 nhưng error khác`, t1.data);
  } else {
    bad(`expect 400 got ${t1.status}`, t1.data);
    if (t1.data?.data?._id) createdTeamIds.push(t1.data.data._id);
  }

  // ── T2: Mongo URI fake ──────────────────────────────────────────────
  sec('T2: Mongo URI fake → 400 ping fail');
  const t2 = await api('POST', '/team', {
    title: `T2-${TS}`, slug: `t2-${TS}`,
    mongodb: { uri: 'mongodb://fake:0001@nowhere.invalid:27017/?serverSelectionTimeoutMS=1000', db_prefix: 'x' },
    redis: { host: 'localhost', port: 10002, password: 'Th@i2004', db: 0 },
    r2: { endpoint: 'https://nowhere.invalid', region: 'auto', access_key: 'x', secret_key: 'y', bucket: 'z' },
  }, token);
  if (t2.status === 400) {
    const errors = t2.data?.data?.errors || t2.data?.errors || [];
    const mongoErr = errors.find((e: any) => e.service === 'mongodb');
    if (mongoErr) ok(`reject mongo: ${mongoErr.message.slice(0, 80)}…`);
    else bad('expect mongo error in errors[]', t2.data);
  } else {
    bad(`expect 400 got ${t2.status}`, t2.data);
    if (t2.data?.data?._id) createdTeamIds.push(t2.data.data._id);
  }

  // ── T3: Mongo OK + Redis fake ────────────────────────────────────────
  sec('T3: Mongo OK + Redis fake → 400 ping redis');
  const t3 = await api('POST', '/team', {
    title: `T3-${TS}`, slug: `t3-${TS}`,
    mongodb: { uri: 'mongodb://thaily:Th%40i2004@localhost:10000/?authSource=admin&replicaSet=rs0&directConnection=true' },
    redis: { host: 'nowhere.invalid', port: 12345, db: 0 },
    r2: { endpoint: 'https://localhost', region: 'auto', access_key: 'x', secret_key: 'y', bucket: 'z' },
  }, token);
  if (t3.status === 400) {
    const errors = t3.data?.data?.errors || t3.data?.errors || [];
    const redisErr = errors.find((e: any) => e.service === 'redis');
    if (redisErr) ok(`reject redis: ${redisErr.message.slice(0, 80)}…`);
    else bad('expect redis error in errors[]', t3.data);
  } else {
    bad(`expect 400 got ${t3.status}`, t3.data);
    if (t3.data?.data?._id) createdTeamIds.push(t3.data.data._id);
  }

  // ── T4: Mongo+Redis OK + R2 fake ────────────────────────────────────
  sec('T4: Mongo+Redis OK + R2 fake → 400 ping r2');
  const t4 = await api('POST', '/team', {
    title: `T4-${TS}`, slug: `t4-${TS}`,
    mongodb: { uri: 'mongodb://thaily:Th%40i2004@localhost:10000/?authSource=admin&replicaSet=rs0&directConnection=true' },
    redis: { host: 'localhost', port: 10002, password: 'Th@i2004', db: 0 },
    r2: { endpoint: 'https://nowhere.invalid', region: 'auto', access_key: 'x', secret_key: 'y', bucket: 'never-exist' },
  }, token);
  if (t4.status === 400) {
    const errors = t4.data?.data?.errors || t4.data?.errors || [];
    const r2Err = errors.find((e: any) => e.service === 'r2');
    if (r2Err) ok(`reject r2: ${r2Err.message.slice(0, 80)}…`);
    else bad('expect r2 error in errors[]', t4.data);
  } else {
    bad(`expect 400 got ${t4.status}`, t4.data);
    if (t4.data?.data?._id) createdTeamIds.push(t4.data.data._id);
  }

  // ── T5: tenant missing team_id ─────────────────────────────────────────
  sec('T5: POST /tenant thiếu team_id → 400');
  const t5 = await api('POST', '/tenant', {
    title: `T5-${TS}`, slug: `t5-${TS}`, type: 'public',
  }, token);
  if (t5.status === 400) {
    const code = t5.data?.code || t5.data?.data?.code || '';
    const msg = t5.data?.message || t5.data?.data?.message || '';
    if (code === 'TENANT_TEAM_REQUIRED' || /team_id/i.test(msg)) ok(`reject: ${code || msg.slice(0, 60)}`);
    else bad('expect team_id required', t5.data);
  } else {
    bad(`expect 400 got ${t5.status}`, t5.data);
    if (t5.data?.data?._id) createdTenantIds.push(t5.data.data._id);
  }

  // ── T6: team_id doesn't exist ────────────────────────────────────────
  sec('T6: team_id không tồn tại → 404');
  const fakeTeamId = '000000000000000000000000';
  const t6 = await api('POST', '/tenant', {
    title: `T6-${TS}`, slug: `t6-${TS}`, type: 'public', team_id: fakeTeamId,
  }, token);
  if (t6.status === 404 || (t6.status === 400 && /team.*not found/i.test(t6.data?.message || ''))) {
    ok(`reject not found`);
  } else {
    bad(`expect 404 got ${t6.status}`, t6.data);
    if (t6.data?.data?._id) createdTenantIds.push(t6.data.data._id);
  }

  // ── T7: duplicate slug within the same team ──────────────────────────────
  sec('T7: slug duplicate → 409');
  // Use the default team
  const teamsList = await api('GET', '/team', undefined, token);
  const defaultTeam = (teamsList.data?.data || []).find((t: any) => t.slug === 'default');
  if (!defaultTeam) { bad('không tìm thấy default team', teamsList.data); }
  else {
    // Get an existing tenant slug
    const existingTenants = await api('GET', '/tenant', undefined, token);
    const sample = (existingTenants.data?.data || [])[0];
    if (!sample) { bad('không có tenant nào để test dup'); }
    else {
      const t7 = await api('POST', '/tenant', {
        title: `T7-${TS}`, slug: sample.slug, type: 'public', team_id: defaultTeam._id,
      }, token);
      if (t7.status === 409) ok(`reject dup slug='${sample.slug}'`);
      else {
        bad(`expect 409 got ${t7.status}`, t7.data);
        if (t7.data?.data?._id) createdTenantIds.push(t7.data.data._id);
      }
    }
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`  passed: ${PASS_COUNT}`);
  console.log(`  failed: ${FAIL}`);

  // Cleanup leaks
  if (createdTeamIds.length || createdTenantIds.length) {
    console.log(`\n⚠ Leaked docs (unexpected creates): teams=${createdTeamIds.length}, tenants=${createdTenantIds.length}`);
    console.log(`  Manual cleanup: mongo db.team/tenant.deleteMany({_id:{$in:[${[...createdTeamIds, ...createdTenantIds].join(', ')}]}})`);
  }
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(2); });
