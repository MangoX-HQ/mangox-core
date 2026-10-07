/**
 * Core V2 - Intermediate Query Format
 * Database-agnostic query representation
 *
 * Key improvements over v1:
 * - Unified filter system (no more filter vs filters vs filtersBefore confusion)
 * - Clear separation of security filters vs user filters
 * - Proper TypeScript types (no any)
 * - JSDoc documentation
 */

import {
  QueryType,
  ComparisonOperator,
  LogicalOperator,
  SortDirection,
  JoinType,
  QueryMetadata,
  FunctionCall,
  PaginationOptions,
  DatabaseType,
} from '../types';

// ============================================================================
// FILTER CONDITIONS
// ============================================================================

/**
 * A single field condition for filtering
 */
/** Filter value type */
export type FilterValue = FunctionCall | string | number | boolean | null | unknown[] | unknown;

export interface FieldCondition {
  /** Field name (supports dot notation for nested fields) */
  field: string;

  /** Comparison operator */
  operator: ComparisonOperator;

  /** Value to compare against - can be static or dynamic (FunctionCall) */
  value: FilterValue;

  /** Optional modifiers for the condition */
  modifiers?: string[];
}

/**
 * Logical grouping of conditions
 */
export interface FilterGroup {
  /** Logical operator for combining conditions in this group */
  operator: LogicalOperator;

  /** Direct field conditions in this group */
  conditions?: FieldCondition[];

  /** Nested filter groups */
  nested?: FilterGroup[];
}

/**
 * Unified filter structure
 * Can be either a single condition, array of conditions, or logical group
 */
export type Filter = FieldCondition | FieldCondition[] | FilterGroup;

/**
 * Check if filter is a FilterGroup
 */
export function isFilterGroup(filter: Filter): filter is FilterGroup {
  return (
    typeof filter === 'object' &&
    filter !== null &&
    !Array.isArray(filter) &&
    'operator' in filter &&
    ['and', 'or', 'not'].includes((filter as FilterGroup).operator)
  );
}

/**
 * Check if filter is a FieldCondition
 */
export function isFieldCondition(filter: unknown): filter is FieldCondition {
  return (
    typeof filter === 'object' &&
    filter !== null &&
    'field' in filter &&
    'operator' in filter &&
    'value' in filter
  );
}

// ============================================================================
// SELECT & PROJECTION
// ============================================================================

/**
 * Field selection/projection configuration
 */
export interface SelectClause {
  /** Fields to include (empty = all fields) */
  include?: string[];

  /** Fields to exclude */
  exclude?: string[];
}

// ============================================================================
// SORTING
// ============================================================================

/**
 * Sort configuration for a single field
 */
export interface SortClause {
  /** Field to sort by */
  field: string;

  /** Sort direction */
  direction: SortDirection;

  /** How to handle null values */
  nulls?: 'first' | 'last';
}

// ============================================================================
// JOINS & RELATIONSHIPS
// ============================================================================

/**
 * Join condition between collections
 */
export interface JoinCondition {
  /** Field in the source collection */
  local: string;

  /** Field in the target collection */
  foreign: string;

  /** Comparison operator (default: eq) */
  operator?: ComparisonOperator;
}

/**
 * Relationship metadata for joins
 */
export interface RelationshipMeta {
  /** Relationship name (as defined in schema) */
  name: string;

  /** Junction table config for many-to-many */
  junction?: {
    table: string;
    localKey: string;
    foreignKey: string;
  };

  /** Preserve null/empty results in output */
  preserveNull?: boolean;
}

/**
 * Join clause for related collections
 */
export interface JoinClause {
  /** Type of join */
  type: JoinType;

  /** Target collection/table */
  target: string;

  /** Alias for the joined data */
  alias?: string;

  /** Join conditions */
  on: JoinCondition[];

  /** Field selection for joined data */
  select?: SelectClause;

  /** Additional filters for joined data (applied inside pipeline - LEFT JOIN behavior) */
  filter?: Filter;

