/**
 * Core V2 - Relationship Registry
 * Manages entity relationships for join operations
 */

import { IRelationshipRegistry, RelationshipDefinition } from '../../interfaces/adapter.interface';
import { getTenantId } from '../mongodb/tenant-context';

/**
 * Buckets relationships by TENANT (key = tenant _id). Avoids the case where 2 tenants with the
 * same collection_name overwrite each other's relations (the registry used to be global by collection_name).
 *
 * - register(def, tenantKey?): tenantKey is taken from ALS (the tenant currently reloading/running) if not passed.
 * - lookup (getForCollection/getByName/...): reads the current tenantKey from ALS; if NONE (system /
 *   outside tenant context) → GLOBAL bucket. Always falls back to GLOBAL if the tenant bucket is empty
 *   → doesn't break the old system/admin flow.
 */
const GLOBAL = '__global__';

interface ScopeBucket {
  byCollection: Map<string, RelationshipDefinition[]>;
  byName: Map<string, RelationshipDefinition>;
}

/**
 * Registry for managing entity relationships (tenant-scoped)
 */
export class RelationshipRegistry implements IRelationshipRegistry {
  /** tenantKey → that tenant's relationship bucket */
  private scopes: Map<string, ScopeBucket> = new Map();

  /** Current tenantKey (ALS) when not passed explicitly. */
  private currentTenantKey(): string {
    try {
      const id = getTenantId();
      return id || GLOBAL;
    } catch {
      return GLOBAL;
    }
  }

  private bucket(tenantKey: string, create = false): ScopeBucket | undefined {
    let b = this.scopes.get(tenantKey);
    if (!b && create) {
      b = { byCollection: new Map(), byName: new Map() };
      this.scopes.set(tenantKey, b);
    }
    return b;
  }

  /**
   * Register a relationship
   * @param definition - Relationship definition
   * @param tenantKey   - tenant _id to scope by; defaults to ALS (GLOBAL if not present)
   */
  register(definition: RelationshipDefinition, tenantKey?: string): void {
    const key = tenantKey ?? this.currentTenantKey();
    const b = this.bucket(key, true)!;

    const collectionRelationships = b.byCollection.get(definition.sourceCollection) || [];
    const existingIndex = collectionRelationships.findIndex((r) => r.name === definition.name);
    if (existingIndex >= 0) {
      collectionRelationships[existingIndex] = definition;
    } else {
      collectionRelationships.push(definition);
    }
    b.byCollection.set(definition.sourceCollection, collectionRelationships);
    b.byName.set(`${definition.sourceCollection}:${definition.name}`, definition);
  }

