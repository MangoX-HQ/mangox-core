/**
 * Core V2 - REST API Adapter
 * Implements IDatabaseAdapter to proxy queries to a remote REST API (Core-to-Core or third-party).
 */

import { IDatabaseAdapter } from '../../interfaces/adapter.interface';
import { AdapterConfig } from '../../config';
import { ValidationResult, DatabaseType } from '../../types';
import {
  IntermediateQuery,
  QueryResult,
  QueryResultMetadata,
} from '../../query/intermediate';
import {
  RestAdapterConfig,
  RestAdapterCapabilities,
  RestNativeQuery,
  CORE_CAPABILITIES,
} from './types';
import { RestQueryConverter } from './query-converter';

// ============================================================================
// ADAPTER
// ============================================================================

export class RestApiAdapter implements IDatabaseAdapter<null, RestNativeQuery> {
  readonly type: DatabaseType = 'rest' as DatabaseType;
  readonly name = 'REST API Adapter';

  private _initialized = false;

  get initialized() {
    return this._initialized;
  }

  // --------------------------------------------------------------------------
  // Lifecycle — config is now per-request (passed via IntermediateQuery.apiConfig)
  // --------------------------------------------------------------------------

  async initialize(_config: AdapterConfig): Promise<void> {
    // No-op — adapter is config-less. Per-request config flows through query.apiConfig
    // (resolved from entity.api_config slug → DB record by core-service).
    this._initialized = true;
  }

  /** Build a converter for a specific api-config record (per-request). */
  private converterFor(apiConfig: Record<string, any>): RestQueryConverter {
    const config = this.toRestConfig(apiConfig);
    const capabilities: RestAdapterCapabilities = {
      ...CORE_CAPABILITIES,
      ...(config.capabilities ?? {}),
    };
    return new RestQueryConverter(config, capabilities);
  }

  /** Map api-config record (DB shape) → RestAdapterConfig (internal). */
  private toRestConfig(record: Record<string, any>): RestAdapterConfig {
    return {
      type: 'rest',
      baseUrl: record.base_url,
      auth: record.auth,
      timeout: record.timeout,
      retries: record.retries,
      capabilities: record.capabilities,
      fallback: record.fallback,
      endpointMap: record.endpoint_map,
      responseMapping: record.response_mapping,
      extraHeaders: record.extra_headers,
      forwardUserToken: record.forward_user_token,
    } as RestAdapterConfig;
  }

  async getConnection(): Promise<null> {
    return null; // Stateless HTTP — no persistent connection
  }

  async dispose(): Promise<void> {
    this._initialized = false;
  }

  async healthCheck(): Promise<boolean> {
    return true; // Config-less adapter; per-request liveness checked by sendRequest
  }

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  validateQuery(query: IntermediateQuery): ValidationResult {
    if (!query.collection) {
      return { valid: false, errors: [{ field: 'collection', message: 'collection is required' }] };
    }
    if (!query.apiConfig) {
      return { valid: false, errors: [{ field: 'apiConfig', message: 'apiConfig is required for REST adapter' }] };
    }
    return { valid: true, errors: [] };
  }

  // --------------------------------------------------------------------------
  // Query Conversion
  // --------------------------------------------------------------------------

  async convertQuery(query: IntermediateQuery): Promise<RestNativeQuery> {
    if (!query.apiConfig) {
      throw new Error('[RestApiAdapter] convertQuery requires query.apiConfig');
    }
    return this.converterFor(query.apiConfig).convert(query);
  }

  // --------------------------------------------------------------------------
  // Query Execution
  // --------------------------------------------------------------------------

  async executeQuery<T = unknown>(
    collection: string,
    intermediateQuery: IntermediateQuery,
    nativeQuery: RestNativeQuery,
  ): Promise<QueryResult<T>> {
    const startTime = Date.now();
    const apiConfig = intermediateQuery.apiConfig;
    if (!apiConfig) {
      throw new Error('[RestApiAdapter] executeQuery requires query.apiConfig');
    }
    const restConfig = this.toRestConfig(apiConfig);

    try {
      const response = await this.sendRequest(nativeQuery, restConfig);

      // Detect binary file response (PPTX/PDF/zip/image/octet-stream/...). When the
      // remote API hands back a file, auto-upload it to media storage and return
      // a JSON envelope with the public URL — callers stay JSON-shaped.
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const contentDisp = response.headers.get('content-disposition') || '';
      const isJsonLike = contentType.includes('application/json') || contentType.startsWith('text/');
      const isAttachment = /attachment/i.test(contentDisp);
      if (!isJsonLike || isAttachment) {
              console.log("cc", response.ok)

        if (!response.ok) {
          // Read text for diagnostics on error responses.
          const errBody = await response.text();
          throw new RestApiError(response.status, errBody);
        }
        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const filename = this.parseFilename(contentDisp)
          ?? `${intermediateQuery.collection}-${Date.now()}.${this.extFromMime(contentType)}`;
        const tenantId = (intermediateQuery as any).tenant_id ?? undefined;
        const userId = (intermediateQuery as any).user_id ?? undefined;
        const { mediaMinioService } = await import('../../../module/_media/media-minio.service');
        const uploaded = await mediaMinioService.uploadBuffer(buffer, filename, contentType || 'application/octet-stream', tenantId, userId);
        return {
          statusCode: 200,
          data: [{
            url: uploaded.path,
            media_id: uploaded.id,
            filename: uploaded.objectName,
            size: uploaded.size,
            mime: uploaded.mimetype,
          }] as unknown as T[],
          count: 1,
          metadata: this.buildMeta(intermediateQuery, nativeQuery, startTime),
        };
      }

      const json = await response.json() as Record<string, unknown> | unknown[];
      console.log("cc1", response.ok)
      if (!response.ok) {
        throw new RestApiError(response.status, json);
      }

      return this.normalizeResponse<T>(json, intermediateQuery, nativeQuery, startTime, restConfig);
    } catch (err) {
      if (err instanceof RestApiError) throw err;

      // Network / timeout error
      const fallback = restConfig.fallback ?? 'fail';
      if (fallback === 'empty') {
        return this.emptyResult<T>(intermediateQuery, nativeQuery, startTime);
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // HTTP execution
  // --------------------------------------------------------------------------

  private async sendRequest(nativeQuery: RestNativeQuery, config: RestAdapterConfig): Promise<Response> {
    const url = new URL(nativeQuery.url);
    console.log("cc2",nativeQuery.url, nativeQuery.method, nativeQuery.headers, nativeQuery.body);
    if (nativeQuery.params) {
      for (const [k, v] of Object.entries(nativeQuery.params)) {
        url.searchParams.set(k, v);
      }
    }

    const init: RequestInit = {
      method: nativeQuery.method,
      headers: nativeQuery.headers,
    };

    if (nativeQuery.body !== undefined) {
      init.body = JSON.stringify(nativeQuery.body);
    }

    return this.fetchWithTimeout(url.toString(), init, config);
  }

  private async fetchWithTimeout(url: string, init: RequestInit, config: RestAdapterConfig): Promise<Response> {
    const timeout = config.timeout ?? 5000;
    const retries = config.retries ?? 1;

    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timer);
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastError = err as Error;
        if (attempt < retries) continue;
      }
    }

    throw lastError;
  }

