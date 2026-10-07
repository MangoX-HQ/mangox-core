/**
 * Core V2 - Query Converter
 * Converts URL query parameters to IntermediateQuery format
 *
 * Key improvements over v1:
 * - NO circular dependency (doesn't call Core directly)
 * - Uses dependency injection for external services
 * - Clean separation of concerns
 * - Better type safety
 */

import {
  IntermediateQuery,
  FieldCondition,
  FilterGroup,
  Filter,
  SelectClause,
  SortClause,
  JoinClause,
  QueryBuilder,
  createQuery,
  isFilterGroup,
} from './intermediate';
import {
  QueryParams,
  ComparisonOperator,
  LogicalOperator,
  FunctionCall,
  RequestOptions,
  UserContext,
} from '../types';
import { QueryConfig, getGlobalConfig } from '../config';
import { ObjectId } from 'mongodb';

// ============================================================================
// RELATIONSHIP RESOLVER INTERFACE (Dependency Injection)
// ============================================================================

/**
 * Relationship definition for joins
 */
export interface RelationshipInfo {
  name: string;
  sourceCollection: string;
  targetCollection: string;
  localField: string;
  foreignField: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' | 'junction';
  /**
   * Discriminator filter — set when targetCollection is a physical store shared by
   * multiple logical entities (mongodb_save_data routing). Join must filter
   * records where `field === value` to scope to the correct logical entity.
   */
  discriminator?: {
    field: string;
    value: string;
  };
}

/**
 * Interface for resolving relationship data
 * This allows dependency injection of the relationship registry
 */
export interface IRelationshipResolver {
  /**
   * Get relationships for a collection
   * @param collection - Source collection name
   */
  getForCollection(collection: string): RelationshipInfo[];

  /**
   * Get a specific relationship by name
   * @param collection - Source collection name
   * @param name - Relationship name
   */
  getByName(collection: string, name: string): RelationshipInfo | undefined;
}

/**
 * Default no-op relationship resolver
 */
export const defaultRelationshipResolver: IRelationshipResolver = {
  getForCollection(): RelationshipInfo[] {
    return [];
  },
  getByName(): RelationshipInfo | undefined {
    return undefined;
  },
};

/**
 * Merge a new filter group into an existing join filter using AND.
 * Filter is FieldCondition | FieldCondition[] | FilterGroup (per intermediate.ts).
 */
function mergeJoinFilters(
  existing: Filter | undefined,
  add: FilterGroup,
): Filter {
  if (!existing) return add;
  const existingGroup: FilterGroup = isFilterGroup(existing)
    ? existing
    : { operator: 'and', conditions: Array.isArray(existing) ? existing : [existing] };
  return {
    operator: 'and',
    nested: [existingGroup, add],
  };
}

// ============================================================================
// QUERY CONVERTER
// ============================================================================

/**
 * Converts URL query parameters to IntermediateQuery
 */
export class QueryConverter {
  private config: QueryConfig;
  private relationshipResolver: IRelationshipResolver;

  constructor(
    config?: QueryConfig,
    relationshipResolver?: IRelationshipResolver
  ) {
    this.config = config || getGlobalConfig().query;
    this.relationshipResolver = relationshipResolver || defaultRelationshipResolver;
  }

  /**
   * Set relationship resolver (for late binding)
   */
  setRelationshipResolver(resolver: IRelationshipResolver): void {
    this.relationshipResolver = resolver;
  }

  // ============================================================================
  // MAIN CONVERSION
  // ============================================================================

