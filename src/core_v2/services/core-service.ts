/**
 * Core V2 - Main Core Service
 * Central orchestration of all core components
 *
 * Key improvements over v1:
 * - Clean separation of concerns
 * - Dependency injection
 * - No debug code in production
 * - Proper error handling
 * - Type-safe operations
 */

import { IntermediateQuery, QueryResult, createQuery } from '../query/intermediate';
import { QueryConverter, IRelationshipResolver } from '../query/converter';
import { AdapterRegistry, getAdapter, hasAdapter } from '../adapters/base/registry';
import { RelationshipRegistry, getRelationshipRegistry } from '../adapters/base/relationship-registry';
import { PluginManager, getPluginManager, PluginContext } from '../plugins/plugin-manager';
import { AuthorizationService, IPermissionResolver } from '../authorization/authorization';
import { CoreConfig, getGlobalConfig, setGlobalConfig, ConfigBuilder } from '../config';
import { Errors, wrapError, CoreError } from '../errors';
import {
  QueryParams,
  RequestOptions,
  UserContext,
  DatabaseType,
  HttpMethod,
} from '../types';
import { IDatabaseAdapter, IRelationshipRegistry } from '../interfaces/adapter.interface';
import { EntityConfigLoader } from '../schema/loader';
import { schemaManager } from '../schema/manager';
import fs from 'fs';

/**
 * Resolve `@field:<path>`, `@context:<alias>:<field...>`, `@options:<path>`
 * placeholders inside an api-config request_template object/array/string.
 * - `@field:xxx` reads from the request body (e.g. `body.html_id`).
 * - `@context:alias:field` reads from policy.data results aliased as `alias`.
 *    findAll-style result auto-derefs `data[0]` so authors write
 *    `@context:html_template:html_content` instead of `:data:0:html_content`.
 * - `@options:xxx` reads from request options (user_id, tenant_id, etc.).
 */
function getDeep(path: string, source: any): any {
  if (!source || !path) return undefined;
  const parts = path.split(':');
  let cur: any = source;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolveToken(token: string, body: any, context: any, options: any): any {
  if (token.startsWith('@field:')) return getDeep(token.slice(7), body);
  if (token.startsWith('@options:')) return getDeep(token.slice(9), options);
  if (token.startsWith('@context:')) {
    const path = token.slice(9);
    const [alias, ...rest] = path.split(':');
    const root = context?.[alias];
    if (!root) return undefined;
    const base = (rest[0] === 'data' || !root.data)
      ? root
      : (Array.isArray(root.data) ? root.data[0] : root);
    return getDeep(rest.join(':'), base);
  }
  return token;
}

function applyRequestTemplate(template: any, body: any, context: any, options: any): any {
  if (template == null) return template;
  if (typeof template === 'string') {
    if (template.startsWith('@field:') || template.startsWith('@context:') || template.startsWith('@options:')) {
      const v = resolveToken(template, body, context, options);
      return v === undefined ? null : v;
    }
    return template;
  }
  if (Array.isArray(template)) return template.map(t => applyRequestTemplate(t, body, context, options));
  if (typeof template === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(template)) out[k] = applyRequestTemplate(v, body, context, options);
    return out;
  }
  return template;
}

// ============================================================================
// CORE SERVICE INTERFACES
// ============================================================================

/**
 * Core service dependencies
 */
export interface CoreDependencies {
  queryConverter: QueryConverter;
  adapterRegistry: AdapterRegistry;
  relationshipRegistry: IRelationshipRegistry;
  pluginManager: PluginManager;
  authorizationService: AuthorizationService;
  config: CoreConfig;
  entityConfigLoader?: EntityConfigLoader;
  /**
   * Resolves an `api-config` record by slug — provided by bootstrap.
   * Used when entity has `databaseType='rest'` to find which remote API to call.
   * `tenantKey` is the tenant id (or slug) so the resolver can scope the lookup.
   */
  apiConfigResolver?: (slug: string, tenantKey?: string) => Promise<Record<string, any> | null>;
}

/**
 * Core service options for each operation
 */
export interface CoreOperationOptions extends RequestOptions {
  skipRbac?: boolean;
  skipPlugins?: boolean;
  skipCache?: boolean;
  /**
   * Requested locale (from ?locale=). When set: a relation to a use_locale entity (joined via
   * foreignField='locale_id') gets a $match {locale} inserted DIRECTLY into the $lookup pipeline →
   * only the matching-language version is returned, with no extra fetching. Not set → no filtering (keeps the old behavior).
   */
  localeFilter?: string;
}

/**
 * Logger interface for core operations
 */
