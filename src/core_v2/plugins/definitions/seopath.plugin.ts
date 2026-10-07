/**
 * Core V2 - SEO Path Plugin
 * Manages seopath records after insert/update/delete operations
 *
 * This plugin handles:
 * - Save seopath after insert
 * - Update seopath after update
 * - Delete seopath after delete
 */

import * as fs from 'fs';
import * as path from 'path';
import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, QueryResult, isSingleData } from '../../query/intermediate';

// Debug trace → <backend>/tmp/seopath-debug.log (append, never throws).
// Temporary instrumentation to diagnose why seopath records are not written.
const SEO_DBG_FILE = path.join(process.cwd(), 'tmp', 'seopath-debug.log');
function seoDbg(stage: string, data: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      SEO_DBG_FILE,
      `${new Date().toISOString()} [${stage}] ${JSON.stringify(data)}\n`,
    );
  } catch {}
}

// ============================================================================
// SEOPATH OPERATIONS INTERFACE
// ============================================================================

/**
 * Interface for seopath database operations
 */
export interface ISeopathOperations {
  /**
   * Find existing seopath records for a related ID
   */
  findByRelatedId(relatedId: string, session?: unknown): Promise<SeopathRecord[]>;

  /**
   * Insert a new seopath record
   */
  insert(record: SeopathRecord, session?: unknown): Promise<void>;

  /**
   * Update seopath records by ID
   */
  updateById(id: string, update: Partial<SeopathRecord>, session?: unknown): Promise<void>;

  /**
   * Update seopath records that match a filter
   */
  updateMany(
    filter: { slug?: string; relatedId?: string },
    update: Partial<SeopathRecord>,
    session?: unknown
  ): Promise<void>;

  /**
   * Delete seopath records by related IDs
   */
  deleteByRelatedIds(relatedIds: string[], session?: unknown): Promise<void>;
}

/**
 * Seopath record structure
 */
export interface SeopathRecord {
  _id?: string;
  slug: string;
  entity_slug?: string | string[];
  entity_save_data?: string;
  /** Name of the entity/schema that owns the record (= entity.collection_name) */
  collection_name?: string;
  tenant_id?: string;
  redirect_url?: string | null;
  locale?: string;
  locale_id?: string;
  related_id?: string[];
  created_at?: Date;
  updated_at?: Date;
}

/**
 * Entity schema for seopath
 */
export interface EntitySchema {
  _id?: string;
  collection_name?: string;
  languages?: Array<{ locale: string; slug: string }>;
  mongodb_save_data?: string;
}

// Global seopath operations instance
let seopathOperations: ISeopathOperations | null = null;

// Global entity schema getter
let entitySchemaGetter: ((collectionName: string) => EntitySchema | null) | null = null;

/**
 * Set the seopath operations implementation
 */
export function setSeopathOperations(ops: ISeopathOperations): void {
  seopathOperations = ops;
}

/**
 * Get the seopath operations implementation
 */
export function getSeopathOperations(): ISeopathOperations | null {
  return seopathOperations;
}

/**
 * Set the entity schema getter
 */
export function setEntitySchemaGetter(getter: (collectionName: string) => EntitySchema | null): void {
  entitySchemaGetter = getter;
}

/**
 * Get the entity schema getter
 */