  /**
   * Convert query parameters to IntermediateQuery
   */
  async convert(
    params: QueryParams,
    collection: string,
    user: UserContext,
    options?: RequestOptions
  ): Promise<IntermediateQuery> {
    // Apply access policies to params
    // const enhancedParams = await this.applyAccessPolicies(
    //   params,
    //   collection,
    //   user.roles,
    //   options
    // );

    // Build base query
    const builder = createQuery(collection, 'read');

    // Set metadata
    builder.setMetadata({
      originalParams: params,
      roles: user.roles,
      timestamp: new Date(),
      source: 'rest-api',
      user,
    });

    // Process parameters
    for (const [key, value] of Object.entries(params)) {
      const paramValue = Array.isArray(value) ? value[0] : value;

      if (this.isSpecialParameter(key)) {
        await this.handleSpecialParameter(key, paramValue, builder, user.roles, options);
      } else if (this.isLogicalOperator(key)) {
        this.handleLogicalOperator(key, paramValue, builder);
      } else if (key === 'filters') {
        this.handleFiltersParam(paramValue, builder);
      } else {
        this.handleFieldFilter(key, paramValue, builder);
      }
    }

    // Apply defaults
    this.applyDefaults(builder);

    return builder.build();
  }

  // ============================================================================
  // ACCESS POLICIES
  // ============================================================================

  /**
   * Apply access policies to query parameters
   * Uses Core V1's callDatabaseGetAccess for compatibility
   */
  // private async applyAccessPolicies(
  //   params: QueryParams,
  //   collection: string,
  //   roles: string[],
  //   options?: RequestOptions
  // ): Promise<QueryParams> {
  //   let enhancedParams = { ...params };

  //   // Get collection-specific access using Core V1's function
  //   if (collection !== 'policy') {
  //     try {
  //       const access = await callDatabaseGetAccess(
  //         collection,
  //         roles,
  //         '1', // layer
  //         (options?.action as 'GET-ALL' | 'GET' | 'POST' | 'PUT' | 'PATCH') || 'GET-ALL',
  //         options
  //       );

  //       enhancedParams = handleMongoRestQueryPlayerOne(enhancedParams, access);
  //     } catch (error) {
  //       // Log but don't fail if policy lookup fails
  //       console.warn(`[QueryConverter] Policy lookup failed for ${collection}:`, error);
  //     }
  //   }

  //   // Get global access using Core V1's function
  //   try {
  //     const globalAccess = await callDatabaseGetAccessGlobal(
  //       collection,
  //       (options?.action as 'GET-ALL' | 'GET' | 'POST' | 'PUT' | 'PATCH') || 'GET-ALL'
  //     );
  //     enhancedParams = handleMongoRestQueryPlayerOne(enhancedParams, globalAccess);
  //   } catch (error) {
  //     // Log but don't fail if global policy lookup fails
  //     console.warn(`[QueryConverter] Global policy lookup failed for ${collection}:`, error);
  //   }

  //   return enhancedParams;
  // }

  /**
   * Merge access policy into query params
   * Uses the same logic as Core V1's handleMongoRestQueryPlayerOne
   */
  // private mergeAccessPolicy(params: QueryParams, policy: AccessPolicy): QueryParams {
  //   if (!policy.custom_query && !policy.custom_scope) return params;

  //   // Convert AccessPolicy to getAccess format expected by handleMongoRestQueryPlayerOne
  //   const access = {
  //     custom_scope: policy.custom_scope || '',
  //     custom_data_scope: policy.custom_data_scope || { data: {} },
  //     custom_query: policy.custom_query || {},
  //   };

  //   // Use Core V1's handleMongoRestQueryPlayerOne to properly format and merge policy conditions
  //   return handleMongoRestQueryPlayerOne(params, access);
  // }

  // ============================================================================
  // PARAMETER HANDLING
  // ============================================================================

  /**
   * Check if key is a special parameter
   */
  private isSpecialParameter(key: string): boolean {
    // Include query builder metadata fields that should not be treated as filters
    return ['select', 'order', 'limit', 'skip', 'offset', 'count', 'page'].includes(key);
  }