  /**
   * Root-level filter for INNER JOIN behavior
   * When set, filter is applied AFTER $unwind at root level
   * Records that don't match will be excluded from results
   * Use syntax: !field=operator.value in select clause
   */
  rootFilter?: Filter;

  /** Nested joins (for deep relationships) */
  joins?: JoinClause[];

  /** Relationship metadata */
  relationship?: RelationshipMeta;
}

// ============================================================================
// AGGREGATION
// ============================================================================

export type AggregationType = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'group' | 'having' | 'distinct';

/**
 * Aggregation operation configuration
 */
export interface AggregationClause {
  /** Type of aggregation */
  type: AggregationType;

  /** Field to aggregate (not needed for count) */
  field?: string;

  /** Output alias for the result */
  alias: string;

  /** Additional parameters */
  params?: Record<string, unknown>;
}

// ============================================================================
// INTERMEDIATE QUERY
// ============================================================================

/**
 * Query options that affect execution
 */
export interface QueryOptions {
  /** Partial update mode */
  partial?: boolean;

  /** ID for partial update */
  partial_id?: string;

  /** Build tree structure from results */
  tree?: boolean;

  /** Include history data */
  history?: boolean;

  /** Database session (for transactions) */
  session?: unknown;

  /** Additional custom options */
  [key: string]: unknown;
}

/**
 * Main intermediate query structure
 *
 * This is the core data structure that represents a database-agnostic query.
 * It gets converted to native queries by database adapters.
 */
export interface IntermediateQuery {
  /** Query operation type */
  type: QueryType;

  /** Target collection/table — LOGICAL entity name (used by RBAC, plugins, schema lookup) */
  collection: string;

  /**
   * Physical collection name when entity has `mongodb_save_data` (polymorphic).
   * When set, the DB adapter uses this for actual storage operations while
   * `collection` (logical) is used for plugins/schema lookup. When unset,
   * `collection` is used directly.
   */
  physicalCollection?: string;

  /**
   * API config record — set when the entity has `databaseType='rest'`.
   * The REST adapter reads this to know which remote API to call.
   * Resolved from entity.api_config slug → schemaManager api-config record.
   */
  apiConfig?: Record<string, any>;

  /**
   * Security filters - applied FIRST, cannot be bypassed
   * Used for:
   * - Tenant isolation (tenant_id filter)
   * - RBAC scope restrictions
   * - Soft delete filtering
   */
  securityFilters: FieldCondition[];

  /** Security filter GROUPS — security constraints that need OR (ANDed with securityFilters; OR inside). */
  securityFilterGroups?: FilterGroup[];

  /**
   * User filters - from query parameters
   * Applied after security filters
   */
  userFilter?: Filter;

  /** Data payload for insert/update operations (array for bulk) */
  data?: Record<string, unknown> | Record<string, unknown>[];

  /** Field selection/projection */
  select?: SelectClause;

  /** Sort configuration */
  sort?: SortClause[];

  /** Pagination settings */
  pagination?: PaginationOptions;

  /** Join/relationship configurations */
  joins?: JoinClause[];

  /** Aggregation operations */
  aggregations?: AggregationClause[];

  /** Query execution options */
  options?: QueryOptions;

  /** Query metadata */
  metadata: QueryMetadata;
}

// ============================================================================
// QUERY RESULT
// ============================================================================

/**
 * Result metadata
 */
export interface QueryResultMetadata {
  /** Execution time in milliseconds */
  executionTime?: number;

  /** Database adapter used */
  adapter: string;

  /** Original intermediate query */
  query: IntermediateQuery;

  /** Generated native query (for debugging) */
  nativeQuery?: unknown;

  /** Number of documents inserted */
  insertedCount?: number;

  /** Number of documents modified */
  modifiedCount?: number;

  /** Number of documents deleted */
  deletedCount?: number;

  /** Number of documents matched */
  matchedCount?: number;
}

/**
 * Query execution result
 */
