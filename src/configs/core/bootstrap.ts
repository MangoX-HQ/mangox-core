/**
 * Core V2 Global Configuration
 * Integration point for the new core system
 *
 * NOTE: Config values are imported from /src/configs/core-v2-config.ts
 */

import { MongoClient, Db } from 'mongodb'; 
import {
  RBAC_CONFIG,
  PLUGIN_CONFIG,
  CACHE_CONFIG,
  QUERY_CONFIG,
} from './config';
import {
  // Config
  CoreConfig,
  ConfigBuilder,
  setGlobalConfig,
  getGlobalConfig,
  DEFAULT_CORE_CONFIG,

  // Adapters
  MongoDBAdapter,
  createMongoDBAdapter,
  createRelationshipRegistry,
  setRelationshipRegistry,
  adapterRegistry,
  mongoDBAdapterFactory,
  restApiAdapterFactory,
  RelationshipRegistry,

  // Services
  CoreService,
  createCoreService,

  // Schema
  EntityConfigLoader,
  createEntityConfigLoader,
  JSONEntityConfigSource,
  AjvValidator,
  createAjvValidator,

  // Cache
  CacheManager,
  createCacheManager,
  createRedisDriverFromUrl,
  createInMemoryDriver,

  // Plugins
  PluginManager,
  createPluginManager,
  builtInPlugins,
  registerBuiltInPlugins,
  setSyncRelationshipOperations,
  setSlugChecker,
  setSeopathOperations,
  setEntitySchemaGetter,
  setBlockOperations,
  setHistoryOperations,
  setUserLookup,
  setApprovalOperations,

  // Authorization
  AuthorizationService,
  createAuthorizationService,
  createPermissionResolver,
  createMongoDBPermissionDatabase,

  // Query
  QueryConverter,
  createQueryConverter,

  // Types
  UserContext,
  setLocaleChecker,
} from '../../core_v2';

import { appSettings, buildRedisKeyPrefix, buildRedisUrl } from '../app-settings';
import { getTenantDb, setSingleTenantDb } from '../../core_v2/adapters/mongodb/tenant-context';
import { getTenantScope } from '../tenant';

// ============================================================================
// GLOBAL INSTANCES
// ============================================================================

let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;
let coreService: CoreService | null = null;
let entityConfigLoader: EntityConfigLoader | null = null;
let ajvValidator: AjvValidator | null = null;
let cacheManager: CacheManager | null = null;
let _mongoAdapter: MongoDBAdapter | null = null;
let authorizationService: AuthorizationService | null = null;
let relationshipRegistry: RelationshipRegistry | null = null;
let pluginManager: PluginManager | null = null;
let _queryConverter: QueryConverter | null = null;
let isInitialized = false;

// Service Manager for Redis/Queue (moved from core-global.ts)
import { initializeServiceManager, ServiceManager } from "../../module/_service";
export let redisGlobal: ServiceManager;

// Utility function (moved from core-global.ts)
export const filterPassword = (obj: any) => {
  if (obj && typeof obj === 'object') {
    for (const key in obj) {
      if (key.toLowerCase().includes('password')) {
        obj[key] = undefined;
      }
    }
  }
  return obj;
};

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Build Core V2 config from app settings using ConfigBuilder
 * Config values are imported from /src/configs/core-v2-config.ts
 */
