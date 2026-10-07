import { IntermediateQueryResult } from "../../../core_v2/compat";

const CACHE_TTL_MS = 30_000; // 30 seconds

type CacheEntry = {
  result: IntermediateQueryResult;
  expiresAt: number;
};

const store = new Map<string, CacheEntry>();

export function getCache(key: string): IntermediateQueryResult | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.result;
}

export function setCache(key: string, result: IntermediateQueryResult, ttlMs = CACHE_TTL_MS): void {
  store.set(key, { result, expiresAt: Date.now() + ttlMs });
}

export function deleteCache(key: string): void {
  store.delete(key);
}

export function deleteCacheByEntity(entity: string): number {
  const prefix = `${entity}:`;
  let n = 0;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      n++;
    }
  }
  return n;
}

export function clearCache(): void {
  store.clear();
}

export function getCacheSize(): number {
  return store.size;
}
