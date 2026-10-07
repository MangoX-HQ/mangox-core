/**
 * Migrate to team-based RBAC (REFACTOR_TEAMS.md §8).
 *
 * What it does (idempotent):
 *   1. CREATE default team {slug:'default', plan:'enterprise', quota:max=-1}
 *   2. BACKFILL tenant.team_id = default._id for every tenant lacking it
 *   3. MOVE folder json/<tenant_slug>/ → json/<default_team_id>/<tenant_slug>/
 *   4. MIGRATE Redis: copy keys schema:<app>:tenant:<slug>:* → schema:<app>:tenant:<team>/<slug>:*
 *      (delete old after copy)
 *   5. FOR EACH user: set is_super_admin = (role_system in {admin, super_admin})
 *      and INSERT user_team(user_id, default_team_id, role_name = mapped role,
 *      assigned_tenants = all tenant ids for admin/manager).
 *
 * Usage:
 *   npx tsx scripts/migrate-to-teams.ts --dry-run    # report only
 *   npx tsx scripts/migrate-to-teams.ts              # apply
 *
 * Safe to re-run: every step checks before mutate.
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';

const MAIN_URI =
  process.env.MONGODB_URL ||
  'mongodb://thaily:Th%40i2004@localhost:10000/mangoads?authSource=admin&replicaSet=rs0&directConnection=true';
const APP_NAME = process.env.APP_NAME || 'mangoads';
const JSON_DIR = path.resolve(__dirname, '../json');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = parseInt(process.env.REDIS_DB || '0');

const DRY_RUN = process.argv.includes('--dry-run');
const log = (...args: any[]) => console.log(`[migrate-teams${DRY_RUN ? ':dry' : ''}]`, ...args);

const DEFAULT_TEAM = {
  slug: 'default',
  title: 'System Default Team',
  description: 'Auto-created by migrate-to-teams.ts — chứa tất cả tenant hiện hữu. CẦN PUT /team/<id> điền mongodb/redis/r2 thật trước khi tạo tenant mới.',
  plan: 'enterprise',
  is_active: true,
  owner_id: [] as string[],
  // Placeholder infra config — must be updated via PUT /team/<id> before
  // POST /tenant will work (validation will fail if left as placeholder).
  mongodb: { uri: 'PLACEHOLDER://update-via-PUT-team', db_prefix: '' },
  redis: { host: 'PLACEHOLDER', port: 6379, db: 0 },
  r2: {
    endpoint: 'https://PLACEHOLDER.r2.example',
    region: 'auto',
    access_key: 'PLACEHOLDER',
    secret_key: 'PLACEHOLDER',
    bucket: 'PLACEHOLDER',
  },
  quota: { max_tenants: -1, max_storage_mb: -1, max_users: -1 },
};

async function run() {
  const mongo = new MongoClient(MAIN_URI);
  await mongo.connect();
  const dbName = new URL(MAIN_URI.replace('mongodb://', 'http://')).pathname.replace(/^\//, '') || 'mangoads';
  const db = mongo.db(dbName);
  log(`Connected to mongo db='${dbName}'`);

  // Redis is OPTIONAL — if it's down, step 4 (rename schema keys) is skipped, and the server
  // will auto-warm Redis from the new JSON folder layout on restart.
  let redis: Redis | null = null;
  try {
    redis = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      password: REDIS_PASSWORD,
      db: REDIS_DB,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    await redis.connect();
    log(`Connected to redis ${REDIS_HOST}:${REDIS_PORT} db=${REDIS_DB}`);
  } catch (e: any) {
    log(`Redis unavailable (${e?.message}) — sẽ SKIP step 4 (rename schema keys). Restart server sẽ warm lại từ JSON.`);
    redis = null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 1 — ensure default team
  // ─────────────────────────────────────────────────────────────────
  let team = await db.collection('team').findOne({ slug: DEFAULT_TEAM.slug });
  if (!team) {
    const now = new Date();
    const doc = { ...DEFAULT_TEAM, created_at: now, updated_at: now };
    if (DRY_RUN) {
      log('would CREATE team:', doc.slug);
      // Synthetic _id for downstream dry-run logging
      team = { ...doc, _id: new ObjectId() };
    } else {
      const ins = await db.collection('team').insertOne(doc);
      team = { ...doc, _id: ins.insertedId };
      log(`CREATED team _id=${team._id}, slug=${team.slug}`);
    }
  } else {
    log(`team '${team.slug}' exists, _id=${team._id}`);
  }
  const teamIdStr = String(team._id);

  // ─────────────────────────────────────────────────────────────────
  // Step 2 — backfill tenant.team_id
  // ─────────────────────────────────────────────────────────────────
  const tenants = await db.collection('tenant').find({}).toArray();
  const tenantsToBackfill = tenants.filter((t) => !t.team_id);
  log(`tenants total=${tenants.length}, missing team_id=${tenantsToBackfill.length}`);
  if (tenantsToBackfill.length > 0) {
    if (DRY_RUN) {
      log('would SET team_id for tenants:', tenantsToBackfill.map((t) => t.slug).join(', '));
    } else {
      const r = await db.collection('tenant').updateMany(
        { _id: { $in: tenantsToBackfill.map((t) => t._id) } },
        { $set: { team_id: teamIdStr, updated_at: new Date() } },
      );
      log(`UPDATED tenants matched=${r.matchedCount} modified=${r.modifiedCount}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 3 — move folders json/<tenant_slug>/ → json/<team_id>/<tenant_slug>/
  // ─────────────────────────────────────────────────────────────────
  const tenantSlugs = tenants.map((t) => t.slug).filter(Boolean) as string[];
  for (const slug of tenantSlugs) {
    const oldDir = path.join(JSON_DIR, slug);
    const newDir = path.join(JSON_DIR, teamIdStr, slug);
    if (!fs.existsSync(oldDir)) continue;
    if (fs.existsSync(newDir)) {
      log(`folder ALREADY at new path: ${teamIdStr}/${slug} — skipping`);
      continue;
    }
    if (DRY_RUN) {
      log(`would MOVE ${slug}/ → ${teamIdStr}/${slug}/`);
    } else {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);
      log(`MOVED folder ${slug}/ → ${teamIdStr}/${slug}/`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 4 — migrate Redis keys schema:<app>:tenant:<slug>:* → schema:<app>:tenant:<team>/<slug>:*
  // ─────────────────────────────────────────────────────────────────
  if (!redis) {
    log('Step 4 SKIPPED (Redis unavailable)');
  } else {
    let redisCopied = 0;
    for (const slug of tenantSlugs) {
      const oldPrefix = `schema:${APP_NAME}:tenant:${slug}:`;
      const newPrefix = `schema:${APP_NAME}:tenant:${teamIdStr}:${slug}:`;
      const keys = await redis.keys(`${oldPrefix}*`);
      if (keys.length === 0) continue;
      for (const oldKey of keys) {
        const suffix = oldKey.slice(oldPrefix.length);
        const newKey = `${newPrefix}${suffix}`;
        const exists = await redis.exists(newKey);
        if (exists) continue;
        if (DRY_RUN) {
          log(`would COPY redis ${oldKey} → ${newKey}`);
        } else {
          await redis.rename(oldKey, newKey).catch((e) => log(`RENAME failed: ${e?.message}`));
          redisCopied += 1;
        }
      }
    }
    if (redisCopied > 0) log(`RENAMED ${redisCopied} redis schema keys`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 5 — users: is_super_admin + user_team membership
  // ─────────────────────────────────────────────────────────────────
  const users = await db.collection('user').find({}).toArray();
  const tenantIdStrings = tenants.map((t) => String(t._id));
  let usersFlippedSuper = 0;
  let membershipsCreated = 0;

  for (const user of users) {
    const userId = String(user._id);
    const role = user.role_system as string | undefined;
    const isSuper = role === 'admin' || role === 'super_admin';
    const isManager = role === 'manager';

    // 5a. is_super_admin
    if (isSuper && user.is_super_admin !== true) {
      if (DRY_RUN) {
        log(`would SET is_super_admin=true for user '${user.email || userId}'`);
      } else {
        await db.collection('user').updateOne({ _id: user._id }, { $set: { is_super_admin: true } });
        usersFlippedSuper += 1;
      }
    }

    // 5b. user_team for default team
    const existingMembership = await db.collection('user_team').findOne({
      user_id: userId,
      team_id: teamIdStr,
    });
    if (!existingMembership) {
      const teamRole = isSuper ? 'admin' : isManager ? 'manager' : 'user';
      const assigned = teamRole === 'manager' ? tenantIdStrings : [];
      const now = new Date();
      const doc = {
        user_id: userId,
        team_id: teamIdStr,
        role_name: teamRole,
        assigned_tenants: assigned,
        is_active: user.is_active !== false,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        created_at: now,
        updated_at: now,
      };
      if (DRY_RUN) {
        log(`would INSERT user_team(${user.email || userId}, role=${teamRole}${teamRole === 'manager' ? `, assigned=${assigned.length}` : ''})`);
      } else {
        await db.collection('user_team').insertOne(doc);
        membershipsCreated += 1;
      }
    }
  }
  log(`users flipped to super=${usersFlippedSuper}, memberships created=${membershipsCreated}`);

  // ─────────────────────────────────────────────────────────────────
  // Done
  // ─────────────────────────────────────────────────────────────────
  log(DRY_RUN ? '─── DRY RUN COMPLETE (no changes) ───' : '─── MIGRATION COMPLETE ───');
  log(`Default team _id = ${teamIdStr}`);
  log(`Tenants under team: ${tenants.length}`);
  log(`Restart server to pick up new layout.`);

  await mongo.close();
  if (redis) await redis.quit().catch(() => {});
}

run().catch((e) => {
  console.error('[migrate-teams] FAILED:', e);
  process.exit(1);
});
