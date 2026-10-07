/**
 * Core V2 - Database Adapter Interface
 * Defines the contract that all database adapters must implement
 *
 * Key improvements over v1:
 * - Clean interface definition
 * - No MongoDB-specific types in interface
 * - Proper generic types
 * - Factory pattern support
 */

import { IntermediateQuery, QueryResult } from '../query/intermediate';
import { ValidationResult, DatabaseType } from '../types';
import { AdapterConfig } from '../config';

// ============================================================================
// ADAPTER ACTION (low-level side-effects, e.g. triggers)
// ============================================================================

/**
 * A direct adapter action — used by trigger / pipeline executors that need to
 * write to a collection without going through the intermediate query layer
 * (no plugins, no security filters). The adapter is free to map the operation
 * to whichever native API fits (Mongo collection methods, SQL statements,
 * REST calls, etc.). `pipeline` is for adapters that support it (Mongo).
 */
export interface AdapterAction {
  collection: string;
  operation:
    | 'insert'
    | 'insertMany'
    | 'update'
    | 'updateMany'
    | 'delete'
    | 'deleteMany'
    | 'find'
    | 'findOne'
    | 'aggregate';
  filter?: Record<string, unknown>;
  data?: unknown;
  update?: unknown;
  pipeline?: unknown[];
  options?: Record<string, unknown>;
}

// ============================================================================
// NATIVE QUERY INTERFACE
// ============================================================================

/**
 * Base interface for native database queries
 * Each adapter will have its own implementation
 */
export interface NativeQuery {
  /** Identifier for the query type */
  type: string;

  /** The actual query object (database-specific) */
  query: unknown;

  /** Additional metadata about the query */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// DATABASE CONNECTION INTERFACE
// ============================================================================

/**
 * Interface for database connections
 */
export interface DatabaseConnection {
  /** Check if connection is active */
  isConnected(): boolean;

  /** Get the underlying connection/client */
  getClient(): unknown;

  /** Close the connection */
  close(): Promise<void>;
}

// ============================================================================
// DATABASE ADAPTER INTERFACE
// ============================================================================

/**
 * Main interface that all database adapters must implement
 */
export interface IDatabaseAdapter<TConnection = unknown, TNativeQuery = unknown> {
  /** Unique identifier for this adapter type */
  readonly type: DatabaseType;

  /** Human-readable name */
  readonly name: string;

  /** Whether the adapter has been initialized */
  readonly initialized: boolean;

  /**
   * Initialize the adapter with configuration
   * @param config - Adapter configuration
   */
  initialize(config: AdapterConfig): Promise<void>;

  /**
   * Get the database connection/client
   */
  getConnection(): Promise<TConnection>;

  /**
   * Validate an intermediate query before conversion
   * @param query - The intermediate query to validate
   * @returns Validation result with any errors
   */
  validateQuery(query: IntermediateQuery): ValidationResult;

  /**
   * Convert intermediate query to native database query
   * @param query - The intermediate query to convert
   * @returns Native query ready for execution
   */
  convertQuery(query: IntermediateQuery): Promise<TNativeQuery>;

  /**
   * Execute a native query against the database
   * @param collection - Target collection/table
   * @param intermediateQuery - Original intermediate query (for metadata)
   * @param nativeQuery - The native query to execute
   * @returns Query results
   */
  executeQuery<T = unknown>(
    collection: string,
    intermediateQuery: IntermediateQuery,
    nativeQuery: TNativeQuery
  ): Promise<QueryResult<T>>;

  /**
   * Execute a low-level action — bypasses intermediate query, plugins, and
   * security filters. Used by triggers / pipeline side-effects where the
   * caller already knows the operation and target collection. Each adapter
   * decides how to map the action to its native API.
   */
  executeAction?(action: AdapterAction): Promise<unknown>;

  /**
   * Start a database transaction
   * @returns Transaction session/context
   */
  beginTransaction?(): Promise<unknown>;

  /**
   * Commit a transaction
   * @param session - Transaction session from beginTransaction
   */
  commitTransaction?(session: unknown): Promise<void>;

  /**
   * Rollback a transaction
   * @param session - Transaction session from beginTransaction
   */
  rollbackTransaction?(session: unknown): Promise<void>;

  /**
   * Dispose of adapter resources (connections, etc.)
   */
  dispose(): Promise<void>;

