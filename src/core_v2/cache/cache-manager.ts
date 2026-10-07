/**
 * Core V2 - Cache Manager
 * Redis-based caching with compression and graceful degradation
 */

import { CacheConfig, getGlobalConfig } from '../config';
import { QueryParams, RequestOptions } from '../types';
import crypto from 'crypto';

// ============================================================================
// CACHE INTERFACES
// ============================================================================

/**
 * Cache entry metadata
 */
export interface CacheEntry<T = unknown> {
  data: T;
  metadata: {
    createdAt: number;
    expiresAt: number;
    compressed: boolean;
    size: number;
  };
}

/**
 * Cache key components
 */
export interface CacheKeyParams {
  collection: string;
  params?: QueryParams;
  roles?: string[];
  options?: RequestOptions;
  id?: string;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  hitRate: number;
}

/**
 * Cache driver interface - implement this for different cache backends
 */
export interface ICacheDriver {
  /**
   * Get value by key
   */
  get(key: string): Promise<Buffer | string | null>;

  /**
   * Set value with TTL
   */
  set(key: string, value: Buffer | string, ttlSeconds: number): Promise<void>;

  /**
   * Delete by key
   */
  delete(key: string): Promise<boolean>;

  /**
   * Delete by pattern
   */
  deleteByPattern(pattern: string): Promise<number>;

  /**
   * Check if connected
   */
  isConnected(): boolean;

  /**
   * Connect to cache backend
   */
  connect(): Promise<void>;

  /**
   * Disconnect from cache backend
   */
  disconnect(): Promise<void>;

  /**
   * Flush all cache
   */
  flushAll(): Promise<void>;
}

// ============================================================================
// CACHE MANAGER
// ============================================================================

/**
 * Cache manager with compression and graceful degradation
 */
