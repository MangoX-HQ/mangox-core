import { FastifyRequest } from "fastify";
import { redisClient } from "../configs/redis";

const CACHE_TTL = 60; // 5 minutes = 300 seconds

/**
 * Redis cache decorator that uses the URL as the key
 * TTL: 5 minutes
 * 
 * @example
 * class MyController {
 *   @RedisCache()
 *   async getData(request: FastifyRequest, reply: FastifyReply) {
 *     // handler logic
 *   }
 * }
 */
export function RedisCache(ttl: number = CACHE_TTL) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const request: FastifyRequest = args[0];

      if (!request?.url) {
        return originalMethod.apply(this, args);
      }

      // Build cache key from URL + query params
      const cacheKey = `cache:${request.url}`;

      let result = null;
      try {
        // Check cache
        const cachedData = await redisClient.get(cacheKey);

        if (cachedData) {
          return JSON.parse(cachedData);
        }

        // If there's no cache, call the original method
        result = await originalMethod.apply(this, args);

        // Save to cache
        if (result) {
          await redisClient.setex(cacheKey, ttl, JSON.stringify(result));
        }

        return result;
      } catch (error) {
        throw error;
      }
    };

    return descriptor;
  };
}

export function RedisCacheWithRole(ttl: number = CACHE_TTL) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const request: FastifyRequest = args[0];
      const reply: any = args[1];

      if (!request?.url) {
        return originalMethod.apply(this, args);
      }

      // Get user info from request headers
      const user: any = request.headers.user;
      const userRole = user?.role_name || "default";
      const userId = user?.id || "anonymous";

      // Build cache key from URL + role + userId
      // Format: cache:role:{role}:user:{userId}:api:{url}
      const cacheKey = `cache:role:${userRole}:user:${userId}:api:${request.url}`;

      try {
        // Check cache
        const cachedData = await redisClient.get(cacheKey);

        if (cachedData) {
          // Cache hit - set response headers
          if (reply) {
            reply.header("X-Cache", "HIT");
            reply.header("X-Cache-Key", cacheKey);
          }
          request.log?.info(`Redis cache hit: ${cacheKey}`);
          return JSON.parse(cachedData);
        }

        // Cache miss - call the original method
        request.log?.info(`Redis cache miss: ${cacheKey}`);
        const result = await originalMethod.apply(this, args);

        // Save to cache
        if (result) {
          await redisClient.setex(cacheKey, ttl, JSON.stringify(result));
          if (reply) {
            reply.header("X-Cache", "MISS");
            reply.header("X-Cache-Key", cacheKey);
          }
        }

        return result;
      } catch (error: any) {
        // If Redis errors out, still return the result from the original method
        console.error("Redis cache error:", error);
        request.log?.error("Redis cache error:", error);
        return originalMethod.apply(this, args);
      }
    };

    return descriptor;
  };
}
