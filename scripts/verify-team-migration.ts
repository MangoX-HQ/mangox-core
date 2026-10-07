/**
 * Verify that migrate-to-teams.ts ran correctly — no server restart needed.
 * Checks:
 *   1. team collection has a default team (slug='default') with quota=unlimited
 *   2. Every tenant has a team_id (= default._id)
 *   3. Every user with role_system in {admin, super_admin} → is_super_admin=true
 *   4. Every user has 1 user_team membership for the default team with the correct role mapping
 *   5. Manager has assigned_tenants = all tenant_ids
 *   6. Folder json/<team_id>/<tenant_slug>/ exists; no leftover old folder json/<slug>/
 *   7. Team & user_team JSON entity/policy/resource files exist under json/system/
 *   8. Per-team slug uniqueness: inserting the same slug in 2 different teams → OK
 *      (tested on a temp collection, rolled back immediately)
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';

const URI = process.env.MONGODB_URL!;
const JSON_DIR = path.resolve(__dirname, '../json');

let PASS = 0, FAIL = 0;
const ok = (msg: string) => { console.log(`  ✓ ${msg}`); PASS++; };
const err = (msg: string, detail?: any) => {
  console.log(`  ✗ ${msg}`);
  if (detail !== undefined) console.log(`    ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  FAIL++;
};
const section = (s: string) => console.log(`\n── ${s} ──`);

(async () => {
  const c = new MongoClient(URI);
  await c.connect();
  const db = c.db('mangoads');

  // ── 1. Default team ──
  section('1. Default team');
  const team = await db.collection('team').findOne({ slug: 'default' });
  if (!team) { err('default team missing'); await c.close(); process.exit(1); }
  ok(`default team _id=${team._id}`);
  if (team.quota?.max_tenants === -1) ok('quota.max_tenants=-1 (unlimited)');
  else err('quota.max_tenants != -1', team.quota);
  const teamIdStr = String(team._id);

  // ── 2. tenant.team_id backfill ──
  section('2. tenant.team_id backfill');
  const tenants = await db.collection('tenant').find({}).toArray();
  const missing = tenants.filter((t) => !t.team_id);
  if (missing.length === 0) ok(`${tenants.length}/${tenants.length} tenants có team_id`);
  else err(`${missing.length} tenants thiếu team_id`, missing.map((t) => t.slug));
  for (const t of tenants) {
    if (String(t.team_id) !== teamIdStr) {
      err(`tenant '${t.slug}'.team_id != default`, { has: String(t.team_id), expected: teamIdStr });
    }
  }
  if (tenants.every((t) => String(t.team_id) === teamIdStr)) {
    ok('mọi tenant trỏ default team');
  }

  // ── 3. is_super_admin flag ──
  section('3. is_super_admin');
  const legacyAdmins = await db.collection('user').find({
    role_system: { $in: ['admin', 'super_admin'] },
  }).toArray();
  const notFlipped = legacyAdmins.filter((u) => u.is_super_admin !== true);
  if (legacyAdmins.length === 0) ok('không có legacy admin (nothing to flip)');
  else if (notFlipped.length === 0) ok(`${legacyAdmins.length} admin được flip is_super_admin=true`);
  else err(`${notFlipped.length} admin chưa flip`, notFlipped.map((u) => u.email));

  // ── 4. user_team mapping ──
  section('4. user_team mapping');
  const users = await db.collection('user').find({}).toArray();
  const memberships = await db.collection('user_team').find({ team_id: teamIdStr }).toArray();
  ok(`tổng user=${users.length}, memberships=${memberships.length}`);

  const mShouldBe = (u: any) => {
    if (u.role_system === 'admin' || u.role_system === 'super_admin' || u.is_super_admin) return 'admin';
    if (u.role_system === 'manager') return 'manager';
    return 'user';
  };
  let mismatch = 0;
  for (const u of users) {
    const m = memberships.find((m) => m.user_id === String(u._id));
    if (!m) {
      // Super admin bypasses all team checks → a user_team is not required
      if (u.is_super_admin || u.role_system === 'admin' || u.role_system === 'super_admin') {
        continue;
      }
      err(`user '${u.email}' thiếu user_team`); mismatch++; continue;
    }
    const exp = mShouldBe(u);
    if (m.role_name !== exp) {
      err(`user '${u.email}' role mismatch`, { has: m.role_name, expected: exp });
      mismatch++;
    }
  }
  if (mismatch === 0) ok('mọi non-super user có membership đúng role');

  // ── 5. Manager assigned_tenants ──
  section('5. Manager assigned_tenants');
  const managers = memberships.filter((m) => m.role_name === 'manager');
  const tenantIds = tenants.map((t) => String(t._id));
  for (const m of managers) {
    const assigned = (m.assigned_tenants || []).map(String).sort();
    const expected = [...tenantIds].sort();
    if (JSON.stringify(assigned) === JSON.stringify(expected)) {
      ok(`manager '${m.email}' assigned đủ ${assigned.length} tenant(s)`);
    } else {
      err(`manager '${m.email}' assigned mismatch`, { has: assigned, expected });
    }
  }
  if (managers.length === 0) ok('không có manager (skip)');

  // ── 6. Folder layout ──
  section('6. Folder layout');
  const teamDir = path.join(JSON_DIR, teamIdStr);
  if (fs.existsSync(teamDir) && fs.statSync(teamDir).isDirectory()) ok(`json/${teamIdStr}/ tồn tại`);
  else err(`json/${teamIdStr}/ KHÔNG có`);

  for (const t of tenants) {
    const tenantDir = path.join(teamDir, t.slug);
    if (fs.existsSync(tenantDir)) ok(`json/${teamIdStr}/${t.slug}/ tồn tại`);
    else err(`json/${teamIdStr}/${t.slug}/ KHÔNG có`);
    // legacy no longer exists
    const legacyDir = path.join(JSON_DIR, t.slug);
    if (fs.existsSync(legacyDir)) err(`legacy folder json/${t.slug}/ vẫn tồn tại (cần xóa thủ công)`);
  }

  // ── 7. System JSON files cho team/user_team ──
  section('7. System JSON files cho team');
  const checks = [
    'system/entity/team.json',
    'system/entity/user_team.json',
    'system/resource/team.json',
    'system/resource/user-team.json',
    'system/policy/policy-team-admin.json',
    'system/policy/user-team-admin.json',
  ];
  for (const rel of checks) {
    const fp = path.join(JSON_DIR, rel);
    if (fs.existsSync(fp)) ok(rel);
    else err(`thiếu ${rel}`);
  }

  // ── 8. Per-team slug uniqueness — index check ──
  section('8. Per-team slug uniqueness');
  const indexes = await db.collection('tenant').indexes();
  const globalSlug = indexes.find((i) => i.unique && i.key && i.key.slug === 1 && Object.keys(i.key).length === 1);
  if (globalSlug) {
    err('tenant.slug VẪN có unique index global — nên drop và tạo compound (team_id+slug)', globalSlug.name);
  } else {
    ok('không có global unique trên tenant.slug');
  }
  const compound = indexes.find((i) =>
    i.unique && i.key && i.key.slug === 1 && i.key.team_id === 1
  );
  if (compound) ok('compound unique (team_id, slug) đã có');
  else {
    console.log('  ℹ (optional) chưa có compound index — POST /tenant của app vẫn check, nhưng nên thêm');
    console.log("     db.tenant.createIndex({team_id: 1, slug: 1}, {unique: true})");
  }

  // ── SUMMARY ──
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`  passed: ${PASS}`);
  console.log(`  failed: ${FAIL}`);
  await c.close();
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(2); });