export interface ICoreLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Default no-op logger
 */
const noopLogger: ICoreLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ============================================================================
// CORE SERVICE
// ============================================================================

/**
 * Main Core Service - orchestrates all operations
 */
export class CoreService {
  private queryConverter: QueryConverter;
  private adapterRegistry: AdapterRegistry;
  private relationshipRegistry: IRelationshipRegistry;
  private pluginManager: PluginManager;
  private authorizationService: AuthorizationService;
  private config: CoreConfig;
  private logger: ICoreLogger;
  private initialized = false;
  private entityConfigLoader?: EntityConfigLoader;
  private apiConfigResolver?: (slug: string, tenantKey?: string) => Promise<Record<string, any> | null>;
  private apiConfigCache = new Map<string, Record<string, any> | null>();

  constructor(
    dependencies: Partial<CoreDependencies> = {},
    logger?: ICoreLogger
  ) {
    this.config = dependencies.config || getGlobalConfig();
    this.adapterRegistry = dependencies.adapterRegistry || AdapterRegistry.getInstance();
    this.relationshipRegistry = dependencies.relationshipRegistry || getRelationshipRegistry();
    this.pluginManager = dependencies.pluginManager || getPluginManager();

    // Create relationship resolver wrapper for query converter
    const relationshipResolver: IRelationshipResolver = {
      getForCollection: (collection: string) => {
        const rels = this.relationshipRegistry.getForCollection(collection);
        return rels.map((r: any) => ({
          name: r.name,
          sourceCollection: r.sourceCollection,
          targetCollection: r.targetCollection,
          localField: r.localField,
          foreignField: r.foreignField,
          type: r.type,
          ...(r.discriminator ? { discriminator: r.discriminator } : {}),
        }));
      },
      getByName: (collection: string, name: string) => {
        const rel = this.relationshipRegistry.getByName(collection, name);
        if (!rel) return undefined;
        return {
          name: rel.name,
          sourceCollection: rel.sourceCollection,
          targetCollection: rel.targetCollection,
          localField: rel.localField,
          foreignField: rel.foreignField,
          type: rel.type,
          ...((rel as any).discriminator ? { discriminator: (rel as any).discriminator } : {}),
        };
      },
    };

    this.queryConverter = dependencies.queryConverter || new QueryConverter(
      this.config.query,
      relationshipResolver
    );
    this.authorizationService = dependencies.authorizationService!; // Must be provided or initialized later
    this.entityConfigLoader = dependencies.entityConfigLoader;
    this.apiConfigResolver = dependencies.apiConfigResolver;
    this.logger = logger || noopLogger;
  }

  /**
   * Look up an api-config record by slug, with tenant-scoped cache.
   * Same slug can resolve to different config records per tenant
   * (each tenant DB may have its own api-config collection).
   */
  async resolveApiConfig(slug: string, tenantKey?: string): Promise<Record<string, any> | null> {
    if (!slug) return null;
    const cacheKey = `${tenantKey ?? '__system__'}::${slug}`;
    if (this.apiConfigCache.has(cacheKey)) return this.apiConfigCache.get(cacheKey) ?? null;
    if (!this.apiConfigResolver) return null;
    try {
      const config = await this.apiConfigResolver(slug, tenantKey);
      this.apiConfigCache.set(cacheKey, config);
      return config;
    } catch (e) {
      this.logger.error('resolveApiConfig failed', { slug, tenantKey, error: e });
      return null;
    }
  }

