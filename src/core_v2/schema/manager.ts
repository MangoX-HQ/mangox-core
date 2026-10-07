/**
 * Core V2 - Schema Manager
 *
 * Pure Redis cache layer. JSON I/O and bootstrap have moved to
 * `src/core_v2/store/{json-store, schema-sync}.ts`.
 *
 * Public surface:
 *  - get/set/delete/has/clear* (single + bulk)
 *  - getEntity / getAllEntities / getAllEntitiesAllTenants / getAllPolicies
 *  - deleteTenantSchema (deletes all Redis keys for a tenant)
 *  - saveAll / itemName / flushAllSchemas / markTenantLoaded / markInitialized — for SchemaSync
 *  - loadTenantSchemas / reloadById — lazy reload helpers
 */

import { appSettings } from "../../configs/app-settings";
import { redisSchemaClient as redisClient } from "../../configs/redis";
import { convertToAjvSchema } from "./converter";
import { getTenantSlug, getTenantScope } from "../adapters/mongodb/tenant-context";
import { dbgStep, dbgGroup, dbgEnd } from "../debug/debug-logger";

// ============================================================================
// TYPES
// ============================================================================

export interface EntitySchema {
  _id?: string;
  collection_name: string;
  label?: string;
  json_schema?: any;
  [key: string]: any;
}

export type SchemaCollection =
  | "entity" | "collection" | "resource" | "policy"
  | "validation" | "action" | "code" | "form" | "tenant"
  | "role" | "rule" | "setting" | "form-setting" | "api-config";

const ALL_COLLECTIONS: SchemaCollection[] = [
  "entity", "collection", "policy", "action", "code", "resource", "form", "tenant", "rule",
];

function stripClientKeyPrefix(client: any, keys: string[]): string[] {
  const prefix = client?.options?.keyPrefix as string | undefined;
  if (!prefix) return keys;
  return keys.map((key) => key.startsWith(prefix) ? key.slice(prefix.length) : key);
}

/** Types that have JSON files on disk → SchemaSync will load them into Redis at bootstrap */
export const JSON_TYPES: SchemaCollection[] = [
  "entity", "collection", "policy", "action", "code", "resource", "form",
  "role", "rule", "setting", "form-setting", "api-config",
];

// ============================================================================
// SCHEMA MANAGER
// ============================================================================

class SchemaManager {
  private initialized = false;
  private tenantLoaded = new Set<string>();

  // ============================================================================
  // REDIS KEY HELPERS
  // Multi-tenant Redis: scope 'team_id/tenant_slug' → use the team's Redis client.
  // System / scope without a team prefix → use the global redisClient.
  // ============================================================================

  private redisKey(collection: string, scope?: string | null): string {
    const app = appSettings.appName || 'app';
    if (!scope) return `schema:${app}:global:${collection}`;
    // Composite scope uses `/` for the FS path — convert to `:` to follow
    // Redis convention (key segments use `:`)
    const rkey = scope.replace(/\//g, ':');
    return `schema:${app}:tenant:${rkey}:${collection}`;
  }

  /** Single-tenant: always uses the global Redis (team Redis has been removed). */
  private async pickRedis(_scope?: string | null): Promise<any> {
    return redisClient;
  }

  private async rGet(collection: string, name: string, scope?: string | null): Promise<any | null> {
    try {
      const client = await this.pickRedis(scope);
      const val = await client.hget(this.redisKey(collection, scope), name);
      return val ? JSON.parse(val) : null;
    } catch { return null; }
  }

  private async rSet(collection: string, name: string, data: any, scope?: string | null): Promise<void> {
    try {
      const client = await this.pickRedis(scope);
      await client.hset(this.redisKey(collection, scope), name, JSON.stringify(data));
    } catch (e) { console.warn('[SchemaManager] Redis hset failed:', e); }
  }

  private async rDel(collection: string, name: string, scope?: string | null): Promise<void> {
    try {
      const client = await this.pickRedis(scope);
      await client.hdel(this.redisKey(collection, scope), name);
    } catch (e) { console.warn('[SchemaManager] Redis hdel failed:', e); }
  }

  private async rDelAll(collection: string, scope?: string | null): Promise<void> {
    try {
      const client = await this.pickRedis(scope);
      await client.del(this.redisKey(collection, scope));
    } catch (e) { console.warn('[SchemaManager] Redis del failed:', e); }
  }

  private async rLoad(collection: string, scope?: string | null): Promise<Record<string, any> | null> {
    try {
      const client = await this.pickRedis(scope);
      const key = this.redisKey(collection, scope);
      dbgGroup('[schema] rLoad', { collection, scope });
      dbgStep('redisKey', { key });
      const hash = await client.hgetall(key);
      const count = hash ? Object.keys(hash).length : 0;
      dbgStep('HGETALL', { count });
      dbgEnd();
      if (!hash || count === 0) return null;
      const result: Record<string, any> = {};
      for (const [k, v] of Object.entries(hash)) {
        try { result[k] = JSON.parse(v as string); } catch { result[k] = v; }
      }
      return result;
    } catch (e: any) {
      dbgStep('!rLoad error', { msg: e?.message });
      dbgEnd();
      return null;
    }
  }

  // ============================================================================
  // BULK / SCHEMASYNC HELPERS (public)
  // ============================================================================

  /** Bulk hset for a collection — used by SchemaSync at bootstrap */
  async saveAll(collection: string, data: Record<string, any>, scope?: string | null): Promise<void> {
    if (Object.keys(data).length === 0) return;
    try {
      const client = await this.pickRedis(scope);
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) args[k] = JSON.stringify(v);
      await client.hset(this.redisKey(collection, scope), args);
    } catch (e) { console.warn('[SchemaManager] Redis hset bulk failed:', e); }
  }

