/**
 * Core V2 - Main Entry Point
 *
 * This is the new architecture for the core system with:
 * - Clean separation of concerns
 * - Dependency injection
 * - Database-agnostic plugin system
 * - Proper TypeScript types
 * - No circular dependencies
 */

// ============================================================================
// TYPES
// ============================================================================

export * from './types';

// ============================================================================
// CONFIG
// ============================================================================

export {
  // Types
  RbacConfig,
  CacheConfig,
  PluginConfig,
  AdapterConfig,
  QueryConfig,
  CoreConfig,
  PluginFieldMapping,

  // Defaults
  DEFAULT_RBAC_CONFIG,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_PLUGIN_CONFIG,
  DEFAULT_QUERY_CONFIG,
  DEFAULT_CORE_CONFIG,

  // Builder & Utils
  ConfigBuilder,
  setGlobalConfig,
  getGlobalConfig,
  updateGlobalConfig,
} from './config';

// ============================================================================
// ERRORS
// ============================================================================

export {
  // Error Codes
  ErrorCodes,
  ErrorCode,
  getHttpStatus,

  // Error Classes
  CoreError,
  ConfigurationError,
  AuthorizationError,
  ValidationError,
  QueryError,
  NotFoundError,
  AdapterError,
  RelationshipError,
  PluginError,

  // Error Factories
  Errors,

  // Type Guards
  isCoreError,
  isAuthorizationError,
  isValidationError,
  isNotFoundError,

  // Utilities
  wrapError,

  // Types
  ErrorContext,
  SerializedError,
} from './errors';

// ============================================================================
// QUERY
// ============================================================================

export {
  // Intermediate Query
  IntermediateQuery,
  FieldCondition,
  FilterGroup,
  Filter,
  SelectClause,
  SortClause,
  JoinClause,
  JoinCondition,
  RelationshipMeta,
  AggregationClause,
  QueryOptions,
  QueryResult,
  QueryResultMetadata,

  // Builder
  QueryBuilder,
  createQuery,

  // Type Guards
  isFilterGroup,
  isFieldCondition,
} from './query/intermediate';

export {
  // Query Converter
  QueryConverter,
  createQueryConverter,
} from './query/converter';


// ============================================================================
// ADAPTERS
// ============================================================================

export {
  // Interfaces
  IDatabaseAdapter,
  IQueryConverter,
  IQueryExecutor,
  IAdapterFactory,
  IRelationshipRegistry,
  NativeQuery,
  DatabaseConnection,
  RelationshipDefinition,
} from './interfaces/adapter.interface';

export {
  // Registry
  AdapterRegistry,
  adapterRegistry,
  getAdapter,
  hasAdapter,
} from './adapters/base/registry';

export {
  // Relationship Registry
  RelationshipRegistry,
  getRelationshipRegistry,
  setRelationshipRegistry,
  createRelationshipRegistry,
} from './adapters/base/relationship-registry';

// MongoDB Adapter
export {
  MongoDBAdapter,
  createMongoDBAdapter,
  MongoDBAdapterFactory,
  createMongoDBAdapterFactory,
  mongoDBAdapterFactory,
  MongoDBFilterConverter,
  MongoDBQueryConverter,
  MongoDBJoinConverter,
  convertFilter,
  convertSecurityFilters,
  createMongoDBQueryConverter,
  createMongoDBJoinConverter,
  MONGODB_CAPABILITIES,
} from './adapters/mongodb';

// REST API Adapter
export * from './adapters/rest-api';

// ============================================================================
// PLUGINS
// ============================================================================

export {
  // Plugin Manager
  PluginManager,
  getPluginManager,
  setPluginManager,
  createPluginManager,

  // Plugin Definition
  definePlugin,

  // Types
  PluginPhase,
  PluginContext,
  PluginHandler,
  PluginDefinition,
} from './plugins/plugin-manager';