  // --------------------------------------------------------------------------
  // Response normalization
  // --------------------------------------------------------------------------

  private normalizeResponse<T>(
    json: Record<string, unknown> | unknown[],
    query: IntermediateQuery,
    nativeQuery: RestNativeQuery,
    startTime: number,
    config: RestAdapterConfig,
  ): QueryResult<T> {
    const mapping = config.responseMapping ?? { dataKey: 'data', countKey: 'count' };
    const isBareArray = Array.isArray(json);
    const env = (isBareArray ? {} : json) as Record<string, unknown>;

    // Write operations — return single item
    if (['insert', 'update', 'replace'].includes(query.type)) {
      const item = (env[mapping.dataKey] ?? env['data'] ?? json) as T;
      return {
        statusCode: 200,
        data: Array.isArray(item) ? item : [item],
        count: 1,
        metadata: this.buildMeta(query, nativeQuery, startTime),
      };
    }

    // Delete — no data
    if (['delete', 'deleteMany'].includes(query.type)) {
      return {
        statusCode: 200,
        data: [],
        count: 0,
        metadata: {
          ...this.buildMeta(query, nativeQuery, startTime),
          deletedCount: (env['deletedCount'] as number) ?? 1,
        },
      };
    }

    // Read — accept either a wrapped envelope (`{data: [...]}`) or a bare array
    // (common with third-party REST APIs like jsonplaceholder).
    const rawData = isBareArray ? json : (env[mapping.dataKey] ?? env['items']);
    const data: T[] = Array.isArray(rawData) ? (rawData as T[]) : (rawData ? [rawData as T] : []);
    const count = !isBareArray && typeof env[mapping.countKey] === 'number'
      ? (env[mapping.countKey] as number)
      : data.length;

    const pagination = isBareArray
      ? undefined
      : (env[mapping.paginationKey ?? 'pagination'] as QueryResult<T>['pagination'] | undefined);

    return {
      statusCode: 200,
      data,
      count,
      ...(pagination ? { pagination } : {}),
      metadata: this.buildMeta(query, nativeQuery, startTime),
    };
  }

  private emptyResult<T>(
    query: IntermediateQuery,
    nativeQuery: RestNativeQuery,
    startTime: number,
  ): QueryResult<T> {
    return {
      statusCode: 200,
      data: [],
      count: 0,
      metadata: this.buildMeta(query, nativeQuery, startTime),
    };
  }

  private buildMeta(
    query: IntermediateQuery,
    nativeQuery: RestNativeQuery,
    startTime: number,
  ): QueryResultMetadata {
    return {
      adapter: this.name,
      query,
      nativeQuery,
      executionTime: Date.now() - startTime,
    };
  }

  private parseFilename(contentDisposition: string): string | null {
    if (!contentDisposition) return null;
    const m = /filename\*?=(?:UTF-8'')?\"?([^;\"]+)\"?/i.exec(contentDisposition);
    if (!m?.[1]) return null;
    try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); }
  }

  private extFromMime(mime: string): string {
    const map: Record<string, string> = {
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/pdf': 'pdf',
      'application/zip': 'zip',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'audio/mpeg': 'mp3',
      'video/mp4': 'mp4',
    };
    const base = mime.split(';')[0].trim().toLowerCase();
    return map[base] ?? 'bin';
  }
}

// ============================================================================
// ERROR
// ============================================================================

export class RestApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(statusCode: number, body: unknown) {
    super(`[RestApiAdapter] Remote API returned ${statusCode}`);
    this.name = 'RestApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createRestApiAdapter(): RestApiAdapter {
  return new RestApiAdapter();
}
