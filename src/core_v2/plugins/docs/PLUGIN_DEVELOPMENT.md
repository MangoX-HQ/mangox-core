# Plugin Development Guide

## Overview

Plugins in Core V2 allow you to extend functionality at different phases of query execution:

- **Before Phase**: Transform input data before query is built
- **Main Phase**: Modify native query (MongoDB aggregation pipeline)
- **After Phase**: Transform result data after query execution

---

## Plugin Structure

```typescript
import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, QueryResult } from '../../query/intermediate';

export const myPlugin: PluginDefinition = definePlugin('use_my_plugin', {
  description: 'Description of what this plugin does',
  phases: ['before', 'main', 'after'],  // Which phases to run
  priority: 50,  // Lower = runs first (0-100)
  enabled: true,

  before: async (
    query: IntermediateQuery,
    context: PluginContext
  ): Promise<void> => {
    // Modify query.data before execution
  },

  main: (
    query: IntermediateQuery,
    context: PluginContext,
    nativeQuery?: unknown
  ): void => {
    // Modify nativeQuery (MongoDB aggregation pipeline)
  },

  after: async (
    query: IntermediateQuery,
    context: PluginContext,
    nativeQuery?: unknown,
    result?: QueryResult<unknown>
  ): Promise<void> => {
    // Modify result.data after execution
  },
});
```

---

## Plugin Context

```typescript
interface PluginContext {
  collection: string;           // Collection name
  entityConfig: Record<string, unknown>;  // Entity configuration
  // Contains use_my_plugin: true/false, json_schema, etc.
}
```

---

## Intermediate Query

```typescript
interface IntermediateQuery {
  type: 'read' | 'insert' | 'update' | 'delete' | 'deleteMany';
  collection: string;
  postTypeCollectionName?: string;  // For post-type-content
  data?: Record<string, unknown>;   // Insert/update data
  securityFilters: FieldCondition[];
  filter?: Filter;
  pagination?: { limit?: number; offset?: number };
  sort?: SortClause[];
  select?: SelectClause;
  joins?: JoinClause[];
  options?: Record<string, unknown>;
  metadata?: {
    database?: string;
    timestamp?: Date;
    user?: UserContext;
    hints?: Record<string, unknown>;
    options?: Record<string, unknown>;
  };
}
```

---

## Example: Auto-Generate Field Plugin

```typescript
import { definePlugin, PluginDefinition } from '../plugin-manager';
import { IntermediateQuery, isSingleData } from '../../query/intermediate';

export const autoCodePlugin: PluginDefinition = definePlugin('use_auto_code', {
  description: 'Auto-generates a unique code on insert',
  phases: ['before'],
  priority: 10,  // Run early
  enabled: true,

  before: async (query, context) => {
    // Only run on insert
    if (query.type !== 'insert') return;

    // Check if plugin is enabled for this entity
    if (!context.entityConfig.use_auto_code) return;

    // Only handle single data
    if (!isSingleData(query.data)) return;

    // Generate code if not provided
    if (!query.data.code) {
      const prefix = context.entityConfig.code_prefix || 'CODE';
      const timestamp = Date.now();
      query.data.code = `${prefix}-${timestamp}`;
    }
  },
});
```

---

## Example: Computed Field Plugin (Main Phase)

```typescript
export const fullNamePlugin: PluginDefinition = definePlugin('use_full_name', {
  description: 'Computes full_name from first_name and last_name',
  phases: ['main'],
  priority: 50,
  enabled: true,

  main: (query, context, nativeQuery) => {
    // Only for read operations
    if (query.type !== 'read') return;

    // Only for MongoDB (nativeQuery is array = aggregation pipeline)
    if (!Array.isArray(nativeQuery)) return;

    // Check if plugin is enabled
    if (!context.entityConfig.use_full_name) return;

    // Add computed field
    nativeQuery.push({
      $addFields: {
        full_name: {
          $concat: [
            { $ifNull: ['$first_name', ''] },
            ' ',
            { $ifNull: ['$last_name', ''] }
          ]
        }
      }
    });
  },
});
```

---

## Example: Post-Processing Plugin (After Phase)

```typescript
export const formatDatePlugin: PluginDefinition = definePlugin('use_format_date', {
  description: 'Formats date fields to ISO string',
  phases: ['after'],
  priority: 90,  // Run late
  enabled: true,

  after: async (query, context, nativeQuery, result) => {
    // Only for read operations with results
    if (query.type !== 'read' || !result?.data) return;

    // Check if plugin is enabled
    if (!context.entityConfig.use_format_date) return;

    const dateFields = context.entityConfig.date_fields as string[] || ['created_at', 'updated_at'];

    for (const item of result.data as Record<string, unknown>[]) {
      for (const field of dateFields) {
        if (item[field] instanceof Date) {
          item[field] = (item[field] as Date).toISOString();
        }
      }
    }
  },
});
```

---

## Example: External API Integration

