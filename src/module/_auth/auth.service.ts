import * as bcrypt from 'bcrypt';
import { UserProfile, ROLE_SYSTEM, LoginResponse, TokenResponse, RegisterResponse, isSystemAdmin, isSuperAdmin } from './types';
import { getCoreUnified, ICoreUnified } from '../../configs/core';
import { ObjectId } from 'mongodb';
import { AppError } from '../../utils/app-error';
import { getUserTenants, getPoliciesForTenant, getTenantRecord } from '../_setting/setting-mode';
import { schemaManager } from '../../core_v2/schema/manager';
import { getTenantScope } from '../../configs/tenant';
import { revokeAllForUser } from './token-blacklist.service';

/** Build permissions as raw policy array [{entity, resource, action, slug, form}] */
async function buildPermissions(roleSlugs: string[], tenantSlug: string | null): Promise<any[]> {
  if (!roleSlugs.length) return [];
  // Single-tenant: resolveRoleContext returns tenantSlug=null (no membership) → must
  // fall back to getTenantScope() to read the policy AT TENANT SCOPE (where the dashboard stores policy),
  // otherwise only the system policy is read → permissions end up empty even if the role has a policy.
  const policies = await getPoliciesForTenant({ role: { $in: roleSlugs } }, tenantSlug || getTenantScope() || null);
  return policies.map((p: any) => ({
    entity: p.root_entity ?? p.entity ?? null,
    resource: p.resource ?? [],
    action: p.action ?? null,
    slug: p.slug ?? null,
    form: p.form ?? null,
  }));
}

/**
 * Rules (post-approval state machine) that the user's role holds within the tenant — includes next_status
 * so the FE can render approval buttons. admin/super_admin → full (every rule in the tenant).
 */
async function buildUserRules(roleSlugs: string[], tenantSlug: string | null): Promise<any[]> {
  const scope = tenantSlug || getTenantScope() || undefined;
  const ruleMap = (await schemaManager.getAll('rule', scope)) ?? {};
  const allRules = Object.values(ruleMap).map((r: any) => ({
    code: r?.code,
    title: r?.title,
    next_status: r?.next_status ?? [],
    slug: r?.slug,
  }));
  if (!allRules.length) return [];
  if (roleSlugs.includes('admin') || roleSlugs.includes('super_admin')) return allRules;

  const roleMap = (await schemaManager.getAll('role', scope)) ?? {};
  const codes = new Set<string>();
  for (const r of Object.values(roleMap) as any[]) {
    const name = r?.role_name || r?.slug;
    if (name && roleSlugs.includes(name)) (r?.rule || []).forEach((c: any) => codes.add(String(c)));
  }
  return allRules.filter((r) => codes.has(String(r.code)));
}
export class AuthService {
  private db: any;
  private isInitialized = false;

  constructor() {
    // Lazy initialization - don't call here as core may not be ready
  }

  private async ensureInitialized() {
    if (!this.isInitialized) {
      this.db = await getCoreUnified().getInstanceDB('mongodb');
      this.isInitialized = true;
    }
  }

  async debugUserCount(): Promise<any> {
    await this.ensureInitialized();
    try {
      const allUsers = await this.db.collection('user').find().limit(5).toArray();
      return allUsers;
    } catch (error) {
      throw error;
    }
  }

  private createError(message: string, statusCode: number): AppError {
    return new AppError({
      statusCode,
      code: `HTTP_${statusCode}`,
      message,
      expose: statusCode < 500,
    });
  }

  private async checkCoreInitialized() {
    try {
      getCoreUnified();
      await this.ensureInitialized();
    } catch (e) {
      throw this.createError('Core system is not initialized', 500);
    }
  }

  async validateCredentials(email: string, password: string): Promise<UserProfile | null> {
    await this.checkCoreInitialized();
    try {
      const userResult = await this.db.collection('user').findOne({ email });
      if (!userResult) return null;
      if (!bcrypt.compareSync(password, userResult.password ?? '') || userResult.is_active === false) return null;
      return await this.getProfile(email, true, true);
    } catch (error: any) {
      console.error('Error in validateCredentials:', error);
      return null;
    }
  }

