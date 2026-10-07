/**
 * Core V2 Adapter
 *
 * Provides backward-compatible interface for modules using Core V1
 * This adapter wraps Core V2 to expose the same method signatures as Core V1
 */

import { Db, ObjectId } from 'mongodb';
import {
  CoreService,
  QueryResult,
  UserContext,
  RelationshipRegistry,
  CoreOperationOptions,
} from '../../core_v2';
import { OptionsInput, IntermediateQueryResult } from '../types';
import {
  getCoreService,
  getMongoDb,
  getRelationshipRegistry,
  isCoreInitialized,
} from './bootstrap';

// withTenant has moved into core_v2/tenant. Local import so CoreAdapter can use it
// + re-export to keep backward compatibility for consumers importing from configs/core.
import { withTenant } from '../../core_v2/tenant';
import { runHooks } from '../../core_v2/hooks';
export { withTenant };
// ============================================================================
// TYPES - Re-export from configs/types for backward compatibility
// ============================================================================

// Re-export for backward compatibility
export type { OptionsInput, IntermediateQueryResult } from '../types';

import type { ComparisonOperator as CoreComparisonOperator, QueryParams } from '../../core_v2';
export type ComparisonOperator = CoreComparisonOperator;
export type { QueryParams };

// ============================================================================
// CORE V2 ADAPTER CLASS
// ============================================================================

/**
 * Adapter class that provides Core V1 compatible interface over Core V2
 */
export class CoreAdapter {
  private getCoreService(): CoreService {
    if (!isCoreInitialized()) {
      throw new Error('[CoreAdapter] Core V2 not initialized. Call initCore() first.');
    }
    return getCoreService();
  }

  /**
   * Convert V1 roles array to V2 UserContext
   */
  private toUserContext(roles: string[], options?: OptionsInput): UserContext {
    return {
      roles: roles,
      user_id: (options?.user_id || options?.userId || 'anonymous') as string,
      tenant_id: options?.tenant_id as string | undefined,
    };
  }


  /**
   * Convert V2 QueryResult to V1 IntermediateQueryResult
   * Maps QueryResult metadata structure to IntermediateQueryResult format
   */
  private toV1Result<T>(result: QueryResult<T>): IntermediateQueryResult<T> {
    return {
      data: result.data as T[],
      count: result.count ?? result.data.length,
      statusCode: result.statusCode || 200,
      metadata: {
        adapter: result.metadata?.adapter,
        query: result.metadata?.query,
        executionTime: result.metadata?.executionTime,
        // Preserve nativeQuery for debugging (MongoDB pipeline, SQL, etc.)
        nativeQuery: result.metadata?.nativeQuery,
      },
      pagination: result.pagination,
    };
  }

  // ============================================================================
  // QUERY METHODS - V1 Compatible Signatures
  // ============================================================================

  /**
   * Get QueryConverter instance
   */
  async getQueryConverter() {
    const coreService = this.getCoreService();
    return await coreService.getQueryConverter();
  }