function buildCoreV2Config(): CoreConfig {
  return new ConfigBuilder()
    .withRbac(RBAC_CONFIG)
    .withCache({
      ...CACHE_CONFIG,
      defaultTTL: appSettings.redis.cacheTTL || CACHE_CONFIG.defaultTTL,
    })
    .withQuery(QUERY_CONFIG)
    .withPlugins(PLUGIN_CONFIG)
    .withAdapter('mongodb', {
      type: 'mongodb',
      connectionString: appSettings.mongo.url,
    })
    .build();
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize Core V2
 */
export async function initCore(): Promise<void> {
  if (isInitialized) {
    console.log('[Core V2] Already initialized, skipping...');
    return;
  }

  console.log('[Core V2] Initializing...');

  try {
    // 1. Set global config
    const config = buildCoreV2Config();
    setGlobalConfig(config);
    console.log('[Core V2] Config set');

    // 2. Connect to MongoDB
    const connectionString = appSettings.mongo.url;
    mongoClient = new MongoClient(connectionString);
    await mongoClient.connect();
    mongoDb = mongoClient.db();
    setSingleTenantDb(mongoDb);
    console.log('[Core V2] MongoDB connected');

    // 3. Create relationship registry
    relationshipRegistry = createRelationshipRegistry();
    adapterRegistry.setRelationshipRegistry(relationshipRegistry);
    // IMPORTANT: always assign as a module-singleton so every place calling getRelationshipRegistry()
    // (plugin, factory, core-service fallback) uses the SAME instance — otherwise, the loader
    // registers into a separate instance while other places read an empty instance → join/get-parent breaks.
    setRelationshipRegistry(relationshipRegistry);
    console.log('[Core V2] Relationship registry created');

    // 4. Register MongoDB adapter factory and initialize adapter
    adapterRegistry.registerFactory(mongoDBAdapterFactory);
    _mongoAdapter = await adapterRegistry.initializeAdapter({
      type: 'mongodb',
      connectionString: connectionString,
    }) as MongoDBAdapter;
    console.log('[Core V2] MongoDB adapter created');

    // 4c. Register REST adapter factory (no eager init).
    // REST adapter is now data-driven: each entity with `databaseType='rest'`
    // references an `api-config` record (DB-managed via dashboard) which carries
    // base_url / auth / capabilities / endpoint_map / etc. Adapter is a singleton;
    // per-request config flows through IntermediateQuery.apiConfig.
    adapterRegistry.registerFactory(restApiAdapterFactory);
    await adapterRegistry.initializeAdapter({ type: 'rest' as any } as any);
    console.log('[Core V2] REST adapter registered (config from api-config records)');

    // 5. Initialize cache
    try {
      const redisDriver = await createRedisDriverFromUrl(buildRedisUrl(), {
        keyPrefix: buildRedisKeyPrefix(),
      });
      cacheManager = createCacheManager(redisDriver, config.cache);
      console.log('[Core V2] Redis cache initialized');
    } catch (error) {
      console.warn('[Core V2] Redis cache failed, using in-memory cache:', error);
      const memoryDriver = createInMemoryDriver();
      cacheManager = createCacheManager(memoryDriver, config.cache);
    }

    // 6. Initialize entity config loader (pass the relationshipRegistry to register relationships)
    const entitySource = new JSONEntityConfigSource();
    entityConfigLoader = createEntityConfigLoader(entitySource, relationshipRegistry);
    await entityConfigLoader.initialize();
    console.log('[Core V2] Entity config loader initialized');

    // 7. Initialize AJV validator (schema is loaded dynamically from SchemaManager at validation time)
    ajvValidator = createAjvValidator();
    console.log('[Core V2] AJV validator initialized');
    // 8. Initialize plugin manager with all built-in plugins
    pluginManager = createPluginManager(config.plugins);
    registerBuiltInPlugins(pluginManager);
    console.log(`[Core V2] Plugin manager initialized with ${builtInPlugins.length} plugins`);

    // 9. Setup slug checker for slug plugin
    // Scope uniqueness by {tenant_id, entity_slug, slug} when scope is provided,
    // otherwise fall back to global {slug} for backward compatibility.
    setSlugChecker({
      checkSlugExists: async (collection, slug, excludeId, scope) => {
        const db = getTenantDb() ?? mongoDb!;
        const filter: any = { slug };
        if (scope?.entitySlug) filter.entity_slug = scope.entitySlug;
        if (scope?.tenantId) filter.tenant_id = scope.tenantId;
        if (excludeId) filter.related_id = { $ne: excludeId };
        const count = await db.collection(collection).countDocuments(filter);
        return count > 0;
      },
      findExistingSlug: async (collection, slug, relatedId, scope) => {
        const db = getTenantDb() ?? mongoDb!;
        const filter: any = { slug };
        if (scope?.entitySlug) filter.entity_slug = scope.entitySlug;
        if (scope?.tenantId) filter.tenant_id = scope.tenantId;
        const record = await db.collection(collection).findOne(filter);
        if (!record) {
          return { exists: false, isOwned: false, hasRedirect: false };
        }
        const isOwned = relatedId
          ? Array.isArray(record.related_id) && record.related_id.includes(relatedId)
          : false;
        const hasRedirect = record.redirect_url != null;
        return { exists: true, isOwned, hasRedirect };
      },
    });
    console.log('[Core V2] Slug checker configured');

    // 10. Setup seopath operations for seopath plugin
    setSeopathOperations({
      findByRelatedId: async (relatedId: string, session?: any) => {
        const db = getTenantDb() ?? mongoDb!;
        const opts = session ? { session } : undefined;
        return db.collection('seopath').find({ related_id: relatedId }, opts).toArray() as any;
      },
      insert: async (record: any, session?: any) => {
        const db = getTenantDb() ?? mongoDb!;
        const opts = session ? { session } : undefined;
        // Use upsert on unique key {tenant_id, entity_slug, slug} so concurrent
        // inserts of the same slug don't throw E11000 — they merge into the
        // existing record (last writer wins). Eliminates race in seopath flow.
        const filter = {
          tenant_id: record.tenant_id,
          entity_slug: record.entity_slug,
          slug: record.slug,
        };
        const { created_at, ...rest } = record;
        await db.collection('seopath').updateOne(
          filter,
          {
            $set: rest,
            $setOnInsert: created_at ? { created_at } : {},
          },
          { ...opts, upsert: true },
        );
      },
      updateById: async (id: string, update: any, session?: any) => {
        const { ObjectId } = await import('mongodb');
        const db = getTenantDb() ?? mongoDb!;
        const opts = session ? { session } : undefined;
        await db.collection('seopath').updateOne(
          { _id: new ObjectId(id) },
          { $set: update },
          opts
        );
      },
      updateMany: async (filter: any, update: any, session?: any) => {
        const db = getTenantDb() ?? mongoDb!;
        const opts = session ? { session } : undefined;
        const mongoFilter: any = {};
        if (filter.slug) mongoFilter.slug = filter.slug;
        if (filter.relatedId) mongoFilter.related_id = [filter.relatedId];
        await db.collection('seopath').updateMany(mongoFilter, { $set: update }, opts);
      },
      deleteByRelatedIds: async (relatedIds: string[], session?: any) => {
        const db = getTenantDb() ?? mongoDb!;
        const opts = session ? { session } : undefined;
        await db.collection('seopath').deleteMany(
          { related_id: { $in: relatedIds } },
          opts
        );
      },
    });
    console.log('[Core V2] Seopath operations configured');

    // 11. Setup entity schema getter for seopath plugin
    setEntitySchemaGetter((collectionName: string) => {
      const entity = entityConfigLoader!.getEntity(collectionName);
      if (!entity) return null;
      return {
        _id: entity._id,
        collection_name: entity.collection_name,
        languages: (entity as any).languages,
        mongodb_save_data: (entity as any).mongodb_save_data,
      };
    });
    console.log('[Core V2] Entity schema getter configured');

    // 12. Setup sync relationship operations for multi-language sync
    setSyncRelationshipOperations({
      getCollection: async (name: string) => (getTenantDb() ?? mongoDb!).collection(name) as any,
      getRelationships: (tableName: string) => {
        const relations = relationshipRegistry!.getForCollection(tableName);
        return relations.map((rel: any) => ({
          localField: rel.localField || rel.name,
          foreignField: rel.foreignField || '_id',
          targetTable: rel.targetTable || rel.target,
        }));
      },
      invalidateCache: async (collection: string) => {
        if (cacheManager) {
          await cacheManager.invalidateCollection(collection);
        }
      },
    });
    console.log('[Core V2] Sync relationship operations configured');

    // 13. Setup block operations for block plugin
    setBlockOperations({
      bulkWrite: async (collection: string, operations: unknown[], session?: unknown) => {
        const db = getTenantDb() ?? mongoDb!;
        const opts = session ? { session: session as any } : undefined;
        const result = await db.collection(collection).bulkWrite(operations as any, opts);
        return {
          insertedIds: result.insertedIds as any,
          modifiedCount: result.modifiedCount,
          deletedCount: result.deletedCount,
        };
      },
      findOne: async (collection: string, filter: Record<string, unknown>, options?: Record<string, unknown>) => {
        const db = getTenantDb() ?? mongoDb!;
        const { ObjectId } = await import('mongodb');
        const mongoFilter: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(filter)) {
          if (key === '_id' && typeof value === 'string') {
            mongoFilter._id = new ObjectId(value);
          } else {
            mongoFilter[key] = value;
          }
        }
        return db.collection(collection).findOne(mongoFilter, options);
      },
      find: async (collection: string, filter: Record<string, unknown>, options?: Record<string, unknown>) => {
        const db = getTenantDb() ?? mongoDb!;
        const { ObjectId } = await import('mongodb');
        const mongoFilter: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(filter)) {
          if (key === '_id' && typeof value === 'object' && value !== null && '$in' in value) {
            const ids = (value as any).$in;
            mongoFilter._id = { $in: ids.map((id: string) => new ObjectId(id)) };
          } else if (key === '_id' && typeof value === 'string') {
            mongoFilter._id = new ObjectId(value);
          } else {
            mongoFilter[key] = value;
          }
        }
        return db.collection(collection).find(mongoFilter, options).toArray();
      },
      invalidateCache: async (collections: string[]) => {
        if (cacheManager) {
          for (const collection of collections) {
            await cacheManager.invalidateCollection(collection);
          }
        }
      },
    });
    console.log('[Core V2] Block operations configured');

    // 14. Setup history operations for history plugin
    setHistoryOperations({
      insert: async (entry: any, session?: any) => {
        const db = getTenantDb() ?? mongoDb!;
        const opts = session ? { session } : undefined;
        await db.collection('history').insertOne(entry, opts);
      },
      findByRecordId: async (recordId: string, collection: string) => {
        const db = getTenantDb() ?? mongoDb!;
        return db.collection('history').find({
          record_id: recordId,
          collection: collection,
        }).sort({ timestamp: -1 }).toArray() as any;
      },
    });
    console.log('[Core V2] History operations configured');

    // 14b. Setup user lookup for the history plugin — resolve the user's name when saving history
    // (to avoid "Unknown"). User is GLOBAL → query the main DB, collection `user`.
    setUserLookup({
      getUserName: async (userId: string) => {
        if (!userId) return 'Unknown';
        try {
          const { ObjectId } = await import('mongodb');
          const _id = ObjectId.isValid(userId) ? new ObjectId(userId) : (userId as any);
          const db = getTenantDb() ?? mongoDb!;
          const u = await db.collection('user').findOne(
            { _id },
            { projection: { full_name: 1, username: 1, email: 1 } },
          );
          return (u?.full_name || u?.username || u?.email || 'Unknown') as string;
        } catch {
          return 'Unknown';
        }
      },
    });
    console.log('[Core V2] User lookup configured');

    // 15. Setup checking locale exists for locale plugin
    // Moved to src/core_v2/plugins/definitions/locale.plugin.ts
    setLocaleChecker({
      checkLocaleExists: async (collection: string, localeId: string, locale: string) => {
        const db = getTenantDb() ?? mongoDb!;
        const count = await db.collection(collection).countDocuments({
          locale_id: localeId,
          locale: locale,
        });
        return count > 0;
      },
    });
    console.log('[Core V2] Locale checker configured');

    // 16. Setup approval operations for approval process plugin
    const { ObjectId } = await import('mongodb');
    setApprovalOperations({
      getPermissions: async (_collection: string, roles: string[]) => {
        // role → rule is GLOBAL per-tenant: the role json (Redis) has a `rule` field.
        // Applies to ALL resources in the tenant → does NOT filter by collection/method.
        const { schemaManager } = await import('../../core_v2/schema/manager');
        const { getTenantScope } = await import('../../core_v2/adapters/mongodb/tenant-context');
        const scope = getTenantScope();
        const roleMap = (await schemaManager.getAll('role', scope)) ?? {};
        const out: any[] = [];
        for (const r of Object.values(roleMap) as any[]) {
          const roleName = r?.role_name || r?.slug;
          if (!roleName || !roles.includes(roleName)) continue;
          out.push({ role_name: roleName, permission: [{ action: 'POST' }, { action: 'PUT' }], rule: r?.rule || [] });
        }
        return out;
      },
      getRulesByCodes: async (codes: string[]) => {
        // rule is stored per-tenant in Redis (json/<tenant>/rule, seeded at deploy time), NOT in the DB.
        const { schemaManager } = await import('../../core_v2/schema/manager');
        const { getTenantScope } = await import('../../core_v2/adapters/mongodb/tenant-context');
        const scope = getTenantScope();
        const map = (await schemaManager.getAll('rule', scope)) ?? {};
        const codeSet = new Set(codes.map(String));
        return Object.values(map).filter((r: any) => codeSet.has(String(r?.code))) as any;
      },
      getOriginalDocument: async (collection: string, id: string) => {
        const db = getTenantDb() ?? mongoDb!;
        try {
          return await db.collection(collection).findOne({
            _id: new ObjectId(id),
          }) as any;
        } catch {
          return null;
        }
      },
      isApprovalEnabled: async (collection: string) => {
        const entity = entityConfigLoader!.getEntity(collection) as any;
        return entity?.use_approval_process === true || entity?.use_approval_process === 'true';
      },
      isPublicEntity: async (collection: string) => {
        const entity = entityConfigLoader!.getEntity(collection) as any;
        return entity?.public_entity === true || entity?.public_entity === 'true';
      },
    });
    console.log('[Core V2] Approval operations configured');

    // 17. Initialize RBAC service
    const permissionDatabase = createMongoDBPermissionDatabase(
      async (name: string) => mongoDb!.collection(name) as any
    );
    const permissionResolver = createPermissionResolver(permissionDatabase);
    authorizationService = createAuthorizationService(permissionResolver, ajvValidator, config.rbac);
    console.log('[Core V2] RBAC service initialized');
    // 18. Create query converter (will be created by CoreService with proper relationshipResolver)
    _queryConverter = createQueryConverter(config.query);

    // 19. Create core service with all dependencies
    // NOTE: Don't pass queryConverter here - let CoreService create its own with the relationshipResolver
    coreService = createCoreService({
      // queryConverter is NOT passed - CoreService will create one with the relationshipResolver
      adapterRegistry,
      relationshipRegistry,
      pluginManager,
      authorizationService,
      config,
      entityConfigLoader,
      // api-config is pre-loaded into Redis (via SchemaSync) for every tenant.
      // The resolver only looks up by scope from tenantKey or ALS.
      apiConfigResolver: async (slug: string, _tenantKey?: string) => {
        // Single-tenant: scope = env <team_id>/<tenant>, fallback null (system)
        const { schemaManager } = await import('../../core_v2/schema/manager');
        const tenantSlug = getTenantScope() || null;
        for (const scope of [tenantSlug, null] as Array<string | null>) {
          const map = (await schemaManager.getAll('api-config', scope)) ?? {};
          const found = map[slug] || Object.values(map).find((it: any) => it.slug === slug);
          if (found) return found;
        }
        return null;
      },
    });
    console.log('[Core V2] Core service created');

    // Initialize Redis/Service Manager
    redisGlobal = await initializeServiceManager();
    console.log('[Core V2] Service Manager initialized');

    // 20. Setup slug uniqueness indexes (idempotent) — reads entities from the Redis seed.
    try {
      const { setupSlugIndexes } = await import('./slug-index-setup');
      const { schemaManager } = await import('../../core_v2/schema/manager');

      // Single-tenant: index system entities + the tenant from the env scope.
      const mainEntities = Object.values((await schemaManager.getAll('entity')) ?? {});
      const tenantSlug = getTenantScope();
      const tenantDbs: Array<{ db: any; slug: string; entities: any[] }> = [];
      if (tenantSlug) {
        const entities = Object.values((await schemaManager.getAll('entity', tenantSlug)) ?? {});
        if (entities.length > 0) tenantDbs.push({ db: mongoDb!, slug: tenantSlug, entities });
      }

      await setupSlugIndexes(mongoDb!, tenantDbs, mainEntities);
    } catch (e: any) {
      console.warn('[Core V2] Slug index setup skipped:', e?.message ?? e);
    }

    isInitialized = true;
    console.log('[Core V2] Initialization complete!');

  } catch (error) {
    console.error('[Core V2] Initialization failed:', error);
    throw error;
  }
}