  async getProfile(user: any, is_remove_password: boolean = true, is_login: boolean = false, tenantId?: string): Promise<UserProfile> {
    await this.checkCoreInitialized();
    try {
      const userResult = await this.db.collection('user').findOne({ email: user.email ?? user });

      if (!userResult) {
        throw this.createError('User not found', 404);
      }

      if (!is_login) {
        const userToken = await this.db.collection('user_token').findOne({ user_id: userResult._id.toString(), type: 'refresh' });
        if (!userToken) {
          throw this.createError('Session expired, please login again', 401);
        }
      }

      let result: any = { ...userResult };
      if (is_remove_password) result.password = undefined;
      const userId = userResult._id.toString();
      const roleIds: string[] = Array.isArray(userResult.role) ? userResult.role : [];

      // Resolve role slugs / tenant context (shared with getPermissions)
      const { roleSlugs, resolvedTenantSlug, teamAccess } = await this.resolveRoleContext(userResult, tenantId);
      const team = await this.buildTeamSummary(teamAccess);

      // System admin (role_system='admin', legacy 'super_admin'): load permissions
      // for both system + the current tenant, bypassing every tenant access check
      if (isSystemAdmin(userResult.role_system)) {
        const permissions = await buildPermissions(roleSlugs, resolvedTenantSlug ?? null);
        const tenantDoc = tenantId ? await this.resolveTenant(tenantId) : null;
        result.tenant = tenantDoc
          ? { _id: tenantDoc._id?.toString() ?? tenantId, slug: tenantDoc.slug ?? tenantId }
          : (tenantId ? { _id: tenantId, slug: tenantId } : undefined);
        result.role = roleIds.length ? roleIds : [userResult.role_name];
        result.permissions = permissions;
        result.full_name = ((result.first_name || '') + ' ' + (result.last_name || '')).trim();
        result.id = userId;
        if (team) result.team = team;
        result.rule = await buildUserRules(roleSlugs, resolvedTenantSlug ?? null);
        return result;
      }

      // Build permissions from policies
      const permissions = await buildPermissions(roleSlugs, resolvedTenantSlug);

      // Return clean profile — no embedded role objects, no password, no internal fields
      return {
        id: userId,
        email: userResult.email,
        username: userResult.username,
        phone: userResult.phone,
        full_name: ((userResult.first_name || '') + ' ' + (userResult.last_name || '')).trim(),
        first_name: userResult.first_name,
        last_name: userResult.last_name,
        featured_image: userResult.featured_image ?? null,
        cover: userResult.cover ?? null,
        role_system: userResult.role_system,  // needed for JWT signing + guard check
        is_super_admin: !!userResult.is_super_admin || isSystemAdmin(userResult.role_system),
        role_name: roleSlugs[0] ?? userResult.role_name,
        role: roleIds,
        tenant: tenantId
          ? { _id: (await this.resolveTenant(tenantId))?._id?.toString() ?? tenantId, slug: resolvedTenantSlug ?? tenantId }
          : undefined,
        team,
        permissions,
        rule: await buildUserRules(roleSlugs, resolvedTenantSlug ?? null),
        created_at: userResult.created_at,
        updated_at: userResult.updated_at,
      };
    } catch (error: any) {
      console.error('Error in getProfile:', error);
      if (error.statusCode) throw error;
      throw this.createError('Failed to get user profile', 500);
    }
  }

  /** Map tenantAccess (from getUserTenants) to [{_id, slug, title, role}] */
  async resolveTenantIds(tenantAccess: { slug: string; role: any }[]): Promise<{ _id: string; slug: string; title: string; role: string }[]> {
    const results: { _id: string; slug: string; title: string; role: string }[] = [];
    for (const t of tenantAccess) {
      const doc = await getTenantRecord(t.slug);
      if (!doc) continue;
      results.push({
        _id: (doc._id ?? doc.slug)?.toString(),
        slug: doc.slug ?? t.slug,
        title: doc.title ?? '',
        role: t.role?.slug || t.role?.role_name,
      });
    }
    return results;
  }

  /** Resolve tenant by _id string or slug */
  private async resolveTenant(tenantId: string): Promise<any | null> {
    return getTenantRecord(tenantId);
  }

