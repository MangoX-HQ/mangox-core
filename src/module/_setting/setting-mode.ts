/**
 * Setting Mode
 *
 * Helpers for roles / settings / form-settings / action-routing.
 * Source of truth: Redis (via schemaManager). JSON files are loaded at bootstrap
 * and kept in sync continuously via SchemaSync — this module does NOT read fs directly.
 */

import { getTenantScope, getTenantDb } from '../../core_v2/adapters/mongodb/tenant-context';
import { dbgStep, dbgGroup, dbgEnd } from '../../core_v2/debug/debug-logger';
import { getCoreUnified } from '../../configs/core';
import { schemaManager } from '../../core_v2/schema/manager';

export function isDevelopmentMode(): boolean {
  return true;
}

// ============================================================================
// Match helpers
// ============================================================================

function matchQuery(item: any, query: Record<string, any>): boolean {
  for (const [key, condition] of Object.entries(query)) {
    const fieldValue = item[key];
    if (condition && typeof condition === 'object' && condition.$in) {
      const inValues: any[] = condition.$in;
      if (Array.isArray(fieldValue)) {
        if (!fieldValue.some((v: any) => inValues.includes(v))) return false;
      } else {
        if (!inValues.includes(fieldValue)) return false;
      }
    } else {
      if (Array.isArray(fieldValue)) {
        if (!fieldValue.includes(condition)) return false;
      } else if (String(fieldValue) !== String(condition)) {
        return false;
      }
    }
  }
  return true;
}

// ============================================================================
// Tenant helpers (always from DB — tenant records live in MongoDB)
// ============================================================================

export const getTenantRecord = async (tenantId: string): Promise<any | null> => {
  const db = getTenantDb() ?? await getCoreUnified().getInstanceDB('mongodb');
  let record: any = null;
  try {
    const { ObjectId } = await import('mongodb');
    record = await db.collection('tenant').findOne({ _id: new ObjectId(tenantId) }).catch(() => null);
  } catch {}
  if (!record) record = await db.collection('tenant').findOne({ slug: tenantId }).catch(() => null);
  return record ?? null;
};

export async function getTenantSlugFromId(tenantId: string): Promise<string | null> {
  const record = await getTenantRecord(tenantId);
  return record?.slug ?? null;
}

export async function listTenants(): Promise<any[]> {
  const db = getTenantDb() ?? await getCoreUnified().getInstanceDB('mongodb');
  return db.collection('tenant').find({}).toArray();
}

// ============================================================================
// Roles
// ============================================================================

export const getRoles = async (query: Record<string, any> = {}): Promise<any[]> => {
  const tenantSlug = getTenantScope();
  const sysMap = (await schemaManager.getAll('role')) ?? {};
  const tenantMap = tenantSlug ? ((await schemaManager.getAll('role', tenantSlug)) ?? {}) : {};
  // tenant overrides system theo key (slug/role_base)
  const merged = { ...sysMap, ...tenantMap };
  const items = Object.values(merged);
  return Object.keys(query).length > 0 ? items.filter((r) => matchQuery(r, query)) : items;
};

export const getRoleBySlug = async (slugOrId: string): Promise<any | null> => {
  const tenantSlug = getTenantScope();
  const match = (r: any) => r.slug === slugOrId || r._id === slugOrId;

  if (tenantSlug) {
    const tenantMap = (await schemaManager.getAll('role', tenantSlug)) ?? {};
    const found = Object.values(tenantMap).find(match);
    if (found) return found;
  }

  const sysMap = (await schemaManager.getAll('role')) ?? {};
  const sysFound = Object.values(sysMap).find(match);
  if (sysFound) return sysFound;

  // Cross-tenant scan (needed when there is no tenant context)
  const all = await schemaManager.getAllAcrossTenants('role');
  return all.find(({ item }) => match(item))?.item ?? null;
};