  /**
   * Find all documents - V1 compatible signature
   * V1: findAll(params, collection, roles, options)
   */
  async findAll<T = any>(
    params: QueryParams,
    collection: string,
    roles: string[] = ['default'],
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<IntermediateQueryResult<T>> {
    const coreService = this.getCoreService();
    const userContext = this.toUserContext(roles, options);

    const run = () => coreService.findAll<T>(params, collection, userContext, options as CoreOperationOptions);
    const result = await withTenant(options?.tenant_id as string | undefined, run);
    return this.toV1Result(result);
  }

  /**
   * Find by ID - V1 compatible signature
   * V1: findById(collection, params, id, roles, options)
   */
  async findById<T = any>(
    collection: string,
    params: QueryParams,
    id: string,
    roles: string[] = ['default'],
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<IntermediateQueryResult<T>> {
    const coreService = this.getCoreService();
    const userContext = this.toUserContext(roles, options);
    // OptionsInput is compatible with CoreOperationOptions, pass directly
    const result = await coreService.findById<T>(collection, id, params, userContext, options as CoreOperationOptions);
    return this.toV1Result(result);
  }

  /**
   * Find one document - V1 compatible signature
   * V1: findOne(collection, params, filters, roles, options)
   */
  async findOne<T = any>(
    collection: string,
    params: QueryParams,
    filters: { field: string; operator: ComparisonOperator | string | { type: ComparisonOperator }; value: any }[],
    roles: string[] = ['default'],
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<IntermediateQueryResult<T>> {
    const coreService = this.getCoreService();
    const userContext = this.toUserContext(roles, options);

    // Convert filters to query params
    const filterParams: QueryParams = { 
      ...params, 
      limit: '1' // QueryParams expects string | string[]
    };
    for (const filter of filters) {
      const operatorStr = typeof filter.operator === 'string'
        ? filter.operator
        : filter.operator.type;
      filterParams[filter.field] = `${operatorStr}.${filter.value}`;
    }

    // OptionsInput is compatible with CoreOperationOptions, pass directly
    const result = await coreService.findAll<T>(filterParams, collection, userContext, options as CoreOperationOptions);

    // Return first result or empty
    return {
      data: result.data.slice(0, 1) as T[],
      count: result.data.length > 0 ? 1 : 0,
      statusCode: 200,
      metadata: {
        adapter: result.metadata?.adapter,
        query: result.metadata?.query,
        executionTime: result.metadata?.executionTime,
        // Preserve nativeQuery for debugging
        nativeQuery: result.metadata?.nativeQuery,
      },
    };
  }

  /**
   * Create document - V1 compatible signature
   * V1: create(collection, data, roles, options, callBack?)
   */
  async create<T = any>(
    collection: string,
    data: Record<string, any>,
    roles: string[] = ['default'],
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false },
    callBack?: () => void
  ): Promise<T> {
    const coreService = this.getCoreService();
    const userContext = this.toUserContext(roles, options);

    await runHooks(collection, 'beforeInsert', data, { user: (options as any)?.user, options });

    const run = () => coreService.create<T>(collection, data, userContext, options as CoreOperationOptions);
    const result = await withTenant(options?.tenant_id as string | undefined, run);
    await runHooks(collection, 'afterInsert', result.data[0], { user: (options as any)?.user, options });

    // Execute callback if provided
    if (callBack) {
      try {
        callBack();
      } catch (error) {
        console.error('[CoreAdapter] Callback error:', error);
      }
    }

    return result.data[0] as T;
  }

  /**
   * Update document - V1 compatible signature
   * V1: update(collection, id, data, roles, options)
   */
  async update<T = any>(
    collection: string,
    query: QueryParams | string,
    data: Record<string, any>,
    roles: string[] = ['default'],
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<T> {
    const coreService = this.getCoreService();
    const userContext = this.toUserContext(roles, options);

    // Convert query to proper format if it's a string (ID)
    const queryParams: QueryParams = typeof query === 'string'
      ? { _id: query }
      : query;

    await runHooks(collection, 'beforeUpdate', data, {
      user: (options as any)?.user, options,
      docId: typeof query === 'string' ? query : (queryParams as any)?._id,
    });

    const run = () => coreService.update<T>(collection, queryParams, data, userContext, options as CoreOperationOptions);
    const result = await withTenant(options?.tenant_id as string | undefined, run);
    await runHooks(collection, 'afterUpdate', result.data[0], {
      user: (options as any)?.user, options,
      docId: typeof query === 'string' ? query : (queryParams as any)?._id,
    });
    return result.data[0] as T;
  }

  /**
   * Delete document - V1 compatible signature
   * V1: delete(collection, id, roles, options)
   */
  async delete(
    collection: string,
    id: string,
    roles: string[] = ['default'],
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<boolean> {
    const coreService = this.getCoreService();
    const userContext = this.toUserContext(roles, options);

    await runHooks(collection, 'beforeDelete', { _id: id }, { user: (options as any)?.user, options, docId: id });

    const run = () => coreService.delete(collection, id, userContext, options as CoreOperationOptions);
    await withTenant(options?.tenant_id as string | undefined, run);

    await runHooks(collection, 'afterDelete', { _id: id }, { user: (options as any)?.user, options, docId: id });
    return true;
  }

  /**
   * Partial update document - V1 compatible signature
   * V1: partialUpdate(collection, id, data, roles, options)
   * Same as update but for PATCH operations
   */
  async partialUpdate<T = any>(
    collection: string,
    query: QueryParams,
    data: Record<string, any>,
    roles: string[] = ['default'],
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<IntermediateQueryResult<T>> {
    const coreService = this.getCoreService();
    const userContext = this.toUserContext(roles, options);
    const updateOptions = { ...options, partial: true } as CoreOperationOptions;

    const run = () => coreService.update<T>(collection, query, data, userContext, updateOptions);
    return this.toV1Result(await withTenant(options?.tenant_id as string | undefined, run));
  }

  /**
   * Delete many documents - V1 compatible signature
   * V1: deleteMany(collection, ids, roles, options)
   */
  async deleteMany(
    collection: string,
    params: any,
    roles: string[] = ['default'],
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<IntermediateQueryResult<any>> {
    const coreService = this.getCoreService();
    const userContext = this.toUserContext(roles, options);

    const run = () => coreService.deleteMany(collection, params, userContext, options as CoreOperationOptions);
    return this.toV1Result(await withTenant(options?.tenant_id as string | undefined, run));
  }

  /**
   * Execute raw intermediate query - V1 compatible signature
   * V1: advanceQuery(intermediateQuery, options)
   */
  async advanceQuery<T = any>(
    intermediateQuery: any,
    options: OptionsInput = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<IntermediateQueryResult<T>> {
    const coreService = this.getCoreService();

    const run = () => coreService.advanceQuery<T>(intermediateQuery, options as CoreOperationOptions);
    return this.toV1Result(await withTenant(options?.tenant_id as string | undefined, run));
  }

  /**
   * Low-level adapter action — service picks the adapter from
   * `entity.databaseType`, adapter executes against its native API.
   * Bypasses plugins / RBAC / validation. Used by trigger pipelines.
   */
  async executeAction(entity: string, action: any): Promise<any> {
    const coreService = this.getCoreService();
    return coreService.executeAction(entity, action);
  }
}

// ============================================================================
// RELATIONSHIP REGISTRY WRAPPER - V1 Compatible
// ============================================================================

/**
 * Wrapper for RelationshipRegistry that provides V1-compatible method names
 * V1 uses `getForTable` while V2 uses `getForCollection`
 */
class RelationshipRegistryWrapper {
  private registry: RelationshipRegistry;

  constructor(registry: RelationshipRegistry) {
    this.registry = registry;
  }

  /**
   * V1 compatible method - maps to V2's getForCollection
   * Excludes inverse (mangox_) relationships - those should only be used when explicitly requested
   */
  getForTable(tableName: string): any[] {
    return this.registry.getForCollection(tableName).filter((r: any) => !r.name.startsWith('mangox_'));
  }

  /**
   * Also expose V2 method for forward compatibility
   * Excludes inverse (mangox_) relationships
   */
  getForCollection(collectionName: string): any[] {
    return this.registry.getForCollection(collectionName).filter((r: any) => !r.name.startsWith('mangox_'));
  }

  /**
   * Get ALL relationships including inverse (mangox_) for explicit use
   */
  getForCollectionAll(collectionName: string): any[] {
    return this.registry.getForCollection(collectionName);
  }

  /**
   * Get relationship by name
   */
  getByName(collection: string, name: string): any {
    return this.registry.getByName(collection, name);
  }
}

// ============================================================================
// CORE V2 BOOTSTRAP - V1 Compatible Interface
// ============================================================================

/**
 * Bootstrap class that provides V1-compatible interface
 * Drop-in replacement for CoreBootstrap from core/main/connect.ts
 */
export class CoreBootstrap {
  private core: CoreAdapter;
  public relationshipRegistry: RelationshipRegistryWrapper;

  constructor() {
    this.core = new CoreAdapter();
    // Will be set after initialization
    this.relationshipRegistry = null as any;
  }

  /**
   * Initialize (called after initCore())
   */
  async initialize(): Promise<void> {
    if (!isCoreInitialized()) {
      throw new Error('[CoreBootstrap] Core V2 not initialized. Call initCore() first.');
    }
    // Wrap the V2 registry to provide V1-compatible interface
    this.relationshipRegistry = new RelationshipRegistryWrapper(getRelationshipRegistry());
  }

  /**
   * Get the Core API - V1 compatible
   */
  getCore(): CoreAdapter {
    return this.core;
  }

  /**
   * Get database instance - V1 compatible
   * Returns MongoDB Db instance, optionally for a specific tenant
   */
  async getInstanceDB(type: 'mongodb', tenantId?: string): Promise<Db> {
    if (type !== 'mongodb') {
      throw new Error(`[CoreBootstrap] Only mongodb is supported, got: ${type}`);
    }
    // Single-tenant: always use the system DB (MONGODB_URL). tenantId is ignored.
    return getMongoDb();
  }

  /**
   * Get MongoDB session for transactions - V1 compatible
   */
  async getSession(type: 'mongodb'): Promise<any> {
    if (type !== 'mongodb') {
      throw new Error(`[CoreBootstrap] Only mongodb is supported, got: ${type}`);
    }
    const { getMongoClient } = await import('./bootstrap');
    return getMongoClient().startSession();
  }

  /**
   * Get adapter - V1 compatible
   * Returns a MongoDB adapter compatible object
   */
  getAdapter(type: 'mongodb'): any {
    if (type !== 'mongodb') {
      throw new Error(`[CoreBootstrap] Only mongodb is supported, got: ${type}`);
    }
    // Return an adapter-like object that provides the expected interface
    // This wraps the V2 MongoDB functionality in a V1-compatible interface
    const db = getMongoDb();
    return {
      getIntanceDb: () => db,
      db: db,
      // Add other adapter methods as needed by PermissionAdapter
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let coreV2Bootstrap: CoreBootstrap | null = null;

/**
 * Get or create the Core V2 Bootstrap singleton
 */
export function getCoreBootstrap(): CoreBootstrap {
  if (!coreV2Bootstrap) {
    coreV2Bootstrap = new CoreBootstrap();
  }
  return coreV2Bootstrap;
}

/**
 * Initialize Core V2 Bootstrap
 * Call this after initCore()
 */
export async function initCoreBootstrap(): Promise<CoreBootstrap> {
  const bootstrap = getCoreBootstrap();
  await bootstrap.initialize();
  return bootstrap;
}