  /** Identifier key cho 1 item trong collection (priority: collection_name > role_base > slug > endpoint > _id) */
  itemName(_collection: string, item: any): string | null {
    return item.collection_name || item.role_base || item.slug || item.endpoint || item._id?.toString() || null;
  }

  /** Wipes every `schema:<app>:*` key — called by SchemaSync before reloading */
  async flushAllSchemas(): Promise<void> {
    try {
      const app = appSettings.appName || 'app';
      const pattern = `schema:${app}:*`;
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(...stripClientKeyPrefix(redisClient, keys));
        console.log(`[SchemaManager] Flushed ${keys.length} stale schema keys from Redis`);
      }
    } catch (err) {
      console.warn('[SchemaManager] Failed to flush schemas:', err);
    }
  }

  markTenantLoaded(slug: string): void {
    this.tenantLoaded.add(slug);
  }

  markInitialized(): void {
    this.initialized = true;
  }

  // ============================================================================
  // GETTERS — read from Redis
  // ============================================================================

  async get(collection: SchemaCollection, name: string): Promise<any | null> {
    const scope = getTenantScope();
    if (scope) {
      const tenantVal = await this.rGet(collection, name, scope);
      if (tenantVal) return tenantVal;
    }
    return this.rGet(collection, name);
  }

  async getEntity(name: string): Promise<EntitySchema | null> {
    const scope = getTenantScope();
    let entity: EntitySchema | null = null;
    if (scope) entity = await this.rGet('entity', name, scope);
    if (!entity) entity = await this.rGet('entity', name);
    if (entity?.json_schema && !(entity as any).__ajv_converted) {
      entity = { ...entity, json_schema: convertToAjvSchema(entity.json_schema, entity.collection_name) };
      (entity as any).__ajv_converted = true;
    }
    return entity;
  }

  /** Lookup an entity for a specific tenant (controller flow where ALS isn't set yet). */
  async getEntityForTenant(name: string, tenantSlug: string): Promise<EntitySchema | null> {
    let entity: EntitySchema | null = await this.rGet('entity', name, tenantSlug);
    if (!entity) entity = await this.rGet('entity', name);
    if (entity?.json_schema && !(entity as any).__ajv_converted) {
      entity = { ...entity, json_schema: convertToAjvSchema(entity.json_schema, entity.collection_name) };
      (entity as any).__ajv_converted = true;
    }
    return entity;
  }

  /**
   * Looks up the entity RAW (does NOT convert via AJV) — keeps the `widget`,
   * `typeRelation`, `refValue` fields in json_schema intact. Used by EntityConfigLoader to
   * parse relationships (AJV conversion strips these fields → relations would be lost).
   */
  async getEntityRaw(name: string, tenantSlug?: string | null): Promise<EntitySchema | null> {
    let entity: EntitySchema | null = null;
    if (tenantSlug) entity = await this.rGet('entity', name, tenantSlug);
    if (!entity) entity = await this.rGet('entity', name);
    return entity;
  }

  async getAllEntities(): Promise<Record<string, EntitySchema>> {
    const global = (await this.rLoad('entity')) ?? {};
    const scope = getTenantScope();
    if (!scope) return global;
    const tenant = (await this.rLoad('entity', scope)) ?? {};
    return { ...global, ...tenant };
  }

  /** Returns system + tenant (env scope) entities — bootstrap relationship registration. */
  async getAllEntitiesAllTenants(): Promise<Record<string, EntitySchema>> {
    const result: Record<string, EntitySchema> = { ...(await this.rLoad('entity')) ?? {} };
    const scope = getTenantScope();
    if (scope) Object.assign(result, (await this.rLoad('entity', scope)) ?? {});
    return result;
  }

  async getAllPolicies(tenantSlug?: string): Promise<Record<string, any> | null> {
    return this.rLoad('policy', tenantSlug);
  }

  /** Generic: returns all items of a collection (by scope), or null if empty. */
  async getAll(collection: SchemaCollection, tenantSlug?: string | null): Promise<Record<string, any> | null> {
    return this.rLoad(collection, tenantSlug ?? undefined);
  }

  /**
   * Lists items of a collection ACROSS all known tenants.
   * Used for cross-tenant lookups (e.g. finding a role slug without a tenant context).
   * Returns an array of {scope, item}.
   */
  async getAllAcrossTenants(collection: SchemaCollection): Promise<Array<{ scope: string; item: any }>> {
    const out: Array<{ scope: string; item: any }> = [];
    const sysMap = (await this.rLoad(collection)) ?? {};
    for (const item of Object.values(sysMap)) out.push({ scope: 'system', item });
    const scope = getTenantScope();
    if (scope) {
      const tenantMap = (await this.rLoad(collection, scope)) ?? {};
      for (const item of Object.values(tenantMap)) out.push({ scope, item });
    }
    return out;
  }

  async getPolicy(slug: string, tenantSlug?: string): Promise<any | null> {
    return this.rGet('policy', slug, tenantSlug);
  }

  async has(collection: SchemaCollection, name: string): Promise<boolean> {
    try {
      return (await redisClient.hexists(this.redisKey(collection), name)) === 1;
    } catch { return false; }
  }

  async getCache(): Promise<Record<string, Record<string, any>>> {
    const result: Record<string, Record<string, any>> = {};
    for (const col of ALL_COLLECTIONS) {
      result[col] = (await this.rLoad(col)) ?? {};
    }
    return result;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ============================================================================
  // SETTERS — write to Redis
  // ============================================================================

  async set(collection: SchemaCollection, name: string, data: any, explicitScope?: string | null): Promise<void> {
    const scope = explicitScope !== undefined ? explicitScope : getTenantScope();
    await this.rSet(collection, name, data, scope || undefined);
  }

  async delete(collection: SchemaCollection, name: string, explicitScope?: string | null): Promise<void> {
    const scope = explicitScope !== undefined ? explicitScope : getTenantScope();
    await this.rDel(collection, name, scope || undefined);
    if (scope) await this.rDel(collection, name);
  }

  async clearCollection(collection: SchemaCollection): Promise<void> {
    await this.rDelAll(collection);
  }

  async clearAll(): Promise<void> {
    for (const col of ALL_COLLECTIONS) await this.rDelAll(col);
    this.initialized = false;
  }

  /**
   * Deletes all of a tenant's schema from Redis (every collection) + removes it from
   * tenantLoaded so that if a tenant with the same slug is recreated, it gets reloaded from scratch.
   * Used when deleting a tenant. Returns the number of keys deleted.
   */
  async deleteTenantSchema(scope: string): Promise<number> {
    try {
      if (!scope) return 0;
      const app = appSettings.appName || 'app';
      const client = await this.pickRedis(scope);
      const rkey = scope.replace(/\//g, ':');
      const keys = await client.keys(`schema:${app}:tenant:${rkey}:*`);
      if (keys.length > 0) await client.del(...stripClientKeyPrefix(client, keys));
      this.tenantLoaded.delete(scope);
      return keys.length;
    } catch (err) {
      console.warn(`[SchemaManager] deleteTenantSchema failed for '${scope}':`, err);
      return 0;
    }
  }

  // ============================================================================
  // LAZY LOADERS (JSON → Redis on-demand)
  // ============================================================================

  /** Single-tenant: schema is already seeded in Redis — no longer seeds from JSON files (no-op). */
  async loadTenantSchemas(tenantSlug: string, _force = false): Promise<void> {
    this.tenantLoaded.add(tenantSlug);
  }

  async getTenantCache(tenantSlug?: string | null): Promise<Record<string, Record<string, any>>> {
    const result: Record<string, Record<string, any>> = {};
    for (const col of ALL_COLLECTIONS) {
      const global = (await this.rLoad(col)) ?? {};
      const tenant = tenantSlug ? ((await this.rLoad(col, tenantSlug)) ?? {}) : {};
      result[col] = { ...global, ...tenant };
    }
    return result;
  }

  /** Finds an item by id/slug in Redis (tenant env scope → system). */
  async reloadById(collection: SchemaCollection, id: string): Promise<any | null> {
    try {
      const scope = getTenantScope();
      const maps = [
        ...(scope ? [await this.rLoad(collection, scope)] : []),
        await this.rLoad(collection),
      ];
      for (const map of maps) {
        if (!map) continue;
        const found = Object.values(map).find((c: any) =>
          c._id === id || c.slug === id || c.collection_name === id,
        );
        if (found) return found;
      }
      return null;
    } catch (error) {
      console.error(`[SchemaManager] Failed to reload ${collection}/${id}:`, error);
      return null;
    }
  }

}

// ============================================================================
// SINGLETON
// ============================================================================

export const schemaManager = new SchemaManager();

/** @deprecated use schemaManager.getCache() — now async */
export const schema = schemaManager.getCache.bind(schemaManager);
