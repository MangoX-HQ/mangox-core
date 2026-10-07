/**
 * Core Unified - Core V2 Only
 *
 * Provides unified interface for Core V2
 */

import { Db } from 'mongodb';

// V2 imports only
import { initCore } from './bootstrap';
import { schemaSync } from '../../core_v2/store';
import { CoreBootstrap, initCoreBootstrap, getCoreBootstrap } from './adapter';
import { QueryConverter } from '../../core_v2';
import type { IntermediateQueryResult, OptionsInput } from '../types';

// ============================================================================
// UNIFIED INTERFACE
// ============================================================================

export interface ICoreUnified {
  getCore(): ICoreApi;
  getInstanceDB(type: 'mongodb', tenantId?: string): Promise<Db>;
  relationshipRegistry: IRelationshipRegistry;
  getSession?(type: 'mongodb'): Promise<any>;
  getAdapter?(type: 'mongodb'): any;
  isCacheAvailable?(): boolean;
  getCacheManager?(): any;
}

export interface ICoreApi {
  getQueryConverter(): Promise<QueryConverter>;
  findAll<T = any>(
    params: any,
    collection: string,
    roles?: string[],
    options?: any
  ): Promise<IntermediateQueryResult<T>>;

  findById<T = any>(
    collection: string,
    params: any,
    id: string,
    roles?: string[],
    options?: any
  ): Promise<IntermediateQueryResult<T>>;

  findOne<T = any>(
    collection: string,
    params: any,
    filters: { field: string; operator: any; value: any }[],
    roles?: string[],
    options?: any
  ): Promise<IntermediateQueryResult<T>>;

  create(
    collection: string,
    data: any,
    roles?: string[],
    options?: any,
    callBack?: () => void
  ): Promise<any>;

  update<T = any>(
    collection: string,
    id: string,
    data: any,
    roles?: string[],
    options?: any
  ): Promise<T>;

  partialUpdate<T = any>(
    collection: string,
    params: any,
    data: any,
    roles?: string[],
    options?: any
  ): Promise<any>;

  delete(
    collection: string,
    id: string,
    roles?: string[],
    options?: any
  ): Promise<boolean>;

  deleteMany<T = any>(
    collection: string,
    params: any,
    roles?: string[],
    options?: any
  ): Promise<IntermediateQueryResult<T>>;

  advanceQuery(
    intermediateQuery: any,
    options?: any,
    callBack?: () => void
  ): Promise<any>;

  /**
   * Low-level adapter action — triggers / pipeline side-effects only.
   * Service picks the adapter from `entity.databaseType` and forwards.
   */
  executeAction(
    entity: string,
    action: any
  ): Promise<any>;

  RbacFilterBody?(
    data: any,
    collection: string,
    roles: string[],
    method: string,
    options?: any
  ): Promise<any>;
}

export interface IRelationshipRegistry {
  getForTable(tableName: string): any[];
  getForCollection(collection: string): any[];
  getAll?(): Map<string, any>;
  removeBySource?(collection: string): void;
}

// ============================================================================
// CORE GLOBAL UNIFIED
// ============================================================================

let coreUnified: ICoreUnified | null = null;

/**
 * Check if Core V2 mode is enabled (always true now)
 */
export function isCoreEnabled(): boolean {
  return true;
}

/**
 * Initialize the unified core (Core V2 only)
 */
export async function InitialCoreUnified(): Promise<void> {
  console.log('[Core Unified] Initializing Core V2...');

  // Self-contained DEPLOY build: do NOT wait for Studio to seed on its behalf — load json/ → Redis itself at boot.
  //   json/system/<type>/<slug>.json                  → scope 'system'
  //   json/<team_id>/<tenant_slug>/<type>/<slug>.json → scope '<team_id>/<tenant_slug>'
  // Must run BEFORE initCore so entityConfigLoader can read the relationship during init.
  console.log('[Core Unified] Loading entity schema (json → Redis)...');
  await schemaSync.bootstrap();

  await initCore();

  await initCoreBootstrap();
  coreUnified = getCoreBootstrap() as any;

  // jsonStore 'change' listener — when admin edits policy/resource via API, this will call
  // jsonStore.write()/delete() (writes to json/ files), and this event syncs it to Redis.
  // THIS IS NOT an fs-watcher.
  schemaSync.start();

  // INTENTIONALLY does NOT call jsonStore.startWatch(): the deploy build does not watch system files
  // (avoids fs.watch/EMFILE; files in the image are immutable). Editing files externally (manual/git)
  // requires a restart to reload; edits via API still sync immediately thanks to the listener above.

  console.log('[Core Unified] Core V2 initialized successfully');
}

/**
 * Get the unified core global instance
 */
export function getCoreUnified(): ICoreUnified {
  if (!coreUnified) {
    throw new Error('[Core Unified] Not initialized. Call InitialCoreUnified() first.');
  }
  return coreUnified;
}

// ============================================================================
// BACKWARD COMPATIBLE EXPORTS
// ============================================================================

export { coreUnified };

// Re-export types for compatibility
export type { IntermediateQueryResult, OptionsInput } from '../types';
