/**
 * E2E SCENARIO TEST — team-based RBAC (DB + filesystem level, no HTTP needed).
 *
 * Setup:
 *   ── Teams ──
 *     team-alpha      (admin: alice, manager: bob, user: carol)
 *     team-beta       (admin: dave; eve = admin alpha + user beta cross-team)
 *
 *   ── Tenants ──
 *     team-alpha: alpha-shop  + alpha-blog
 *     team-beta : beta-shop   + beta-blog
 *     (slug 'shop'/'blog' do NOT clash cross-team in this scenario — but
 *      we'll also run a bonus test: 1 tenant with the same slug in 2 teams to verify per-team unique)
 *
 *   ── Users ──
 *     alice  : team-alpha admin
 *     bob    : team-alpha manager  + assigned [alpha-shop] only
 *     carol  : team-alpha user     + user_tenant(carol → alpha-blog, role=editor)
 *     dave   : team-beta admin
 *     eve    : team-alpha admin    + team-beta user
 *                                  + user_tenant(eve → beta-shop, role=viewer)
 *
 *   ── Entity JSON files ──
 *     json/<alpha_id>/alpha-shop/entity/product.json       (override)
 *     json/<beta_id>/beta-shop/entity/product.json         (DIFFERENT content)
 *     → verify cross-team isolation (same entity name but different content)
 *
 *   ── Per-team slug bonus ──
 *     json/<alpha_id>/shared-slug/  + tenant.slug='shared-slug', team=alpha
 *     json/<beta_id>/shared-slug/   + tenant.slug='shared-slug', team=beta
 *     → verify 2 tenants with the same slug get separate folder + DB records
 *
 * Test matrix (28 expectations):
 *   ────────────────────────────────┬───────────┬────────────┬───────────┐
 *   user × tenant                   │ expected  │ expected   │ source    │
 *                                   │ ok        │ role       │           │
 *   ────────────────────────────────┼───────────┼────────────┼───────────┤
 *   alice  × alpha-shop             │ true      │ admin      │ team_admin
 *   alice  × alpha-blog             │ true      │ admin      │ team_admin
 *   alice  × beta-shop              │ false     │ -          │ denied
 *   bob    × alpha-shop             │ true      │ admin      │ manager_assigned
 *   bob    × alpha-blog             │ false     │ -          │ denied      (not assigned, no user_tenant)
 *   carol  × alpha-shop             │ false     │ -          │ denied
 *   carol  × alpha-blog             │ true      │ editor     │ user_tenant
 *   dave   × alpha-shop             │ false     │ -          │ denied
 *   dave   × beta-shop              │ true      │ admin      │ team_admin
 *   eve    × alpha-shop             │ true      │ admin      │ team_admin
 *   eve    × beta-shop              │ true      │ viewer     │ user_tenant (manager-not-assigned-fallback)
 *   eve    × beta-blog              │ false     │ -          │ denied      (user role, no user_tenant)
 *
 * Cleanup: all docs + folders after the test, do NOT touch old data.
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';
import bcrypt from 'bcrypt';
import { getEffectiveTenantRole, canCreateTenantInTeam } from '../src/module/_team/helpers';
import { isSuperAdmin } from '../src/module/_auth/types';

const URI = process.env.MONGODB_URL!;
const JSON_DIR = path.resolve(__dirname, '../json');
const TS = Date.now();
const TAG = `e2e-${TS}`;   // suffix for safe cleanup
const PASS_HASH = bcrypt.hashSync('Test@1234', 10);

let PASS = 0, FAIL = 0;
const ok = (msg: string) => { console.log(`  ✓ ${msg}`); PASS++; };
const bad = (msg: string, detail?: any) => {
  console.log(`  ✗ ${msg}`);
  if (detail !== undefined) console.log(`    ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  FAIL++;
};
const section = (s: string) => console.log(`\n── ${s} ──`);

interface Created {
  teamIds: string[];
  tenantIds: string[];
  userIds: string[];
  userTeamIds: string[];
  userTenantIds: string[];
  folderPaths: string[];
}

const created: Created = {
  teamIds: [], tenantIds: [], userIds: [],
  userTeamIds: [], userTenantIds: [], folderPaths: [],
};

(async () => {
  const c = new MongoClient(URI);
  await c.connect();
  const db = c.db('mangoads');

  try {
    // ═══════════════════════════════════════════════════════════════════
    // SETUP
    // ═══════════════════════════════════════════════════════════════════
    section(`SETUP — tag=${TAG}`);

    const insertTeam = async (slug: string) => {
      const doc: any = {
        slug: `${slug}-${TAG}`, title: slug, description: TAG,
        plan: 'enterprise', is_active: true, owner_id: [],
        quota: { max_tenants: -1, max_storage_mb: -1, max_users: -1 },
        created_at: new Date(), updated_at: new Date(),
      };
      const r = await db.collection('team').insertOne(doc);
      created.teamIds.push(String(r.insertedId));
      return { ...doc, _id: r.insertedId };
    };
    const alpha = await insertTeam('team-alpha');
    const beta = await insertTeam('team-beta');
    ok(`team alpha=${alpha._id}, beta=${beta._id}`);

    const insertTenant = async (slug: string, teamId: ObjectId) => {
      const doc: any = {
        slug, title: slug, type: 'public', team_id: String(teamId),
        is_active: true, created_at: new Date(), updated_at: new Date(),
      };
      const r = await db.collection('tenant').insertOne(doc);
      created.tenantIds.push(String(r.insertedId));
      // Folder
      const dir = path.join(JSON_DIR, String(teamId), slug);
      fs.mkdirSync(dir, { recursive: true });
      created.folderPaths.push(dir);
      return { ...doc, _id: r.insertedId };
    };
    const alphaShop = await insertTenant(`alpha-shop-${TAG}`, alpha._id);
    const alphaBlog = await insertTenant(`alpha-blog-${TAG}`, alpha._id);
    const betaShop = await insertTenant(`beta-shop-${TAG}`, beta._id);
    const betaBlog = await insertTenant(`beta-blog-${TAG}`, beta._id);
    ok(`4 tenants tạo trong 2 team`);

    // Bonus: tenant with a MATCHING slug in 2 teams
    const sharedSlug = `shared-${TAG}`;
    const sharedAlpha = await insertTenant(sharedSlug, alpha._id);
    const sharedBeta = await insertTenant(sharedSlug, beta._id);
    ok(`shared slug '${sharedSlug}' tạo OK ở cả 2 team (per-team unique)`);

    // Users
    const insertUser = async (name: string, role_system = 'user') => {
      const doc: any = {
        email: `${name}-${TAG}@e2e.local`,
        username: `${name}_${TAG}`,
        full_name: name,
        phone: '0900000000',
        password: PASS_HASH,
        role_system,
        is_super_admin: false,
        is_active: true,
        created_at: new Date(), updated_at: new Date(),
      };
      const r = await db.collection('user').insertOne(doc);
      created.userIds.push(String(r.insertedId));
      return { ...doc, _id: r.insertedId };
    };
    const alice = await insertUser('alice');
    const bob = await insertUser('bob');
    const carol = await insertUser('carol');
    const dave = await insertUser('dave');
    const eve = await insertUser('eve');
    ok(`5 users inserted`);

    // user_team memberships
    const addMembership = async (
      user: any, team: any, role_name: string, assigned: string[] = [],
    ) => {
      const doc: any = {
        user_id: String(user._id), team_id: String(team._id),
        role_name, assigned_tenants: assigned, is_active: true,
        username: user.username, full_name: user.full_name, email: user.email,
        created_at: new Date(), updated_at: new Date(),
      };
      const r = await db.collection('user_team').insertOne(doc);
      created.userTeamIds.push(String(r.insertedId));
      return { ...doc, _id: r.insertedId };
    };
    await addMembership(alice, alpha, 'admin');
    await addMembership(bob, alpha, 'manager', [String(alphaShop._id)]);
    await addMembership(carol, alpha, 'user');
    await addMembership(dave, beta, 'admin');
    await addMembership(eve, alpha, 'admin');
    await addMembership(eve, beta, 'user');
    ok(`6 user_team rows inserted`);

    // user_tenant memberships (for fallback)
    const addUserTenant = async (user: any, tenant: any, role_name: string) => {
      const doc: any = {
        user_id: String(user._id), tenant_id: String(tenant._id),
        role_name, is_active: true,
        username: user.username, full_name: user.full_name, email: user.email,
        created_at: new Date(), updated_at: new Date(),
      };
      const r = await db.collection('user_tenant').insertOne(doc);
      created.userTenantIds.push(String(r.insertedId));
      return doc;
    };
    await addUserTenant(carol, alphaBlog, 'editor');
    await addUserTenant(eve, betaShop, 'viewer');
    ok(`2 user_tenant rows inserted (cho fallback)`);

    // Entity files (override)
    const writeEntity = (teamId: ObjectId, tenantSlug: string, slug: string, content: any) => {
      const dir = path.join(JSON_DIR, String(teamId), tenantSlug, 'entity');
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, `${slug}.json`);
      fs.writeFileSync(fp, JSON.stringify(content, null, 2));
      created.folderPaths.push(dir);
    };
    writeEntity(alpha._id, alphaShop.slug, 'product', { title: 'Product (ALPHA edition)', collection_name: 'product', team: 'alpha' });
    writeEntity(beta._id, betaShop.slug, 'product', { title: 'Product (BETA edition)', collection_name: 'product', team: 'beta' });
    ok(`2 entity files (cùng slug 'product', khác content theo team)`);

    // ═══════════════════════════════════════════════════════════════════
    // TEST 1 — Folder layout isolation
    // ═══════════════════════════════════════════════════════════════════
    section('TEST 1 — Folder isolation');
    const alphaProdPath = path.join(JSON_DIR, String(alpha._id), alphaShop.slug, 'entity', 'product.json');
    const betaProdPath = path.join(JSON_DIR, String(beta._id), betaShop.slug, 'entity', 'product.json');
    const alphaContent = JSON.parse(fs.readFileSync(alphaProdPath, 'utf-8'));
    const betaContent = JSON.parse(fs.readFileSync(betaProdPath, 'utf-8'));
    alphaContent.team === 'alpha' ? ok(`alpha product.title = '${alphaContent.title}'`) : bad('alpha content mismatch');
    betaContent.team === 'beta' ? ok(`beta product.title = '${betaContent.title}'`) : bad('beta content mismatch');
    alphaContent.title !== betaContent.title ? ok('cùng slug entity, content khác nhau theo team') : bad('cross-team isolation FAILED');

    // ═══════════════════════════════════════════════════════════════════
    // TEST 2 — Per-team slug
    // ═══════════════════════════════════════════════════════════════════
    section('TEST 2 — Per-team slug uniqueness');
    const sharedDocs = await db.collection('tenant').find({ slug: sharedSlug }).toArray();
    sharedDocs.length === 2 ? ok(`2 tenant cùng slug='${sharedSlug}' tồn tại`) : bad(`expected 2 found ${sharedDocs.length}`);
    const teamIds = sharedDocs.map((t) => String(t.team_id)).sort();
    JSON.stringify(teamIds) === JSON.stringify([String(alpha._id), String(beta._id)].sort())
      ? ok('mỗi shared tenant thuộc team khác nhau') : bad('team_id mismatch', teamIds);
    fs.existsSync(path.join(JSON_DIR, String(alpha._id), sharedSlug))
      ? ok(`folder shared/alpha tồn tại`) : bad('shared/alpha folder MISSING');
    fs.existsSync(path.join(JSON_DIR, String(beta._id), sharedSlug))
      ? ok(`folder shared/beta tồn tại`) : bad('shared/beta folder MISSING');

    // ═══════════════════════════════════════════════════════════════════
    // TEST 3 — RBAC matrix via getEffectiveTenantRole
    // ═══════════════════════════════════════════════════════════════════
    section('TEST 3 — RBAC matrix');
    const matrix: Array<{
      user: any; userName: string; tenant: any; tenantName: string;
      expectOk: boolean; expectRole?: string; expectSource?: string;
    }> = [
      { user: alice, userName: 'alice', tenant: alphaShop, tenantName: 'alpha-shop', expectOk: true, expectRole: 'admin', expectSource: 'team_admin' },
      { user: alice, userName: 'alice', tenant: alphaBlog, tenantName: 'alpha-blog', expectOk: true, expectRole: 'admin', expectSource: 'team_admin' },
      { user: alice, userName: 'alice', tenant: betaShop, tenantName: 'beta-shop', expectOk: false },
      { user: bob, userName: 'bob', tenant: alphaShop, tenantName: 'alpha-shop', expectOk: true, expectRole: 'admin', expectSource: 'team_manager_assigned' },
      { user: bob, userName: 'bob', tenant: alphaBlog, tenantName: 'alpha-blog', expectOk: false },
      { user: carol, userName: 'carol', tenant: alphaShop, tenantName: 'alpha-shop', expectOk: false },
      { user: carol, userName: 'carol', tenant: alphaBlog, tenantName: 'alpha-blog', expectOk: true, expectRole: 'editor', expectSource: 'user_tenant' },
      { user: dave, userName: 'dave', tenant: alphaShop, tenantName: 'alpha-shop', expectOk: false },
      { user: dave, userName: 'dave', tenant: betaShop, tenantName: 'beta-shop', expectOk: true, expectRole: 'admin', expectSource: 'team_admin' },
      { user: eve, userName: 'eve', tenant: alphaShop, tenantName: 'alpha-shop', expectOk: true, expectRole: 'admin', expectSource: 'team_admin' },
      { user: eve, userName: 'eve', tenant: betaShop, tenantName: 'beta-shop', expectOk: true, expectRole: 'viewer', expectSource: 'user_tenant' },
      { user: eve, userName: 'eve', tenant: betaBlog, tenantName: 'beta-blog', expectOk: false },
    ];

    for (const tc of matrix) {
      const access = await getEffectiveTenantRole(db, tc.user, String(tc.tenant._id));
      const label = `${tc.userName} × ${tc.tenantName}`;
      if (access.ok !== tc.expectOk) {
        bad(`${label}: ok mismatch`, { expect: tc.expectOk, got: access.ok, reason: access.reason });
        continue;
      }
      if (tc.expectOk) {
        if (access.role !== tc.expectRole) {
          bad(`${label}: role mismatch`, { expect: tc.expectRole, got: access.role });
          continue;
        }
        if (tc.expectSource && access.source !== tc.expectSource) {
          bad(`${label}: source mismatch`, { expect: tc.expectSource, got: access.source });
          continue;
        }
        ok(`${label} → ${access.role} (${access.source})`);
      } else {
        ok(`${label} → DENIED (${access.reason || access.source})`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST 4 — canCreateTenantInTeam
    // ═══════════════════════════════════════════════════════════════════
    section('TEST 4 — canCreateTenantInTeam');
    const create = await Promise.all([
      canCreateTenantInTeam(db, alice, String(alpha._id)),  // admin alpha → OK
      canCreateTenantInTeam(db, bob, String(alpha._id)),    // manager alpha → OK
      canCreateTenantInTeam(db, carol, String(alpha._id)),  // user alpha → 403
      canCreateTenantInTeam(db, dave, String(alpha._id)),   // not in alpha → 403
      canCreateTenantInTeam(db, eve, String(beta._id)),     // user beta → 403
    ]);
    const expCreate = [true, true, false, false, false];
    const names = ['alice→alpha (admin)', 'bob→alpha (manager)', 'carol→alpha (user)', 'dave→alpha (none)', 'eve→beta (user)'];
    for (let i = 0; i < create.length; i++) {
      create[i].ok === expCreate[i]
        ? ok(`${names[i]} = ${create[i].ok}`)
        : bad(`${names[i]}: expect ${expCreate[i]} got ${create[i].ok}`, create[i]);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TEST 5 — isSuperAdmin helper
    // ═══════════════════════════════════════════════════════════════════
    section('TEST 5 — isSuperAdmin (flag & legacy)');
    isSuperAdmin({ is_super_admin: true } as any) ? ok('flag=true → true') : bad('flag=true expect true');
    isSuperAdmin({ is_super_admin: false } as any) === false ? ok('flag=false → false') : bad('flag=false expect false');
    isSuperAdmin({ role_system: 'admin' } as any) ? ok('legacy role_system=admin → true') : bad('legacy admin expect true');
    isSuperAdmin({ role_system: 'super_admin' } as any) ? ok('legacy super_admin → true') : bad('legacy super_admin expect true');
    isSuperAdmin({ role_system: 'manager' } as any) === false ? ok('legacy manager → false') : bad('legacy manager expect false');
    isSuperAdmin(null) === false ? ok('null → false') : bad('null expect false');

    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════
    console.log(`\n═══ SUMMARY ═══`);
    console.log(`  passed: ${PASS}`);
    console.log(`  failed: ${FAIL}`);
  } catch (e: any) {
    console.error(`\n!!! SCENARIO ABORTED:`, e.stack || e);
    FAIL++;
  } finally {
    // ═══════════════════════════════════════════════════════════════════
    // CLEANUP
    // ═══════════════════════════════════════════════════════════════════
    section('CLEANUP');
    try {
      if (created.userTenantIds.length) await db.collection('user_tenant').deleteMany({
        _id: { $in: created.userTenantIds.map((s) => new ObjectId(s)) },
      });
      if (created.userTeamIds.length) await db.collection('user_team').deleteMany({
        _id: { $in: created.userTeamIds.map((s) => new ObjectId(s)) },
      });
      if (created.userIds.length) await db.collection('user').deleteMany({
        _id: { $in: created.userIds.map((s) => new ObjectId(s)) },
      });
      if (created.tenantIds.length) await db.collection('tenant').deleteMany({
        _id: { $in: created.tenantIds.map((s) => new ObjectId(s)) },
      });
      if (created.teamIds.length) await db.collection('team').deleteMany({
        _id: { $in: created.teamIds.map((s) => new ObjectId(s)) },
      });
      // Folders: only delete TAG-marked subfolders to avoid mistakes
      for (const teamId of created.teamIds) {
        const teamDir = path.join(JSON_DIR, teamId);
        if (fs.existsSync(teamDir)) fs.rmSync(teamDir, { recursive: true, force: true });
      }
      console.log(`  cleaned ${created.userIds.length} users, ${created.teamIds.length} teams, ${created.tenantIds.length} tenants`);
    } catch (e: any) {
      console.log(`  cleanup error: ${e.message}`);
    }
    await c.close();
    process.exit(FAIL > 0 ? 1 : 0);
  }
})().catch((e) => { console.error('FAILED at top:', e.stack || e); process.exit(2); });
