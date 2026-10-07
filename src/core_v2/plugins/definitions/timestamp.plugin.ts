/**
 * Core V2 - Timestamp Plugin
 * Automatically adds created_at and updated_at timestamps
 */

import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, isSingleData, isBulkData } from '../../query/intermediate';

// ============================================================================
// TIMESTAMP HELPERS
// ============================================================================

/**
 * Get current timestamp
 */
function getCurrentTimestamp(): Date {
  return new Date();
}

/**
 * Add created_at timestamp to data
 */
function addCreatedAt(data: Record<string, unknown>, date: Date): Record<string, unknown> {
  data["created_at"] = date;
  return data;
}

/**
 * Add updated_at timestamp to data
 */
function addUpdatedAt(data: Record<string, unknown>, date: Date): Record<string, unknown> {
  data["updated_at"] = date;
  return data;
}

/**
 * Add both timestamps for insert
 */
function addTimestamps(data: Record<string, unknown>, date: Date): Record<string, unknown> {
  return addUpdatedAt(addCreatedAt(data, date), date);
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Timestamp plugin - automatically manages created_at and updated_at fields
 *
 * Entity config:
 * - use_timestamp: true/false - Enable/disable plugin
 */
export const timestampPlugin: PluginDefinition = definePlugin('use_timestamp', {
  description: 'Automatically adds created_at and updated_at timestamps',
  phases: ['before'],
  priority: 10,
  enabled: true,

  before: (query: IntermediateQuery, context: PluginContext): void => {
    const now = getCurrentTimestamp();

    switch (query.type) {
      case 'insert':
        if (isSingleData(query.data)) {
          query.data = addTimestamps(query.data, now);
        } else if (isBulkData(query.data)) {
          query.data = query.data.map(item => addTimestamps(item, now));
        }
        break;

      case 'update':
      case 'updateMany':
      case 'replace':
        if (isSingleData(query.data)) {
          query.data = addUpdatedAt(query.data, now);
        } else if (isBulkData(query.data)) {
          query.data = query.data.map(item => addUpdatedAt(item, now));
        }
        break;
    }
  },
});

export default timestampPlugin;
