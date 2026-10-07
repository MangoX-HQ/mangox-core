/**
 * Core V2 - REST API Adapter Types
 */

// ============================================================================
// CAPABILITIES
// ============================================================================

/**
 * Declares what the target API supports.
 * Features not supported must NOT be silently compensated — throw RestCapabilityError.
 */
export interface RestAdapterCapabilities {
  /** Supports dynamic filter params (e.g. status=eq."active") */
  filter: boolean;
  /** Supports field projection (e.g. ?select=title,slug) */
  select: boolean;
  /** Supports sorting (e.g. ?order=-created_at) */
  sort: boolean;
  /** Supports pagination (e.g. ?limit=10&offset=0) */
  pagination: boolean;
}

export const CORE_CAPABILITIES: RestAdapterCapabilities = {
  filter: true,
  select: true,
  sort: true,
  pagination: true,
};

export const UNKNOWN_API_CAPABILITIES: RestAdapterCapabilities = {
  filter: false,
  select: false,
  sort: false,
  pagination: false,
};

// ============================================================================
// AUTH CONFIG
// ============================================================================

export type RestAuthType = 'bearer' | 'apikey' | 'basic' | 'none';

export interface RestAuthConfig {
  type: RestAuthType;
  token?: string;           // bearer / apikey
  username?: string;        // basic auth
  password?: string;        // basic auth
  headerName?: string;      // apikey header name (default: 'X-API-Key')
}

// ============================================================================
// ADAPTER CONFIG
// ============================================================================

export interface RestAdapterConfig {
  type: 'rest';
  /** Base URL of the target API (e.g. https://core-b/api/v1) */
  baseUrl: string;
  /** Auth config */
  auth?: RestAuthConfig;
  /** Request timeout in ms (default: 5000) */
  timeout?: number;
  /** Retry count on network error (default: 1) */
  retries?: number;
  /** What the target API supports */
  capabilities?: Partial<RestAdapterCapabilities>;
  /**
   * Fallback behavior when the target is unavailable.
   * - 'fail': throw error (default)
   * - 'empty': return empty data
   */
  fallback?: 'fail' | 'empty';
  /**
   * Map collection name → actual API path segment.
   * e.g. { 'user': 'users', 'order': 'v2/orders' }
   * Default: use collection name as-is.
   */
  endpointMap?: Record<string, string>;
  /**
   * Response shape mapping (for non-Core APIs).
   * e.g. { dataKey: 'items', countKey: 'total' }
   * Default: { dataKey: 'data', countKey: 'count' }
   */
  responseMapping?: {
    dataKey: string;
    countKey: string;
    paginationKey?: string;
  };
  /**
   * Additional fixed headers sent with every request.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Forward the end-user token from the incoming request
   * instead of using the configured service token.
   * Requires the user token to be injected into context.
   */
  forwardUserToken?: boolean;
}

// ============================================================================
// NATIVE QUERY (HTTP request descriptor)
// ============================================================================

export interface RestNativeQuery {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  params?: Record<string, string>;
  body?: unknown;
  headers: Record<string, string>;
}