  /**
   * Handle special parameters
   */
  private async handleSpecialParameter(
    key: string,
    value: string,
    builder: QueryBuilder,
    roles: string[],
    options?: RequestOptions
  ): Promise<void> {
    switch (key) {
      case 'select':
        // Parse regular fields
        const selectFields = this.parseSelectFields(value);
        console.log("Parsed select fields:", selectFields);
        if (selectFields.include && selectFields.include.length > 0) {
          builder.select(selectFields.include);
        }
        if (selectFields.exclude && selectFields.exclude.length > 0) {
          builder.exclude(selectFields.exclude);
        }
        // Parse embed expressions (relations) and add as joins.
        // builder.build().collection is now ALWAYS the LOGICAL entity name
        // (core-service handles physical translation via query.physicalCollection).
        const entityName = builder.build().collection;
        // Get locale from params for auto-filtering locale_id relations
        const params = builder.build().metadata?.originalParams as Record<string, unknown> | undefined;
        const locale = params?.locale as string | undefined;
        const embedJoins = await this.parseEmbedExpressions(value, entityName, locale);
        for (const joinClause of embedJoins) {
          builder.join(joinClause);
        }
        break;

      case 'order':
        const sorts = this.parseSort(value);
        for (const sort of sorts) {
          builder.orderBy(sort.field, sort.direction);
        }
        break;

      case 'limit':
        const limit = Math.min(parseInt(value) || this.config.defaultLimit, this.config.maxLimit);
        builder.paginate(limit);
        break;

      case 'skip':
      case 'offset':
        const query = builder.build();
        const currentLimit = query.pagination?.limit || this.config.defaultLimit;
        builder.paginate(currentLimit, parseInt(value) || 0);
        break;

      case 'page':
        const pageNum = parseInt(value) || 1;
        const pageQuery = builder.build();
        const pageLimit = pageQuery.pagination?.limit || this.config.defaultLimit;
        builder.paginate(pageLimit, (pageNum - 1) * pageLimit);
        break;

      case 'count':
        if (value === 'true' || value === 'exact') {
          builder.withCount();
        }
        break;
    }
  }

  /**
   * Parse select fields (without join handling)
   */
  private parseSelectFields(selectClause: string): SelectClause {
    if (!selectClause) {
      return { include: [] };
    }

    // Strip leading "select=" prefix if client sends the full param as value
    if (selectClause.startsWith('select=')) {
      selectClause = selectClause.substring(7);
    }

    // Handle wildcard select
    if (selectClause === '*') {
      return { include: ['*'] };
    }

    const include: string[] = [];
    const exclude: string[] = [];

    const fields = this.tokenizeSelect(selectClause);

    for (const field of fields) {
      const trimmed = field.trim();

      // Skip embed expressions (handled by parseEmbedExpressions)
      if (this.isEmbedExpression(trimmed)) continue;
      console.log("Select field:", trimmed);
      if (trimmed.startsWith('-')) {
        exclude.push(trimmed.substring(1));
      } else {
        include.push(trimmed);
      }
    }

    return { include, exclude };
  }

  /**
   * Tokenize select clause respecting parentheses
   */
  private tokenizeSelect(selectClause: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < selectClause.length; i++) {
      const char = selectClause[i];

      if (char === '(') {
        depth++;
        current += char;
      } else if (char === ')') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        if (current.trim()) {
          tokens.push(current.trim());
        }
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      tokens.push(current.trim());
    }

