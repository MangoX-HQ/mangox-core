import { getCoreUnified, ICoreUnified } from "../../configs/core";
import { IntermediateQueryResult, OptionsInput } from "../../core_v2/compat";
import { FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import e from "express";
import { AppError } from "../../utils/app-error";
import { revokeAllForUser } from "../_auth/token-blacklist.service";


export interface PaginatedResult<T> {
  limit: number;
  skip: number;
  documents: T[];
  count: number;
}

class UserService {
  constructor() { }

  private createError(message: string, statusCode: number): AppError {
    return new AppError({
      statusCode,
      code: `HTTP_${statusCode}`,
      message,
      expose: statusCode < 500,
    });
  }

  async findAllQuery(
    collectionName: string,
    queryData: any = {},
    roles: string[] = ["default"],
    options?: OptionsInput,
    request?: FastifyRequest
  ): Promise<IntermediateQueryResult<any>> {
    const relation = getCoreUnified().relationshipRegistry.getForTable(collectionName);
    queryData.limit = queryData.limit ? queryData.limit : 10;

    if (relation.length > 0) {
      if (queryData.select == undefined) {
        queryData.select = "*";
        relation.forEach((item: any) => {
          queryData.select += `,${item.name}()`;
        });
      }
    }

    if (!queryData.order) {
      queryData.order = '-created_at,-updated_at';
    }

    queryData.skip = 0;
    if (queryData.page) {
      const limit = queryData.limit ?? 10;
      queryData.skip = `${(queryData.page - 1) * limit}`;
      delete queryData.page;
    }

    const result = await getCoreUnified()
      .getCore()
      .findAll(queryData as any, collectionName, roles, options);

    return result;
  }
  async findOne(
    collectionName: string,
    queryData: any = {},
    id: string,
    roles: string[] = ["default"],
    options?: OptionsInput,
    request?: FastifyRequest
  ): Promise<IntermediateQueryResult<any> | null> {
    const relation = getCoreUnified().relationshipRegistry.getForTable(collectionName);
    queryData.limit = queryData.limit ? queryData.limit : 10;

    if (relation.length > 0) {
      if (queryData.select == undefined) {
        queryData.select = "*";
        relation.forEach((item: any) => {
          queryData.select += `,${item.name}()`;
        });
      }
    }

    const result = await getCoreUnified()
      .getCore()
      .findById(collectionName, queryData, id, roles, options);

    return result;
  }
  
  private checkEmailExists = async (email: string): Promise<boolean> => {
    const db = await getCoreUnified().getInstanceDB('mongodb');
    const user = await db.collection('user').findOne({ email });
    return !!user;
  }
  async createUser(
    collectionName: string,
    userData: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
    request?: FastifyRequest
  ): Promise<IntermediateQueryResult<any>> {
    try {

      const emailExists = await this.checkEmailExists(userData.email);
      if (emailExists) {
        throw this.createError('Email already exists', 400);
      }

      if (userData.password) {
        const bcrypt = require('bcrypt');
        userData.password = await bcrypt.hash(userData.password, 10);
      } else {
        throw this.createError('Password is required for creation', 400);
      }

      // Role is JSON-based (json/system/role/*.json, Redis cache). No DB lookup.
      // - Non-admin creator → forces role='user' (slug + array)
      // - Admin creator     → uses the input body, defaults to 'admin' if missing
      if (!roles.includes("admin")) {
        userData.role_name = 'user';
        userData.role = ['user'];
      } else {
        userData.role_name = userData.role_name || (Array.isArray(userData.role) ? userData.role[0] : userData.role) || 'admin';
        userData.role = Array.isArray(userData.role) ? userData.role : [userData.role_name];
      }

      // is_super_admin can only be set by super_admin (privilege escalation guard).
      if (!roles.includes('super_admin')) {
        delete userData.is_super_admin;
      }

      const result = await getCoreUnified()
        .getCore()
        .create(collectionName, userData, roles, options);

      return result;
    } catch (error: any) {
      throw this.createError(`Failed to create user: ${error.message}`, error.statusCode || 500);
    }
  }
  
  /**
   * Is the update allowed? A non-admin caller cannot update an admin user.
   * Role is JSON-based — reads role_name directly from the user document (a string slug),
   * no lookup against the 'role' DB collection.
   */
  async checkIsAdminUpdateAdmin(roles: string[], userData: any, id?: string): Promise<boolean> {
    if (roles.includes("admin") || roles.includes("super_admin")) return true;

    const db = await getCoreUnified().getInstanceDB('mongodb');
    let targetRoleName: string | undefined;
    if (id) {
      let user: any = null;
      try { user = await db.collection('user').findOne({ _id: new ObjectId(id) }, { projection: { role_name: 1 } }); } catch {}
      if (!user) throw this.createError('User not found', 404);
      targetRoleName = user.role_name;
    } else {
      targetRoleName = userData.role_name
        || (Array.isArray(userData.role) ? userData.role[0] : userData.role);
    }

    // Non-admin cannot edit admin
    return targetRoleName !== 'admin';
  }
  async updateUser(
    collectionName: string,
    id: string,
    userData: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
    request?: FastifyRequest
  ): Promise<IntermediateQueryResult<any>> {
    const isAdmin = await this.checkIsAdminUpdateAdmin(roles, userData, id);
    if (!isAdmin) {
      throw this.createError('Unauthorized to update admin user', 403);
    }

    const db = await getCoreUnified().getInstanceDB('mongodb');
    const curUser = await db.collection('user').findOne({ _id: new ObjectId(id) });

    // §8 — flag the sensitive change BEFORE userData gets mutated (the password fallback below
    // always sets userData.password = curUser.password if the body doesn't send a password).
    const pwdChanged = !!userData.password || !!userData.newPassword;
    const beingDeactivated = userData.is_active === false;

    // is_super_admin can only be set/changed by super_admin. Tenant-admin/team-admin cannot
    // self-escalate their privileges (privilege escalation guard).
    const isCallerSuper = roles.includes('super_admin');
    if (!isCallerSuper) {
      if (curUser?.is_super_admin === true) {
        throw this.createError('Cannot update super-admin user', 403);
      }
      delete userData.is_super_admin;
    }

    // Hash password if exists and is being updated
    if (userData.password) {
      const bcrypt = require('bcrypt');
      userData.password = await bcrypt.hash(userData.password, 10);
    } else {
      if (curUser) {
        userData.password = curUser.password;
      }
    }

    // Role is JSON-based — non-admin keeps the current role; admin takes input from the body.
    if (!roles.includes("admin") && curUser) {
      userData.role_name = curUser.role_name;
      userData.role = curUser.role;
    } else {
      // Admin update: input takes priority, falls back to the old value
      const inputRoleName = userData.role_name
        || (Array.isArray(userData.role) ? userData.role[0] : userData.role);
      userData.role_name = inputRoleName || curUser?.role_name || 'admin';
      userData.role = Array.isArray(userData.role) ? userData.role : [userData.role_name];
      // role changed → invalidate the old token
      if (curUser && curUser.role_name !== userData.role_name) {
        await db.collection('user_token').deleteMany({ user_id: id });
      }
    }

    if (!userData.password) {
      throw this.createError('Password is required for update', 400);
    }

    const result = await getCoreUnified()
      .getCore()
      .partialUpdate(collectionName, {
        id: id
      }, userData, roles, options);

    // §8 — admin changes the password or disables (is_active:false) → revoke-all for that account:
    // logs out all devices (a stateless access token can only be blocked via revoke-all) + kills
    // the refresh token. This makes a ban (is_active:false) take effect IMMEDIATELY, without waiting for the token to expire.
    if (pwdChanged || beingDeactivated) {
      await revokeAllForUser(id);
      await db.collection('user_token').deleteMany({ user_id: id });
    }

    return result;
  }
  async deleteUser(
    collectionName: string,
    id: string,
    roles: string[] = ["default"],
    options?: OptionsInput,
    request?: FastifyRequest
  ): Promise<{ success: boolean }> {
    try {
      const result = await getCoreUnified()
        .getCore()
        .delete(collectionName, id, roles, options);

      return { success: result };
    } catch (error: any) {
      console.error('Error deleting user:', error);
      throw this.createError('Failed to delete user', 500);
    }
  }
  async getUserProfile(
    userId: string,
    roles: string[] = ["default"],
    options?: OptionsInput,
    request?: FastifyRequest
  ): Promise<IntermediateQueryResult<any> | null> {
    try {
      const relation = getCoreUnified().relationshipRegistry.getForTable('user');
      let select = "*";

      if (relation.length > 0) {
        relation.forEach((item: any) => {
          select += `,${item.name}()`;
        });
      }

      const queryData = { select };
      const result = await getCoreUnified()
        .getCore()
        .findById('user', queryData, userId, roles, options);

      // Remove password from response
      if (result?.data && result.data[0]) {
        delete result.data[0].password;
      }

      return result;
    } catch (error: any) {
      console.error('Error getting user profile:', error);
      throw this.createError('Failed to get user profile', 500);
    }
  }
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    roles: string[] = ["default"],
    options?: OptionsInput,
    request?: FastifyRequest
  ): Promise<{ success: boolean; message: string }> {
    try {
      const bcrypt = require('bcrypt');

      // Get current user
      const userResult = await getCoreUnified()
        .getCore()
        .findById('user', {}, userId, roles, options);

      if (!userResult?.data || userResult.data.length === 0) {
        throw this.createError('User not found', 404);
      }

      const user = userResult.data[0];

      // Verify old password
      const isValidPassword = await bcrypt.compare(oldPassword, user.password);
      if (!isValidPassword) {
        throw this.createError('Current password is incorrect', 400);
      }

      // Hash new password
      const hashedNewPassword = await bcrypt.hash(newPassword, 10);

      // Update password
      await getCoreUnified()
        .getCore()
        .partialUpdate('user', userId, { password: hashedNewPassword }, roles, options);

      return {
        success: true,
        message: 'Password changed successfully'
      };
    } catch (error: any) {
      console.error('Error changing password:', error);
      if (error.statusCode) {
        throw error;
      }
      throw this.createError('Failed to change password', 500);
    }
  }
  async searchUsers(
    searchQuery: string,
    queryData: any = {},
    roles: string[] = ["default"],
    options?: OptionsInput,
    request?: FastifyRequest
  ): Promise<IntermediateQueryResult<any>> {
    try {
      // Add search conditions
      const searchConditions = {
        ...queryData,
        $or: [
          { email: { $regex: searchQuery, $options: 'i' } },
          { name: { $regex: searchQuery, $options: 'i' } },
          { username: { $regex: searchQuery, $options: 'i' } }
        ]
      };

      const relation = getCoreUnified().relationshipRegistry.getForTable('user');
      if (relation.length > 0) {
        if (!searchConditions.select) {
          searchConditions.select = "*";
          relation.forEach((item: any) => {
            searchConditions.select += `,${item.name}()`;
          });
        }
      }

      // Handle pagination
      searchConditions.limit = searchConditions.limit ? searchConditions.limit : 10;
      searchConditions.skip = 0;
      if (searchConditions.page) {
        const limit = searchConditions.limit ?? 10;
        searchConditions.skip = `${(searchConditions.page - 1) * limit}`;
        delete searchConditions.page;
      }

      const result = await getCoreUnified()
        .getCore()
        .findAll(searchConditions as any, 'user', roles, options);

      return result;
    } catch (error: any) {
      console.error('Error searching users:', error);
      throw this.createError('Failed to search users', 500);
    }
  }
}

export const userService = new UserService();
