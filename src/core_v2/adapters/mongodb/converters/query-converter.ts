/**
 * Core V2 - MongoDB Query Converter
 * Converts IntermediateQuery to MongoDB aggregation pipeline or CRUD operations
 */

import { Document } from 'mongodb';
import { IntermediateQuery, SortClause, SelectClause, JoinClause } from '../../../query/intermediate';
import { IQueryConverter } from '../../../interfaces/adapter.interface';
import { MongoDBNativeQuery, MongoDBOperation, MongoDBPipeline } from '../types';
import { MongoDBFilterConverter, convertSecurityFilters } from './filter-converter';
import { MongoDBJoinConverter } from './join-converter';
import { IRelationshipRegistry } from '../../../interfaces/adapter.interface';

/** Merge securityFilters (AND conditions) + securityFilterGroups (each group OR/AND, ANDed together). */
function buildSecurityMatch(query: IntermediateQuery): Document {
  const parts: Document[] = [];
  if (query.securityFilters && query.securityFilters.length > 0) {
    const m = convertSecurityFilters(query.securityFilters);
    if (Object.keys(m).length > 0) parts.push(m);
  }
  if (query.securityFilterGroups && query.securityFilterGroups.length > 0) {
    for (const g of query.securityFilterGroups) {
      const m = MongoDBFilterConverter.convert(g);
      if (Object.keys(m).length > 0) parts.push(m);
    }
  }
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

// ============================================================================
// MONGODB QUERY CONVERTER
// ============================================================================

/**
 * MongoDB Query Converter
 * Converts IntermediateQuery to MongoDB native query format
 */
export class MongoDBQueryConverter implements IQueryConverter<MongoDBNativeQuery> {
  private joinConverter: MongoDBJoinConverter;

  constructor(relationshipRegistry: IRelationshipRegistry) {
    this.joinConverter = new MongoDBJoinConverter(relationshipRegistry);
  }

  /**
   * Convert intermediate query to MongoDB native query
   */
  async convert(query: IntermediateQuery): Promise<MongoDBNativeQuery> {
    switch (query.type) {
      case 'insert':
        return this.convertInsert(query);

      case 'update':
        return this.convertUpdate(query, false);

      case 'updateMany':
        return this.convertUpdate(query, true);

      case 'delete':
        return this.convertDelete(query, false);

      case 'deleteMany':
        return this.convertDelete(query, true);

      case 'bulkUpdate':
        return this.convertBulkUpdate(query);

      case 'read':
      default:
        return await this.convertRead(query);
    }
  }

  // ============================================================================
  // READ QUERY (Aggregation Pipeline)
  // ============================================================================

  /**
   * Convert read query to aggregation pipeline
   */
  private async convertRead(query: IntermediateQuery): Promise<MongoDBPipeline> {
    const pipeline: Document[] = [];

    // 1. Security filters first (cannot be bypassed)
    {
      const securityMatch = buildSecurityMatch(query);
      if (Object.keys(securityMatch).length > 0) {
        pipeline.push({ $match: securityMatch });
      }
    }

    // 2. User filters
    if (query.userFilter) {
      const userMatch = MongoDBFilterConverter.convert(query.userFilter);
      if (Object.keys(userMatch).length > 0) {
        pipeline.push({ $match: userMatch });
      }
    }

    // 3. Sort
    if (query.sort && query.sort.length > 0) {
      const sortStage = this.buildSort(query.sort);
      pipeline.push({ $sort: sortStage });
    }

    // 4. Pagination
    if (query.pagination) {
      if (query.pagination.offset && query.pagination.offset > 0) {
        pipeline.push({ $skip: query.pagination.offset });
      }
      if (query.pagination.limit && query.pagination.limit > 0) {
        pipeline.push({ $limit: query.pagination.limit });
      }
    }

    // 5. Joins (lookups)
    if (query.joins && query.joins.length > 0) {
      const lookupStages = await this.joinConverter.convert(
        query.joins,
        query.collection,
        query.metadata?.user
      );
      pipeline.push(...lookupStages);
    }

    // 6. Projection
    if (query.select) {
      const projectionStages = this.buildProjection(query.select);
      for (const stage of projectionStages) {
        if (Object.keys(stage).length > 0) {
          pipeline.push({ $project: stage });
        }
      }
    }

    return pipeline;
  }

  // ============================================================================
  // WRITE QUERIES
  // ============================================================================

  /**
   * Convert insert query
   */
  private convertInsert(query: IntermediateQuery): MongoDBOperation {
    return {
      operation: 'insertOne',
      document: query.data || {},
    };
  }

  /**
   * Convert update query
   */
  private convertUpdate(query: IntermediateQuery, many: boolean): MongoDBOperation {
    // Build filter from security filters
    const match: Document[] = [];
    {
      const securityMatch = buildSecurityMatch(query);
      if (Object.keys(securityMatch).length > 0) {
        match.push(securityMatch);
      }
    }
    if (query.userFilter) {
      const userMatch = MongoDBFilterConverter.convert(query.userFilter);
      if (Object.keys(userMatch).length > 0) {
        match.push(userMatch);
      }
    }

    const filter: Document = match.length > 1 ? { $and: match } : (match[0] || {});


    // Prepare update document
    const updateDoc = query.data || {};

    return {
      operation: many ? 'updateMany' : (query.options?.partial ? 'updateOne' : 'replaceOne'),
      filter,
      update: updateDoc,
      document: updateDoc,
    };
  }

  /**
   * Convert delete query
   */
  private convertDelete(query: IntermediateQuery, many: boolean): MongoDBOperation {
    
    const match: Document[] = [];
    {
      const securityMatch = buildSecurityMatch(query);
      if (Object.keys(securityMatch).length > 0) {
        match.push(securityMatch);
      }
    }
    if (query.userFilter) {
      const userMatch = MongoDBFilterConverter.convert(query.userFilter);
      if (Object.keys(userMatch).length > 0) {
        match.push(userMatch);
      }
    }

    const filter: Document = match.length > 1 ? { $and: match } : (match[0] || {});

    return {
      operation: many ? 'deleteMany' : 'deleteOne',
      filter,
    };
  }
  

  /**
   * Convert bulk update query
   */
  private convertBulkUpdate(query: IntermediateQuery): MongoDBOperation {
    const documents = Array.isArray(query.data)
      ? query.data
      : query.data
        ? [query.data]
        : [];
    return {
      operation: 'bulkWrite',
      documents: documents as Document[],
    };
  }

  // ============================================================================
  // CONVERSION HELPERS
  // ============================================================================

  /**
   * Convert filters (public interface method)
   */
  convertFilters(query: IntermediateQuery): Document {
    let filters: Document = {};

    // Security filters (+ groups OR)
    filters = buildSecurityMatch(query);

    // User filters
    if (query.userFilter) {
      const userFilters = MongoDBFilterConverter.convert(query.userFilter);
      if (Object.keys(filters).length > 0 && Object.keys(userFilters).length > 0) {
        filters = { $and: [filters, userFilters] };
      } else if (Object.keys(userFilters).length > 0) {
        filters = userFilters;
      }
    }

    return filters;
  }

  /**
   * Convert projection (public interface method)
   */
  convertProjection(query: IntermediateQuery): Document[] {
    const select = query.select;
    if (!select) {
      return [{}, { password: 0 }];
    }
    return this.buildProjection(select);
  }

  /**
   * Internal: Build projection from SelectClause
   */
  private buildProjection(select: SelectClause): Document[] {
    const projectionInclude: Document = {};
    const projectionExclude: Document = {};

    // Handle include fields
    if (select.include && select.include.length > 0) {
      // Check for wildcard
      if (select.include.includes('*')) {
        // Just exclude password for safety
        projectionExclude.password = 0;
        return [projectionInclude, projectionExclude];
      }

      for (const field of select.include) {
        projectionInclude[field] = 1;
      }
    }

    // Handle exclude fields
    if (select.exclude && select.exclude.length > 0) {
      for (const field of select.exclude) {
        projectionExclude[field] = 0;
      }
    }

    // Always exclude password
    projectionExclude.password = 0;

    return [projectionInclude, projectionExclude];
  }

  /**
   * Convert sort (public interface method)
   */
  convertSort(query: IntermediateQuery): Document {
    const sorts = query.sort;
    if (!sorts || sorts.length === 0) {
      return {};
    }
    return this.buildSort(sorts);
  }

  /**
   * Internal: Build sort from SortClause[]
   */
  private buildSort(sorts: SortClause[]): Document {
    const sortDoc: Document = {};

    for (const sort of sorts) {
      sortDoc[sort.field] = sort.direction === 'desc' ? -1 : 1;
    }

    return sortDoc;
  }

  /**
   * Convert joins (public interface method)
   */
  convertJoins(query: IntermediateQuery): Document[] {
    // This is handled by joinConverter.convert()
    // For sync interface compliance, return empty
    return [];
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Flatten nested object for $set operations
   * Converts { a: { b: 1 } } to { 'a.b': 1 }
   */
  flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;

      // Skip special keys that should not be flattened
      if (['_id', 'json_schema', 'ui_schema', 'blocks_position'].includes(key)) {
        result[newKey] = value;
        continue;
      }

      // Check if value is a plain object (not array, date, objectid, etc)
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        value.constructor === Object
      ) {
        Object.assign(result, this.flattenObject(value as Record<string, unknown>, newKey));
      } else {
        result[newKey] = value;
      }
    }

    return result;
  }

  /**
   * Prepare document for update (flatten if needed)
   */
  prepareUpdateDocument(doc: Record<string, unknown>, partial: boolean): Document {
    if (!partial) {
      return doc;
    }

    const flattened = this.flattenObject(doc);
    return { $set: flattened };
  }
}

/**
 * Create a new MongoDB query converter
 */
export function createMongoDBQueryConverter(
  relationshipRegistry: IRelationshipRegistry
): MongoDBQueryConverter {
  return new MongoDBQueryConverter(relationshipRegistry);
}