// Plugin Definitions
export {
  // Plugins
  timestampPlugin,
  softDeletePlugin,
  localePlugin,
  slugPlugin,
  parentPlugin,
  historyPlugin,
  blockPlugin,
  pinPlugin,
  generatorPlugin,
  syncRelationshipPlugin,
  builtInPlugins,
  registerBuiltInPlugins,

  // Locale plugin interfaces
  setLocaleChecker,
  getLocaleChecker,
  ILocaleChecker,

  // Slug plugin interfaces
  setSlugChecker,
  getSlugChecker,
  ISlugChecker,

  // Seopath plugin interfaces
  seopathPlugin,
  setSeopathOperations,
  getSeopathOperations,
  setEntitySchemaGetter,
  getEntitySchemaGetter,
  ISeopathOperations,
  SeopathRecord,
  EntitySchema as SeopathEntitySchema,

  // Parent plugin interfaces
  setObjectIdValidator,
  getObjectIdValidator,
  IObjectIdValidator,
  buildTreeFromFlat,
  flattenTree,

  // History plugin interfaces
  setUserLookup,
  getUserLookup,
  IUserLookup,
  setHistoryOperations,
  getHistoryOperations,
  IHistoryOperations,
  HistoryEntry,

  // Block plugin interfaces
  setBlockOperations,
  getBlockOperations,
  IBlockOperations,
  BlockItem,

  // Generator plugin interfaces
  GeneratorType,
  GeneratorConfig,

  // Sync Relationship plugin interfaces
  setSyncRelationshipOperations,
  getSyncRelationshipOperations,
  ISyncRelationshipOperations,

  // Approval Process plugin interfaces
  approvalProcessPlugin,
  setApprovalOperations,
  getApprovalOperations,
  IApprovalOperations,
  ApprovalRule,
  ApprovalPermission,
} from './plugins/definitions';

// ============================================================================
// AUTHORIZATION
// ============================================================================

export {
  AuthorizationService,
  createAuthorizationService,
  IPermissionResolver,
  EntitySchema,
} from './authorization/authorization';

export {
  PermissionResolver,
  createPermissionResolver,
  MongoDBPermissionDatabase,
  createMongoDBPermissionDatabase,
} from './authorization/permission-resolver';

// ============================================================================
// CORE SERVICE
// ============================================================================

export {
  // Core Service
  CoreService,
  createCoreService,

  // Types
  CoreDependencies,
  CoreOperationOptions,
  ICoreLogger,
} from './services/core-service';

// ============================================================================
// CACHE
// ============================================================================

export {
  // Cache Manager
  CacheManager,
  createCacheManager,
  getCacheManager,
  setCacheManager,
  isCacheAvailable,
  ICacheDriver,
  CacheEntry,
  CacheKeyParams,
  CacheStats,

  // Redis Driver
  RedisDriver,
  createRedisDriver,
  createRedisDriverFromUrl,
  IRedisClient,
  RedisDriverOptions,

  // In-Memory Driver
  InMemoryDriver,
  createInMemoryDriver,
} from './cache';

// ============================================================================
// SCHEMA
// ============================================================================

export {
  // Types
  EntityConfig,
  JSONSchema,
  JSONSchemaProperty,
  EntitiesData,

  // Interfaces
  IEntityConfigSource,

  // EntityConfigLoader
  EntityConfigLoader,
  createEntityConfigLoader,

  // Source (Redis-backed)
  JSONEntityConfigSource,

  // AJV Validator
  ValidationResult,
  ValidationError as SchemaValidationError,
  ValidationOptions,
  AjvValidator,
  createAjvValidator,
  getGlobalValidator,
  resetGlobalValidator,

  // Schema Converter
  FieldDefinition,
  AjvSchema,
  ConversionOptions,
  SchemaConverter,
  createSchemaConverter,
  convertToAjvSchema,
} from './schema';

// ============================================================================
// TENANT — routing/context layer
// ============================================================================

export {
  withTenant,
  setSingleTenantDb,
  runWithTenantDb,
  runWithTenantSlug,
  getTenantDb,
  getTenantId,
  getTenantSlug,
  getTenantTeamId,
  getTenantScope,
} from './tenant';

// ============================================================================
// VERSION INFO
// ============================================================================

export const VERSION = '2.0.0';

export const FEATURES = [
  'database-agnostic',
  'plugin-system',
  'rbac',
  'relationship-registry',
  'unified-filters',
  'type-safe',
  'configurable',
] as const;