  /**
   * Resolve role slugs + tenant slug for a user within the context of one tenant.
   *
   * Rules:
   *  - Has tenantId:
   *      • System admin → roleSlugs=['admin'] ALWAYS (bypasses the membership check)
   *      • Otherwise → read user_tenant.role_name for that tenant. NO membership → 403.
   *        Role within a tenant is granted by admin/manager via POST /user_tenant, so one
   *        user (role_system='user') can be 'admin' of tenant A and 'editor'
   *        of tenant B.
   *  - No tenantId:
   *      • System admin → roleSlugs=['admin']
   *      • Otherwise → use role_name from the user document (single-tenant flow)
   *
   * resolvedTenantSlug is the slug normalized from tenantId (_id → slug).
   * legacy: scanning role records via user.role[] has been removed — role is now JSON-based,
   * no more ObjectId lookups.
   */
  private async resolveRoleContext(
    userResult: any,
    tenantId?: string
  ): Promise<{
    roleSlugs: string[];
    resolvedTenantSlug: string | null;
    teamAccess?: { team_id: string; role_name: string; source: string };
  }> {
    // Single-tenant: no more team/tenant routing — role is taken directly from the user.
    let roleSlugs: string[] = [];
    if (isSuperAdmin(userResult)) {
      roleSlugs = ['admin'];
    } else if (userResult.role_name) {
      roleSlugs = [userResult.role_name];
    }

    return { roleSlugs, resolvedTenantSlug: null, teamAccess: undefined };
  }

  /** Build {team} object for /auth/me response. null if the user doesn't belong to any team related to the requested tenant. */
  private async buildTeamSummary(teamAccess?: { team_id: string; role_name: string; source: string }): Promise<any | undefined> {
    if (!teamAccess?.team_id) return undefined;
    const oid = ObjectId.isValid(teamAccess.team_id) ? new ObjectId(teamAccess.team_id) : null;
    const team = oid
      ? await this.db.collection('team').findOne({ _id: oid }, { projection: { title: 1, slug: 1 } })
      : null;
    return {
      _id: teamAccess.team_id,
      slug: team?.slug ?? null,
      title: team?.title ?? null,
      role_name: teamAccess.role_name,
      is_admin: teamAccess.role_name === 'admin',
      is_manager: teamAccess.role_name === 'manager',
    };
  }

  /**
   * Get a user's permissions within a tenant (endpoint /auth/permissions).
   * Kept separate from getProfile / login — not embedded in the common payload.
   */
  async getPermissions(emailOrUser: any, tenantId?: string): Promise<any[]> {
    await this.checkCoreInitialized();
    const email = emailOrUser?.email ?? emailOrUser;
    const userResult = await this.db.collection('user').findOne({ email });
    if (!userResult) {
      throw this.createError('User not found', 404);
    }
    const { roleSlugs, resolvedTenantSlug } = await this.resolveRoleContext(userResult, tenantId);
    return buildPermissions(roleSlugs, resolvedTenantSlug);
  }

  /** Get all tenants a user has access to via user_team membership */
  async getTenantsForUser(userId: string): Promise<{ _id: string; slug: string; title: string; role: string }[]> {
    const memberships = await this.db.collection('user_team')
      .find({ user_id: userId, is_active: { $ne: false } })
      .toArray();
    const tenantRoleMap = new Map<string, string>(); // tenantId → effective role (max-priority)

    for (const m of memberships) {
      const teamId = String(Array.isArray(m.team_id) ? m.team_id[0] : m.team_id || '');
      if (!teamId) continue;
      if (m.role_name === 'admin') {
        // team admin → every tenant in the team
        const tenants = await this.db.collection('tenant')
          .find({ team_id: teamId }).project({ _id: 1, slug: 1, title: 1 }).toArray();
        for (const t of tenants) {
          tenantRoleMap.set(t._id.toString(), 'admin');
        }
      } else if (m.role_name === 'manager') {
        for (const tid of (m.assigned_tenants || [])) {
          const key = String(tid);
          if (!tenantRoleMap.has(key)) tenantRoleMap.set(key, 'admin');
        }
      } else if (m.role_name === 'user') {
        for (const tr of (m.tenant_roles || [])) {
          if (!tr?.tenant_id || !tr?.role_name) continue;
          const key = String(tr.tenant_id);
          if (!tenantRoleMap.has(key)) tenantRoleMap.set(key, tr.role_name);
        }
      }
    }

    const results: { _id: string; slug: string; title: string; role: string }[] = [];
    for (const [tenantId, role] of tenantRoleMap) {
      const tenant = await getTenantRecord(tenantId);
      if (!tenant) continue;
      results.push({
        _id: tenant._id.toString(),
        slug: tenant.slug ?? tenantId,
        title: tenant.title ?? '',
        role,
      });
    }
    return results;
  }
  async googleLogin(idToken: string, profile: boolean, jwtSign: Function): Promise<LoginResponse> {
    await this.checkCoreInitialized();

    // Verify Google idToken locally via google-auth-library
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    let payload: any;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      throw this.createError('Invalid Google token', 401);
    }