    return tokens;
  }

  /**
   * Check if token is an embed expression (relation)
   */
  private isEmbedExpression(token: string): boolean {
    const trimmed = token.trim();

    // Must have both opening and closing parentheses
    if (!trimmed.includes('(') || !trimmed.includes(')')) {
      return false;
    }

    // Must not be a quoted string
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return false;
    }

    // Check if it looks like a function call (name followed by parentheses)
    const functionPattern = /^[a-zA-Z_][a-zA-Z0-9_-]*\(/;
    return functionPattern.test(trimmed);
  }

  /**
   * Parse embed expressions from select clause and convert to JoinClause
   * @param locale - Current locale for filtering locale_id relations
   */
  private async parseEmbedExpressions(
    selectClause: string,
    collection: string,
    locale?: string
  ): Promise<JoinClause[]> {
    const joins: JoinClause[] = [];
    const tokens = this.tokenizeSelect(selectClause);

    for (const token of tokens) {
      if (this.isEmbedExpression(token)) {
        const joinClause = await this.parseEmbedToJoin(token, collection, locale);
        if (joinClause) {
          joins.push(joinClause);
        }
      }
    }

    return joins;
  }

  /**
   * Parse embed expression to JoinClause
   * e.g., "user()" -> JoinClause for user relationship
   * e.g., "posts(status=published)" -> JoinClause with filter
   * @param locale - Current locale for filtering locale_id relations
   */
  private async parseEmbedToJoin(
    embedExpr: string,
    collection: string,
    locale?: string
  ): Promise<JoinClause | null> {
    // Parse relation name and inner expression
    const openIndex = embedExpr.indexOf('(');
    if (openIndex === -1) {
      return null;
    }

    const relationName = embedExpr.substring(0, openIndex);

    // Find matching closing parenthesis
    let depth = 0;
    let closeIndex = -1;

    for (let i = openIndex; i < embedExpr.length; i++) {
      if (embedExpr[i] === '(') {
        depth++;
      } else if (embedExpr[i] === ')') {
        depth--;
        if (depth === 0) {
          closeIndex = i;
          break;
        }
      }
    }

    if (closeIndex === -1 || closeIndex !== embedExpr.length - 1) {
      return null;
    }

    const innerExpr = embedExpr.substring(openIndex + 1, closeIndex);

    // Look up relationship from registry
    const relationship = this.relationshipResolver.getByName(collection, relationName);

    // Skip embed when no relationship is registered. The registry is global, so
    // a per-tenant relation may be missing if a different tenant's entity (with
    // no such relation) clobbered the global cache. Falling back to relationName
    // as table name would yield SQL like JOIN "subscription_id" which crashes
    // strict adapters (SQLite). Better to drop the embed than 500 the request.
    if (!relationship) {
      return null;
    }

    // For polymorphic targets, targetCollection is the PHYSICAL store (e.g. "task"),
    // while nested embed parsing must use the LOGICAL entity name (e.g. "task_worker")
    // because relationships are registered by logical sourceCollection.
    const logicalTarget = relationship.discriminator?.value
      || relationship.targetCollection
      || relationName;

    // Create JoinClause - use relationship type for proper $unwind handling
    const joinClause: JoinClause = {
      type: relationship.type || 'lookup',
      target: relationship.targetCollection,
      alias: relationName,
      on: [{
        local: relationship.localField,
        foreign: relationship.foreignField,
        operator: 'eq',
      }],
      select: { include: [], exclude: [] },
    };

    // Parse inner expression for nested filters and joins
    if (innerExpr.trim()) {
      const { filter, rootFilter, nestedJoins, select } = await this.parseInnerExpression(
        innerExpr,
        logicalTarget,
        locale
      );

      if (filter) {
        joinClause.filter = filter;
      }
      if (rootFilter) {
        joinClause.rootFilter = rootFilter;
      }
      if (nestedJoins && nestedJoins.length > 0) {
        joinClause.joins = nestedJoins;
      }
      if (select) {
        joinClause.select = select;
      }
    }

    // Auto-add discriminator filter when target is a polymorphic physical collection
    // (target entity has mongodb_save_data — multiple logical entities share same store).
    // Filter must scope join to records where discriminator.field === discriminator.value.
    if (relationship?.discriminator) {
      const discFilter: FilterGroup = {
        operator: 'and',
        conditions: [
          {
            field: relationship.discriminator.field,
            operator: 'eq',
            value: relationship.discriminator.value,
          },
        ],
      };
      joinClause.filter = mergeJoinFilters(joinClause.filter, discFilter);
    }

    // Auto-add locale filter when foreignField is 'locale_id' and locale is provided
    // This ensures we only get one language version instead of all locale versions
    // Uses OR condition: locale doesn't exist OR locale matches (same as Core V1)
    if (locale && relationship?.foreignField === 'locale_id') {
      const localeFilter: FilterGroup = {
        operator: 'or',
        conditions: [
          { field: 'locale', operator: 'exists', value: false },
          { field: 'locale', operator: 'eq', value: locale },
        ],
      };
      joinClause.filter = mergeJoinFilters(joinClause.filter, localeFilter);
    }

    return joinClause;
  }

  /**
   * Parse inner expression of embed for filters, nested joins, and select
   * @param locale - Current locale for filtering locale_id relations in nested joins
   *
   * Filter syntax:
   * - `field=operator.value` - LEFT JOIN behavior (filter inside pipeline, keeps root record)
   * - `!field=operator.value` - INNER JOIN behavior (filter at root level, excludes root if no match)
   */
  private async parseInnerExpression(
    innerExpr: string,
    targetCollection: string,
    locale?: string
  ): Promise<{
    filter?: Filter;
    rootFilter?: Filter;
    nestedJoins?: JoinClause[];
    select?: SelectClause;
  }> {
    const result: {
      filter?: Filter;
      rootFilter?: Filter;
      nestedJoins?: JoinClause[];
      select?: SelectClause;
    } = {};

    // Tokenize inner expression
    const tokens = this.tokenizeSelect(innerExpr);
    const filterConditions: FieldCondition[] = [];
    const rootFilterConditions: FieldCondition[] = [];
    const nestedJoins: JoinClause[] = [];
    const selectFields: string[] = [];

    for (const token of tokens) {
      const trimmed = token.trim();

      if (this.isEmbedExpression(trimmed)) {
        // Nested relation - pass locale for nested locale_id filtering
        const nestedJoin = await this.parseEmbedToJoin(trimmed, targetCollection, locale);
        if (nestedJoin) {
          nestedJoins.push(nestedJoin);
        }
      } else if (trimmed.startsWith('!') && trimmed.includes('=')) {
        // INNER JOIN filter (! prefix) - apply at root level
        const condition = this.parseFieldCondition(trimmed.substring(1));
        if (condition) {
          rootFilterConditions.push(condition);
        }
      } else if (trimmed.includes('=')) {
        // LEFT JOIN filter (no prefix) - apply inside pipeline
        const condition = this.parseFieldCondition(trimmed);
        if (condition) {
          filterConditions.push(condition);
        }
      } else if (trimmed) {
        // Select field
        selectFields.push(trimmed);
      }
    }

    if (filterConditions.length > 0) {
      result.filter = {
        operator: 'and',
        conditions: filterConditions,
      };
    }

    if (rootFilterConditions.length > 0) {
      result.rootFilter = {
        operator: 'and',
        conditions: rootFilterConditions,
      };
    }

    if (nestedJoins.length > 0) {
      result.nestedJoins = nestedJoins;
    }

    if (selectFields.length > 0) {
      result.select = { include: selectFields, exclude: [] };
    }

    return result;
  }

  /**
   * Parse sort clause
   */
  private parseSort(orderClause: string): SortClause[] {
    const sorts: SortClause[] = [];
    const fields = orderClause.split(',');

    for (const field of fields) {
      const trimmed = field.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('-')) {
        sorts.push({
          field: trimmed.substring(1),
          direction: 'desc',
        });
      } else {
        sorts.push({
          field: trimmed,
          direction: 'asc',
        });
      }
    }

    // Add default sort if configured
    if (this.config.includeIdInSort && this.config.defaultSort) {
      const hasIdSort = sorts.some((s) => s.field === this.config.defaultSort?.field);
      if (!hasIdSort) {
        sorts.push({
          field: this.config.defaultSort.field,
          direction: this.config.defaultSort.direction,
        });
      }
    }

    return sorts;
  }

  // ============================================================================
  // LOGICAL OPERATORS
  // ============================================================================

  /**
   * Check if key is a logical operator
   */
  private isLogicalOperator(key: string): boolean {
    return ['and', 'or', 'not'].includes(key) || key.startsWith('not.');
  }

  /**
   * Handle logical operator
   */
  private handleLogicalOperator(key: string, value: string, builder: QueryBuilder): void {
    const filterGroup = this.parseLogicalCondition(key, value);

    if (filterGroup) {
      const query = builder.build();
      if (query.userFilter) {
        // Combine with existing filter using AND
        builder.setUserFilter({
          operator: 'and',
          nested: [query.userFilter as FilterGroup, filterGroup],
        });
      } else {
        builder.setUserFilter(filterGroup);
      }
    }
  }

  /**
   * Parse logical condition
   */
  private parseLogicalCondition(key: string, value: string): FilterGroup | null {
    const operator: LogicalOperator = key.startsWith('not.') ? 'not' : (key as LogicalOperator);

    // Remove outer parentheses
    let cleanValue = value.trim();
    if (cleanValue.startsWith('(') && cleanValue.endsWith(')')) {
      cleanValue = cleanValue.slice(1, -1);
    }

    // Parse conditions
    const conditionStrings = this.splitLogicalConditions(cleanValue);
    const conditions: FieldCondition[] = [];
    const nested: FilterGroup[] = [];

    for (const condStr of conditionStrings) {
      // Check for nested logical conditions
      if (condStr.startsWith('and=') || condStr.startsWith('or=')) {
        const nestedKey = condStr.substring(0, condStr.indexOf('='));
        const nestedValue = condStr.substring(condStr.indexOf('=') + 1);
        const nestedCondition = this.parseLogicalCondition(nestedKey, nestedValue);
        if (nestedCondition) {
          nested.push(nestedCondition);
        }
      } else {
        const fieldCondition = this.parseFieldCondition(condStr);
        if (fieldCondition) {
          conditions.push(fieldCondition);
        }
      }
    }

    if (conditions.length === 0 && nested.length === 0) {
      return null;
    }

    return {
      operator,
      conditions: conditions.length > 0 ? conditions : undefined,
      nested: nested.length > 0 ? nested : undefined,
    };
  }

  /**
   * Split logical conditions respecting nested parentheses
   */
  private splitLogicalConditions(value: string): string[] {
    const conditions: string[] = [];
    let current = '';
    let depth = 0;
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      if ((char === '"' || char === "'") && value[i - 1] !== '\\') {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
          quoteChar = '';
        }
        current += char;
      } else if (!inQuotes) {
        if (char === '(' || char === '[') {
          depth++;
          current += char;
        } else if (char === ')' || char === ']') {
          depth--;
          current += char;
        } else if (char === ',' && depth === 0) {
          if (current.trim()) {
            conditions.push(current.trim());
          }
          current = '';
        } else {
          current += char;
        }
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      conditions.push(current.trim());
    }

    return conditions;
  }

  // ============================================================================
  // FIELD FILTERS
  // ============================================================================

  /**
   * Handle filters parameter (semicolon-separated)
   */
  private handleFiltersParam(value: string, builder: QueryBuilder): void {
    const filters = value.split(';');

    for (const filter of filters) {
      const condition = this.parseFieldCondition(filter);
      if (condition) {
        const query = builder.build();
        if (query.userFilter) {
          builder.setUserFilter({
            operator: 'and',
            conditions: [...((query.userFilter as FilterGroup).conditions || []), condition],
          });
        } else {
          builder.setUserFilter({ operator: 'and', conditions: [condition] });
        }
      }
    }
  }

  /**
   * Handle single field filter
   */
  private handleFieldFilter(key: string, value: string, builder: QueryBuilder): void {
    const condition = this.parseFieldCondition(`${key}=${value}`);

    if (condition) {
      const query = builder.build();
      if (query.userFilter) {
        const existing = query.userFilter as FilterGroup;
        builder.setUserFilter({
          operator: 'and',
          conditions: [...(existing.conditions || []), condition],
          nested: existing.nested,
        });
      } else {
        builder.setUserFilter({ operator: 'and', conditions: [condition] });
      }
    }
  }

  /**
   * Parse field condition from string
   * Format: field=operator.value or field=value (eq implied)
   */
  private parseFieldCondition(conditionStr: string): FieldCondition | null {
    const eqIndex = conditionStr.indexOf('=');
    if (eqIndex === -1) return null;

    const field = conditionStr.substring(0, eqIndex);
    const afterEq = conditionStr.substring(eqIndex + 1);

    // Check for operator.value format
    const dotIndex = afterEq.indexOf('.');
    let operator: ComparisonOperator = 'eq';
    let valuePart = afterEq;

    if (dotIndex > 0) {
      const potentialOperator = afterEq.substring(0, dotIndex);
      if (this.isValidOperator(potentialOperator)) {
        operator = potentialOperator as ComparisonOperator;
        valuePart = afterEq.substring(dotIndex + 1);
      }
    }

    // Parse value
    const value = this.parseValue(valuePart, field);

    // Check for function call
    const functionValue = this.parseFunctionCall(valuePart);
    

    return {
      field,
      operator,
      value: functionValue || value,
    };
  }

  /**
   * Check if string is a valid operator
   */
  private isValidOperator(str: string): boolean {
    const operators: ComparisonOperator[] = [
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
      'in', 'nin', 'like', 'ilike', 'regex',
      'exists', 'null', 'notnull',
      'contains', 'startswith', 'endswith',
      'not_contains', 'not_startswith', 'not_endswith',
      'between', 'not_between',
    ];
    return operators.includes(str as ComparisonOperator);
  }

  /**
   * Parse value from string
   */
  private parseValue(valueStr: string, fieldPath?: string): unknown {
  
    const trimmed = valueStr.trim();

    // Handle null
    if (trimmed === 'null') return null;

    // Handle boolean
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    // Handle array
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const arrayStr = trimmed.slice(1, -1);
      return arrayStr.split(',').map((v) => this.parseValue(v.trim(), fieldPath));
    }

    // handle id fields
    if (fieldPath && (fieldPath.startsWith('_id') || fieldPath === 'id')) {
      // convert to ObjectId if looks like a hex string
      if (ObjectId.isValid(trimmed)) {
        return new ObjectId(trimmed);
      }
    }

    // Handle integer
    if (/^\d+$/.test(trimmed)) {
      return parseInt(trimmed);
    }

    // Handle float
    if (/^\d+\.\d+$/.test(trimmed)) {
      return parseFloat(trimmed);
    }

    // Handle ISO date
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(trimmed)) {
      const date = new Date(trimmed);
      if (!isNaN(date.getTime())) return date;
    }

    // Handle quoted strings
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  }

  /**
   * Parse function call from string
   * Format: functionName(arg1, arg2, ...)
   */
  private parseFunctionCall(str: string): FunctionCall | null {
    const openIndex = str.indexOf('(');
    const closeIndex = str.lastIndexOf(')');

    if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
      return null;
    }

    const functionName = str.substring(0, openIndex);
    if (!functionName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionName)) {
      return null;
    }

    const argsStr = str.substring(openIndex + 1, closeIndex);
    const args = this.parseFunctionArgs(argsStr);

    return {
      functionName,
      args,
    };
  }

  /**
   * Parse function arguments
   */
  private parseFunctionArgs(argsStr: string): unknown[] {
    if (!argsStr.trim()) return [];

    const args: unknown[] = [];
    let current = '';
    let depth = 0;
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < argsStr.length; i++) {
      const char = argsStr[i];

      if ((char === '"' || char === "'") && argsStr[i - 1] !== '\\') {
        if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar) {
          inQuotes = false;
          quoteChar = '';
        }
        current += char;
      } else if (!inQuotes) {
        if (char === '(') {
          depth++;
          current += char;
        } else if (char === ')') {
          depth--;
          current += char;
        } else if (char === ',' && depth === 0) {
          const trimmed = current.trim();
          const nested = this.parseFunctionCall(trimmed);
          args.push(nested || this.parseValue(trimmed));
          current = '';
        } else {
          current += char;
        }
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      const trimmed = current.trim();
      const nested = this.parseFunctionCall(trimmed);
      args.push(nested || this.parseValue(trimmed));
    }

    return args;
  }

  // ============================================================================
  // DEFAULTS
  // ============================================================================

  /**
   * Apply default values
   */
  private applyDefaults(builder: QueryBuilder): void {
    const query = builder.build();

    // Apply default limit if not set
    if (!query.pagination?.limit) {
      builder.paginate(this.config.defaultLimit);
    }

    // Apply default sort if no sort specified and configured
    if ((!query.sort || query.sort.length === 0) && this.config.defaultSort) {
      builder.orderBy(this.config.defaultSort.field, this.config.defaultSort.direction);
    }
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new query converter
 */
export function createQueryConverter(
  config?: QueryConfig,
  relationshipResolver?: IRelationshipResolver
): QueryConverter {
  return new QueryConverter(config, relationshipResolver);
}
