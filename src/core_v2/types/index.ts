/**
 * Core V2 - Base Types
 * Centralized type definitions for the entire core system
 */

// ============================================================================
// DATABASE TYPES
// ============================================================================

export type DatabaseType = 'mongodb' | 'postgresql' | 'rest';

export type QueryType = 'read' | 'insert' | 'update' | 'delete' | 'deleteMany' | 'updateMany' | 'bulkUpdate' | 'replace';

// Standard HTTP methods + custom actions (like 'GET-ADMIN', 'POST-APPROVE', etc.)
export type HttpMethod = 'GET' | 'GET-ALL' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'FRONT' | (string & {});

// ============================================================================
// FILTER & QUERY TYPES
// ============================================================================

export type ComparisonOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin' | 'like' | 'ilike' | 'regex'
  | 'exists' | 'null' | 'notnull'
  | 'contains' | 'startswith' | 'endswith'
  | 'not_contains' | 'not_startswith' | 'not_endswith'
  | 'between' | 'not_between';

export type LogicalOperator = 'and' | 'or' | 'not';

export type SortDirection = 'asc' | 'desc';

export type JoinType =
  | 'inner' | 'left' | 'right' | 'full'
  | 'lookup' | 'embed'
  | 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' | 'junction';

export type RelationType = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' | 'junction';

// ============================================================================
// COMMON INTERFACES
// ============================================================================

export interface QueryParams {
  [key: string]: string | string[];
}

export interface UserContext {
  user_id: string;
  roles: string[];
  tenant_id?: string;
}

export interface RequestOptions {
  databaseType: DatabaseType;
  is_tenant: boolean;
  tenant_id?: string;
  user_id?: string;
  roles?: string[];
  log?: any;  // Fastify logger instance
  noCache?: boolean;
  cacheTTL?: number;
  frontAPI?: boolean;
  tree?: boolean | string;
  history?: boolean | string;
  action?: string;
  headers?: Record<string, string>;
  body?: any;
  localOnly?: boolean; // For schema reload/delete operations
  [key: string]: unknown;
}

// ============================================================================
// FUNCTION CUSTOM (for dynamic values)
// ============================================================================

export interface FunctionCall {
  functionName: string;
  args: (FunctionCall | unknown)[];
}

export function isFunctionCall(value: unknown): value is FunctionCall {
  return (
    typeof value === 'object' &&
    value !== null &&
    'functionName' in value &&
    'args' in value
  );
}

// ============================================================================
// VALIDATION TYPES
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  field?: string;
  message: string;
  code?: string;
}

// ============================================================================
// PAGINATION TYPES
// ============================================================================

export interface PaginationInfo {
  current_page: number;
  last_page: number;
  total: number;
  hasMore?: boolean;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  count?: boolean;
}

// ============================================================================
// METADATA TYPES
// ============================================================================

export interface QueryMetadata {
  originalParams?: Record<string, unknown>;
  roles?: string[];
  source?: string;
  timestamp?: Date;
  hints?: Record<string, unknown>;
  database?: DatabaseType;
  user: UserContext;
  options?: Record<string, unknown>;
}

export interface ResultMetadata {
  executionTime?: number;
  adapter: string;
  insertedCount?: number;
  modifiedCount?: number;
  deletedCount?: number;
  matchedCount?: number;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

export type OptionalFields<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
