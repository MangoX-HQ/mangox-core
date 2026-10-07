/**
 * Core V2 - Configuration System
 * Externalized configuration for all core components
 *
 * NOTE: Config values are imported from /src/configs/core-v2-config.ts
 * To change the config, edit that file instead of here
 */

import { DatabaseType } from '../types';
import {
  RBAC_CONFIG,
  PLUGIN_CONFIG,
  CACHE_CONFIG,
  QUERY_CONFIG,
} from '../../configs/core';

// ============================================================================
// RBAC CONFIG
// ============================================================================

export interface RbacConfig {
  /**
   * Collections that bypass access control entirely
   * Use sparingly - only for truly public collections
   */
  bypassAccessList: string[];

  /**
   * Collections that bypass field projection filtering
   */
  bypassProjectionList: string[];

  /**
   * System fields automatically added to all entities
   */
  systemFields: string[];

  /**
   * Fields that require date format validation
   */
  dateFormatFields: string[];

  /**
   * Plugin field mappings
   * Maps plugin names to their associated fields
   */
  pluginFields: PluginFieldMapping[];

  /**
   * Default role when no role is specified
   */
  defaultRole: string;

  /**
   * Admin role name(s) that bypass most checks
   */
  adminRoles: string[];
}

export interface PluginFieldMapping {
  plugin: string;
  fields: string[];
}

// ============================================================================
// CACHE CONFIG
// ============================================================================

export interface CacheConfig {
  /**
   * Enable/disable caching globally
   */
  enabled: boolean;

  /**
   * Default TTL in seconds
   */
  defaultTTL: number;

  /**
   * Prefix for cache keys
   */
  keyPrefix?: string;

  /**
   * Enable compression
   */
  compression?: boolean;

  /**
   * Compression threshold in bytes (compress if larger)
   */
  compressionThreshold?: number;

  /**
   * Max cache size
   */
  maxSize?: number;

  /**
   * Collections to exclude from caching
   */
  excludeCollections?: string[];
}

// ============================================================================
// PLUGIN CONFIG
// ============================================================================

export interface PluginConfig {
  /**
   * Enable/disable plugins globally
   */
  enabled?: boolean;

  /**
   * Plugins to run before query conversion
   */
  beforePlugins: string[];

  /**
   * Plugins to run after query conversion (modify native query)
   */
  mainPlugins: string[];

  /**
   * Plugins to run after query execution (modify results)
   */
  afterPlugins: string[];

  /**
   * Plugin-specific configurations
   */
  pluginOptions?: Record<string, unknown>;

  /**
   * Field mappings for plugins
   */
  fieldMappings?: Record<string, string[]>;
}

// ============================================================================
// ADAPTER CONFIG
// ============================================================================

export interface AdapterConfig {
  type: DatabaseType;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  options?: Record<string, unknown>;
}

// ============================================================================
// QUERY CONFIG
// ============================================================================

export interface QueryConfig {
  /**
   * Default limit for queries
   */
  defaultLimit: number;

  /**
   * Maximum limit allowed
   */
  maxLimit: number;

  /**
   * Include _id in sort by default
   */
  includeIdInSort: boolean;

  /**
   * Default sort field and direction
   */
  defaultSort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
}

// ============================================================================
// CORE CONFIG (Main)
// ============================================================================

export interface CoreConfig {
  rbac: RbacConfig;
  cache: CacheConfig;
  plugins: PluginConfig;
  query: QueryConfig;
  adapters: Record<string, AdapterConfig>;

  /**
   * Enable debug mode (extra logging, no production optimizations)
   */
  debug: boolean;

  /**
   * Application name (used in cache keys, logs)
   */
  appName: string;
}

// ============================================================================
// DEFAULT CONFIGURATIONS
// Imported from /src/configs/core-v2-config.ts - EDIT THERE to change the config
// ============================================================================

export const DEFAULT_RBAC_CONFIG: RbacConfig = RBAC_CONFIG;

export const DEFAULT_CACHE_CONFIG: CacheConfig = CACHE_CONFIG;

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = PLUGIN_CONFIG;

export const DEFAULT_QUERY_CONFIG: QueryConfig = QUERY_CONFIG;

export const DEFAULT_CORE_CONFIG: CoreConfig = {
  rbac: DEFAULT_RBAC_CONFIG,
  cache: DEFAULT_CACHE_CONFIG,
  plugins: DEFAULT_PLUGIN_CONFIG,
  query: DEFAULT_QUERY_CONFIG,
  adapters: {},
  debug: false,
  appName: 'mangox-api',
};

// ============================================================================
// CONFIG BUILDER
// ============================================================================

export class ConfigBuilder {
  private config: CoreConfig;

  constructor(baseConfig: Partial<CoreConfig> = {}) {
    this.config = this.mergeDeep(DEFAULT_CORE_CONFIG, baseConfig) as CoreConfig;
  }

  withRbac(rbacConfig: Partial<RbacConfig>): this {
    this.config.rbac = { ...this.config.rbac, ...rbacConfig };
    return this;
  }

  withCache(cacheConfig: Partial<CacheConfig>): this {
    this.config.cache = { ...this.config.cache, ...cacheConfig };
    return this;
  }

  withPlugins(pluginConfig: Partial<PluginConfig>): this {
    this.config.plugins = { ...this.config.plugins, ...pluginConfig };
    return this;
  }

  withQuery(queryConfig: Partial<QueryConfig>): this {
    this.config.query = { ...this.config.query, ...queryConfig };
    return this;
  }

  withAdapter(name: string, adapterConfig: AdapterConfig): this {
    this.config.adapters[name] = adapterConfig;
    return this;
  }

  withDebug(enabled: boolean): this {
    this.config.debug = enabled;
    return this;
  }

  build(): CoreConfig {
    return { ...this.config };
  }

  private mergeDeep(target: unknown, source: unknown): unknown {
    if (typeof target !== 'object' || target === null) return source;
    if (typeof source !== 'object' || source === null) return source;

    const output = { ...target as Record<string, unknown> };
    const sourceObj = source as Record<string, unknown>;

    for (const key of Object.keys(sourceObj)) {
      if (sourceObj[key] !== undefined) {
        if (
          typeof sourceObj[key] === 'object' &&
          sourceObj[key] !== null &&
          !Array.isArray(sourceObj[key])
        ) {
          output[key] = this.mergeDeep(output[key], sourceObj[key]);
        } else {
          output[key] = sourceObj[key];
        }
      }
    }

    return output;
  }
}

// ============================================================================
// CONFIG SINGLETON
// ============================================================================

let globalConfig: CoreConfig = DEFAULT_CORE_CONFIG;

export function setGlobalConfig(config: CoreConfig): void {
  globalConfig = config;
}

export function getGlobalConfig(): CoreConfig {
  return globalConfig;
}

export function updateGlobalConfig(updates: Partial<CoreConfig>): void {
  globalConfig = new ConfigBuilder(globalConfig).build();
  Object.assign(globalConfig, updates);
}
