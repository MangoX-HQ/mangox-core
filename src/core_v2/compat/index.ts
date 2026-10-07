/**
 * Core V2 - Compatibility Layer
 * Provides backward-compatible functions for migrating from Core V1
 *
 * These functions replicate Core V1 behavior using Core V2's SchemaManager
 */

import { schemaManager } from "../schema/manager";

// ============================================================================
// RE-EXPORT TYPES (from core_v2/types)
// ============================================================================

export {
  ComparisonOperator,
  RequestOptions,
  DatabaseType,
  QueryType,
  HttpMethod,
  LogicalOperator,
  SortDirection,
  JoinType,
  RelationType,
  QueryParams,
  UserContext,
  FunctionCall,
  isFunctionCall,
  ValidationResult,
  ValidationError,
  PaginationInfo,
  PaginationOptions,
  QueryMetadata,
  ResultMetadata,
} from "../types";

// ============================================================================
// RE-EXPORT QUERY TYPES (from core_v2/query/intermediate)
// ============================================================================

export {
  IntermediateQuery,
  QueryResult,
  FieldCondition,
  FilterGroup,
  Filter,
  SelectClause,
  SortClause,
  JoinClause,
  JoinCondition,
  QueryBuilder,
  createQuery,
  isFilterGroup,
  isFieldCondition,
} from "../query/intermediate";

// Re-export compatible types from configs/types
export type { IntermediateQueryResult, OptionsInput } from "../../configs/types";

// ============================================================================
// RE-EXPORT SCHEMA (from core_v2/schema/manager)
// ============================================================================

export { schema, schemaManager } from "../schema/manager";

// ============================================================================
// RE-EXPORT RBAC (from core_v2/compat)
// ============================================================================

export { PermissionAdapter } from "./permission-adapter";

// ============================================================================
// RE-EXPORT DATA ACCESS (from core_v2/compat)
// ============================================================================

export {
  handleMongoRestQueryPlayerOne,
  callDatabaseGetAccess,
  callDatabaseGetAccessGlobal,
} from "./data-access";

// ============================================================================
// COMPATIBILITY FUNCTIONS
// ============================================================================

/**
 * Get entity plugins configuration
 * Replaces: objectPlug("entity", entityName) from core/schema/schema
 *
 * @param collection - Usually "entity"
 * @param entityName - Name of the entity
 * @returns Object containing plugin flags (use_history, use_pinned, etc.)
 */
export async function objectPlug(_collection: string, entityName: string): Promise<Record<string, any>> {
  const entity = await schemaManager.getEntity(entityName);

  if (!entity) {
    return {};
  }

  // Extract plugin flags from entity schema
  const plugins: Record<string, any> = {};

  // Common plugin flags
  const pluginKeys = [
    'use_history',
    'use_pinned',
    'use_locale',
    'use_slug',
    'use_timestamp',
    'use_soft_delete',
    'use_block',
    'use_parent',
    'use_sync_relationship_multiply_language',
    'use_generate_fields',
  ];

  for (const key of pluginKeys) {
    if (entity[key] !== undefined) {
      plugins[key] = entity[key];
    }
  }

  return plugins;
}

/**
 * Get locale configuration for entity
 * Replaces: typeLocale(entityName, mode) from core/schema/schema
 *
 * @param entityName - Name of the entity
 * @param mode - "create" | "find" | ""
 * @returns Object with useLocale flag and field name
 */
export async function typeLocale(
  entityName: string,
  _mode: "create" | "find" | string
): Promise<{ useLocale: boolean; field: string }> {
  const entity = await schemaManager.getEntity(entityName);

  if (!entity || !entity.use_locale) {
    return { useLocale: false, field: "_id" };
  }

  // Default locale field
  let field = "locale_id";

  // Check json_schema for locale field
  if (entity.json_schema?.properties) {
    const props = entity.json_schema.properties;

    // Look for locale_id or similar field
    if (props.locale_id) {
      field = "locale_id";
    } else if (props.group_locale) {
      field = "group_locale";
    }
  }

  // Check entity-level locale field config
  if (entity.locale_field) {
    field = entity.locale_field;
  }

  return { useLocale: true, field };
}

/**
 * Check if entity uses locale feature
 * Replaces: useLocale(tableName) from core/schema/schema
 *
 * @param tableName - Name of the entity/table
 * @returns Tuple [useLocale: boolean, fieldName: string]
 */
export async function useLocale(tableName: string): Promise<[boolean, string]> {
  const result = await typeLocale(tableName, "");
  return [result.useLocale, result.field];
}

// ============================================================================
// BOOTSTRAP CONFIG TYPE
// Simplified version - only includes fields actually used
// This is a legacy compatibility interface, primarily for backward compatibility
// ============================================================================

export interface BootstrapConfig {
  /** Include built-in adapters in initialization */
  includeBuiltinAdapters?: boolean;
  
  /** Redis connection configuration */
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    db?: number;
    prefix?: string;
    cacheTTL?: number;
  };
  
  /** Relationship definitions by collection/table name */
  relationships?: Record<string, any[]>;
  
  /** Core adapter configurations */
  core?: {
    adapters?: Record<string, {
      connection?: Record<string, any>;
    }>;
  };
}
