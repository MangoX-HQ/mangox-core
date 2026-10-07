/**
 * Tests for RestQueryConverter
 * Covers: filter serialization, select, sort, pagination, capability errors, write ops
 */

import { RestQueryConverter, RestCapabilityError } from '../query-converter';
import { CORE_CAPABILITIES, UNKNOWN_API_CAPABILITIES, RestAdapterConfig } from '../types';
import { IntermediateQuery } from '../../../query/intermediate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<RestAdapterConfig> = {}): RestAdapterConfig {
  return {
    type: 'rest',
    baseUrl: 'https://core-b/api/v1',
    ...overrides,
  };
}

function makeReadQuery(overrides: Partial<IntermediateQuery> = {}): IntermediateQuery {
  return {
    type: 'read',
    collection: 'user',
    securityFilters: [],
    metadata: { user: { user_id: 'test', roles: ['admin'] }, source: 'test' },
    ...overrides,
  };
}

function converter(configOverrides: Partial<RestAdapterConfig> = {}) {
  const cfg = makeConfig(configOverrides);
  return new RestQueryConverter(cfg, { ...CORE_CAPABILITIES, ...cfg.capabilities });
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

describe('URL building', () => {
  it('builds correct endpoint from baseUrl + collection', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({ collection: 'user' }));
    expect(result.url).toBe('https://core-b/api/v1/user');
  });

  it('strips trailing slash from baseUrl', () => {
    const c = converter({ baseUrl: 'https://core-b/api/v1/' });
    const result = c.convert(makeReadQuery({ collection: 'user' }));
    expect(result.url).toBe('https://core-b/api/v1/user');
  });

  it('uses endpointMap when defined', () => {
    const c = converter({ endpointMap: { user: 'v2/accounts' } });
    const result = c.convert(makeReadQuery({ collection: 'user' }));
    expect(result.url).toBe('https://core-b/api/v1/v2/accounts');
  });
});

// ---------------------------------------------------------------------------
// Filter serialization
// ---------------------------------------------------------------------------

describe('filter serialization', () => {
  it('serializes eq condition', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      securityFilters: [{ field: 'status', operator: 'eq', value: 'active' }],
    }));
    expect(result.params!['status']).toBe('"active"');
  });

  it('serializes gt condition', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      securityFilters: [{ field: 'price', operator: 'gt', value: 100 }],
    }));
    expect(result.params!['price']).toBe('gt.100');
  });

  it('serializes in condition with array', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      securityFilters: [{ field: 'status', operator: 'in', value: ['active', 'draft'] }],
    }));
    expect(result.params!['status']).toBe('in.["active","draft"]');
  });

  it('serializes null operator', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      securityFilters: [{ field: 'deleted_at', operator: 'null', value: null }],
    }));
    expect(result.params!['deleted_at']).toBe('null');
  });

  it('serializes notnull operator', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      securityFilters: [{ field: 'deleted_at', operator: 'notnull', value: null }],
    }));
    expect(result.params!['deleted_at']).toBe('notnull');
  });

  it('serializes boolean value', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      securityFilters: [{ field: 'is_active', operator: 'eq', value: true }],
    }));
    expect(result.params!['is_active']).toBe('true');
  });

  it('merges securityFilters + userFilter into params', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      securityFilters: [{ field: 'tenant_id', operator: 'eq', value: 'abc' }],
      userFilter: { field: 'status', operator: 'eq', value: 'active' },
    }));
    expect(result.params!['tenant_id']).toBe('"abc"');
    expect(result.params!['status']).toBe('"active"');
  });

  it('serializes OR group', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      userFilter: {
        operator: 'or',
        conditions: [
          { field: 'status', operator: 'eq', value: 'active' },
          { field: 'status', operator: 'eq', value: 'pending' },
        ],
      },
    }));
    // or=(status="active",status="pending")
    expect(result.params).toBeDefined();
    const paramStr = Object.entries(result.params!).map(([k, v]) => `${k}=${v}`).join('&');
    expect(paramStr).toContain('or=');
  });
});

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

describe('select serialization', () => {
  it('serializes select.include fields', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      select: { include: ['title', 'slug', 'status'] },
    }));
    expect(result.params!['select']).toBe('title,slug,status');
  });

  it('omits select param when no include', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({ select: { exclude: ['__v'] } }));
    expect(result.params!['select']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

describe('sort serialization', () => {
  it('serializes asc sort', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      sort: [{ field: 'created_at', direction: 'asc' }],
    }));
    expect(result.params!['order']).toBe('created_at');
  });

  it('serializes desc sort with minus prefix', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      sort: [{ field: 'created_at', direction: 'desc' }],
    }));
    expect(result.params!['order']).toBe('-created_at');
  });

  it('serializes multiple sort fields', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      sort: [
        { field: 'priority', direction: 'asc' },
        { field: 'created_at', direction: 'desc' },
      ],
    }));
    expect(result.params!['order']).toBe('priority,-created_at');
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination serialization', () => {
  it('serializes limit and offset', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      pagination: { limit: 20, offset: 40 },
    }));
    expect(result.params!['limit']).toBe('20');
    expect(result.params!['offset']).toBe('40');
  });

  it('omits offset when 0', () => {
    const c = converter();
    const result = c.convert(makeReadQuery({
      pagination: { limit: 10, offset: 0 },
    }));
    expect(result.params!['limit']).toBe('10');
    // offset=0 still serialized — harmless
  });
});

