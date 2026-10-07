/**
 * Single source for tenant identity — import from here everywhere instead of reading env directly.
 *
 * Single-tenant runtime: 1 process / 1 docker / 1 tenant fixed at boot.
 *   - TEAM_ID  : the team containing the tenant (env `TEAM_ID`)
 *   - TENANT   : tenant slug (env `TENANT`)
 *
 * Scope (schema / Redis key / JSON folder) = `<team_id>/<tenant>` to match the layout
 * `json/<team_id>/<tenant>/...`. If TEAM_ID is absent → fallback to just `<tenant>`.
 */

export const TEAM_ID: string = process.env.TEAM_ID || '';
export const TENANT_SLUG: string = process.env.TENANT || process.env.TENANT_SLUG || '';

export function getTeamId(): string {
  return TEAM_ID;
}

export function getTenantSlug(): string {
  return TENANT_SLUG;
}

/** Composite scope cho schema/Redis/folder: `<team_id>/<tenant>` (else `<tenant>`). */
export function getTenantScope(): string {
  return TEAM_ID ? `${TEAM_ID}/${TENANT_SLUG}` : TENANT_SLUG;
}
