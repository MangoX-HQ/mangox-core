/**
 * Common Types and Interfaces for Configs
 * 
 * This file contains shared types used across config files.
 * To avoid duplication, we import from core_v2 where possible.
 */

import { RequestOptions, QueryResult, UserContext } from '../core_v2';

// ============================================================================
// REDIS CONFIG
// ============================================================================

export interface RedisConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  prefix?: string;
  url?: string;
  cacheTTL: number;
}

// ============================================================================
// APP SETTINGS TYPES
// ============================================================================

export interface MongoConfig {
  url: string;
  dbName: string;
  options: string;
  isReplicaSet: boolean;
}

export interface MinioConfig {
  endpoint?: string;
  port?: string;
  user?: string;
  password?: string;
  loginPort?: string;
  useHash: boolean;
  accessKey?: string;
  secretKey?: string;
  bucketName?: string;
  public?: string;
  sharp: {
    bucketName?: string;
    webpQuality: number;
    sizes: number[];
    generateThumb: boolean;
    thumbSize: number;
    regenerateOnUpload: boolean;
  };
  cv: {
    bucketName?: string;
  };
}

export interface ElasticsearchConfig {
  mode: string;
  host: string;
  port: number;
  index: string;
  batchSize: number;
  syncCron: string;
}

export interface MailConfig {
  host: string;
  port: number;
  from: string;
  password: string;
}

export interface CloudflareConfig {
  apiKey?: string;
  zoneId?: string;
}

// ============================================================================
// RE-EXPORT FROM CORE_V2 (for convenience)
// ============================================================================

export type {
  RequestOptions,
  QueryResult,
  UserContext,
  CoreOperationOptions,
} from '../core_v2';

export type OptionsInput = RequestOptions;

export interface IntermediateQueryResult<T = any> {
  data: T[];
  count: number;
  statusCode: number;
  metadata?: {
    adapter?: string;
    query?: any;
    executionTime?: number;
    nativeQuery?: unknown;
  };
  pagination?: {
    current_page: number;
    last_page: number;
    total: number;
    hasMore?: boolean;
  };
}
