/**
 * Core V2 - REST Query Converter
 * Converts IntermediateQuery → MongoREST-style HTTP request params.
 * This is essentially the reverse of QueryConverter (URL params → IntermediateQuery).
 */

import {
  IntermediateQuery,
  FieldCondition,
  FilterGroup,
  Filter,
  isFieldCondition,
  isFilterGroup,
  SelectClause,
  SortClause,
} from '../../query/intermediate';
import { PaginationOptions } from '../../types';
import { RestAdapterCapabilities, RestAdapterConfig, RestNativeQuery } from './types';

// ============================================================================
// ERRORS
// ============================================================================

export class RestCapabilityError extends Error {
  constructor(collection: string, feature: string) {
    super(
      `Collection '${collection}' is backed by a REST adapter that does not support '${feature}'. ` +
      `Remove the ${feature} from your query or use a capable collection.`
    );
    this.name = 'RestCapabilityError';
  }
}

// ============================================================================
// FILTER SERIALIZATION (IntermediateQuery filters → MongoREST params)
// ============================================================================

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const items = value.map((v) =>
      typeof v === 'string' ? `"${v}"` : String(v)
    );
    return `[${items.join(',')}]`;
  }
  // String — wrap in quotes
  return `"${value}"`;
}

function serializeCondition(cond: FieldCondition): string {
  const { field, operator, value } = cond;

  // Operators with no value
  if (operator === 'null') return `${field}=null`;
  if (operator === 'notnull') return `${field}=notnull`;
  if (operator === 'exists') return `${field}=exists`;

  // eq shorthand (omit operator)
  if (operator === 'eq') return `${field}=${serializeValue(value)}`;

  return `${field}=${operator}.${serializeValue(value)}`;
}

/**
 * Serialize a Filter (FieldCondition | FieldCondition[] | FilterGroup) to MongoREST.
 *
 * AND group at root → joined with &
 * OR group → or=(cond1,cond2)
 * Nested AND → and=(cond1,cond2)
 */
function serializeFilter(filter: Filter): string {
  if (Array.isArray(filter)) {
    return filter.map(serializeCondition).join('&');
  }

  if (isFilterGroup(filter)) {
    const parts = [
      ...(filter.conditions || []).map(serializeCondition),
      ...(filter.nested || []).map(serializeFilter),
    ].filter(Boolean);

    if (parts.length === 0) return '';
    if (filter.operator === 'and') {
      // Root AND → flat & join (callers handle top-level)
      return parts.join('&');
    }
    // or / not
    return `${filter.operator}=(${parts.join(',')})`;
  }

  if (isFieldCondition(filter)) {
    return serializeCondition(filter);
  }

  return '';
}

// ============================================================================
// SELECT SERIALIZATION
// ============================================================================

function serializeSelect(select: SelectClause | undefined): string | null {
  if (!select) return null;
  if (select.include?.length) return select.include.join(',');
  // exclude is hard to represent in MongoREST — skip (Core B will return all fields)
  return null;
}

// ============================================================================
// SORT SERIALIZATION
// ============================================================================

function serializeSort(sort: SortClause[]): string {
  return sort
    .map((s) => (s.direction === 'desc' ? `-${s.field}` : s.field))
    .join(',');
}

// ============================================================================
// MAIN CONVERTER
// ============================================================================

export class RestQueryConverter {
  private config: RestAdapterConfig;
  private capabilities: RestAdapterCapabilities;

  constructor(config: RestAdapterConfig, capabilities: RestAdapterCapabilities) {
    this.config = config;
    this.capabilities = capabilities;
  }

  convert(query: IntermediateQuery): RestNativeQuery {
    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    
    const collection = this.config.endpointMap?.[query.collection] ?? query.collection;
    const endpoint = `${baseUrl}/${collection}`;
    const headers = this.buildHeaders();
    console.log("xxx", baseUrl, collection, endpoint, headers)
    switch (query.type) {
      case 'read':      return this.convertRead(query, endpoint, headers);
      case 'insert':    return this.convertInsert(query, endpoint, headers);
      case 'update':    return this.convertUpdate(query, endpoint, headers);
      case 'replace':   return this.convertUpdate(query, endpoint, headers);
      case 'delete':    return this.convertDelete(query, endpoint, headers);
      case 'deleteMany':return this.convertDeleteMany(query, endpoint, headers);
      default:
        throw new Error(`RestQueryConverter: unsupported query type '${query.type}'`);
    }
  }

  // --------------------------------------------------------------------------
  // READ
  // --------------------------------------------------------------------------

