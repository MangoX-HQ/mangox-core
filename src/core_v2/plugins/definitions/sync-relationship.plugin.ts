/**
 * Core V2 - Sync Relationship Plugin
 *
 * Synchronizes relationship fields across language versions of documents.
 * When a document is updated, this plugin updates the same relationship
 * fields in all other language versions (documents with same locale_id).
 *
 * Entity config: use_sync_relationship_multiply_language = true
 */

import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, QueryResult } from '../../query/intermediate';

// ============================================================================
// TYPES
// ============================================================================

export interface RelationshipInfo {
  localField: string;
  foreignField: string;
  targetTable: string;
}

export interface ISyncRelationshipOperations {
  /**
   * Get MongoDB collection for direct operations
   */
  getCollection(name: string): Promise<{
    find(filter: Record<string, unknown>): { toArray(): Promise<unknown[]> };
    updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>
    ): Promise<unknown>;
  }>;

  /**
   * Get relationships for a table
   */
  getRelationships(tableName: string): RelationshipInfo[];

  /**
   * Invalidate cache for collection
   */
  invalidateCache?(collection: string): Promise<void>;
}

// ============================================================================
// DEPENDENCY INJECTION
// ============================================================================

let syncOperations: ISyncRelationshipOperations | null = null;

/**
 * Set sync relationship operations (call during initialization)
 */
export function setSyncRelationshipOperations(ops: ISyncRelationshipOperations): void {
  syncOperations = ops;
}

/**
 * Get sync relationship operations
 */
export function getSyncRelationshipOperations(): ISyncRelationshipOperations | null {
  return syncOperations;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get nested value from object by path
 */
function getValueByPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  return path.split('.').reduce((acc: unknown, key: string) => {
    if (acc && typeof acc === 'object' && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Sync relationship plugin for multi-language support
 *
 * Entity config:
 * - use_sync_relationship_multiply_language: true
 */
export const syncRelationshipPlugin: PluginDefinition = definePlugin('use_sync_relationship_multiply_language', {
  description: 'Synchronizes relationship fields across language versions',
  phases: ['after'],
  priority: 100,
  enabled: true,

  after: async (
    query: IntermediateQuery,
    context: PluginContext,
    _nativeQuery: unknown,
    result?: QueryResult
  ): Promise<void> => {
    // Only apply to update operations
    if (query.type !== 'update') return;

    // Check if plugin is enabled
    if (!context.entityConfig?.use_sync_relationship_multiply_language) return;

    // Check if result is available
    if (!result) return;

    // Check if operations are set
    if (!syncOperations) {
      console.warn('[Sync Relationship Plugin] Operations not initialized');
      return;
    }

    // Get the updated document
    const data = result.data?.[0];
    if (!data || typeof data !== 'object') return;

    const dataObj = data as Record<string, unknown>;
    const localeId = dataObj.locale_id as string;
    const locale = dataObj.locale as string;

    // Need locale_id and locale for multi-language sync
    if (!localeId || !locale) return;

    try {
      // Get collection and find other language versions
      const collection = await syncOperations.getCollection(query.collection);
      const otherLanguages = await collection
        .find({
          locale_id: localeId,
          locale: { $ne: locale },
        })
        .toArray();

      if (otherLanguages.length === 0) return;

      // Get relationships for this collection
      const collectionName = query.collection;
      const relationships = syncOperations.getRelationships(collectionName);

      if (!relationships || relationships.length === 0) return;

      // Find relationships that need syncing (those linked by locale_id)
      const syncableRelations = relationships.filter((rel: RelationshipInfo) => {
        // Skip blocks and blocks_position
        if (rel.localField === 'blocks' || rel.localField === 'blocks_position') {
          return false;
        }
        // Only sync relationships linked by locale_id
        return rel.foreignField === 'locale_id';
      });

      if (syncableRelations.length === 0) return;

      // Sync each relationship field to other language versions
      let hasUpdates = false;
      for (const relation of syncableRelations) {
        const fieldValue = getValueByPath(dataObj, relation.localField);
        if (fieldValue === undefined) continue;

        for (const langDoc of otherLanguages) {
          const langDocObj = langDoc as Record<string, unknown>;
          await collection.updateOne(
            { _id: langDocObj._id },
            { $set: { [relation.localField]: fieldValue } }
          );
          hasUpdates = true;
        }
      }

      // Invalidate cache if updates were made
      if (hasUpdates && syncOperations.invalidateCache) {
        try {
          await syncOperations.invalidateCache(query.collection);

          // Also invalidate related target tables
          const relatedTables = [...new Set(
            syncableRelations.map((r: RelationshipInfo) => r.targetTable)
          )];

          for (const table of relatedTables) {
            if (table) {
              await syncOperations.invalidateCache(table);
            }
          }
        } catch (cacheError) {
          console.warn('[Sync Relationship Plugin] Cache invalidation failed:', cacheError);
        }
      }
    } catch (error) {
      console.error('[Sync Relationship Plugin] Error:', error);
      // Don't throw - this is a background sync operation
    }
  },
});

// ============================================================================
// EXPORTS
// ============================================================================

export default syncRelationshipPlugin;