export const getRoleWithTenant = async (
  slugOrId: string,
): Promise<{ role: any; tenantSlug: string } | null> => {
  const match = (r: any) => r.slug === slugOrId || r._id === slugOrId;
  // prioritize tenant first, system second (keep old behaviour)
  const all = await schemaManager.getAllAcrossTenants('role');
  const tenantHit = all.find(({ scope, item }) => scope !== 'system' && match(item));
  if (tenantHit) return { role: tenantHit.item, tenantSlug: tenantHit.scope };
  const sysHit = all.find(({ scope, item }) => scope === 'system' && match(item));
  if (sysHit) return { role: sysHit.item, tenantSlug: 'system' };
  return null;
};

export const getUserTenants = async (roleIds: string[]): Promise<{ slug: string; role: any }[]> => {
  const seen = new Set<string>();
  const results: { slug: string; role: any }[] = [];
  for (const id of roleIds) {
    const found = await getRoleWithTenant(id);
    if (found && !seen.has(found.tenantSlug)) {
      seen.add(found.tenantSlug);
      results.push({ slug: found.tenantSlug, role: found.role });
    }
  }
  return results;
};

// ============================================================================
// Policies
// ============================================================================

export const getPoliciesForTenant = async (
  query: Record<string, any>,
  tenantSlug: string | null,
): Promise<any[]> => {
  const isTenant = tenantSlug && tenantSlug !== 'system';
  const systemMap = (await schemaManager.getAllPolicies()) ?? {};
  const tenantMap = isTenant ? ((await schemaManager.getAllPolicies(tenantSlug)) ?? {}) : {};
  const merged = { ...systemMap, ...tenantMap };
  const items = Object.values(merged);
  return items
    .filter((item) => matchQuery(item, query))
    .sort((a: any, b: any) => (b.piority || 0) - (a.piority || 0));
};

export const getPolicies = async (query: Record<string, any>): Promise<any[]> => {
  const tenantSlug = getTenantScope();
  const systemMap = (await schemaManager.getAllPolicies()) ?? {};
  const tenantMap = tenantSlug ? ((await schemaManager.getAllPolicies(tenantSlug)) ?? {}) : {};
  const merged = { ...systemMap, ...tenantMap };
  const items = Object.values(merged);
  return items
    .filter((item) => matchQuery(item, query))
    .sort((a: any, b: any) => (b.piority || 0) - (a.piority || 0));
};

export const getPolicyBySlug = async (slug: string): Promise<any | null> => {
  const tenantSlug = getTenantScope();
  if (tenantSlug) {
    const found = await schemaManager.getPolicy(slug, tenantSlug);
    if (found) return found;
  }
  return schemaManager.getPolicy(slug);
};

// ============================================================================
// Settings
// ============================================================================

export const getSetting = async (query: Record<string, any>): Promise<any | null> => {
  const tenantSlug = getTenantScope();
  if (tenantSlug) {
    const tenantMap = (await schemaManager.getAll('setting', tenantSlug)) ?? {};
    const found = Object.values(tenantMap).find((item: any) => matchQuery(item, query));
    if (found) return found;
  }
  const sysMap = (await schemaManager.getAll('setting')) ?? {};
  return Object.values(sysMap).find((item: any) => matchQuery(item, query)) ?? null;
};

export const getFormSettingBySlug = async (slug: string): Promise<any | null> => {
  const tenantSlug = getTenantScope();
  if (tenantSlug) {
    const found = await schemaManager.get('form-setting', slug);
    // get() already prioritizes tenant scope then falls back to system, so it's enough; but to
    // avoid depending on ALS, call rGet directly via getAll once tenantSlug is known.
    if (found) return found;
    const tenantMap = (await schemaManager.getAll('form-setting', tenantSlug)) ?? {};
    const hit = tenantMap[slug] || Object.values(tenantMap).find((f: any) => f.slug === slug);
    if (hit) return hit;
  }
  const sysMap = (await schemaManager.getAll('form-setting')) ?? {};
  return sysMap[slug] || Object.values(sysMap).find((f: any) => f.slug === slug) || null;
};

