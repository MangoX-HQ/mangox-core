import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ObjectId } from "mongodb";
import { userService } from "./user.service";
import { OptionsInput } from "../../core_v2/compat";
import { jwtGuard } from "../..";
import { modeHandler } from "../../middleware/mode-handler";
import { getCoreUnified } from "../../configs/core";
import { isSuperAdmin, ROLE_SYSTEM } from "../_auth/types";

async function getSystemDb() {
  return getCoreUnified().getInstanceDB('mongodb');
}

interface ChangePasswordBody {
  oldPassword: string;
  newPassword: string;
}

interface SearchQuery {
  q?: string;
  page?: string;
  limit?: string;
}

class UserController {

  async getUserList(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user: any = request.headers.user;
      await modeHandler.getWithModeHandler(request, 'GET-ALL', 'user');
      const queryData = request.query as any;
      const roles: string[] = isSuperAdmin(user)
        ? ['super_admin', user?.role_name].filter(Boolean) as string[]
        : [user?.role_name ?? 'default'];
      const options: OptionsInput = {
        databaseType: "mongodb",
        is_tenant: false,
        user_id: user?.id,
        log: request.log
      };

      const result = await userService.findAllQuery('user', queryData, roles, options);
      
      // Remove passwords from response
      if (result?.data) {
        result.data = result.data?.map((userData: any) => {
          userData.password = undefined;
          return userData;
        });
      }

      if (result?.statusCode) {
        reply.statusCode = result.statusCode;
      }
      return result;
    } catch (error: any) {
      console.error('Error in getUserList:', error);
      return reply.code(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
  async getUserDetails(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user: any = request.headers.user;
      const { id } = request.params as { id: string };
      const queryData = request.query as any;
      const roles: string[] = isSuperAdmin(user)
        ? ['super_admin', user?.role_name].filter(Boolean) as string[]
        : [user?.role_name ?? 'default'];
      const options: OptionsInput = {
        databaseType: "mongodb",
        is_tenant: false,
        user_id: user?.id,
        log: request.log
      };

      const result = await userService.findOne('user', queryData, id, roles, options, request);
      
      // Remove password from response
      if (result?.data && result.data[0]) {
        delete result.data[0].password;
      }

      if (result?.statusCode) {
        reply.statusCode = result.statusCode;
      }
      return {
        data: result?.data[0],
      };
    } catch (error: any) {
      console.error('Error in getUserDetails:', error);
      return reply.code(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
  async createUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user: any = request.headers.user;
      const userData = request.body as any;
      const roles: string[] = isSuperAdmin(user)
        ? ['super_admin', user?.role_name].filter(Boolean) as string[]
        : [user?.role_name ?? 'default'];
      const options: OptionsInput = {
        databaseType: "mongodb",
        is_tenant: false,
        user_id: user?.id,
        log: request.log
      };

      const result = await userService.createUser('user', userData, roles, options, request);
      
      // Remove password from response
      if (result?.data && result.data[0]) {
        delete result.data[0].password;
      }

      if (result?.statusCode) {
        reply.statusCode = result.statusCode;
      }
      return result;
    } catch (error: any) {
      console.error('Error in createUser:', error);
      return reply.code(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
  async updateUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user: any = request.headers.user;
      const { id } = request.params as { id: string };
      const userData = request.body as any;
      const roles: string[] = isSuperAdmin(user)
        ? ['super_admin', user?.role_name].filter(Boolean) as string[]
        : [user?.role_name ?? 'default'];
      const options: OptionsInput = {
        databaseType: "mongodb",
        is_tenant: false,
        user_id: user?.id,
        log: request.log
      };

      const result = await userService.updateUser('user', id, userData, roles, options, request);
      
      // Remove password from response
      if (result?.data && result.data[0]) {
        delete result.data[0].password;
      }

      if (result?.statusCode) {
        reply.statusCode = result.statusCode;
      }
      return result;
    } catch (error: any) {
      console.error('Error in updateUser:', error);
      return reply.code(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
  async deleteUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user: any = request.headers.user;
      const { id } = request.params as { id: string };
      const roles: string[] = isSuperAdmin(user)
        ? ['super_admin', user?.role_name].filter(Boolean) as string[]
        : [user?.role_name ?? 'default'];
      const options: OptionsInput = {
        databaseType: "mongodb",
        is_tenant: false,
        user_id: user?.id,
        log: request.log
      };

      const result = await userService.deleteUser('user', id, roles, options, request);

      return result;
    } catch (error: any) {
      console.error('Error in deleteUser:', error);
      return reply.code(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
  async getUserProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user: any = request.headers.user;
      const { id } = request.params as { id: string };
      const roles: string[] = isSuperAdmin(user)
        ? ['super_admin', user?.role_name].filter(Boolean) as string[]
        : [user?.role_name ?? 'default'];
      const options: OptionsInput = {
        databaseType: "mongodb",
        is_tenant: false,
        user_id: user?.id,
        log: request.log
      };

      const result = await userService.getUserProfile(id, roles, options, request);
      
      if (result?.statusCode) {
        reply.statusCode = result.statusCode;
      }
      return {
        data: result?.data[0],
      };
    } catch (error: any) {
      console.error('Error in getUserProfile:', error);
      return reply.code(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
  async changePassword(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user: any = request.headers.user;
      const { id } = request.params as { id: string };
      const { oldPassword, newPassword } = request.body as ChangePasswordBody;
      const roles: string[] = isSuperAdmin(user)
        ? ['super_admin', user?.role_name].filter(Boolean) as string[]
        : [user?.role_name ?? 'default'];
      const options: OptionsInput = {
        databaseType: "mongodb",
        is_tenant: false,
        user_id: user?.id,
        log: request.log
      };

      // Validation
      if (!oldPassword || !newPassword) {
        return reply.code(400).send({
          success: false,
          error: 'Old password and new password are required'
        });
      }

      if (newPassword.length < 6) {
        return reply.code(400).send({
          success: false,
          error: 'New password must be at least 6 characters long'
        });
      }

      const result = await userService.changePassword(id, oldPassword, newPassword, roles, options, request);
      
      return reply.code(200).send(result);
    } catch (error: any) {
      console.error('Error in changePassword:', error);
      return reply.code(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
  async searchUsers(request: FastifyRequest, reply: FastifyReply) {
    try {
      const user: any = request.headers.user;
      const { q, page = '1', limit = '10' } = request.query as SearchQuery;
      const roles: string[] = isSuperAdmin(user)
        ? ['super_admin', user?.role_name].filter(Boolean) as string[]
        : [user?.role_name ?? 'default'];
      const options: OptionsInput = {
        databaseType: "mongodb",
        is_tenant: false,
        user_id: user?.id,
        log: request.log
      };

      if (!q || q.trim() === '') {
        return reply.code(400).send({
          success: false,
          error: 'Search query is required'
        });
      }

      const queryData = {
        page: parseInt(page),
        limit: parseInt(limit)
      };

      const result = await userService.searchUsers(q.trim(), queryData, roles, options, request);
      
      // Remove passwords from response
      if (result?.data) {
        result.data = result.data?.map((userData: any) => {
          const { password, ...userWithoutPassword } = userData;
          return userWithoutPassword;
        });
      }

      if (result?.statusCode) {
        reply.statusCode = result.statusCode;
      }
      return result;
    } catch (error: any) {
      console.error('Error in searchUsers:', error);
      return reply.code(error.statusCode || 500).send({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
}

// ============================================================================
// Helpers (RBAC theo 3-tier role)
// ============================================================================

/** Load the auth user from DB via the email in the JWT. Reply 401 if missing. */
async function loadAuthUser(request: FastifyRequest, reply: FastifyReply): Promise<any | null> {
  const headerUser: any = (request.headers as any).user;
  if (!headerUser?.email) {
    reply.code(401).send({ statusCode: 401, message: 'Unauthorized' });
    return null;
  }
  const db = await getSystemDb();
  const dbUser = await db.collection('user').findOne(
    { email: headerUser.email },
    { projection: { role_system: 1, is_super_admin: 1, _id: 1, email: 1 } },
  );
  if (!dbUser) {
    reply.code(401).send({ statusCode: 401, message: 'User not found' });
    return null;
  }
  return dbUser;
}

/** Manager can only set role_system='user' when creating/editing a user. */
function rejectIfInvalidRoleSystemForManager(
  role: string | undefined,
  reply: FastifyReply,
): boolean {
  if (role === undefined || role === null || role === '') return true;
  if (role !== ROLE_SYSTEM.USER) {
    reply.code(403).send({
      statusCode: 403,
      message: 'Manager chỉ được set role_system=user',
    });
    return false;
  }
  return true;
}

// Field-level access: only system_admin (isSuperAdmin) sees the full user. Other roles only see
// username + name + avatar; email/phone/... are locked. Applies to list + /user/:id (viewing peers).
const PUBLIC_USER_FIELDS = ['_id', 'username', 'full_name', 'first_name', 'last_name', 'featured_image'] as const;

/** Mongo projection by permission: super_admin → full (except password); other roles → whitelist. */
function userProjection(isPriv: boolean): Record<string, 0 | 1> {
  if (isPriv) return { password: 0 };
  const p: Record<string, 0 | 1> = {};
  for (const f of PUBLIC_USER_FIELDS) p[f] = 1;
  return p;
}

/** Mask a fetched user object → keep only the whitelist (used when the doc was already fetched in full). */
function maskUser(u: any): any {
  const out: any = {};
  for (const f of PUBLIC_USER_FIELDS) if (u?.[f] !== undefined) out[f] = u[f];
  return out;
}

export async function UserRoutes(app: FastifyInstance) {
  const controller = new UserController();
  const auth = { preHandler: jwtGuard.preHandler.bind(jwtGuard) };

  // ── GET list /user ──────────────────────────────────────────────────────
  // Scope: EVERY logged-in role sees ALL users. The difference is in the FIELDS:
  //   super_admin → full (except password)
  //   other roles → only username + name + avatar (mask email/phone/... via projection)
  // Optional query filter `?created_by=me|others`.
  const listHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const dbUser = await loadAuthUser(request, reply);
    if (!dbUser) return;

    const db = await getSystemDb();
    const q = request.query as any;
    const page = parseInt(q.page ?? '1');
    const limit = Math.min(parseInt(q.limit ?? '20'), 200);
    const skip = (page - 1) * limit;
    const selfId = dbUser._id.toString();
    const isPriv = isSuperAdmin(dbUser);

    const filter: any = {};
    if (q.q) {
      const re = { $regex: q.q, $options: 'i' };
      // Lower roles are NOT allowed to search by email → prevents probing for emails even though the field is locked.
      filter.$or = isPriv
        ? [{ email: re }, { username: re }, { first_name: re }, { last_name: re }]
        : [{ username: re }, { first_name: re }, { last_name: re }];
    }

    // No scope restriction: any logged-in role can list ALL users (fields are masked for
    // lower roles via the projection below). Removed the 403 + removed the fallback "only see users you created".

    if (q.created_by === 'me') {
      filter.created_by = selfId;
    } else if (q.created_by === 'others') {
      filter.created_by = { $ne: selfId };
    }

    const [users, total] = await Promise.all([
      db.collection('user').find(filter, { projection: userProjection(isPriv) }).skip(skip).limit(limit).toArray(),
      db.collection('user').countDocuments(filter),
    ]);

    return { statusCode: 200, data: users, pagination: { total, page, limit } };
  };
  app.get('/user', auth, listHandler);
  app.get('/users', auth, listHandler);

  // ── GET /user/:id ────────────────────────────────────────────────────────
  // super_admin / self → full (except password). Other roles viewing a peer → sensitive fields are masked.
  app.get('/user/:id', auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const dbUser = await loadAuthUser(request, reply);
    if (!dbUser) return;
    const { id } = request.params as { id: string };
    const db = await getSystemDb();
    let user: any = null;
    try { user = await db.collection('user').findOne({ _id: new ObjectId(id) }, { projection: { password: 0 } }); } catch {}
    if (!user) return reply.code(404).send({ statusCode: 404, message: 'User not found' });

    if (isSuperAdmin(dbUser)) return { statusCode: 200, data: user };

    const selfId = dbUser._id.toString();
    if (id === selfId) return { statusCode: 200, data: user };

    // Peer (not super, not self) → mask sensitive fields, return only the whitelist.
    return { statusCode: 200, data: maskUser(user) };
  });

  // ── POST /user (admin + manager) ─────────────────────────────────────────
  // Manager → role_system must be 'user'; created_by is auto-set to manager._id
  // Admin   → free to choose, created_by defaults to admin._id (can be overridden via body)
  app.post('/user', auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const dbUser = await loadAuthUser(request, reply);
    if (!dbUser) return;
    const isAdmin = isSuperAdmin(dbUser);
    const isManager = dbUser.role_system === ROLE_SYSTEM.MANAGER;
    if (!isAdmin && !isManager) {
      return reply.code(403).send({ statusCode: 403, message: 'Admin or manager required' });
    }

    const body = (request.body as any) || {};
    if (isManager) {
      if (!rejectIfInvalidRoleSystemForManager(body.role_system, reply)) return;
      body.role_system = ROLE_SYSTEM.USER;
    }
    if (!body.created_by) body.created_by = dbUser._id.toString();

    (request as any).body = body;
    return controller.createUser(request, reply);
  });

  // ── PUT /user/:id ────────────────────────────────────────────────────────
  // admin   → full permissions
  // manager → can only edit users they created OR themselves; NOT allowed to set role_system != 'user'
  // user    → self only; NOT allowed to change role_system
  app.put('/user/:id', auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const dbUser = await loadAuthUser(request, reply);
    if (!dbUser) return;
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};

    const isAdmin = isSuperAdmin(dbUser);
    const isManager = dbUser.role_system === ROLE_SYSTEM.MANAGER;
    const selfId = dbUser._id.toString();
    const isSelf = id === selfId;

    if (!isAdmin) {
      const db = await getSystemDb();
      let target: any = null;
      try { target = await db.collection('user').findOne({ _id: new ObjectId(id) }); } catch {}
      if (!target) return reply.code(404).send({ statusCode: 404, message: 'User not found' });

      if (isManager) {
        const isCreator = String(target.created_by ?? '') === selfId;
        if (!isCreator && !isSelf) {
          return reply.code(403).send({ statusCode: 403, message: 'Manager chỉ sửa được user mình tạo' });
        }
        if (!rejectIfInvalidRoleSystemForManager(body.role_system, reply)) return;
      } else {
        // role_system='user' can only edit THEMSELVES
        if (!isSelf) {
          return reply.code(403).send({ statusCode: 403, message: 'User chỉ sửa được hồ sơ của chính mình' });
        }
        if (body.role_system !== undefined && body.role_system !== dbUser.role_system) {
          return reply.code(403).send({ statusCode: 403, message: 'Không được đổi role_system' });
        }
      }
    }

    (request as any).body = body;
    return controller.updateUser(request, reply);
  });

  // ── DELETE /user (bulk) ──────────────────────────────────────────────────
  // admin   → deletes all ids
  // manager → per-id check created_by; not owned → skipped
  // user    → 403
  app.delete('/user', auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const dbUser = await loadAuthUser(request, reply);
    if (!dbUser) return;
    const isAdmin = isSuperAdmin(dbUser);
    const isManager = dbUser.role_system === ROLE_SYSTEM.MANAGER;
    if (!isAdmin && !isManager) {
      return reply.code(403).send({ statusCode: 403, message: 'Admin or manager required' });
    }

    const q = request.query as any;
    const body = (request.body as any) || {};
    const raw: string[] = [];
    if (typeof q?.ids === 'string') raw.push(...q.ids.split(','));
    else if (Array.isArray(q?.ids)) raw.push(...q.ids);
    if (Array.isArray(body?.ids)) raw.push(...body.ids);
    const ids = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
    if (ids.length === 0) {
      return reply.code(400).send({ statusCode: 400, message: 'ids is required' });
    }

    const headerUser: any = (request.headers as any).user;
    const roles: string[] = [headerUser?.role_name ?? 'default'];
    const options: OptionsInput = {
      databaseType: 'mongodb',
      is_tenant: false,
      user_id: headerUser?.id,
      log: request.log,
    };
    const db = await getSystemDb();
    const selfId = dbUser._id.toString();

    const data: any[] = [];
    for (const id of ids) {
      if (!isAdmin) {
        let target: any = null;
        try { target = await db.collection('user').findOne({ _id: new ObjectId(id) }, { projection: { created_by: 1 } }); } catch {}
        if (!target) { data.push({ id, deleted: false, reason: 'not found' }); continue; }
        if (String(target.created_by ?? '') !== selfId) {
          data.push({ id, deleted: false, reason: 'not creator' });
          continue;
        }
      }
      try {
        const result = await userService.deleteUser('user', id, roles, options, request);
        data.push({ id, deleted: !!result?.success });
      } catch (err: any) {
        data.push({ id, deleted: false, reason: err?.message || 'error' });
      }
    }
    const deletedCount = data.filter((r) => r.deleted).length;
    return { statusCode: 200, message: `Deleted ${deletedCount}/${ids.length} user(s)`, data };
  });
}