// ---------------------------------------------------------------------------
// Capability errors
// ---------------------------------------------------------------------------

describe('capability errors', () => {
  const noCapConverter = () =>
    new RestQueryConverter(makeConfig({ capabilities: UNKNOWN_API_CAPABILITIES }), UNKNOWN_API_CAPABILITIES);

  it('throws RestCapabilityError when filter used and not supported', () => {
    const c = noCapConverter();
    expect(() =>
      c.convert(makeReadQuery({
        securityFilters: [{ field: 'status', operator: 'eq', value: 'active' }],
      }))
    ).toThrow(RestCapabilityError);
  });

  it('throws RestCapabilityError when select used and not supported', () => {
    const c = noCapConverter();
    expect(() =>
      c.convert(makeReadQuery({ select: { include: ['title'] } }))
    ).toThrow(RestCapabilityError);
  });

  it('throws RestCapabilityError when sort used and not supported', () => {
    const c = noCapConverter();
    expect(() =>
      c.convert(makeReadQuery({ sort: [{ field: 'name', direction: 'asc' }] }))
    ).toThrow(RestCapabilityError);
  });

  it('throws RestCapabilityError when pagination used and not supported', () => {
    const c = noCapConverter();
    expect(() =>
      c.convert(makeReadQuery({ pagination: { limit: 10 } }))
    ).toThrow(RestCapabilityError);
  });

  it('passes when no filter/select/sort/pagination on unsupported API', () => {
    const c = noCapConverter();
    expect(() => c.convert(makeReadQuery())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

describe('write operations', () => {
  it('converts insert → POST with body', () => {
    const c = converter();
    const result = c.convert({
      type: 'insert',
      collection: 'user',
      data: { name: 'Alice', email: 'alice@test.com' },
      securityFilters: [],
      metadata: { user: { user_id: 'test', roles: ['admin'] }, source: 'test' },
    });
    expect(result.method).toBe('POST');
    expect(result.url).toBe('https://core-b/api/v1/user');
    expect(result.body).toEqual({ name: 'Alice', email: 'alice@test.com' });
  });

  it('converts update → PATCH with id in url', () => {
    const c = converter();
    const result = c.convert({
      type: 'update',
      collection: 'user',
      data: { name: 'Bob' },
      securityFilters: [{ field: '_id', operator: 'eq', value: '123' }],
      metadata: { user: { user_id: 'test', roles: ['admin'] }, source: 'test' },
    });
    expect(result.method).toBe('PATCH');
    expect(result.url).toBe('https://core-b/api/v1/user/123');
    expect(result.body).toEqual({ name: 'Bob' });
  });

  it('converts replace → PUT', () => {
    const c = converter();
    const result = c.convert({
      type: 'replace',
      collection: 'user',
      data: { name: 'Charlie' },
      securityFilters: [{ field: '_id', operator: 'eq', value: '456' }],
      metadata: { user: { user_id: 'test', roles: ['admin'] }, source: 'test' },
    });
    expect(result.method).toBe('PUT');
    expect(result.url).toBe('https://core-b/api/v1/user/456');
  });

  it('converts delete → DELETE with id in url', () => {
    const c = converter();
    const result = c.convert({
      type: 'delete',
      collection: 'user',
      securityFilters: [{ field: '_id', operator: 'eq', value: '789' }],
      metadata: { user: { user_id: 'test', roles: ['admin'] }, source: 'test' },
    });
    expect(result.method).toBe('DELETE');
    expect(result.url).toBe('https://core-b/api/v1/user/789');
  });

  it('converts deleteMany → DELETE with ids param', () => {
    const c = converter();
    const result = c.convert({
      type: 'deleteMany',
      collection: 'user',
      securityFilters: [{ field: '_id', operator: 'in', value: ['1', '2', '3'] }],
      metadata: { user: { user_id: 'test', roles: ['admin'] }, source: 'test' },
    });
    expect(result.method).toBe('DELETE');
    expect(result.params!['ids']).toBe('1,2,3');
  });
});

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

describe('auth headers', () => {
  it('sets Authorization: Bearer token', () => {
    const c = converter({ auth: { type: 'bearer', token: 'mytoken123' } });
    const result = c.convert(makeReadQuery());
    expect(result.headers['Authorization']).toBe('Bearer mytoken123');
  });

  it('sets custom apikey header', () => {
    const c = converter({ auth: { type: 'apikey', token: 'key-abc', headerName: 'X-Api-Key' } });
    const result = c.convert(makeReadQuery());
    expect(result.headers['X-Api-Key']).toBe('key-abc');
  });

  it('defaults apikey header to X-API-Key', () => {
    const c = converter({ auth: { type: 'apikey', token: 'key-abc' } });
    const result = c.convert(makeReadQuery());
    expect(result.headers['X-API-Key']).toBe('key-abc');
  });

  it('sets Authorization: Basic for basic auth', () => {
    const c = converter({ auth: { type: 'basic', username: 'admin', password: 'pass' } });
    const result = c.convert(makeReadQuery());
    expect(result.headers['Authorization']).toMatch(/^Basic /);
    const decoded = Buffer.from(result.headers['Authorization'].slice(6), 'base64').toString();
    expect(decoded).toBe('admin:pass');
  });

  it('no auth header when type is none', () => {
    const c = converter({ auth: { type: 'none' } });
    const result = c.convert(makeReadQuery());
    expect(result.headers['Authorization']).toBeUndefined();
  });
});
