/**
 * Core V2 - Generator Plugin
 *
 * Automatically generates field values during insert operations.
 * Supports:
 * - UUID v4 generation
 *
 * Configuration in entity: use_generate_fields = "field1:uuidv4,field2:uuidv4"
 */

import { v4 as uuidv4 } from 'uuid';
import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, isSingleData, isBulkData } from '../../query/intermediate';

// ============================================================================
// TYPES
// ============================================================================

export type GeneratorType = 'uuidv4';

export interface GeneratorConfig {
  field: string;
  type: GeneratorType;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse generator configuration string
 * Format: "field1:uuidv4,field2:uuidv4"
 */
function parseGeneratorConfig(configString: string): GeneratorConfig[] {
  if (!configString) return [];

  return configString.split(',').map(item => {
    const [field, type] = item.trim().split(':');
    return {
      field: field.trim(),
      type: (type?.trim() || 'uuidv4') as GeneratorType,
    };
  }).filter(config => config.field);
}

/**
 * Generate value based on type
 */
function generateValue(type: GeneratorType): string | undefined {
  switch (type) {
    case 'uuidv4':
      return uuidv4();
    default:
      return undefined;
  }
}

/**
 * Apply generators to data object
 */
function applyGenerators(
  data: Record<string, unknown>,
  configs: GeneratorConfig[]
): Record<string, unknown> {
  const result = { ...data };
  for (const config of configs) {
    // Only generate if field is not already set
    if (!result[config.field]) {
      const value = generateValue(config.type);
      if (value !== undefined) {
        result[config.field] = value;
      }
    }
  }
  return result;
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Generator plugin - auto-generates field values on insert
 *
 * Entity config:
 * - use_generate_fields: "field1:uuidv4,field2:uuidv4"
 */
export const generatorPlugin: PluginDefinition = definePlugin('use_generate_fields', {
  description: 'Automatically generates field values (UUID, etc.) on insert',
  phases: ['before'],
  priority: 5,
  enabled: true,

  before: (query: IntermediateQuery, context: PluginContext): void => {
    // Only apply to insert operations
    if (query.type !== 'insert') return;

    // Get generator config from entity
    const configString = context.entityConfig?.use_generate_fields;
    if (!configString || typeof configString !== 'string') return;

    // Parse configuration
    const configs = parseGeneratorConfig(configString);
    if (configs.length === 0) return;

    // Apply generators to data
    if (isSingleData(query.data)) {
      query.data = applyGenerators(query.data, configs);
    } else if (isBulkData(query.data)) {
      query.data = query.data.map(item => applyGenerators(item, configs));
    }
  },
});

// ============================================================================
// EXPORTS
// ============================================================================

export default generatorPlugin;
