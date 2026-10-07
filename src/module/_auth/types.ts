// Common interfaces and types for Auth module

export interface JwtPayload {
  id: string;
  email: string;
  username: string;
  phone: string;
  role_system: string;
  role_name: string;
  is_super_admin?: boolean;
  exp?: number;
  iat?: number;
  id_tenant?: string;
  id_team?: string;
  profile_tenant?: any;
}

export interface UserProfile {
  _id?: any;
  id?: string;
  email: string;
  username?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  role_system?: string;
  role_name?: string;
  role?: any[];
  is_super_admin?: boolean;
  tenant?: any;
  team?: any;
  permission?: any[];
  permissions?: any;
  rule?: any[];
  featured_image?: any;
  cover?: any;
  password?: string;
  is_active?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
  tenants?: { slug: string; role: string }[];
  default_tenant?: string | null;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
}

export interface RegisterResponse {
  _id: any;
  email: string;
  username: string;
  phone: string;
  created_at?: Date;
  updated_at?: Date;
}

// Enum for role system (3-tier model)
export enum ROLE_SYSTEM {
  ADMIN = 'admin',     // CRUD on ALL tenants
  MANAGER = 'manager', // CRUD on owned tenant; GET on joined tenant
  USER = 'user',       // GET only on tenants they've joined
}

/** Legacy super_admin string still present in old DB records — still treated as admin. */
export function isSystemAdmin(roleSystem: string | undefined | null): boolean {
  return roleSystem === ROLE_SYSTEM.ADMIN || roleSystem === 'super_admin';
}

export function isSystemManager(roleSystem: string | undefined | null): boolean {
  return roleSystem === ROLE_SYSTEM.MANAGER;
}

// ─────────────────────────────────────────────────────────────────────────────
// Team-based RBAC (see REFACTOR_TEAMS.md). Co-exists with ROLE_SYSTEM until
// the migration script flips users to is_super_admin and removes role_system.
// ─────────────────────────────────────────────────────────────────────────────

export enum TEAM_ROLE {
  ADMIN = 'admin',     // full permissions within the team (all tenants of the team)
  MANAGER = 'manager', // only tenants assigned in assigned_tenants
  USER = 'user',       // access via user_tenant membership
}

export interface TenantRole {
  tenant_id: string;
  role_name: string;   // editor | viewer | admin | custom slug
}

export interface UserTeamMembership {
  _id?: any;
  user_id: string;
  team_id: string;
  role_name: TEAM_ROLE | string;
  /** Tenants assigned to role=manager (manager has full permissions in these tenants). */
  assigned_tenants?: string[];
  /**
   * Per-tenant roles for role=user. Each entry = { tenant_id, role_name }.
   * Team admin/manager bypass this field. role=user with NO entry for tenant X → 403.
   */
  tenant_roles?: TenantRole[];
  is_active?: boolean;
  username?: string;
  full_name?: string;
  email?: string;
  created_at?: Date;
  updated_at?: Date;
}

/** Super-admin bypass: user.is_super_admin === true OR legacy role_system=admin/super_admin. */
export function isSuperAdmin(user: Pick<UserProfile, 'is_super_admin' | 'role_system'> | null | undefined): boolean {
  if (!user) return false;
  if (user.is_super_admin === true) return true;
  return isSystemAdmin(user.role_system);
}

export function isTeamAdmin(membership: UserTeamMembership | null | undefined): boolean {
  return !!membership && membership.is_active !== false && membership.role_name === TEAM_ROLE.ADMIN;
}

export function isTeamManager(membership: UserTeamMembership | null | undefined): boolean {
  return !!membership && membership.is_active !== false && membership.role_name === TEAM_ROLE.MANAGER;
}

// Version configuration
export const MODULE_VERSION = 'v1';

// Response wrapper interface
export interface ApiResponse<T = any> {
  data: T;
  message: string;
  statusCode: number;
}