  /**
   * Invalidate cached api-config — called from setting watcher when record changes.
   * Tenant-scoped: pass tenantKey to invalidate only that tenant's entry.
   */
  invalidateApiConfig(slug?: string, tenantKey?: string): void {
    if (!slug) {
      this.apiConfigCache.clear();
      return;
    }
    if (tenantKey) {
      this.apiConfigCache.delete(`${tenantKey}::${slug}`);
    } else {
      // Invalidate slug across ALL tenant scopes
      for (const key of this.apiConfigCache.keys()) {
        if (key.endsWith(`::${slug}`)) this.apiConfigCache.delete(key);
      }
    }
  }
  async getQueryConverter(): Promise<QueryConverter> {
    if (!this.queryConverter) {
      this.queryConverter = new QueryConverter(
        this.config.query,
        this.relationshipRegistry as IRelationshipResolver
      );
    }
    return this.queryConverter;
  }
  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize the core service
   */
  async initialize(config?: Partial<CoreConfig>): Promise<void> {
    if (config) {
      const builder = new ConfigBuilder(this.config);
      this.config = builder.build();
      Object.assign(this.config, config);
      setGlobalConfig(this.config);
    }

    // Initialize adapters
    if (this.config.adapters && Object.keys(this.config.adapters).length > 0) {
      await this.adapterRegistry.initializeAll(this.config.adapters);
    }

    this.initialized = true;
    this.logger.info('Core service initialized');
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dispose of all resources
   */
  async dispose(): Promise<void> {
    await this.adapterRegistry.disposeAll();
    this.initialized = false;
    this.logger.info('Core service disposed');
  }

  // ============================================================================
  // QUERY OPERATIONS
  // ============================================================================

  /**
   * Find all resources in a collection
   */
  async findAll<T = unknown>(
    params: QueryParams,
    collection: string,
    user: UserContext,
    options: CoreOperationOptions = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<QueryResult<T>> {

    try {
      // Resolve polymorphic storage routing
      const routing = this.resolveRouting(collection);

      // RBAC check - uses LOGICAL entity name for policy/schema lookup
      /**
       * need to review this logic
      if (!options.skipRbac) {
        const method = options.action || (options.frontAPI ? 'FRONT' : 'GET-ALL');
        await this.authorizationService.ensureAccess(
          collection,
          method as any,
          user.roles
        );
      }
       */
      

      // Convert params to intermediate query
      const intermediateQuery = await this.queryConverter.convert(
        params,
        collection,
        user,
        options
      );
      intermediateQuery.physicalCollection = routing?.physical;

      // Add discriminator filter for polymorphic — restrict reads to this logical entity
      if (routing) {
        intermediateQuery.securityFilters.push({
          field: routing.discriminatorField,
          operator: 'eq',
          value: collection,
        });
      }

      // Add security filters
      this.addSecurityFilters(intermediateQuery, user, options);

      // Enhance with relationships — use logical entity name
      this.enhanceQueryWithRelationships(intermediateQuery, collection, options.localeFilter);

      // Get entity config for plugins
      const entityConfig = await this.getEntityConfig(collection);

      // Apply RBAC projection - use options.action for custom actions
      if (!options.skipRbac) {
        const rbacMethod = options.action || (options.frontAPI ? 'FRONT' : 'GET-ALL');
        // Get requested fields from query select
        const requestedFields = intermediateQuery.select?.include?.length ? intermediateQuery.select.include : undefined;
        const allowedFields = await this.authorizationService.getAllowedFields(
          collection,
          user.roles,
          rbacMethod as any,
          requestedFields
        );
        if (allowedFields.length > 0) {
          intermediateQuery.select = { include: allowedFields };
        }
      }

      // Execute query through adapter
      const result = await this.executeQuery<T>(
        collection,
        intermediateQuery,
        entityConfig,
        options
      );

      // Log native query for debugging (GET requests)
      if (process.env.NODE_ENV === 'development') {
        fs.writeFileSync('./log.json', JSON.stringify({
          method: 'findAll',
          collection,
          params,
          nativeQuery: result.metadata?.nativeQuery,
          intermediateQuery,
          dataCount: result.data.length,
        }, null, 2));
      }

      return result;
    } catch (error) {
      this.logger.error('findAll failed', { collection, error });
      throw wrapError(error, `Failed to find resources in ${collection}`);
    }
  }

  /**
   * Find a single resource by ID
   */
  async findById<T = unknown>(
    collection: string,
    id: string,
    params: QueryParams,
    user: UserContext,
    options: CoreOperationOptions = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<QueryResult<T>> {
    const startTime = Date.now();


    try {
      // Resolve polymorphic storage routing
      const routing = this.resolveRouting(collection);

      // RBAC check uses LOGICAL entity name
      if (!options.skipRbac) {
        await this.authorizationService.ensureAccess(
          collection,
          options.frontAPI ? 'FRONT' : 'GET',
          user.roles
        );
      }

      // Convert params to intermediate query
      const intermediateQuery = await this.queryConverter.convert(
        params,
        collection,
        user,
        options
      );
      intermediateQuery.physicalCollection = routing?.physical;

      // Add ID filter
      intermediateQuery.securityFilters.push({
        field: '_id',
        operator: 'eq',
        value: { functionName: 'toObjectId', args: [id] },
      });

      // Discriminator filter for polymorphic — prevents cross-entity ID lookup
      if (routing) {
        intermediateQuery.securityFilters.push({
          field: routing.discriminatorField,
          operator: 'eq',
          value: collection,
        });
      }

      // Add security filters
      this.addSecurityFilters(intermediateQuery, user, options);

      // Enhance with relationships using logical entity name
      this.enhanceQueryWithRelationships(intermediateQuery, collection, options.localeFilter);

      // Get entity config
      const entityConfig = await this.getEntityConfig(collection);

      // Apply RBAC projection
      if (!options.skipRbac) {
        // Get requested fields from query select
        const requestedFields = intermediateQuery.select?.include?.length ? intermediateQuery.select.include : undefined;
        const allowedFields = await this.authorizationService.getAllowedFields(
          collection,
          user.roles,
          options.frontAPI ? 'FRONT' : 'GET',
          requestedFields
        );
        if (allowedFields.length > 0) {
          intermediateQuery.select = { include: allowedFields };
        }
      }

      // Limit to 1
      intermediateQuery.pagination = { limit: 1 };

      // Execute query
      const result = await this.executeQuery<T>(
        collection,
        intermediateQuery,
        entityConfig,
        options
      );

      // Log native query for debugging
      if (process.env.NODE_ENV === 'development') {
        fs.writeFileSync('./log.json', JSON.stringify({
          method: 'findById',
          collection,
          id,
          nativeQuery: result.metadata?.nativeQuery,
          intermediateQuery,
          result: result.data[0],
        }, null, 2));
      }

      this.logger.debug('findById completed', {
        collection,
        id,
        executionTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('findById failed', { collection, id, error });
      throw wrapError(error, `Failed to find resource ${collection}/${id}`);
    }
  }

  /**
   * Create a new resource
   */
  async create<T = unknown>(
    collection: string,
    data: Record<string, unknown>,
    user: UserContext,
    options: CoreOperationOptions = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<QueryResult<T>> {
    const startTime = Date.now();

    try {
      // Resolve polymorphic storage routing (mongodb_save_data)
      const routing = this.resolveRouting(collection);

      // RBAC check uses LOGICAL entity name for schema/policy
      if (!options.skipRbac) {
        await this.authorizationService.ensureAccess(
          collection,
          options.frontAPI ? 'FRONT' : 'POST',
          user.roles
        );

        // Filter data through RBAC
        data = await this.authorizationService.validateAndFilterData(
          collection,
          user.roles,
          data,
          'POST'
        );
      }

      // Add metadata
      if (options.tenant_id) {
        data.tenant_id = options.tenant_id;
      }
      if (user.user_id) {
        data.created_by = user.user_id;
        data.updated_by = user.user_id;
      }

      // Always tag the logical entity name onto the record for traceability
      // and as the polymorphic discriminator (default field: collection_name).
      const discriminatorField = routing?.discriminatorField ?? 'collection_name';
      data[discriminatorField] = collection;

      // Get entity config (tenant-aware) — use_posttype is needed for the auto-fill below.
      const entityConfig = await this.getEntityConfig(collection);

      // Entity use_posttype: auto-set post_type = <entity> if the client/import does NOT
      // send it. No plugin sets this field (unlike collection_name, which is the discriminator);
      // without post_type, the two-layer front-detail filter on post_type=<entity> returns 404 even though
      // the record exists. Only fill it in when missing — never override a value explicitly sent by the FE.
      if (entityConfig?.use_posttype && data.post_type == null) {
        data.post_type = collection;
      }

      // Build intermediate query
      // - `collection` = LOGICAL entity name (used by plugins, RBAC, schema lookup)
      // - `physicalCollection` = actual DB store (only set when polymorphic routing)
      const intermediateQuery: IntermediateQuery = {
        type: 'insert',
        collection,
        physicalCollection: routing?.physical,
        data,
        securityFilters: [],
        metadata: {
          database: options.databaseType,
          timestamp: new Date(),
          user,
        },
      };

      // Execute insert
      const result = await this.executeQuery<T>(
        collection,
        intermediateQuery,
        entityConfig,
        options
      );

      this.logger.debug('create completed', {
        collection,
        executionTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('create failed', { collection, error });
      throw wrapError(error, `Failed to create resource in ${collection}`);
    }
  }

  /**
   * Update a resource by ID
   */
  async update<T = unknown>(
    collection: string,
    query: QueryParams,
    data: Record<string, unknown>,
    user: UserContext,
    options: CoreOperationOptions = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<QueryResult<T>> {
    const startTime = Date.now();

    try {
      // Remove _id from data if present
      delete data._id;

      // Resolve polymorphic storage routing (mongodb_save_data)
      const routing = this.resolveRouting(collection);

      // RBAC check uses LOGICAL entity name
      if (!options.skipRbac) {
        await this.authorizationService.ensureAccess(collection, 'PUT', user.roles);

        // Filter data through RBAC
        data = await this.authorizationService.validateAndFilterData(
          collection,
          user.roles,
          data,
          'PUT',
        );
      }

      // Add metadata
      if (user.user_id) {
        data.updated_by = user.user_id;
      }

      // Idempotently set discriminator on body so update keeps record tagged
      const discriminatorField = routing?.discriminatorField ?? 'collection_name';
      data[discriminatorField] = collection;

      const intermediateQuery = await this.queryConverter.convert(
        query,
        collection,
        user,
        options
      )
      intermediateQuery.metadata.hints = {
        id: query.id,
      }
      if (options.partial) {
        intermediateQuery.options = {
          partial: true,
        }
      }

      intermediateQuery.type = "update"
      intermediateQuery.data = data;
      intermediateQuery.physicalCollection = routing?.physical;

      // Mirror runtime flags into metadata.options — parent.plugin reads
      // tree from query.metadata.options (not query.options). Without this,
      // tree-SAVE never flattens nested children → child parent_id not written.
      if (options.tree || options.history) {
        intermediateQuery.metadata.options = {
          ...(intermediateQuery.metadata.options || {}),
        };
        if (options.tree) intermediateQuery.metadata.options!.tree = true;
        if (options.history) intermediateQuery.metadata.options!.history = true;
      }

      // Add discriminator filter so we only update records of this logical entity
      if (routing) {
        intermediateQuery.securityFilters.push({
          field: routing.discriminatorField,
          operator: 'eq',
          value: collection,
        });
      }

      // Add tenant filter if applicable
      if (options.tenant_id) {
        intermediateQuery.securityFilters.push({
          field: 'tenant_id',
          operator: 'eq',
          value: options.tenant_id,
        });
      }

      // Get entity config
      const entityConfig = await this.getEntityConfig(collection);

      // Execute update
      const result = await this.executeQuery<T>(
        collection,
        intermediateQuery,
        entityConfig,
        options
      );

      return result;
    } catch (error) {
      throw wrapError(error, `Failed to update resource ${collection}`);
    }
  }


  /**
   * Delete a resource by ID
   */
  async delete(
    collection: string,
    id: string,
    user: UserContext,
    options: CoreOperationOptions = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<QueryResult<unknown>> {
    const startTime = Date.now();

    try {
      // RBAC check uses LOGICAL entity name
      if (!options.skipRbac) {
        await this.authorizationService.ensureAccess(collection, 'DELETE', user.roles);
      }

      // Resolve polymorphic storage routing
      const routing = this.resolveRouting(collection);

      // Build intermediate query
      const intermediateQuery: IntermediateQuery = {
        type: 'delete',
        collection,
        physicalCollection: routing?.physical,
        securityFilters: [
          {
            field: '_id',
            operator: 'eq',
            value: { functionName: 'toObjectId', args: [id] },
          },
        ],
        metadata: {
          database: options.databaseType,
          timestamp: new Date(),
          hints: { id },
          user,
        },
        options: {
          user_id: user.user_id,
        },
      };

      // Discriminator filter for polymorphic — prevents deleting sibling entity record
      if (routing) {
        intermediateQuery.securityFilters.push({
          field: routing.discriminatorField,
          operator: 'eq',
          value: collection,
        });
      }

      // Add tenant filter
      if (options.tenant_id) {
        intermediateQuery.securityFilters.push({
          field: 'tenant_id',
          operator: 'eq',
          value: options.tenant_id,
        });
      }

      // Get entity config
      const entityConfig = await this.getEntityConfig(collection);

      // Execute delete
      const result = await this.executeQuery(
        collection,
        intermediateQuery,
        entityConfig,
        options
      );

      this.logger.debug('delete completed', {
        collection,
        id,
        executionTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('delete failed', { collection, id, error });
      throw wrapError(error, `Failed to delete resource ${collection}/${id}`);
    }
  }

  /**
   * Delete multiple resources by IDs
   */
  async deleteMany(
    collection: string,
    params: any,
    user: UserContext,
    options: CoreOperationOptions = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<QueryResult<unknown>> {
    const startTime = Date.now();

    try {
      // RBAC check uses LOGICAL entity name
      if (!options.skipRbac) {
        await this.authorizationService.ensureAccess(collection, 'DELETE', user.roles);
      }

      // Resolve polymorphic storage routing
      const routing = this.resolveRouting(collection);

      const intermediateQuery = await this.queryConverter.convert(
        params,
        collection,
        user,
        options
      )

      intermediateQuery.type = "deleteMany"
      intermediateQuery.metadata.hints = {
        ids: options.ids
      }
      intermediateQuery.physicalCollection = routing?.physical;

      // Discriminator filter — prevents bulk delete crossing entity scope
      if (routing) {
        intermediateQuery.securityFilters.push({
          field: routing.discriminatorField,
          operator: 'eq',
          value: collection,
        });
      }

      // Add tenant filter
      if (options.tenant_id) {
        intermediateQuery.securityFilters.push({
          field: 'tenant_id',
          operator: 'eq',
          value: options.tenant_id,
        });
      }

      // Get entity config
      const entityConfig = await this.getEntityConfig(collection);

      // Execute deleteMany
      const result = await this.executeQuery(
        collection,
        intermediateQuery,
        entityConfig,
        options
      );

      return result;
    } catch (error) {
      this.logger.error('deleteMany failed', { collection, error });
      throw wrapError(error, `Failed to delete resources in ${collection}`);
    }
  }

  /**
   * Execute a raw intermediate query
   * For advanced use cases like bulk updates
   */
  async advanceQuery<T = unknown>(
    intermediateQuery: IntermediateQuery,
    options: CoreOperationOptions = { databaseType: 'mongodb', is_tenant: false }
  ): Promise<QueryResult<T>> {
    const startTime = Date.now();

    try {
      // Get entity config — collection is always LOGICAL entity name
      const entityConfig = await this.getEntityConfig(intermediateQuery.collection);

      // Execute query
      const result = await this.executeQuery<T>(
        intermediateQuery.collection,
        intermediateQuery,
        entityConfig,
        options
      );

      this.logger.debug('advanceQuery completed', {
        collection: intermediateQuery.collection,
        type: intermediateQuery.type,
        executionTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('advanceQuery failed', {
        collection: intermediateQuery.collection,
        type: intermediateQuery.type,
        error
      });
      throw wrapError(error, `Failed to execute advance query on ${intermediateQuery.collection}`);
    }
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  /**
   * Execute query through adapter with plugins
   */
  private async executeQuery<T>(
    collection: string,
    intermediateQuery: IntermediateQuery,
    entityConfig: Record<string, unknown>,
    options: CoreOperationOptions
  ): Promise<QueryResult<T>> {
    // Entity-level databaseType overrides per-request option.
    // Also resolve api-config when entity uses REST adapter.
    const entityDbType = (entityConfig?.databaseType as DatabaseType | undefined) || options.databaseType;
    if (entityDbType === ('rest' as DatabaseType)) {
      const apiConfigSlug = entityConfig?.api_config as string | undefined;
      if (!apiConfigSlug) {
        throw Errors.validation(
          `Entity '${collection}' has databaseType='rest' but no 'api_config' field set`
        );
      }
      // Tenant-scoped lookup: same slug may resolve to different config per tenant.
      const tenantKey = (options.tenant_id as string) ?? '__system__';
      const apiConfig = await this.resolveApiConfig(apiConfigSlug, tenantKey);
      if (!apiConfig) {
        throw Errors.validation(
          `api-config '${apiConfigSlug}' not found for entity '${collection}' (tenant=${tenantKey})`
        );
      }
      intermediateQuery.apiConfig = apiConfig;
      // Stash tenant/user for adapter-side hooks (e.g. auto-upload binary
      // responses to media — needs tenant_id/created_by tags).
      (intermediateQuery as any).tenant_id = options.tenant_id;
      (intermediateQuery as any).user_id = options.user_id;

      // Apply api-config.request_template.body — declarative body shaping that
      // resolves `@field:`/`@context:`/`@options:` placeholders against the
      // request body, the policy-loaded context (options.policyContext), and
      // request options. Lets a client send `{html_id, wallet_id}` while the
      // upstream API receives `{html: "<looked-up html_content>"}`.
      const tmplBody = (apiConfig as any).request_template?.body;
      if (tmplBody && intermediateQuery.data) {
        const inputBody = Array.isArray(intermediateQuery.data)
          ? intermediateQuery.data[0]
          : intermediateQuery.data;
        intermediateQuery.data = applyRequestTemplate(
          tmplBody,
          inputBody,
          (options as any).policyContext,
          options,
        );
      }
      // Strip query parts the remote API can't honor — defaulted by api-config.
      // Framework-injected (e.g. tenant_id) and policy-injected filters are dropped
      // unless capabilities.filter is true.
      const caps = (apiConfig.capabilities ?? {}) as Record<string, boolean>;
      if (!caps.filter) {
        intermediateQuery.securityFilters = [];
        intermediateQuery.userFilter = undefined;
      }
      if (!caps.select) intermediateQuery.select = undefined;
      if (!caps.sort) intermediateQuery.sort = undefined;
      if (!caps.pagination) intermediateQuery.pagination = undefined;
    }
    const adapter = this.getAdapter(entityDbType);
    const pluginContext: Omit<PluginContext, 'phase'> = {
      collection,
      entityConfig,
    };

    // Validate query
    const validation = adapter.validateQuery(intermediateQuery);
    if (!validation.valid) {
      throw Errors.queryInvalid(
        validation.errors.map((e) => e.message).join('; '),
        intermediateQuery
      );
    }

    // Apply before plugins
    if (!options.skipPlugins) {
      await this.pluginManager.executeBefore(intermediateQuery, pluginContext);
    }

    // Convert to native query
    const nativeQuery = await adapter.convertQuery(intermediateQuery);
    // Apply main plugins
    if (!options.skipPlugins) {
      await this.pluginManager.executeMain(intermediateQuery, nativeQuery, pluginContext);
    }

    // Execute query — adapter targets the PHYSICAL collection if polymorphic,
    // otherwise the logical collection (which is also the physical name).
    const physicalTarget = intermediateQuery.physicalCollection || collection;
    const result = await adapter.executeQuery<T>(
      physicalTarget,
      intermediateQuery,
      nativeQuery
    );

    // Apply after plugins
    if (!options.skipPlugins) {
      await this.pluginManager.executeAfter(intermediateQuery, result, pluginContext);
    }

    return result;
  }

  /**
   * Get adapter by type
   */
  private getAdapter(type: DatabaseType = 'mongodb'): IDatabaseAdapter {
    if (!hasAdapter(type)) {
      throw Errors.adapterNotFound(type);
    }
    return getAdapter(type);
  }

  /**
   * Run a low-level adapter action (insert / update / delete / find / aggregate)
   * against an entity. The service picks the adapter based on the entity's
   * `databaseType` (mongodb / sqlite / rest); the adapter handles the actual
   * operation. No plugins, security filters, or AJV validation — intended
   * for trusted infrastructure code (triggers, audit logs, billing hooks).
   *
   *   await core.executeAction('pptx_history', {
   *     collection: 'pptx_history',
   *     operation: 'insert',
   *     data: { user_id, url, ... }
   *   });
   */
  async executeAction(
    entityName: string,
    action: Omit<import('../interfaces/adapter.interface').AdapterAction, 'collection'> & { collection?: string },
  ): Promise<unknown> {
    const entity = this.entityConfigLoader
      ? (this.entityConfigLoader.getEntity(entityName) as any) ?? {}
      : {};
    const dbType = (entity.databaseType as DatabaseType | undefined) ?? ('mongodb' as DatabaseType);
    const adapter = this.getAdapter(dbType);
    if (!adapter.executeAction) {
      throw Errors.queryInvalid(`Adapter '${dbType}' does not implement executeAction`);
    }
    const collection = action.collection
      ?? (entity.mongodb_save_data as string)
      ?? entityName;
    return adapter.executeAction({ ...action, collection });
  }

  /**
   * Add security filters to query
   */
  private addSecurityFilters(
    query: IntermediateQuery,
    user: UserContext,
    options: CoreOperationOptions
  ): void {
    // Tenant isolation
    if (options.tenant_id) {
      query.securityFilters.push({
        field: 'tenant_id',
        operator: 'eq',
        value: options.tenant_id,
      });
    }

    // Add options. Mirror into metadata.options too: plugins (parent/history)
    // read runtime flags from query.metadata.options, NOT query.options.
    // Setting only query.options made use_parent see tree=undefined → no tree built.
    if (options.tree || options.history) {
      query.metadata = query.metadata || ({} as typeof query.metadata);
      query.metadata.options = { ...(query.metadata.options || {}) };
    }
    if (options.tree) {
      query.options = { ...query.options, tree: true };
      query.metadata.options!.tree = true;
    }
    if (options.history) {
      query.options = { ...query.options, history: true };
      query.metadata.options!.history = true;
    }
  }

  /**
   * Enhance query with relationship information using the logical entity name
   */
  private enhanceQueryWithRelationships(
    query: IntermediateQuery,
    sourceCollection?: string,
    localeFilter?: string,
  ): void {
    if (!query.joins || query.joins.length === 0) return;
    this.enhanceJoinsRecursively(query.joins, sourceCollection || query.collection, localeFilter);
  }

  /**
   * Recursively enhance joins with relationship information
   */
  private enhanceJoinsRecursively(joins: unknown[], sourceCollection: string, localeFilter?: string): void {
    const registry = this.relationshipRegistry;

    for (const join of joins as Record<string, unknown>[]) {
      const relationship = join.relationship as { name?: string } | undefined;

      if (relationship?.name && (!join.on || (join.on as unknown[]).length === 0)) {
        const rel = registry.getByName(sourceCollection, relationship.name);

        if (rel) {
          join.on = [
            {
              local: rel.localField,
              foreign: rel.foreignField,
              operator: 'eq',
            },
          ];
          join.target = rel.targetCollection;
          join.type = rel.type;

          if (rel.type === 'many-to-many' && rel.junction) {
            (relationship as Record<string, unknown>).junction = rel.junction;
          }
        }
      }

      // QUERY-LEVEL locale filter: relation to a use_locale entity joined via foreignField='locale_id'.
      // Insert $match {locale=localeFilter} into join.filter → the join-converter places it into the $lookup pipeline →
      // MongoDB filters it directly, returning only the matching-language version (no extra fetching). Merged with AND if a filter already exists.
      if (localeFilter) {
        const foreign = (join.on as Array<{ foreign?: string }> | undefined)?.[0]?.foreign;
        if (foreign === 'locale_id') {
          const cond: any = { field: 'locale', operator: 'eq', value: localeFilter };
          const cur: any = join.filter;
          if (!cur) {
            join.filter = cond;
          } else {
            const group: any = { operator: 'and', conditions: [cond], nested: [] };
            if (Array.isArray(cur)) group.conditions.push(...cur);
            else if (cur && typeof cur === 'object' && 'field' in cur) group.conditions.push(cur);
            else group.nested.push(cur);
            join.filter = group;
          }
        }
      }

      // Recursively process nested joins
      if (join.joins && Array.isArray(join.joins) && join.joins.length > 0) {
        this.enhanceJoinsRecursively(join.joins, join.target as string, localeFilter);
      }
    }
  }

  /**
   * Get entity configuration
   */
  private async getEntityConfig(collection: string): Promise<Record<string, unknown>> {
    // Tenant-aware resolution. The in-memory entityConfigLoader cache is
    // GLOBAL-only (single slot per collection, populated once at bootstrap),
    // so per-tenant entity overrides (e.g. use_slug / use_seo_path from
    // json/<tenant>/entity/*.json → tenant-scoped Redis) are invisible to the
    // plugin pipeline. schemaManager.getEntity resolves the current tenant
    // scope first, then global — use it, fall back to the loader if absent.
    let entity: any = null;
    try {
      entity = await schemaManager.getEntity(collection);
    } catch {}
    const loaderEntity = this.entityConfigLoader
      ? this.entityConfigLoader.getEntity(collection)
      : null;
    if (!entity) entity = loaderEntity;

    // TEMP DIAG: prove the source/divergence at this line.
    if (collection === 'group-field') {
      try {
        const { getTenantSlug } = await import('../adapters/mongodb/tenant-context');
        fs.appendFileSync(
          '/tmp/seopath-debug.log',
          `${new Date().toISOString()} [cs:getEntityConfig] ${JSON.stringify({
            collection,
            tenantSlug: getTenantSlug(),
            chosen: entity === loaderEntity ? 'loader(global)' : 'schemaManager(tenant)',
            loader_use_slug: (loaderEntity as any)?.use_slug,
            schemaManager_use_slug: (entity === loaderEntity ? undefined : (entity as any)?.use_slug),
            final_use_slug: (entity as any)?.use_slug,
            final_use_seo_path: (entity as any)?.use_seo_path,
          })}\n`,
        );
      } catch (e: any) {
        fs.appendFileSync('/tmp/seopath-debug.log', `${new Date().toISOString()} [cs:getEntityConfig:err] ${e?.message}\n`);
      }
    }

    return (entity as unknown as Record<string, unknown>) || {};
  }

  /**
   * Resolve polymorphic storage routing for a logical entity name.
   * Returns physical collection + discriminator info if entity has
   * `mongodb_save_data` (multiple logical entities sharing 1 physical store).
   * Returns null when entity stores in its own collection.
   */
  private resolveRouting(logicalCollection: string): {
    physical: string;
    discriminatorField: string;
  } | null {
    if (!this.entityConfigLoader) return null;
    const entity = this.entityConfigLoader.getEntity(logicalCollection) as any;
    if (!entity) return null;
    const physical = entity.mongodb_save_data;
    if (!physical || physical === logicalCollection) return null;
    return {
      physical,
      discriminatorField: entity.discriminator_field || 'collection_name',
    };
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new Core service
 */
export function createCoreService(
  dependencies?: Partial<CoreDependencies>,
  logger?: ICoreLogger
): CoreService {
  return new CoreService(dependencies, logger);
}