export class CacheManager {
  private driver: ICacheDriver;
  private config: CacheConfig;
  private prefix: string;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    errors: 0,
    hitRate: 0,
  };

  // Compression threshold (1KB)
  private readonly compressionThreshold = 1024;

  constructor(driver: ICacheDriver, config?: CacheConfig, prefix = 'core') {
    this.driver = driver;
    this.config = config || getGlobalConfig().cache;
    this.prefix = prefix;
  }

  // ============================================================================
  // KEY GENERATION
  // ============================================================================

  /**
   * Generate cache key
   */
  generateKey(params: CacheKeyParams): string {
    const parts = [this.prefix, 'v2', params.collection];

    // Add roles hash
    if (params.roles && params.roles.length > 0) {
      parts.push(this.hashObject(params.roles.sort()));
    } else {
      parts.push('default');
    }

    // Add ID if present
    if (params.id) {
      parts.push(`id_${params.id}`);
    }

    // Add params hash
    if (params.params && Object.keys(params.params).length > 0) {
      parts.push(this.hashObject(params.params));
    }

    // Add options hash (excluding non-cacheable options)
    if (params.options) {
      const cacheableOptions = this.filterCacheableOptions(params.options);
      if (Object.keys(cacheableOptions).length > 0) {
        parts.push(this.hashObject(cacheableOptions));
      }
    }

    return parts.join(':');
  }

  /**
   * Hash object to create short unique key
   */
  private hashObject(obj: unknown): string {
    if (!obj || (typeof obj === 'object' && Object.keys(obj as object).length === 0)) {
      return 'empty';
    }
    const str = JSON.stringify(obj, Object.keys(obj as object).sort());
    return crypto.createHash('md5').update(str).digest('hex').substring(0, 12);
  }

  /**
   * Filter out non-cacheable options
   */
  private filterCacheableOptions(options: RequestOptions): Record<string, unknown> {
    const { session, log, ...rest } = options as Record<string, unknown>;
    return rest;
  }

  // ============================================================================
  // COMPRESSION
  // ============================================================================

  /**
   * Compress data using gzip
   */
  private async compress(data: string): Promise<Buffer> {
    const { promisify } = await import('util');
    const { gzip } = await import('zlib');
    const gzipAsync = promisify(gzip);
    return gzipAsync(Buffer.from(data, 'utf-8'));
  }

  /**
   * Decompress data using gunzip
   */
  private async decompress(buffer: Buffer): Promise<string> {
    const { promisify } = await import('util');
    const { gunzip } = await import('zlib');
    const gunzipAsync = promisify(gunzip);
    const decompressed = await gunzipAsync(buffer);
    return decompressed.toString('utf-8');
  }

  /**
   * Check if data should be compressed
   */
  private shouldCompress(data: string): boolean {
    return (this.config.compression === true) && Buffer.byteLength(data, 'utf-8') > this.compressionThreshold;
  }

  /**
   * Check if buffer is gzip compressed
   */
  private isCompressed(buffer: Buffer): boolean {
    return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  }

  // ============================================================================
  // CORE OPERATIONS
  // ============================================================================

  /**
   * Check if cache is available
   */
  isAvailable(): boolean {
    return this.config.enabled && this.driver.isConnected();
  }

  /**
   * Get cached value
   */
  async get<T = unknown>(keyParams: CacheKeyParams): Promise<T | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const key = this.generateKey(keyParams);
      const cached = await this.driver.get(key);

      if (!cached) {
        this.stats.misses++;
        this.updateHitRate();
        return null;
      }

      let data: string;
      const buffer = Buffer.isBuffer(cached) ? cached : Buffer.from(cached);

      if (this.isCompressed(buffer)) {
        data = await this.decompress(buffer);
      } else {
        data = buffer.toString('utf-8');
      }

      this.stats.hits++;
      this.updateHitRate();
      return JSON.parse(data) as T;
    } catch (error) {
      this.stats.errors++;
      // Silent fail - graceful degradation
      return null;
    }
  }

  /**
   * Set cached value
   */
  async set<T = unknown>(
    keyParams: CacheKeyParams,
    value: T,
    ttl?: number
  ): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const key = this.generateKey(keyParams);
      const jsonData = JSON.stringify(value);
      const ttlSeconds = ttl || this.config.defaultTTL;

      let dataToStore: Buffer | string;

      if (this.shouldCompress(jsonData)) {
        dataToStore = await this.compress(jsonData);
      } else {
        dataToStore = jsonData;
      }

      await this.driver.set(key, dataToStore, ttlSeconds);
      this.stats.sets++;
    } catch (error) {
      this.stats.errors++;
      // Silent fail - graceful degradation
    }
  }

  /**
   * Delete cached value
   */
  async delete(keyParams: CacheKeyParams): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const key = this.generateKey(keyParams);
      const deleted = await this.driver.delete(key);
      if (deleted) {
        this.stats.deletes++;
      }
      return deleted;
    } catch (error) {
      this.stats.errors++;
      return false;
    }
  }

  /**
   * Invalidate all cache for a collection
   */
  async invalidateCollection(collection: string): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const pattern = `${this.prefix}:v2:${collection}:*`;
      const count = await this.driver.deleteByPattern(pattern);
      this.stats.deletes += count;
      return count;
    } catch (error) {
      this.stats.errors++;
      return 0;
    }
  }

  /**
   * Invalidate multiple collections
   */
  async invalidateCollections(collections: string[]): Promise<number> {
    let total = 0;
    for (const collection of collections) {
      total += await this.invalidateCollection(collection);
    }
    return total;
  }

  /**
   * Flush all cache
   */
  async flushAll(): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.driver.flushAll();
      this.resetStats();
    } catch (error) {
      this.stats.errors++;
    }
  }

  // ============================================================================
  // CONVENIENCE METHODS
  // ============================================================================

  /**
   * Get or set pattern - fetch from cache or execute function and cache result
   */
  async getOrSet<T = unknown>(
    keyParams: CacheKeyParams,
    fetchFn: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    // Try to get from cache
    const cached = await this.get<T>(keyParams);
    if (cached !== null) {
      return cached;
    }

    // Fetch fresh data
    const freshData = await fetchFn();

    // Cache the result (don't await - fire and forget)
    this.set(keyParams, freshData, ttl).catch(() => {
      // Silent fail
    });

    return freshData;
  }

  /**
   * Cache findAll result
   */
  async cacheQuery<T = unknown>(
    collection: string,
    params: QueryParams,
    roles: string[],
    options: RequestOptions | undefined,
    value: T,
    ttl?: number
  ): Promise<void> {
    await this.set({ collection, params, roles, options }, value, ttl);
  }

  /**
   * Get cached findAll result
   */
  async getCachedQuery<T = unknown>(
    collection: string,
    params: QueryParams,
    roles: string[],
    options?: RequestOptions
  ): Promise<T | null> {
    return this.get({ collection, params, roles, options });
  }

  /**
   * Cache findById result
   */
  async cacheById<T = unknown>(
    collection: string,
    id: string,
    params: QueryParams,
    roles: string[],
    options: RequestOptions | undefined,
    value: T,
    ttl?: number
  ): Promise<void> {
    await this.set({ collection, id, params, roles, options }, value, ttl);
  }

  /**
   * Get cached findById result
   */
  async getCachedById<T = unknown>(
    collection: string,
    id: string,
    params: QueryParams,
    roles: string[],
    options?: RequestOptions
  ): Promise<T | null> {
    return this.get({ collection, id, params, roles, options });
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  /**
   * Update hit rate
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      errors: 0,
      hitRate: 0,
    };
  }

  /**
   * Get statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  /**
   * Connect to cache backend
   */
  async connect(): Promise<void> {
    await this.driver.connect();
  }

  /**
   * Disconnect from cache backend
   */
  async disconnect(): Promise<void> {
    await this.driver.disconnect();
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create cache manager
 */
export function createCacheManager(
  driver: ICacheDriver,
  config?: CacheConfig,
  prefix?: string
): CacheManager {
  return new CacheManager(driver, config, prefix);
}

// ============================================================================
// SINGLETON
// ============================================================================

let globalCacheManager: CacheManager | null = null;

/**
 * Get global cache manager
 */
export function getCacheManager(): CacheManager | null {
  return globalCacheManager;
}

/**
 * Set global cache manager
 */
export function setCacheManager(manager: CacheManager): void {
  globalCacheManager = manager;
}

/**
 * Check if cache is available
 */
export function isCacheAvailable(): boolean {
  return globalCacheManager?.isAvailable() ?? false;
}