  private convertRead(
    query: IntermediateQuery,
    endpoint: string,
    headers: Record<string, string>,
  ): RestNativeQuery {
    const params: Record<string, string> = {};

    // --- Filters ---
    const allConditions: string[] = [];

    if (query.securityFilters?.length) {
      if (!this.capabilities.filter) {
        throw new RestCapabilityError(query.collection, 'filter (securityFilters)');
      }
      const sf = query.securityFilters.map(serializeCondition).join('&');
      if (sf) allConditions.push(sf);
    }
    if (query.securityFilterGroups?.length) {
      throw new RestCapabilityError(query.collection, 'filter (securityFilterGroups OR)');
    }

    if (query.userFilter) {
      if (!this.capabilities.filter) {
        throw new RestCapabilityError(query.collection, 'filter');
      }
      const uf = serializeFilter(query.userFilter);
      if (uf) allConditions.push(uf);
    }

    if (allConditions.length) {
      // Merge all filter parts into params
      const combined = allConditions.join('&');
      combined.split('&').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx > 0) {
          const k = part.slice(0, idx);
          const v = part.slice(idx + 1);
          params[k] = v;
        }
      });
    }

    // --- Select ---
    if (query.select) {
      if (!this.capabilities.select) {
        throw new RestCapabilityError(query.collection, 'select');
      }
      const sel = serializeSelect(query.select);
      if (sel) params['select'] = sel;
    }

    // --- Sort ---
    if (query.sort?.length) {
      if (!this.capabilities.sort) {
        throw new RestCapabilityError(query.collection, 'sort');
      }
      params['order'] = serializeSort(query.sort);
    }

    // --- Pagination ---
    if (query.pagination) {
      if (!this.capabilities.pagination) {
        throw new RestCapabilityError(query.collection, 'pagination');
      }
      const p = query.pagination as PaginationOptions;
      if (p.limit !== undefined) params['limit'] = String(p.limit);
      if (p.offset !== undefined) params['offset'] = String(p.offset);
    }

    return { method: 'GET', url: endpoint, params, headers };
  }

  // --------------------------------------------------------------------------
  // INSERT
  // --------------------------------------------------------------------------

  private convertInsert(
    query: IntermediateQuery,
    endpoint: string,
    headers: Record<string, string>,
  ): RestNativeQuery {
    return { method: 'POST', url: endpoint, body: query.data, headers };
  }

  // --------------------------------------------------------------------------
  // UPDATE / REPLACE
  // --------------------------------------------------------------------------

  private convertUpdate(
    query: IntermediateQuery,
    endpoint: string,
    headers: Record<string, string>,
  ): RestNativeQuery {
    const id = this.extractId(query);
    const url = id ? `${endpoint}/${id}` : endpoint;
    const method = query.type === 'replace' ? 'PUT' : 'PATCH';
    return { method, url, body: query.data, headers };
  }

  // --------------------------------------------------------------------------
  // DELETE (single)
  // --------------------------------------------------------------------------

  private convertDelete(
    query: IntermediateQuery,
    endpoint: string,
    headers: Record<string, string>,
  ): RestNativeQuery {
    const id = this.extractId(query);
    const url = id ? `${endpoint}/${id}` : endpoint;
    return { method: 'DELETE', url, headers };
  }

  // --------------------------------------------------------------------------
  // DELETE MANY
  // --------------------------------------------------------------------------

  private convertDeleteMany(
    query: IntermediateQuery,
    endpoint: string,
    headers: Record<string, string>,
  ): RestNativeQuery {
    // Extract ids from securityFilters or userFilter
    const ids = this.extractIds(query);
    const params: Record<string, string> = ids.length
      ? { ids: ids.join(',') }
      : {};
    return { method: 'DELETE', url: endpoint, params, headers };
  }

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.extraHeaders,
    };

    const auth = this.config.auth;
    if (!auth || auth.type === 'none') return headers;

    switch (auth.type) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${auth.token}`;
        break;
      case 'apikey':
        headers[auth.headerName ?? 'X-API-Key'] = auth.token ?? '';
        break;
      case 'basic': {
        const creds = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        headers['Authorization'] = `Basic ${creds}`;
        break;
      }
    }

    return headers;
  }

  private extractId(query: IntermediateQuery): string | null {
    // Look for _id eq condition in securityFilters
    const idFilter = query.securityFilters?.find(
      (f) => (f.field === '_id' || f.field === 'id') && f.operator === 'eq'
    );
    return idFilter ? String(idFilter.value) : null;
  }

  private extractIds(query: IntermediateQuery): string[] {
    const idFilter = query.securityFilters?.find(
      (f) => (f.field === '_id' || f.field === 'id') && f.operator === 'in'
    );
    if (!idFilter || !Array.isArray(idFilter.value)) return [];
    return (idFilter.value as unknown[]).map(String);
  }
}
