/**
 * Single-tenant runtime: AsyncLocalStorage is not needed.
 * Slug + DB are fixed via env (`TENANT`) + bootstrap. The functions below keep
 * the old signature so callsites don't have to change.
 *
 * The full multi-tenant version still exists on the main branch.
 */

import { Db } from 'mongodb';
import { TENANT_SLUG, TEAM_ID, getTenantScope as envTenantScope } from '../../../configs/tenant';

let _systemDb: Db | null = null;

/** Called by bootstrap.ts to inject systemDb after connecting. */
export function setSingleTenantDb(db: Db): void {
  _systemDb = db;
}

export function runWithTenantDb<T>(
  _db: Db,
  _tenantId: string,
  _tenantSlug: string,
  fn: () => Promise<T>,
  _teamId?: string,
): Promise<T> {
  return fn();
}

export function runWithTenantSlug<T>(
  _tenantSlug: string,
  _tenantId: string,
  fn: () => Promise<T>,
  _teamId?: string,
): Promise<T> {
  return fn();
}

export function getTenantDb(): Db | null {
  return _systemDb;
}

export function getTenantId(): string {
  return TENANT_SLUG;
}

export function getTenantSlug(): string {
  return TENANT_SLUG;
}

/** Team is fixed via env `TEAM_ID`. */
export function getTenantTeamId(): string | null {
  return TEAM_ID || null;
}

/** Scope cho schema/Redis/folder: composite `<team_id>/<tenant>` (env). */
export function getTenantScope(): string | null {
  return envTenantScope() || null;
}
