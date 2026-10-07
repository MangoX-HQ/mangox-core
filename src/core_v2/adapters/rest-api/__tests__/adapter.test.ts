/**
 * Tests for RestApiAdapter
 * Covers: initialization, executeQuery (read/write/error), fallback, response normalization
 */

import { RestApiAdapter, RestApiError } from '../adapter';
import { IntermediateQuery } from '../../../query/intermediate';
import { RestNativeQuery } from '../types';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function mockOkResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function mockErrorResponse(status: number, body: unknown = {}) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => body,
  });
}

function mockNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error('Network error'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeAdapter(overrides: Record<string, unknown> = {}): Promise<RestApiAdapter> {
  const adapter = new RestApiAdapter();
  await adapter.initialize({
    type: 'rest' as any,
    baseUrl: 'https://core-b/api/v1',
    ...overrides,
  } as any);
  return adapter;
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

function makeNativeQuery(overrides: Partial<RestNativeQuery> = {}): RestNativeQuery {
  return {
    method: 'GET',
    url: 'https://core-b/api/v1/user',
    headers: { 'Content-Type': 'application/json' },
    ...overrides,
  };
}

beforeEach(() => mockFetch.mockClear());

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

describe('initialization', () => {
  it('initializes successfully with baseUrl', async () => {
    const adapter = new RestApiAdapter();
    await adapter.initialize({ type: 'rest' as any, baseUrl: 'https://core-b/api/v1' } as any);
    expect(adapter.initialized).toBe(true);
  });

  it('throws when baseUrl is missing', async () => {
    const adapter = new RestApiAdapter();
    await expect(adapter.initialize({ type: 'rest' as any } as any)).rejects.toThrow('baseUrl is required');
  });

  it('disposes and sets initialized = false', async () => {
    const adapter = await makeAdapter();
    await adapter.dispose();
    expect(adapter.initialized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeQuery — READ
// ---------------------------------------------------------------------------

describe('executeQuery — read', () => {
  it('returns normalized data and count', async () => {
    const adapter = await makeAdapter();
    mockOkResponse({ data: [{ _id: '1', name: 'Alice' }], count: 1 });

    const result = await adapter.executeQuery('user', makeReadQuery(), makeNativeQuery());

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ _id: '1', name: 'Alice' });
    expect(result.count).toBe(1);
    expect(result.statusCode).toBe(200);
  });

  it('falls back to data.length when count missing', async () => {
    const adapter = await makeAdapter();
    mockOkResponse({ data: [{ _id: '1' }, { _id: '2' }] });

    const result = await adapter.executeQuery('user', makeReadQuery(), makeNativeQuery());
    expect(result.count).toBe(2);
  });

  it('uses custom responseMapping keys', async () => {
    const adapter = await makeAdapter({
      responseMapping: { dataKey: 'items', countKey: 'total' },
    });
    mockOkResponse({ items: [{ _id: '1' }], total: 99 });

    const result = await adapter.executeQuery('user', makeReadQuery(), makeNativeQuery());
    expect(result.data).toHaveLength(1);
    expect(result.count).toBe(99);
  });

  it('forwards pagination from response', async () => {
    const adapter = await makeAdapter();
    mockOkResponse({
      data: [],
      count: 0,
      pagination: { current_page: 2, last_page: 5, total: 100, hasMore: true },
    });

    const result = await adapter.executeQuery('user', makeReadQuery(), makeNativeQuery());
    expect(result.pagination?.current_page).toBe(2);
    expect(result.pagination?.last_page).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// executeQuery — WRITE
// ---------------------------------------------------------------------------

describe('executeQuery — insert', () => {
  it('returns created item', async () => {
    const adapter = await makeAdapter();
    mockOkResponse({ data: { _id: 'new-1', name: 'Alice' } });

    const query: IntermediateQuery = {
      type: 'insert',
      collection: 'user',
      data: { name: 'Alice' },
      securityFilters: [],
      metadata: { user: { user_id: 'test', roles: ['admin'] }, source: 'test' },
    };

    const result = await adapter.executeQuery(
      'user',
      query,
      makeNativeQuery({ method: 'POST', url: 'https://core-b/api/v1/user' }),
    );

    expect(result.data[0]).toMatchObject({ _id: 'new-1', name: 'Alice' });
  });
});

describe('executeQuery — delete', () => {
  it('returns empty data with deletedCount', async () => {
    const adapter = await makeAdapter();
    mockOkResponse({ deletedCount: 3 });

    const query: IntermediateQuery = {
      type: 'deleteMany',
      collection: 'user',
      securityFilters: [],
      metadata: { user: { user_id: 'test', roles: ['admin'] }, source: 'test' },
    };

    const result = await adapter.executeQuery(
      'user',
      query,
      makeNativeQuery({ method: 'DELETE' }),
    );

    expect(result.data).toHaveLength(0);
    expect((result.metadata as any).deletedCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('throws RestApiError on 4xx response', async () => {
    const adapter = await makeAdapter();
    mockErrorResponse(404, { error: 'Not found' });

    await expect(
      adapter.executeQuery('user', makeReadQuery(), makeNativeQuery())
    ).rejects.toThrow(RestApiError);
  });

  it('RestApiError has statusCode', async () => {
    const adapter = await makeAdapter();
    mockErrorResponse(403, { error: 'Forbidden' });

    try {
      await adapter.executeQuery('user', makeReadQuery(), makeNativeQuery());
    } catch (err) {
      expect(err).toBeInstanceOf(RestApiError);
      expect((err as RestApiError).statusCode).toBe(403);
    }
  });

  it('throws on network error when fallback = fail', async () => {
    const adapter = await makeAdapter({ fallback: 'fail' });
    mockNetworkError();

    await expect(
      adapter.executeQuery('user', makeReadQuery(), makeNativeQuery())
    ).rejects.toThrow();
  });

  it('returns empty result on network error when fallback = empty', async () => {
    const adapter = await makeAdapter({ fallback: 'empty', retries: 0 });
    mockNetworkError();

    const result = await adapter.executeQuery('user', makeReadQuery(), makeNativeQuery());
    expect(result.data).toHaveLength(0);
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe('healthCheck', () => {
  it('returns true when /health responds 200', async () => {
    const adapter = await makeAdapter();
    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(await adapter.healthCheck()).toBe(true);
  });

  it('returns false when /health responds 500', async () => {
    const adapter = await makeAdapter();
    mockFetch.mockResolvedValueOnce({ ok: false });
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('returns false on network error', async () => {
    const adapter = await makeAdapter();
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    expect(await adapter.healthCheck()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateQuery
// ---------------------------------------------------------------------------

describe('validateQuery', () => {
  it('returns valid for correct query', async () => {
    const adapter = await makeAdapter();
    const result = adapter.validateQuery(makeReadQuery());
    expect(result.valid).toBe(true);
  });

  it('returns invalid when collection is missing', async () => {
    const adapter = await makeAdapter();
    const result = adapter.validateQuery(makeReadQuery({ collection: '' }));
    expect(result.valid).toBe(false);
  });
});