  /**
   * Health check for the adapter
   * @returns true if healthy, false otherwise
   */
  healthCheck(): Promise<boolean>;
}

// ============================================================================
// QUERY CONVERTER INTERFACE
// ============================================================================

/**
 * Interface for converting intermediate queries to native format
 */
export interface IQueryConverter<TNativeQuery = unknown> {
  /**
   * Convert intermediate query to native query
   * @param query - Intermediate query
   * @returns Native query
   */
  convert(query: IntermediateQuery): Promise<TNativeQuery>;

  /**
   * Convert filter conditions
   */
  convertFilters(query: IntermediateQuery): unknown;

  /**
   * Convert projection/select
   */
  convertProjection(query: IntermediateQuery): unknown;

  /**
   * Convert sort clauses
   */
  convertSort(query: IntermediateQuery): unknown;

  /**
   * Convert joins/lookups
   */
  convertJoins(query: IntermediateQuery): unknown;
}

// ============================================================================
// QUERY EXECUTOR INTERFACE
// ============================================================================

/**
 * Interface for executing native queries
 */
export interface IQueryExecutor<TConnection = unknown, TNativeQuery = unknown> {
  /**
   * Execute a read query
   */
  executeRead<T>(
    connection: TConnection,
    collection: string,
    query: TNativeQuery
  ): Promise<T[]>;

  /**
   * Execute an insert query
   */
  executeInsert<T>(
    connection: TConnection,
    collection: string,
    query: TNativeQuery
  ): Promise<{ data: T[]; insertedCount: number }>;

  /**
   * Execute an update query
   */
  executeUpdate<T>(
    connection: TConnection,
    collection: string,
    query: TNativeQuery
  ): Promise<{ data: T[]; modifiedCount: number; matchedCount: number }>;

  /**
   * Execute a delete query
   */
  executeDelete<T = unknown>(
    connection: TConnection,
    collection: string,
    query: TNativeQuery
  ): Promise<{ data: T[]; deletedCount: number }>;

  /**
   * Execute a count query
   */
  executeCount(
    connection: TConnection,
    collection: string,
    query: TNativeQuery
  ): Promise<number>;
}

// ============================================================================
// ADAPTER FACTORY INTERFACE
// ============================================================================

/**
 * Factory interface for creating database adapters
 */
export interface IAdapterFactory<TAdapter extends IDatabaseAdapter = IDatabaseAdapter> {
  /** The database type this factory creates */
  readonly type: DatabaseType;

  /**
   * Create a new adapter instance
   * @param config - Adapter configuration
   * @returns New adapter instance
   */
  create(config: AdapterConfig): Promise<TAdapter>;

  /**
   * Check if this factory supports the given configuration
   * @param config - Configuration to check
   */
  supports(config: AdapterConfig): boolean;
}

// ============================================================================
// RELATIONSHIP REGISTRY INTERFACE
// ============================================================================

/**
 * Relationship definition
 */
export interface RelationshipDefinition {
  /** Unique name for the relationship */
  name: string;

  /** Source collection */
  sourceCollection: string;

  /** Target collection (physical — where records actually live) */
  targetCollection: string;

  /** Local field in source collection */
  localField: string;

  /** Foreign field in target collection */
  foreignField: string;

  /** Relationship type */
  type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

  /** Don't convert to ObjectId (for non-ObjectId references) */
  noObjectId?: boolean;

  /** Junction table for many-to-many */
  junction?: {
    table: string;
    localKey: string;
    foreignKey: string;
  };

  /**
   * Discriminator filter — set when targetCollection is a physical store shared by
   * multiple logical entities (entity has `mongodb_save_data`). The join must filter
   * records where `field === value` to scope to the correct logical entity.
   */
  discriminator?: {
    field: string;
    value: string;
  };
}

/**
 * Interface for relationship registry
 */
export interface IRelationshipRegistry {
  /**
   * Register a relationship
   */
  register(definition: RelationshipDefinition): void;

  /**
   * Get relationships for a collection
   */
  getForCollection(collection: string): RelationshipDefinition[];

  /**
   * Get a specific relationship by name
   */
  getByName(collection: string, name: string): RelationshipDefinition | undefined;

  /**
   * Get all registered relationships
   */
  getAll(): RelationshipDefinition[];

  /**
   * Clear all relationships
   */
  clear(): void;

  /**
   * Remove all relationships for a collection (V1 compatibility)
   */
  removeBySource?(collection: string): void;
}

