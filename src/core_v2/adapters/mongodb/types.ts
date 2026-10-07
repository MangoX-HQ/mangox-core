/**
 * Core V2 - MongoDB Adapter Types
 */

import { Document, Filter, Sort, ObjectId, ClientSession } from 'mongodb';

// ============================================================================
// MONGODB NATIVE QUERY TYPES
// ============================================================================

/**
 * MongoDB CRUD operation types
 */
export type MongoDBOperationType =
  | 'insertOne'
  | 'insertMany'
  | 'updateOne'
  | 'updateMany'
  | 'replaceOne'
  | 'deleteOne'
  | 'deleteMany'
  | 'bulkWrite';

/**
 * MongoDB CRUD operation
 */
export interface MongoDBOperation {
  operation: MongoDBOperationType;
  filter?: Filter<Document>;
  document?: Document;
  update?: Document;
  documents?: Document[];
  options?: MongoDBOperationOptions;
}

/**
 * MongoDB operation options
 */
export interface MongoDBOperationOptions {
  upsert?: boolean;
  arrayFilters?: Document[];
  session?: ClientSession;
}

/**
 * MongoDB aggregation pipeline
 */
export type MongoDBPipeline = Document[];

/**
 * MongoDB native query - either a pipeline or CRUD operation
 */
export type MongoDBNativeQuery = MongoDBPipeline | MongoDBOperation;

/**
 * Check if query is a pipeline (array)
 */
export function isPipeline(query: MongoDBNativeQuery): query is MongoDBPipeline {
  return Array.isArray(query);
}

/**
 * Check if query is a CRUD operation
 */
export function isOperation(query: MongoDBNativeQuery): query is MongoDBOperation {
  return !Array.isArray(query) && 'operation' in query;
}

// ============================================================================
// MONGODB CONNECTION CONFIG
// ============================================================================

/**
 * MongoDB connection configuration
 */
export interface MongoDBConnectionConfig {
  /** Full connection string (mongodb://...) */
  connectionString?: string;

  /** Host (if not using connection string) */
  host?: string;

  /** Port (default: 27017) */
  port?: number;

  /** Database name */
  database?: string;

  /** Username for authentication */
  username?: string;

  /** Password for authentication */
  password?: string;

  /** Authentication database */
  authSource?: string;

  /** Connection pool settings */
  pool?: {
    maxPoolSize?: number;
    minPoolSize?: number;
    maxIdleTimeMS?: number;
    waitQueueTimeoutMS?: number;
  };

  /** Timeout settings */
  timeouts?: {
    serverSelectionTimeoutMS?: number;
    socketTimeoutMS?: number;
    connectTimeoutMS?: number;
  };

  /** Replica set name */
  replicaSet?: string;

  /** Enable retry writes */
  retryWrites?: boolean;

  /** Enable retry reads */
  retryReads?: boolean;
}

/**
 * Default MongoDB connection config
 */
export const DEFAULT_MONGODB_CONFIG: Partial<MongoDBConnectionConfig> = {
  port: 27017,
  pool: {
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 60000,
    waitQueueTimeoutMS: 10000,
  },
  timeouts: {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
  },
  retryWrites: true,
  retryReads: true,
};

// ============================================================================
// MONGODB ADAPTER CAPABILITIES
// ============================================================================

/**
 * MongoDB adapter capabilities
 */
export const MONGODB_CAPABILITIES = {
  filterOperators: [
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'in', 'nin', 'exists', 'null', 'notnull',
    'regex', 'like', 'ilike',
    'contains', 'startswith', 'endswith',
    'not_contains', 'not_startswith', 'not_endswith',
    'between', 'not_between',
  ],
  joinTypes: [
    'lookup', 'left', 'inner',
    'one-to-one', 'one-to-many', 'many-to-one', 'many-to-many',
  ],
  aggregations: ['count', 'sum', 'avg', 'min', 'max', 'group', 'distinct'],
  features: {
    fullTextSearch: true,
    transactions: true,
    nestedQueries: true,
    geoQueries: true,
  },
  limits: {
    maxComplexity: 100,
    maxResultSize: 1000000,
    maxPipelineStages: 1000,
  },
} as const;

// ============================================================================
// MONGODB OPERATOR MAPPING
// ============================================================================

/**
 * Mapping from intermediate operators to MongoDB operators
 */
export const OPERATOR_MAP: Record<string, string> = {
  eq: '$eq',
  neq: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  nin: '$nin',
  exists: '$exists',
  regex: '$regex',
  like: '$regex',
  ilike: '$regex',
  contains: '$regex',
  startswith: '$regex',
  endswith: '$regex',
  not_contains: '$regex',
  not_startswith: '$regex',
  not_endswith: '$regex',
  between: '$gte',
  not_between: '$not',
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert string to ObjectId if valid
 */
export function toObjectId(value: string | ObjectId): ObjectId {
  if (typeof value === 'string' && ObjectId.isValid(value)) {
    return new ObjectId(value);
  }
  throw new Error(`Invalid ObjectId: ${value}`);
}

/**
 * Convert array of strings to ObjectIds
 */
export function toObjectIdArray(values: (string | ObjectId)[]): ObjectId[] {
  return values.map(toObjectId);
}

/**
 * Check if value is a valid ObjectId string
 */
export function isValidObjectId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ObjectId.isValid(value);
}

/**
 * Safely convert to ObjectId, returning original if invalid
 */
export function safeToObjectId(value: unknown): ObjectId | unknown {
  if (value instanceof ObjectId) return value;
  if (typeof value === 'string' && ObjectId.isValid(value)) {
    return new ObjectId(value);
  }
  return value;
}