    if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
      throw this.createError('Invalid token issuer', 401);
    }

    const email = payload.email;
    if (!email || !payload.email_verified) {
      throw this.createError('Email not verified by Google', 400);
    }

    // Find or create user
    let user = await this.db.collection('user').findOne({ email });
    if (!user) {
      // Auto-register Google user — no password, only Google login
      const newUser = {
        email,
        username: payload.name || email.split('@')[0],
        first_name: payload.given_name || '',
        last_name: payload.family_name || '',
        full_name: payload.name || email,
        featured_image: payload.picture || '',
        password: null,
        auth_provider: 'google',
        role: [],
        role_name: 'user',
        is_active: true,
        google_id: payload.sub,
      };
      const insertResult = await this.db.collection('user').insertOne(newUser);
      user = await this.db.collection('user').findOne({ _id: insertResult.insertedId });
    } else if (user.auth_provider !== 'google' && user.password) {
      // Existing user registered with email/password — link Google
      await this.db.collection('user').updateOne(
        { _id: user._id },
        { $set: { google_id: payload.sub } }
      );
    }

    if (user.is_active === false) {
      throw this.createError('Account is deactivated', 403);
    }

    // Get profile (no tenant needed for login — just basic info)
    const account: any = { ...user, password: undefined };

    const accessToken = await jwtSign({
      id: account._id?.toString() || user._id.toString(),
      email: account.email,
      username: account.username,
      phone: account.phone,
      role_name: account.role_name,
      is_super_admin: !!account.is_super_admin || isSystemAdmin(account.role_system),
    });

    const refreshToken = await this.createRefreshToken(account._id ? account : user, jwtSign);

    return {
      accessToken,
      refreshToken,
      user: {
        ...JSON.parse(JSON.stringify(account)),
        id: (account._id || user._id).toString(),
        password: undefined,
      },
    };
  }

  async githubLogin(code: string, profile: boolean, jwtSign: Function): Promise<LoginResponse> {
    await this.checkCoreInitialized();

    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData: any = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      throw this.createError(tokenData.error_description || 'GitHub auth failed', 401);
    }

    // Get GitHub user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    const ghUser: any = await userRes.json();

    // Get primary email (may be private)
    let email = ghUser.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
      });
      const emails: any[] = await emailsRes.json();
      const primary = emails.find((e: any) => e.primary && e.verified);
      email = primary?.email;
    }
    if (!email) {
      throw this.createError('GitHub account has no verified email', 400);
    }

    // Find or create user
    let user = await this.db.collection('user').findOne({ email });
    if (!user) {
      const newUser = {
        email,
        username: ghUser.login || email.split('@')[0],
        first_name: ghUser.name?.split(' ')[0] || '',
        last_name: ghUser.name?.split(' ').slice(1).join(' ') || '',
        full_name: ghUser.name || ghUser.login || email,
        featured_image: ghUser.avatar_url || '',
        password: null,
        auth_provider: 'github',
        role: [],
        role_name: 'user',
        is_active: true,
        github_id: String(ghUser.id),
      };
      const insertResult = await this.db.collection('user').insertOne(newUser);
      user = await this.db.collection('user').findOne({ _id: insertResult.insertedId });
    } else if (!user.github_id) {
      await this.db.collection('user').updateOne(
        { _id: user._id },
        { $set: { github_id: String(ghUser.id) } }
      );
    }

    if (user.is_active === false) {
      throw this.createError('Account is deactivated', 403);
    }

    let account: any;
    if (profile) {
      account = await this.getProfile(email, true, true);
    } else {
      account = { ...user, password: undefined };
    }

    const accessToken = await jwtSign({
      id: account._id?.toString() || user._id.toString(),
      email: account.email,
      username: account.username,
      phone: account.phone,
      role_name: account.role_name,
      is_super_admin: !!account.is_super_admin || isSystemAdmin(account.role_system),
    });

    const refreshToken = await this.createRefreshToken(account._id ? account : user, jwtSign);

    return {
      accessToken,
      refreshToken,
      user: {
        ...JSON.parse(JSON.stringify(account)),
        id: (account._id || user._id).toString(),
        password: undefined,
      },
    };
  }

  async login(email: string, password: string, profile: boolean, jwtSign: Function): Promise<LoginResponse> {
    await this.checkCoreInitialized();

    try {
      let account = null;
      if (typeof profile === 'string') profile = profile === 'true' ? true : false;

      if (profile) {
        account = await this.getProfile(email, false, true);
      } else {
        const userResult = await this.db.collection('user').findOne({
          email
        });

        if (userResult) {
          account = userResult;
        }
      }

      if (!account) {
        throw this.createError('Account not found', 404);
      }

      if (!account) {
        throw this.createError('Account not found', 404);
      }

      if (
        !bcrypt.compareSync(password, account.password) ||
        account.is_active === false
      ) {
        throw this.createError('Account info is not valid', 400);
      }

      let accessToken = await jwtSign({
        id: account._id.toString(),
        email: account.email,
        username: account.username,
        phone: account.phone,
        role_system: account.role_system,
        role_name: account.role_name,
        is_super_admin: !!account.is_super_admin || isSystemAdmin(account.role_system),
      });

      let refreshToken = await this.createRefreshToken(account, jwtSign);
      return {
        accessToken: accessToken,
        refreshToken: refreshToken,
        user: {
          ...JSON.parse(JSON.stringify(account)),
          id: account._id.toString(),
          email: account.email,
          username: account.username,
          phone: account.phone,
          role_system: account.role_system,
          role_name: account.role_name,
          role: account.role,
          password: undefined,
        },
      };
    } catch (error: any) {
      console.error('Error in login:', error);
      if (error.statusCode) {
        throw error;
      }
      throw this.createError('Login failed', 500);
    }
  }
  async changeTenant(user: any, tenant_id: string, jwtSign: Function): Promise<string> {
    await this.checkCoreInitialized();

    try {
      const userTenantResult = await this.db.collection('user_tenant_profile').findOne({
        user: user.id,
        tenant_id: tenant_id
      });

      if (!userTenantResult) {
        throw this.createError('User tenant profile not found', 404);
      }

      const user_tenant_profile = userTenantResult;

      let accessToken = await jwtSign({
        ...JSON.parse(JSON.stringify({ ...user, exp: undefined })),
        id_tenant: user_tenant_profile._id,
        profile_tenant: user_tenant_profile,
      }, {
        expiresIn: user.exp - Math.floor(Date.now() / 1000) - 400,
      });

      return accessToken;
    } catch (error: any) {
      console.error('Error in changeTenant:', error);
      if (error.statusCode) {
        throw error;
      }
      throw this.createError('Change tenant failed', 500);
    }
  }
  async validateUserWithEntity(user: any, entity: string, id: string, tenant_id: string): Promise<any> {
    await this.checkCoreInitialized();

    try {
      const userResult = await this.db.collection('user').findOne({
        _id: id,
        tenant_id: tenant_id
      });

      if (!userResult) {
        throw this.createError('Account not found', 404);
      }

      // check permission logic here
      return userResult;
    } catch (error: any) {
      console.error('Error in validateUserWithEntity:', error);
      if (error.statusCode) {
        throw error;
      }
      throw this.createError('User validation failed', 500);
    }
  }
  async createRefreshToken(
    user: any,
    jwtSign: Function,
    expiresIn: string | number = '365d',
  ): Promise<string> {
    await this.checkCoreInitialized();

    try {
      user.password = undefined;
      const options: any = { expiresIn };
      const userId = (user._id ?? user.id)?.toString();
      if (!userId) throw new Error('user._id and user.id are both undefined');

      let token = await jwtSign(
        {
          _id: userId,
          timestamp: Date.now(),
        },
        options
      );

      // Remove old refresh token (scoped to admin source_entity='user' so tenant tokens stay intact)
      try {
        const oldTokensResult = await this.db.collection('user_token').find({
          email: user.email.toString(),
          type: 'refresh',
          source_entity: 'user',
        }).toArray();

        if (oldTokensResult && oldTokensResult.length > 0) {
          for (const tokenRecord of oldTokensResult) {
            await getCoreUnified().getCore().delete(
              'user_token',
              tokenRecord._id.toString(),
              ['admin']
            );
          }
        }
      } catch (deleteError) {
        console.warn('Failed to delete old refresh tokens:', deleteError);
      }

      // Create new refresh token
      await this.db.collection('user_token').insertOne({
        user_id: userId,
        email: user.email.toString(),
        token: token,
        type: 'refresh',
        source_entity: 'user',
      });

      return token;
    } catch (error) {
      console.error('Error in createRefreshToken:', error);
      throw this.createError('Failed to create request token', 500);
    }
  }
  async getNewAccessToken(
    refreshToken: string,
    profile: boolean,
    jwtSign: Function,
    jwtVerify: Function
  ): Promise<TokenResponse> {
    await this.checkCoreInitialized();

    try {
      const tokenResult = await this.db.collection('user_token').findOne({
        token: refreshToken
      });

      if (!tokenResult) {
        throw this.createError('Token not found', 404);
      }

      const token = tokenResult;

      let decoded: any = null;
      try {
        decoded = await jwtVerify(token.token);
      } catch (error: any) {
        throw this.createError(error.message || 'Invalid token', 400);
      }

      let account = null;
      if (typeof profile === 'string') profile = profile === 'true' ? true : false;

      if (profile) {
        account = await this.getProfile(token.email, false);
      } else {
        const userResult = await this.db.collection('user').findOne({
          email: token.email
        });

        if (userResult) {
          account = userResult;
        }
      }

      if (!account) {
        throw this.createError('Account not found', 404);
      }

      let accessToken = await jwtSign({
        id: account._id.toString(),
        email: account.email,
        username: account.username,
        phone: account.phone,
        role_system: account.role_system,
        is_super_admin: !!account.is_super_admin || isSystemAdmin(account.role_system),
      });

      return {
        accessToken: accessToken,
        refreshToken: refreshToken,
        user: {
          ...JSON.parse(JSON.stringify(account)),
          id: account._id.toString(),
          email: account.email,
          username: account.username,
          phone: account.phone,
          role_system: account.role_system,
          role: account.role,
          password: undefined,
        },
      };
    } catch (error: any) {
      console.error('Error in getNewAccessToken:', error);
      if (error.statusCode) {
        throw error;
      }
      throw this.createError('Failed to refresh token', 500);
    }
  }

  async logout(userId: string): Promise<{ message: string }> {
    await this.checkCoreInitialized();

    try {
      // Delete all refresh tokens for the user
      const deleteResult = await this.db.collection('user_token').deleteMany({
        user_id: userId,
        type: 'refresh'
      });

      if (deleteResult.deletedCount === 0) {
        console.warn(`No refresh tokens found for user ${userId}`);
      }

      return {
        message: 'Logged out successfully'
      };
    } catch (error: any) {
      console.error('Error in logout:', error);
      throw this.createError('Logout failed', 500);
    }
  }

  /**
   * Change password (knows old password) + revoke-all. After verifying the old password and updating to the new one:
   *   - revokeAllForUser(userId) → every old access token (including the one in the current call) gets guard-rejected.
   *   - user_token.deleteMany → kills refresh tokens → /auth/refresh-token fails.
   * The controller mints and returns a NEW token (auto-login) AFTER this function finishes, so the new token has
   * iat >= revokedAt → valid; other devices get logged out.
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string
  ): Promise<{ success: boolean; message: string }> {
    await this.checkCoreInitialized();

    let _id: ObjectId;
    try {
      _id = new ObjectId(userId);
    } catch {
      throw this.createError('Invalid user id', 400);
    }

    const user = await this.db.collection('user').findOne({ _id });
    if (!user) {
      throw this.createError('User not found', 404);
    }

    const isValid = await bcrypt.compare(oldPassword, user.password ?? '');
    if (!isValid) {
      throw this.createError('Current password is incorrect', 400);
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.db.collection('user').updateOne({ _id }, { $set: { password: hashed } });

    // Revoke-all BEFORE the controller mints a new token → guarantees the new token's iat >= revokedAt.
    await revokeAllForUser(userId);
    await this.db.collection('user_token').deleteMany({ user_id: userId });

    return { success: true, message: 'Password changed successfully' };
  }
}
