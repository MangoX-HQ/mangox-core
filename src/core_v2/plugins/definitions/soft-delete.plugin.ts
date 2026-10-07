/**
 * Core V2 - Soft Delete Plugin
 * Converts delete operations to updates with deleted=true
 * Automatically filters out deleted records on read
 */

import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, FieldCondition, FilterGroup, isSingleData, isBulkData } from '../../query/intermediate';
 
// ============================================================================
// SOFT DELETE HELPERS
// ============================================================================

/**
 * Add deleted flag to data — uses root-level fields (no "system" wrapper)
 * to match config.systemFields naming.
 */
function addDeletedFlag(data: Record<string, unknown>, user_id: string): Record<string, unknown> {
  data["deleted"] = true;
  data["deleted_at"] = new Date();
  data["deleted_by"] = user_id;
  return data;
}

/**
 * Create filter to exclude deleted records
 */
function createNotDeletedFilter(): FilterGroup {
  return {
    operator: 'or',
    conditions: [
      { field: 'deleted', operator: 'exists', value: false },
      { field: 'deleted', operator: 'eq', value: false },
    ],
  };
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Soft Delete plugin - converts delete to update with deleted=true
 *
 * Entity config:
 * - use_soft_delete: true/false - Enable/disable plugin
 */
export const softDeletePlugin: PluginDefinition = definePlugin('use_soft_delete', {
  description: 'Converts delete operations to updates and filters deleted records',
  phases: ['before'],
  priority: 20,
  enabled: true,

  before: (query: IntermediateQuery, context: PluginContext): void => {
    switch (query.type) {
      case 'delete':
        // Convert delete to update - use empty base for soft delete
        const baseData = isSingleData(query.data) ? query.data : {};
        query.data = addDeletedFlag(baseData, query.metadata.user.user_id);
        query.type = 'update';
        if (!query.metadata.options) {
          query.metadata.options = {};
        }
        query.metadata.options.partial = true;
        break;

      case 'deleteMany':
        // Convert deleteMany to updateMany
        const baseManyData = isSingleData(query.data) ? query.data : {};
        query.data = addDeletedFlag(baseManyData, query.metadata.user.user_id);
        // Remove slug if present (from v1 logic)
        if (isSingleData(query.data) && 'slug' in query.data) {
          delete query.data.slug;
        }
        query.type = 'updateMany';
        if (!query.metadata.options) {
          query.metadata.options = {};
        }
        query.metadata.options.partial = true;
        break;

      case 'read':
        // Add filter to exclude deleted records
        const notDeletedFilter = createNotDeletedFilter();

        if (!query.userFilter) {
          // No existing filter, just use the not-deleted filter
          query.userFilter = notDeletedFilter;
        } else {
          // Combine with existing filter using AND
          const existingFilter = query.userFilter;
          query.userFilter = {
            operator: 'and',
            nested: [
              existingFilter as FilterGroup,
              notDeletedFilter,
            ],
          };
        }
        break;
    }
  },
});

export default softDeletePlugin;
