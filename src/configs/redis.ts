import { appSettings, buildRedisKeyPrefix, buildRedisJsonKeyPrefix } from "./app-settings";
import Redis from 'ioredis';

export const redisPrefix = appSettings.redis.prefix || 'default';
export const redisKeyPrefix = buildRedisKeyPrefix();
export const redisSchemaKeyPrefix = buildRedisJsonKeyPrefix();

// SINGLE SOURCE for all ioredis/BullMQ clients (host/port/password/db/tls).
// db comes from appSettings.redis.db (= REDIS_DB) — must match the DB that the schema was seeded into.
// TLS is enabled when REDIS_TLS=true (managed/cloud Redis); REDIS_TLS_INSECURE=true to
// skip cert verification (self-signed).
export const redisConnection = {
    host: appSettings.redis.host || 'localhost',
    port: appSettings.redis.port || 6379,
    username: appSettings.redis.username || 'default',
    password: appSettings.redis.password || '',
    db: appSettings.redis.db ?? 0,
    ...(process.env.REDIS_TLS === 'true'
      ? { tls: { rejectUnauthorized: process.env.REDIS_TLS_INSECURE !== 'true' } }
      : {}),
};

export const redisPrefixedConnection = {
    ...redisConnection,
    keyPrefix: redisKeyPrefix,
};

export const redisQueuePrefix = redisPrefix.endsWith(':') ? redisPrefix.slice(0, -1) : redisPrefix;

export const redisClient = new Redis(redisPrefixedConnection);

export const redisSchemaClient = new Redis({
    ...redisConnection,
    keyPrefix: redisSchemaKeyPrefix,
});
