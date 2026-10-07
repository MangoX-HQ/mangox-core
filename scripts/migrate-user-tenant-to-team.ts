/**
 * Migrate user_tenant → user_team.tenant_roles
 *
 * Embed per-tenant roles into user_team membership. After migration:
 *   - any role=user with a user_tenant for tenant X → tenant_roles gets { tenant_id, role_name }
 *   - if the user has no user_team yet for the team containing the tenant → create one with role=user
 *
 * Idempotent: safe to run again (only adds entries that don't exist yet).
 *
 * Usage:
 *   npx tsx scripts/migrate-user-tenant-to-team.ts --dry-run
 *   npx tsx scripts/migrate-user-tenant-to-team.ts
 *   npx tsx scripts/migrate-user-tenant-to-team.ts --drop-user-tenant   # drop the collection after migrating
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const URI = process.env.MONGODB_URL!;
const DRY = process.argv.includes('--dry-run');
const DROP = process.argv.includes('--drop-user-tenant');
const log = (...a: any[]) => console.log(`[migrate-ut-to-team${DRY ? ':dry' : ''}]`, ...a);

(async () => {
  const c = new MongoClient(URI);
  await c.connect();
  const db = c.db('mangoads');

  const [userTenants, tenants, userTeams, users] = await Promise.all([
    db.collection('user_tenant').find({ is_active: { $ne: false } }).toArray(),
    db.collection('tenant').find({}).toArray(),
    db.collection('user_team').find({}).toArray(),
    db.collection('user').find({}, { projection: { username: 1, email: 1, full_name: 1 } }).toArray(),
  ]);

  log(`Load: ${userTenants.length} user_tenant, ${userTeams.length} user_team, ${tenants.length} tenants, ${users.length} users`);

  const tenantById = new Map(tenants.map((t: any) => [String(t._id), t]));
  const userById = new Map(users.map((u: any) => [String(u._id), u]));
  // index user_team theo (user_id|team_id)
  const utByKey = new Map<string, any>();
  for (const ut of userTeams) utByKey.set(`${ut.user_id}|${ut.team_id}`, ut);

  // Group user_tenant by (user_id, team_id derived from tenant.team_id)
  const updates = new Map<string, {
    membershipId: any | null;
    user_id: string;
    team_id: string;
    user: any;
    newTenantRoles: Array<{ tenant_id: string; role_name: string }>;
  }>();

  let skippedNoTeam = 0;
  let skippedDuplicate = 0;
  for (const ut of userTenants) {
    const tenant = tenantById.get(String(ut.tenant_id));
    if (!tenant?.team_id) { skippedNoTeam++; continue; }
    const teamId = String(tenant.team_id);
    const userId = String(ut.user_id);
    const key = `${userId}|${teamId}`;

    const existing = utByKey.get(key);
    // Skip if admin/manager — they bypass tenant_roles
    if (existing?.role_name === 'admin' || existing?.role_name === 'manager') {
      skippedDuplicate++; continue;
    }
    // Skip if an entry for this tenant already exists
    const existingRoles: any[] = existing?.tenant_roles ?? [];
    if (existingRoles.some((tr: any) => String(tr.tenant_id) === String(ut.tenant_id))) {
      skippedDuplicate++; continue;
    }

    let entry = updates.get(key);
    if (!entry) {
      entry = {
        membershipId: existing?._id ?? null,
        user_id: userId,
        team_id: teamId,
        user: userById.get(userId) ?? null,
        newTenantRoles: [...existingRoles],
      };
      updates.set(key, entry);
    }
    entry.newTenantRoles.push({
      tenant_id: String(ut.tenant_id),
      role_name: ut.role_name || 'viewer',
    });
  }

  log(`Plan: ${updates.size} user_team to update/create. Skipped: ${skippedNoTeam} (tenant no team_id), ${skippedDuplicate} (admin/mgr/already)`);

  let created = 0, updated = 0;
  for (const entry of updates.values()) {
    if (entry.membershipId) {
      log(`UPDATE user_team(${entry.membershipId}) += ${entry.newTenantRoles.length} tenant_roles`);
      if (!DRY) {
        await db.collection('user_team').updateOne(
          { _id: entry.membershipId },
          { $set: { tenant_roles: entry.newTenantRoles, updated_at: new Date() } },
        );
        updated++;
      }
    } else {
      log(`CREATE user_team{user=${entry.user?.email || entry.user_id}, team=${entry.team_id}, role=user, tenant_roles=${entry.newTenantRoles.length}}`);
      if (!DRY) {
        const now = new Date();
        await db.collection('user_team').insertOne({
          user_id: entry.user_id,
          team_id: entry.team_id,
          role_name: 'user',
          assigned_tenants: [],
          tenant_roles: entry.newTenantRoles,
          is_active: true,
          username: entry.user?.username,
          full_name: entry.user?.full_name,
          email: entry.user?.email,
          created_at: now,
          updated_at: now,
        });
        created++;
      }
    }
  }

  log(`Done: created=${created}, updated=${updated}`);

  if (DROP) {
    log('Dropping user_tenant collection…');
    if (DRY) log('would DROP user_tenant');
    else {
      await db.collection('user_tenant').drop().catch((e) => log('drop failed:', e.message));
    }
  } else {
    log(`(skip drop user_tenant — pass --drop-user-tenant to delete after verifying)`);
  }

  await c.close();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