```typescript
// Plugin that enriches data from external API
export const enrichPlugin: PluginDefinition = definePlugin('use_enrich', {
  description: 'Enriches data with external API',
  phases: ['after'],
  priority: 80,
  enabled: true,

  after: async (query, context, nativeQuery, result) => {
    if (query.type !== 'read' || !result?.data) return;
    if (!context.entityConfig.use_enrich) return;

    const enrichField = context.entityConfig.enrich_field as string || 'external_id';
    const enrichUrl = context.entityConfig.enrich_url as string;

    if (!enrichUrl) return;

    for (const item of result.data as Record<string, unknown>[]) {
      const externalId = item[enrichField];
      if (externalId) {
        try {
          const response = await fetch(`${enrichUrl}/${externalId}`);
          const enrichData = await response.json();
          item.enriched_data = enrichData;
        } catch (error) {
          console.warn(`Failed to enrich ${externalId}:`, error);
        }
      }
    }
  },
});
```

---

## Dependency Injection Pattern

For plugins that need external dependencies (database access, caching, etc.):

```typescript
// Define interface for external operations
export interface IMyOperations {
  findRelated(id: string): Promise<unknown>;
  saveCache(key: string, data: unknown): Promise<void>;
}

// Global instance
let myOperations: IMyOperations | null = null;

export function setMyOperations(ops: IMyOperations): void {
  myOperations = ops;
}

export function getMyOperations(): IMyOperations | null {
  return myOperations;
}

// Plugin uses injected operations
export const myPlugin: PluginDefinition = definePlugin('use_my_feature', {
  phases: ['after'],

  after: async (query, context, nativeQuery, result) => {
    if (!myOperations) {
      console.warn('[use_my_feature] Operations not configured');
      return;
    }

    // Use injected operations
    const related = await myOperations.findRelated('some-id');
    await myOperations.saveCache('key', result);
  },
});

// In initialization
setMyOperations({
  findRelated: async (id) => {
    return mongoDb.collection('related').findOne({ _id: id });
  },
  saveCache: async (key, data) => {
    await redisClient.set(key, JSON.stringify(data));
  },
});
```

---

## Registering Plugins

```typescript
import { createPluginManager } from './core_v2';
import { myPlugin } from './my-plugin';

// Create plugin manager
const pluginManager = createPluginManager({
  enabled: true,
  beforePlugins: ['use_my_plugin'],  // Add to appropriate phase
  mainPlugins: [],
  afterPlugins: [],
});

// Register plugin
pluginManager.register(myPlugin);

// Or register multiple
pluginManager.registerMany([myPlugin, anotherPlugin]);
```

---

## Plugin Execution Order

1. Plugins run in order of their **priority** (lower = first)
2. Within same priority, order is undefined
3. Plugins only run if:
   - Enabled globally (`config.plugins.enabled`)
   - Listed in appropriate phase array (`beforePlugins`, etc.)
   - Entity config has the flag (`use_my_plugin: true`)

```typescript
// Priority examples
const plugins = [
  { name: 'use_timestamp', priority: 10 },   // Runs 1st
  { name: 'use_locale', priority: 20 },      // Runs 2nd
  { name: 'use_slug', priority: 30 },        // Runs 3rd
  { name: 'use_history', priority: 100 },    // Runs last
];
```

---

## Best Practices

### 1. Check Plugin Enabled

```typescript
// Always check entity config
if (!context.entityConfig.use_my_plugin) return;
```

### 2. Handle Query Types

```typescript
// Most plugins only apply to specific operations
if (query.type !== 'insert') return;
// or
if (!['insert', 'update'].includes(query.type)) return;
```

### 3. Graceful Degradation

```typescript
// Don't crash if dependencies missing
if (!myOperations) {
  console.warn('[MyPlugin] Operations not configured, skipping');
  return;
}
```

### 4. Avoid Side Effects in Main Phase

```typescript
// Main phase should only modify nativeQuery
// Don't make API calls or database writes in main phase
main: (query, context, nativeQuery) => {
  // Good: modify query
  nativeQuery.push({ $addFields: { ... } });

  // Bad: side effects
  // await saveToDatabase();  // DON'T DO THIS
},
```

### 5. Use Proper Priority

| Priority Range | Use Case |
|----------------|----------|
| 0-20 | Validation, early transforms |
| 20-50 | Core functionality |
| 50-80 | Enrichment, computed fields |
| 80-100 | Final transforms, cleanup |

---

## Testing Plugins

```typescript
import { createPluginManager } from './core_v2';
import { myPlugin } from './my-plugin';

describe('myPlugin', () => {
  it('should add field on insert', async () => {
    const pluginManager = createPluginManager({
      enabled: true,
      beforePlugins: ['use_my_plugin'],
    });
    pluginManager.register(myPlugin);

    const query = {
      type: 'insert',
      collection: 'test',
      data: { title: 'Test' },
    };

    const context = {
      collection: 'test',
      entityConfig: { use_my_plugin: true },
    };

    await pluginManager.executeBefore(query, context);

    expect(query.data.my_field).toBeDefined();
  });
});
```