export function getEntitySchemaGetter(): ((collectionName: string) => EntitySchema | null) | null {
  return entitySchemaGetter;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get current timestamp
 */
function getCurrentTime(): Date {
  return new Date();
}

/**
 * Get entity slug from entity schema and locale
 */
function getEntitySlug(entity: EntitySchema, locale?: string): string | string[] {
  if (!entity.languages || entity.languages.length === 0) {
    return entity.collection_name ? [entity.collection_name] : [];
  }

  const localeConfig = entity.languages.find((item) => item.locale === locale);
  return localeConfig?.slug || entity.collection_name || '';
}

/**
 * Get target entity for category (uses post_type entity for slug)
 */
function getTargetEntity(
  entity: EntitySchema,
  collectionName: string,
  data: Record<string, unknown>
): EntitySchema {
  // Special case for category
  if (
    collectionName === 'category' &&
    data.post_type &&
    Array.isArray(data.post_type) &&
    data.post_type.length > 0
  ) {
    const postTypeId = data.post_type[0];
    // This would need to look up the entity by _id
    // For now, return the original entity
    // The actual lookup should be done via entitySchemaGetter
  }
  return entity;
}

// ============================================================================
// SEOPATH HANDLERS
// ============================================================================

/**
 * Save seopath after insert
 */
async function saveSeopath(
  result: QueryResult<unknown>,
  query: IntermediateQuery
): Promise<void> {
  if (!seopathOperations) {
    console.warn('[SeopathPlugin] No seopath operations configured');
    seoDbg('save:return', { reason: 'no seopathOperations (inner)' });
    return;
  }

  if (!result.data || result.data.length === 0) {
    seoDbg('save:return', { reason: 'no result.data' });
    return;
  }

  const firstData = result.data[0] as Record<string, unknown>;
  // Universal discriminator: every record auto-tagged with `collection_name`
  // by core-service. Falls back to legacy `post_type` (use_posttype pattern)
  // then to `query.collection` (which is logical entity name after refactor).
  const collectionName = (Array.isArray(firstData.post_type) ? firstData.post_type[0] : firstData.post_type as string) 
    || (firstData.collection_name as string)
    || query.collection;
  
  seoDbg('save:resolved', {
    collectionName,
    id: String(firstData._id),
    slug: firstData.slug,
    tenant_id: firstData.tenant_id,
    hasEntityGetter: !!entitySchemaGetter,
  });
  if (!collectionName) {
    seoDbg('save:return', { reason: 'no collectionName' });
    return;
  }

  // Get entity schema
  const entity = entitySchemaGetter?.(collectionName);
  if (!entity) {
    console.warn(`[SeopathPlugin] Entity schema not found for ${collectionName}`);
    seoDbg('save:return', { reason: 'entity schema not found', collectionName });
    return;
  }

  // Skip entity collection itself
  if (
    entity.collection_name === 'entity' &&
    entity.mongodb_save_data === 'entity' &&
    collectionName === 'entity'
  ) {
    seoDbg('save:return', { reason: 'skip entity collection itself', collectionName });
    return;
  }

  const targetEntity = getTargetEntity(entity, collectionName, firstData);
  const entitySlug = getEntitySlug(targetEntity, firstData.locale as string | undefined);
  seoDbg('save:entitySlug', { collectionName, entitySlug, entity_use_slug: (entity as any)?.use_slug });
  const session = query.options?.session;

  try {
    // Update existing seopath records to set redirect_url
    const existingRecords = await seopathOperations.findByRelatedId(
      String(firstData._id),
      session
    );

    for (const record of existingRecords) {
      await seopathOperations.updateById(
        String(record._id),
        { redirect_url: firstData.slug as string },
        session
      );
    }

    // Check if seopath with this slug already exists for this related_id
    const existingWithSameSlug = existingRecords.find(
      (record) => record.slug === firstData.slug
    );

    seoDbg('save:branch', {
      slug: firstData.slug,
      existingRecords: existingRecords.length,
      branch: existingWithSameSlug ? 'update-existing' : 'insert-new',
    });

    if (existingWithSameSlug) {
      // Update existing record instead of inserting
      await seopathOperations.updateById(
        String(existingWithSameSlug._id),
        {
          entity_slug: entitySlug,
          collection_name: entity.collection_name,
          tenant_id: firstData.tenant_id as string | undefined,
          entity_save_data: query.physicalCollection || query.collection,
          redirect_url: null,
          locale: firstData.locale as string | undefined,
          locale_id: firstData.locale_id as string | undefined,
          updated_at: getCurrentTime(),
        },
        session
      );
    } else {
      // Insert new seopath record
      await seopathOperations.insert(
        {
          slug: firstData.slug as string,
          entity_slug: entitySlug,
          collection_name: entity.collection_name,
          tenant_id: firstData.tenant_id as string | undefined,
          entity_save_data: query.physicalCollection || query.collection,
          redirect_url: null,
          locale: firstData.locale as string | undefined,
          locale_id: firstData.locale_id as string | undefined,
          related_id: [String(firstData._id)],
          created_at: getCurrentTime(),
          updated_at: getCurrentTime(),
        },
        session
      );
    }
    seoDbg('save:done', { slug: firstData.slug, id: String(firstData._id) });
  } catch (err: any) {
    console.error('[SeopathPlugin] Error saving seopath:', err);
    seoDbg('save:error', { message: err?.message, code: err?.code, slug: firstData.slug });
    throw err;
  }
}

/**
 * Update seopath after update
 */
async function updateSeopath(
  result: QueryResult<unknown>,
  query: IntermediateQuery
): Promise<void> {
  if (!seopathOperations) {
    return;
  }

  if (!result.data || result.data.length === 0) {
    return;
  }

  const firstData = result.data[0] as Record<string, unknown>;
  // Universal discriminator from record itself (auto-tagged by core-service),
  // legacy post_type fallback, then query.collection.
  const collectionName = (Array.isArray(firstData.post_type) ? firstData.post_type[0] : firstData.post_type as string)
    || (firstData.collection_name as string)
    || query.collection;

  console.log(firstData)
  console.log(`[SeopathPlugin] Updating seopath for collection: ${collectionName}, id: ${firstData._id}`);

  if (!collectionName) {
    return;
  }

  const entity = entitySchemaGetter?.(collectionName);
  if (!entity) {
    return;
  }

  const targetEntity = getTargetEntity(entity, collectionName, firstData);
  const entitySlug = getEntitySlug(targetEntity, firstData.locale as string | undefined);
  const session = query.options?.session;

  try {
    // Update existing seopath records to set redirect_url
    const existingRecords = await seopathOperations.findByRelatedId(
      String(firstData._id),
      session
    );

    for (const record of existingRecords) {
      await seopathOperations.updateById(
        String(record._id),
        { redirect_url: firstData.slug as string },
        session
      );
    }

    // Update the current slug record
    await seopathOperations.updateMany(
      { slug: firstData.slug as string, relatedId: String(firstData._id) },
      {
        entity_slug: entitySlug,
        collection_name: entity.collection_name,
        tenant_id: firstData.tenant_id as string | undefined,
        entity_save_data: query.physicalCollection || query.collection,
        redirect_url: null,
        locale: firstData.locale as string | undefined,
        locale_id: firstData.locale_id as string | undefined,
        updated_at: getCurrentTime(),
      },
      session
    );

    // Update old slug records to redirect to new slug
    await seopathOperations.updateMany(
      { relatedId: String(firstData._id) },
      {
        entity_slug: entitySlug,
        collection_name: entity.collection_name,
        tenant_id: firstData.tenant_id as string | undefined,
        entity_save_data: query.physicalCollection || query.collection,
        redirect_url: firstData.slug as string,
        locale: firstData.locale as string | undefined,
        locale_id: firstData.locale_id as string | undefined,
        updated_at: getCurrentTime(),
      },
      session
    );
  } catch (err) {
    console.error('[SeopathPlugin] Error updating seopath:', err);
    throw err;
  }
}

/**
 * Delete seopath after delete
 */
async function deleteSeopath(
  ids: string[],
  _query: IntermediateQuery
): Promise<void> {
  if (!seopathOperations) {
    return;
  }

  try {
    await seopathOperations.deleteByRelatedIds(ids);
  } catch (err) {
    console.error('[SeopathPlugin] Error deleting seopath:', err);
    throw err;
  }
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Seopath plugin - manages seopath records
 *
 * Entity config:
 * - use_slug: true - This plugin works in conjunction with slug plugin
 */
export const seopathPlugin: PluginDefinition = definePlugin('use_slug', {
  description: 'Manages SEO path records after insert/update/delete',
  phases: ['after'],
  priority: 90, // Run after most other plugins
  enabled: true,

  after: async (
    query: IntermediateQuery,
    context: PluginContext,
    _nativeQuery?: unknown,
    result?: QueryResult<unknown>
  ): Promise<void> => {
    if (!result) { seoDbg('after:return', { reason: 'no result', type: query.type, collection: query.collection }); return; }
    if (!seopathOperations) { seoDbg('after:return', { reason: 'no seopathOperations', type: query.type, collection: query.collection }); return; }

    // Check for seopath flags from slug plugin
    const options = query.metadata?.options as Record<string, boolean> | undefined;
    seoDbg('after:enter', {
      type: query.type,
      collection: query.collection,
      physicalCollection: query.physicalCollection,
      no_save_seo_path: options?.no_save_seo_path,
      resultLen: Array.isArray(result.data) ? result.data.length : null,
    });

    switch (query.type) {
      case 'insert':
        // Save seopath after insert
        if (options?.no_save_seo_path !== true) {
          await saveSeopath(result, query);
        } else {
          seoDbg('after:skip-insert', { reason: 'no_save_seo_path===true', collection: query.collection });
        }
        break;

      case 'update':
        // Handle seopath after update
        if (options?.no_save_seo_path === false) {
          // New slug, save as new seopath + update old to redirect
          await saveSeopath(result, query);
        } else if (options?.no_update_seo_path === false || query.collection == "category") {
          // Update existing seopath
          await updateSeopath(result, query);
        }
        break;

      case 'delete':
      case 'deleteMany':
        // The adapter returns the deleted docs in result.data — get the _id from there
        // instead of relying on metadata.hints (the controller doesn't set ids).
        if (result.data && result.data.length > 0) {
          const deleteIds = (result.data as Array<Record<string, unknown>>)
            .map((d) => (d?._id != null ? String(d._id) : null))
            .filter((x): x is string => !!x);
          if (deleteIds.length > 0) {
            await deleteSeopath(deleteIds, query);
          }
        }
        break;
    }
  },
});

export default seopathPlugin;