export interface QueryResult<T = unknown> {
  /** HTTP status code */
  statusCode: number;

  /** Result data */
  data: T[];

  /** Total count (if requested) */
  count?: number;

  /** Pagination info */
  pagination?: {
    current_page: number;
    last_page: number;
    total: number;
    hasMore?: boolean;
  };

  /** Result metadata */
  metadata: QueryResultMetadata;
}

// ============================================================================
// QUERY BUILDER HELPER
// ============================================================================

/**
 * Helper class for building IntermediateQuery objects
 */
export class QueryBuilder {
  private query: IntermediateQuery;

  constructor(collection: string, type: QueryType = 'read') {
    this.query = {
      type,
      collection,
      securityFilters: [],
      metadata: {
        timestamp: new Date(),
        user: { user_id: '', roles: [] },
      },
    };
  }

  /**
   * Set query type
   */
  setType(type: QueryType): this {
    this.query.type = type;
    return this;
  }

  /**
   * Add security filter (cannot be bypassed)
   */
  addSecurityFilter(field: string, operator: ComparisonOperator, value: unknown): this {
    this.query.securityFilters.push({ field, operator, value });
    return this;
  }

  /**
   * Set user filter
   */
  setUserFilter(filter: Filter): this {
    this.query.userFilter = filter;
    return this;
  }

  /**
   * Set data for insert/update (array for bulk operations)
   */
  setData(data: Record<string, unknown> | Record<string, unknown>[]): this {
    this.query.data = data;
    return this;
  }

  /**
   * Set field selection
   */
  select(fields: string[]): this {
    this.query.select = { include: fields };
    return this;
  }

  /**
   * Exclude fields
   */
  exclude(fields: string[]): this {
    this.query.select = { ...this.query.select, exclude: fields };
    return this;
  }

  /**
   * Add sort clause
   */
  orderBy(field: string, direction: SortDirection = 'asc'): this {
    if (!this.query.sort) this.query.sort = [];
    this.query.sort.push({ field, direction });
    return this;
  }

  /**
   * Set pagination
   */
  paginate(limit: number, offset: number = 0): this {
    this.query.pagination = { ...this.query.pagination, limit, offset };
    return this;
  }

  /**
   * Request count
   */
  withCount(): this {
    this.query.pagination = { ...this.query.pagination, count: true };
    return this;
  }

  /**
   * Add join
   */
  join(joinClause: JoinClause): this {
    if (!this.query.joins) this.query.joins = [];
    this.query.joins.push(joinClause);
    return this;
  }

  /**
   * Set metadata
   */
  setMetadata(metadata: Partial<QueryMetadata>): this {
    this.query.metadata = { ...this.query.metadata, ...metadata };
    return this;
  }

  /**
   * Set options
   */
  setOptions(options: QueryOptions): this {
    this.query.options = { ...this.query.options, ...options };
    return this;
  }

  /**
   * Build the final query
   */
  build(): IntermediateQuery {
    return { ...this.query };
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Type guard: check if data is single record (not array)
 */
export function isSingleData(
  data: Record<string, unknown> | Record<string, unknown>[] | undefined
): data is Record<string, unknown> {
  return data !== undefined && !Array.isArray(data);
}

/**
 * Type guard: check if data is array (bulk operation)
 */
export function isBulkData(
  data: Record<string, unknown> | Record<string, unknown>[] | undefined
): data is Record<string, unknown>[] {
  return data !== undefined && Array.isArray(data);
}

/**
 * Get data as single record (for non-bulk operations)
 * Returns undefined if data is an array
 */
export function getSingleData(
  data: Record<string, unknown> | Record<string, unknown>[] | undefined
): Record<string, unknown> | undefined {
  if (isSingleData(data)) return data;
  return undefined;
}

/**
 * Create a new query builder
 */
export function createQuery(collection: string, type: QueryType = 'read'): QueryBuilder {
  return new QueryBuilder(collection, type);
}
