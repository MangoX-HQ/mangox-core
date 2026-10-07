/**
 * Core V2 - Cache Exports
 */

// Cache Manager
export {
  CacheManager,
  createCacheManager,
  getCacheManager,
  setCacheManager,
  isCacheAvailable,
  ICacheDriver,
  CacheEntry,
  CacheKeyParams,
  CacheStats,
} from './cache-manager';

// Redis Driver
export {
  RedisDriver,
  createRedisDriver,
  createRedisDriverFromUrl,
  IRedisClient,
  RedisDriverOptions,
} from './redis-driver';

// In-Memory Driver (for testing)
export {
  InMemoryDriver,
  createInMemoryDriver,
} from './redis-driver';
