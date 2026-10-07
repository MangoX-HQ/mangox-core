/**
 * Core V2 - Pin Plugin
 * Handles pinned item sorting
 */

import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery } from '../../query/intermediate';

// ============================================================================
// PIN CONSTANTS
// ============================================================================

/**
 * Default pin position for unpinned items
 */
const UNPINNED_POSITION = 999;

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Pin plugin - handles pinned item sorting
 *
 * Entity config:
 * - use_pinned: true/false - Enable/disable plugin
 *
 * Adds virtual field:
 * - is_pinned: boolean - Whether item is pinned
 *
 * Sorting:
 * - Pinned items appear first, sorted by pinned position
 */
export const pinPlugin: PluginDefinition = definePlugin('use_pinned', {
  description: 'Handles pinned item sorting',
  phases: ['main'],
  priority: 5,
  enabled: true,

  main: (query: IntermediateQuery, context: PluginContext, nativeQuery?: unknown): void => {
    // Only applies to read operations with MongoDB pipeline
    if (query.type !== 'read' || !Array.isArray(nativeQuery)) {
      return;
    }

    // Add pinned field handling at the beginning of pipeline
    nativeQuery.unshift(
      // Set default pinned value for items without pinned field
      {
        $addFields: {
          pinned: { $ifNull: ['$pinned', UNPINNED_POSITION] },
        },
      },
      // Add computed is_pinned field
      {
        $addFields: {
          is_pinned: {
            $cond: {
              if: { $ne: ['$pinned', UNPINNED_POSITION] },
              then: true,
              else: false,
            },
          },
        },
      }
    );

    // Modify or add sort to prioritize pinned items
    const sortStageIndex = nativeQuery.findIndex((stage: Record<string, unknown>) => stage.$sort);

    if (sortStageIndex !== -1) {
      // Add pinned to existing sort
      const sortStage = nativeQuery[sortStageIndex] as { $sort: Record<string, number> };
      sortStage.$sort = {
        pinned: 1,
        ...sortStage.$sort,
      };
    } else {
      // Add new sort stage
      nativeQuery.push({ $sort: { pinned: 1 } });
    }
  },
});

export default pinPlugin;