  /**
   * Register multiple relationships at once
   * @param definitions - Array of relationship definitions
   */
  registerMany(definitions: RelationshipDefinition[]): void {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /**
   * Register a relationship from a simplified format
   */
  registerSimple(
    sourceCollection: string,
    name: string,
    targetCollection: string,
    localField: string,
    foreignField: string = '_id',
    type: RelationshipDefinition['type'] = 'one-to-many'
  ): void {
    this.register({
      name,
      sourceCollection,
      targetCollection,
      localField,
      foreignField,
      type,
    });
  }

  /**
   * Get relationships for a collection (current tenant; fallback to GLOBAL if empty).
   */
  getForCollection(collection: string, tenantKey?: string): RelationshipDefinition[] {
    const key = tenantKey ?? this.currentTenantKey();
    const own = this.bucket(key)?.byCollection.get(collection);
    if (own && own.length) return own;
    if (key !== GLOBAL) {
      const glob = this.bucket(GLOBAL)?.byCollection.get(collection);
      if (glob && glob.length) return glob;
    }
    return own || [];
  }

  /**
   * Get a specific relationship by name (current tenant; fallback to GLOBAL).
   */
  getByName(collection: string, name: string, tenantKey?: string): RelationshipDefinition | undefined {
    const key = tenantKey ?? this.currentTenantKey();
    const fullName = `${collection}:${name}`;
    return this.bucket(key)?.byName.get(fullName)
      ?? (key !== GLOBAL ? this.bucket(GLOBAL)?.byName.get(fullName) : undefined);
  }

  /**
   * Find relationship by local field
   */
  findByLocalField(collection: string, localField: string, tenantKey?: string): RelationshipDefinition | undefined {
    return this.getForCollection(collection, tenantKey).find((r) => r.localField === localField);
  }

  /**
   * Get all registered relationships (all tenants — debug/export).
   */
  getAll(): RelationshipDefinition[] {
    const out: RelationshipDefinition[] = [];
    for (const b of this.scopes.values()) out.push(...b.byName.values());
    return out;
  }

  /**
   * Get all collections that have relationships (union of all tenants).
   */
  getCollections(): string[] {
    const set = new Set<string>();
    for (const b of this.scopes.values()) for (const c of b.byCollection.keys()) set.add(c);
    return Array.from(set);
  }

  hasRelationships(collection: string, tenantKey?: string): boolean {
    return this.getForCollection(collection, tenantKey).length > 0;
  }

  hasRelationship(collection: string, name: string, tenantKey?: string): boolean {
    return this.getByName(collection, name, tenantKey) !== undefined;
  }

  /**
   * Remove a specific relationship from the current tenant.
   */
  remove(collection: string, name: string, tenantKey?: string): boolean {
    const key = tenantKey ?? this.currentTenantKey();
    const b = this.bucket(key);
    if (!b) return false;
    const fullName = `${collection}:${name}`;
    if (!b.byName.has(fullName)) return false;
    b.byName.delete(fullName);
    const list = b.byCollection.get(collection);
    if (list) {
      const filtered = list.filter((r) => r.name !== name);
      if (filtered.length > 0) b.byCollection.set(collection, filtered);
      else b.byCollection.delete(collection);
    }
    return true;
  }

  /**
   * Remove all relationships for a collection from the current tenant.
   */
  removeForCollection(collection: string, tenantKey?: string): void {
    const key = tenantKey ?? this.currentTenantKey();
    const b = this.bucket(key);
    if (!b) return;
    for (const rel of b.byCollection.get(collection) || []) {
      b.byName.delete(`${collection}:${rel.name}`);
    }
    b.byCollection.delete(collection);
  }

  /** Alias for removeForCollection (V1 compatibility) */
  removeBySource(collection: string, tenantKey?: string): void {
    this.removeForCollection(collection, tenantKey);
  }

  /** Clear all relationships (all tenants) */
  clear(): void {
    this.scopes.clear();
  }

  /** Get relationship count (all tenants) */
  count(): number {
    let n = 0;
    for (const b of this.scopes.values()) n += b.byName.size;
    return n;
  }

  /**
   * Export all relationships as JSON
   */
  toJSON(): Record<string, RelationshipDefinition[]> {
    const result: Record<string, RelationshipDefinition[]> = {};
    for (const b of this.scopes.values()) {
      for (const [collection, relationships] of b.byCollection) {
        result[collection] = [...(result[collection] || []), ...relationships];
      }
    }
    return result;
  }

  /**
   * Import relationships from JSON
   * @param data - JSON data from toJSON()
   */
  fromJSON(data: Record<string, RelationshipDefinition[]>): void {
    for (const [collection, relationships] of Object.entries(data)) {
      for (const relationship of relationships) {
        this.register({
          ...relationship,
          sourceCollection: collection,
        });
      }
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let globalRelationshipRegistry: RelationshipRegistry | null = null;

/**
 * Get global relationship registry instance
 */
export function getRelationshipRegistry(): RelationshipRegistry {
  if (!globalRelationshipRegistry) {
    globalRelationshipRegistry = new RelationshipRegistry();
  }
  return globalRelationshipRegistry;
}

/**
 * Set global relationship registry instance
 */
export function setRelationshipRegistry(registry: RelationshipRegistry): void {
  globalRelationshipRegistry = registry;
}

/**
 * Create a new relationship registry
 */
export function createRelationshipRegistry(): RelationshipRegistry {
  return new RelationshipRegistry();
}