// ============================================================================
// loadAction — resolve URL + method → action config
// ============================================================================

export const loadAction = async (
  urlPath: string,
  method: string,
  opts?: { onlyPublic?: boolean; excludePublic?: boolean },
) => {
  const pathSegments = urlPath.split('/').filter(Boolean);
  const resourceName = pathSegments[0];
  const tenantSlug = getTenantScope();
  dbgGroup('[setting-mode] loadAction', { resourceName, scope: tenantSlug, method });

  // 1. Find the resource config
  let resourceConfig: any = null;

  // 1a. Tenant first, system second (per old behaviour)
  if (tenantSlug) {
    const tenantResources = (await schemaManager.getAll('resource', tenantSlug)) ?? {};
    dbgStep('lookup tenant resources', { count: Object.keys(tenantResources).length, hit: !!tenantResources[resourceName] });
    resourceConfig = tenantResources[resourceName]
      || Object.values(tenantResources).find((r: any) => r.slug === resourceName);
  }
  if (!resourceConfig) {
    const sysResources = (await schemaManager.getAll('resource')) ?? {};
    dbgStep('lookup system resources', { count: Object.keys(sysResources).length, hit: !!sysResources[resourceName] });
    resourceConfig = sysResources[resourceName]
      || Object.values(sysResources).find((r: any) => r.slug === resourceName);
  }

  // 1b. No tenant context → cross-tenant scan (keep old behaviour)
  if (!resourceConfig && !tenantSlug) {
    const all = await schemaManager.getAllAcrossTenants('resource');
    dbgStep('cross-tenant scan', { total: all.length });
    resourceConfig = all.find(({ item }) => item.slug === resourceName)?.item ?? null;
  }

  if (!resourceConfig) {
    dbgStep('!resource_not_found', { resourceName });
    dbgEnd();
    return { action: null, resource: null, is_tenant: false, params: {} };
  }
  dbgStep('resourceConfig.resolved', { slug: resourceConfig.slug, is_tenant: resourceConfig.is_tenant });
  dbgEnd();

  // 2. Aggregate actions: system + tenant (+ cross-tenant if there is no context)
  const collectActions = (map: Record<string, any> | null): any[] =>
    map ? Object.values(map) : [];

  let actions: any[] = collectActions((await schemaManager.getAll('action')) ?? {});
  if (tenantSlug) {
    actions = [
      ...actions,
      ...collectActions((await schemaManager.getAll('action', tenantSlug)) ?? {}),
    ];
  } else {
    const all = await schemaManager.getAllAcrossTenants('action');
    for (const { scope, item } of all) {
      if (scope !== 'system') actions.push(item);
    }
  }

  let params: Record<string, string> = {};
  let matchedResource: string | null = null;

  const matchedAction = actions.find((action: any) => {
    if (action.method?.toLowerCase() !== method.toLowerCase()) return false;
    if (opts?.onlyPublic && action.auth !== false) return false;
    if (opts?.excludePublic && action.auth === false) return false;

    const actionPathSegments = (action.path || '').split('/').filter(Boolean);
    const fullTemplate = [resourceName, ...actionPathSegments];
    if (pathSegments.length !== fullTemplate.length) return false;

    const currentParams: Record<string, string> = {};
    const isMatch = fullTemplate.every((segment, i) => {
      if (segment.startsWith(':')) {
        currentParams[segment.slice(1)] = pathSegments[i];
        return true;
      }
      return segment === pathSegments[i];
    });

    if (isMatch) {
      params = currentParams;
      matchedResource = resourceName;
      return true;
    }
    return false;
  });

  return {
    action: matchedAction || null,
    resource: matchedResource,
    is_tenant: (resourceConfig.is_tenant as boolean) || false,
    params,
  };
};
