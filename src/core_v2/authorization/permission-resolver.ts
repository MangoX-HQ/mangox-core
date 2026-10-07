/**
 * Core V2 - Permission Resolver
 * Interfaces, implementation and database access for permission resolution
 */

// ============================================================================
// PERMISSION INTERFACES
// ============================================================================

/**
 * Entity schema (from database)
 */
export interface EntitySchema {
  collection_name: string;
  mongodb_save_data?: string;
  json_schema?: {
    properties?: Record<string, unknown>;
  };
  public_entity?: boolean;
  use_approval_process?: boolean;
  [key: string]: unknown;
}

/**
 * Permission resolver interface (for database access)
 */
export interface IPermissionResolver {
  /**
   * Get entity schema
   */
  getEntitySchema(collection: string): Promise<EntitySchema | null>;

  /**
   * Check if entity is public
   */
  isPublicEntity(collection: string): Promise<boolean>;
}

// ============================================================================
// DATABASE OPERATIONS INTERFACE
// ============================================================================

/**
 * Interface for database operations needed by permission resolver
 */
export interface IPermissionDatabase {
  /**
   * Find entity schema
   */
  findEntitySchema(collection: string): Promise<EntitySchema | null>;

  /**
   * Find entity plugins/configuration
   */
  findEntityConfig(collection: string): Promise<Record<string, unknown> | null>;
}

// ============================================================================
// PERMISSION RESOLVER IMPLEMENTATION
// ============================================================================

/**
 * Default permission resolver implementation
 */
export class PermissionResolver implements IPermissionResolver {
  private database: IPermissionDatabase;

  constructor(database: IPermissionDatabase, _options?: { cacheTTL?: number }) {
    this.database = database;
  }

  /**
   * Get entity schema - reads from SchemaManager (single source of truth)
   */
  async getEntitySchema(collection: string): Promise<EntitySchema | null> {
    // Read from SchemaManager (updated by SchemaSync when the JSON file changes)
    const { schemaManager } = await import('../schema/manager');
    const entity = await schemaManager.getEntity(collection);
    if (entity) {
      return entity as EntitySchema;
    }

    // Fallback to database if not in shared cache
    const schema = await this.database.findEntitySchema(collection);
    return schema;
  }

  /**
   * Check if entity is public (no auth required)
   */
  async isPublicEntity(collection: string): Promise<boolean> {
    const schema = await this.getEntitySchema(collection);
    return schema?.public_entity === true;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a permission resolver
 */
export function createPermissionResolver(
  database: IPermissionDatabase,
  options?: { cacheTTL?: number }
): PermissionResolver {
  return new PermissionResolver(database, options);
}

// ============================================================================
// MONGODB IMPLEMENTATION
// ============================================================================

/**
 * MongoDB-specific permission database implementation
 */
export class MongoDBPermissionDatabase implements IPermissionDatabase {
  private getCollection: (name: string) => Promise<{
    find: (filter: Record<string, unknown>) => { toArray: () => Promise<unknown[]> };
    findOne: (filter: Record<string, unknown>) => Promise<unknown>;
  }>;

  constructor(
    getCollection: (name: string) => Promise<{
      find: (filter: Record<string, unknown>) => { toArray: () => Promise<unknown[]> };
      findOne: (filter: Record<string, unknown>) => Promise<unknown>;
    }>
  ) {
    this.getCollection = getCollection;
  }

  async findEntitySchema(collection: string): Promise<EntitySchema | null> {
    const col = await this.getCollection('entity');
    const entity = await col.findOne({ collection_name: collection });

    if (!entity) return null;

    return entity as EntitySchema;
  }

  async findEntityConfig(collection: string): Promise<Record<string, unknown> | null> {
    const schema = await this.findEntitySchema(collection);
    if (!schema) return null;

    return (schema as Record<string, unknown>).plugins as Record<string, unknown> || null;
  }
}

/**
 * Create MongoDB permission database
 */
export function createMongoDBPermissionDatabase(
  getCollection: (name: string) => Promise<{
    find: (filter: Record<string, unknown>) => { toArray: () => Promise<unknown[]> };
    findOne: (filter: Record<string, unknown>) => Promise<unknown>;
  }>
): MongoDBPermissionDatabase {
  return new MongoDBPermissionDatabase(getCollection);
}