// ============================================================================
// GETTERS
// ============================================================================

/**
 * Get Core V2 service
 */
export function getCoreService(): CoreService {
  if (!coreService) {
    throw new Error('[Core V2] Not initialized. Call initCore() first.');
  }
  return coreService;
}

/**
 * Get MongoDB client
 */
export function getMongoClient(): MongoClient {
  if (!mongoClient) {
    throw new Error('[Core V2] MongoDB not connected');
  }
  return mongoClient;
}

/**
 * Get MongoDB database
 */
export function getMongoDb(): Db {
  if (!mongoDb) {
    throw new Error('[Core V2] MongoDB not connected');
  }
  return mongoDb;
}

/**
 * Get Entity Config Loader
 */
export function getEntityConfigLoader(): EntityConfigLoader {
  if (!entityConfigLoader) {
    throw new Error('[Core V2] Entity config loader not initialized');
  }
  return entityConfigLoader;
}

/**
 * Get Relationship Registry
 */
export function getRelationshipRegistry(): RelationshipRegistry {
  if (!relationshipRegistry) {
    throw new Error('[Core V2] Relationship registry not initialized');
  }
  return relationshipRegistry;
}

/**
 * Check if Core V2 is initialized
 */
export function isCoreInitialized(): boolean {
  return isInitialized;
}

// ============================================================================
// CONVENIENCE EXPORTS
// ============================================================================

export {
  CoreService,
  UserContext,
  MongoDBAdapter,
  EntityConfigLoader,
  AjvValidator,
  CacheManager,
  AuthorizationService,
  PluginManager,
  RelationshipRegistry,
};
