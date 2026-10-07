/**
 * Core V2 - Redis Cache Driver
 * Redis implementation of ICacheDriver
 */

import { ICacheDriver } from './cache-manager';

// ============================================================================
// REDIS CLIENT INTERFACE
// ============================================================================

/**
 * Redis client interface - compatible with ioredis
 */
export interface IRedisClient {
  get(key: string): Promise<string | null>;
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: string | Buffer, mode?: string, duration?: number): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  flushall(): Promise<string>;
  quit(): Promise<string>;
  connect(): Promise<void>;
  on(event: string, callback: (...args: unknown[]) => void): void;
  status?: string;
}

// ============================================================================
// REDIS DRIVER OPTIONS
// ============================================================================

export interface RedisDriverOptions {
  /**
   * Redis URL (e.g., redis://localhost:6379)
   */
  url?: string;

  /**
   * Max retries per request
   */
  maxRetries?: number;

  /**
   * Enable offline queue
   */
  enableOfflineQueue?: boolean;

  /**
   * Connection timeout in ms
   */
  connectionTimeout?: number;

  /**
   * Lazy connect (don't connect immediately)
   */
  lazyConnect?: boolean;

  /**
   * Prefix applied by ioredis to Redis keys.
   */
  keyPrefix?: string;
}

// ============================================================================
// REDIS DRIVER
// ============================================================================

/**
 * Redis cache driver implementation
 */
export class RedisDriver implements ICacheDriver {
  private client: IRedisClient;
  private connected = false;
  private connectionAttempted = false;

  constructor(client: IRedisClient) {
    this.client = client;
    this.setupEvents();
  }

  /**
   * Setup event listeners
   */
  private setupEvents(): void {
    this.client.on('connect', () => {
      this.connected = true;
      console.log('[Redis Driver] Connected');
    });

    this.client.on('error', (err: unknown) => {
      this.connected = false;
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[Redis Driver] Error:', message);
    });

    this.client.on('close', () => {
      this.connected = false;
      console.warn('[Redis Driver] Disconnected');
    });

    this.client.on('ready', () => {
      this.connected = true;
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.connectionAttempted) return;
    this.connectionAttempted = true;

    try {
      await this.client.connect();
      this.connected = true;
    } catch (error) {
      this.connected = false;
      console.warn('[Redis Driver] Connection failed:', (error as Error).message);
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.quit();
      this.connected = false;
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Get value by key
   */
  async get(key: string): Promise<Buffer | null> {
    if (!this.connected) return null;

    try {
      return await this.client.getBuffer(key);
    } catch (error) {
      return null;
    }
  }

  /**
   * Set value with TTL
   */
  async set(key: string, value: Buffer | string, ttlSeconds: number): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch (error) {
      // Silent fail
    }
  }

  /**
   * Delete by key
   */
  async delete(key: string): Promise<boolean> {
    if (!this.connected) return false;

    try {
      const deleted = await this.client.del(key);
      return deleted > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Delete by pattern using SCAN
   */
  async deleteByPattern(pattern: string): Promise<number> {
    if (!this.connected) return 0;

    try {
      let cursor = '0';
      let deletedCount = 0;

      do {
        const [newCursor, keys] = await this.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100
        );
        cursor = newCursor;

        if (keys.length > 0) {
          const keyPrefix = (this.client as any)?.options?.keyPrefix as string | undefined;
          const deleteKeys = keyPrefix
            ? keys.map((key) => key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key)
            : keys;
          const deleted = await this.client.del(...deleteKeys);
          deletedCount += deleted;
        }
      } while (cursor !== '0');

      return deletedCount;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Flush all cache
   */
  async flushAll(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.flushall();
    } catch (error) {
      // Silent fail
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create Redis driver from existing client
 */
export function createRedisDriver(client: IRedisClient): RedisDriver {
  return new RedisDriver(client);
}

/**
 * Create Redis driver with ioredis
 * Note: Requires ioredis to be installed
 */
export async function createRedisDriverFromUrl(
  url: string,
  options?: RedisDriverOptions
): Promise<RedisDriver> {
  // Dynamic import to avoid requiring ioredis if not used
  const Redis = (await import('ioredis')).default;

  const client = new Redis(url, {
    lazyConnect: options?.lazyConnect ?? true,
    maxRetriesPerRequest: options?.maxRetries ?? 1,
    enableOfflineQueue: options?.enableOfflineQueue ?? false,
    keyPrefix: options?.keyPrefix,
    retryStrategy: () => null, // Don't retry on failure
  });

  return new RedisDriver(client as unknown as IRedisClient);
}

// ============================================================================
// IN-MEMORY DRIVER (FOR TESTING)
// ============================================================================

interface MemoryCacheEntry {
  value: Buffer | string;
  expiresAt: number;
}

/**
 * In-memory cache driver for testing
 */
export class InMemoryDriver implements ICacheDriver {
  private cache: Map<string, MemoryCacheEntry> = new Map();
  private connected = true;

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.cache.clear();
  }

  async get(key: string): Promise<Buffer | string | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: Buffer | string, ttlSeconds: number): Promise<void> {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async deleteByPattern(pattern: string): Promise<number> {
    // Convert glob pattern to regex
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );

    let count = 0;
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }

    return count;
  }

  async flushAll(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Get cache size (for testing)
   */
  size(): number {
    return this.cache.size;
  }
}

/**
 * Create in-memory driver
 */
export function createInMemoryDriver(): InMemoryDriver {
  return new InMemoryDriver();
}
