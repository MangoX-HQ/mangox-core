/**
 * Core V2 - Entity Config Loader
 *
 * Runtime layer for `entity`:
 *  - Parse json_schema → relationship graph + register into RelationshipRegistry
 *  - Auto-inject default relations (created_by/updated_by → user)
 *  - Cache EntityConfig + plugin flags in RAM (Map per instance)
 *
 * Data source: Redis (via schemaManager) — does NOT read fs or the DB directly.
 */

import { IRelationshipRegistry, RelationshipDefinition } from '../interfaces/adapter.interface';
import { getRelationshipRegistry } from '../adapters/base/relationship-registry';

// ============================================================================
// ENTITY CONFIG TYPES
// ============================================================================

/**
 * Entity configuration structure
 */
export interface EntityConfig {
  _id?: string;
  title: string;
  name?: string;
  collection_name?: string;
  mongodb_save_data?: string;
  unique_key?: string;

  // Plugin flags
  use_parent?: boolean;
  use_parent_delete_childs?: boolean;
  use_timestamp?: boolean;
  use_soft_delete?: boolean;
  use_locale?: boolean;
  use_slug?: boolean;
  use_history?: boolean;
  use_block?: boolean;
  use_pinned?: boolean;
  use_generate_fields?: Record<string, unknown>;
  use_sync_relationship_multiply_language?: boolean;

  // Schema
  json_schema?: JSONSchema;
  ui_schema?: Record<string, unknown>;

  // Additional plugins config
  plugins?: Record<string, unknown>;
}

/**
 * JSON Schema structure
 */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * JSON Schema property
 */
export interface JSONSchemaProperty {
  type?: string | string[];
  widget?: string;
  typeRelation?: {
    type?: string;
    collection?: string;
    entity?: string;
    title?: string;
    collection_name?: string;
    junction?: {
      table: string;
      localKey?: string;
      foreignKey?: string;
    };
  };
  refValue?: string;
  refValueAdmin?: string;
  properties?: Record<string, JSONSchemaProperty>;
  items?: JSONSchemaProperty;
  [key: string]: unknown;
}

/**
 * Entities data container
 */
export interface EntitiesData {
  documents: EntityConfig[];
}

// ============================================================================
// ENTITY CONFIG SOURCE INTERFACE
// ============================================================================

/**
 * Interface for entity config data source
 */
export interface IEntityConfigSource {
  /**
   * Load all entity configurations
   */
  loadAll(): Promise<EntityConfig[]>;

  /**
   * Load single entity configuration
   * @param tenantSlug - optional tenant scope; sources may use it to read tenant-scoped cache
   */
  load(collectionName: string, tenantSlug?: string): Promise<EntityConfig | null>;

  /**
   * Check if entity exists
   */
  exists(collectionName: string): Promise<boolean>;
}

// ============================================================================
// ENTITY CONFIG LOADER
// ============================================================================

/**
 * Entity configuration loader and manager
 */
export class EntityConfigLoader {
  private source: IEntityConfigSource;
  private relationshipRegistry: IRelationshipRegistry;
  private cache: Map<string, EntityConfig> = new Map();
  private pluginsCache: Map<string, Record<string, unknown>> = new Map();
  private initialized = false;

  constructor(
    source: IEntityConfigSource,
    relationshipRegistry?: IRelationshipRegistry
  ) {
    this.source = source;
    this.relationshipRegistry = relationshipRegistry || getRelationshipRegistry();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  private buildDefaultRelations(collectionName: string): RelationshipDefinition[] {
    return [
      {
        name: 'created_by',
        sourceCollection: collectionName,
        targetCollection: 'user',
        localField: 'created_by',
        foreignField: '_id',
        type: 'one-to-one',
      },
      {
        name: 'updated_by',
        sourceCollection: collectionName,
        targetCollection: 'user',
        localField: 'updated_by',
        foreignField: '_id',
        type: 'one-to-one',
      }
    ];
  }

  /**
   * Initialize the loader - load all entities and register relationships
   *
   * Two-pass:
   * - Pass 1: cache every entity so target lookup works regardless of order.
   * - Pass 2: parse relationships; resolve mongodb_save_data → physical
   *   collection + discriminator filter when target is polymorphic.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const entities = await this.source.loadAll();
    console.log(`[EntityConfigLoader] Loaded ${entities.length} entities`);

    // Pass 1: populate cache so parseRelationshipsFromSchema can look up any target
    for (const entity of entities) {
      const collectionName = this.getCollectionName(entity);
      if (!collectionName) continue;
      this.cache.set(collectionName, entity);
      this.pluginsCache.set(collectionName, this.extractPlugins(entity));
    }

    // Pass 2: parse + register relationships
    let totalRelationships = 0;
    for (const entity of entities) {
      const collectionName = this.getCollectionName(entity);
      if (!collectionName) continue;

      if (entity.json_schema) {
        const relationships = this.parseRelationshipsFromSchema(
          entity.json_schema,
          collectionName
        );

        for (const rel of relationships) {
          this.relationshipRegistry.register(rel);
          totalRelationships++;

          // Register inverse relationship with mangox prefix
          const inverse = this.createInverseRelationship(rel);
          this.relationshipRegistry.register(inverse);
          totalRelationships++;
        }

        if (relationships.length > 0) {
          console.log(`[EntityConfigLoader] Registered ${relationships.length} relationships (+ ${relationships.length} inverse) for '${collectionName}':`, relationships.map(r => r.name));
        }
      }

      // Register default relations (created_by, updated_by → user)
      for (const rel of this.buildDefaultRelations(collectionName)) {
        if (!this.relationshipRegistry.getByName(collectionName, rel.name)) {
          this.relationshipRegistry.register(rel);
          totalRelationships++;
        }
      }
    }

    console.log(`[EntityConfigLoader] Total relationships registered: ${totalRelationships}`);
    this.initialized = true;
  }

  /**
   * Get collection name from entity config
   */
  private getCollectionName(entity: EntityConfig): string | null {
    return entity.collection_name || entity.name || null;
  }

  /**
   * Extract plugin configuration from entity
   */
  private extractPlugins(entity: EntityConfig): Record<string, unknown> {
    const plugins: Record<string, unknown> = {};

    // Extract standard plugin flags
    const pluginKeys = [
      'use_parent',
      'use_parent_delete_childs',
      'use_timestamp',
      'use_soft_delete',
      'use_locale',
      'use_slug',
      'use_history',
      'use_block',
      'use_pinned',
      'use_generate_fields',
      'use_sync_relationship_multiply_language',
    ];

    for (const key of pluginKeys) {
      const entityRecord = entity as unknown as Record<string, unknown>;
      if (entityRecord[key] !== undefined) {
        plugins[key] = entityRecord[key];
      }
    }

    // Merge with explicit plugins config
    if (entity.plugins) {
      Object.assign(plugins, entity.plugins);
    }

    return plugins;
  }

  // ============================================================================
  // RELATIONSHIP PARSING
  // ============================================================================

  /**
   * Parse relationships from JSON schema
   */
  private parseRelationshipsFromSchema(
    schema: JSONSchema,
    sourceCollection: string,
    parentPath = ''
  ): RelationshipDefinition[] {
    const relationships: RelationshipDefinition[] = [];

    if (!schema?.properties) {
      return relationships;
    }

    for (const [fieldName, fieldDef] of Object.entries(schema?.properties)) {
      const currentPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;
      const nameRelation = currentPath.split('.').join('_');

      // Check for relation widget
      if (fieldDef.widget === 'relation' && fieldDef.typeRelation) {
        const relation = fieldDef.typeRelation;
        const relType = this.convertRelationType(relation.type);
        const logicalTarget =
          relation.collection ||
          relation.entity ||
          relation.title ||
          relation.collection_name;

        if (logicalTarget) {
          // Resolve polymorphic routing: if target entity has mongodb_save_data,
          // join must hit the physical collection AND filter by discriminator.
          const targetEntity = this.cache.get(logicalTarget) as
            | (EntityConfig & { mongodb_save_data?: string; discriminator_field?: string })
            | undefined;
          const physicalTarget =
            (targetEntity?.mongodb_save_data && targetEntity.mongodb_save_data !== logicalTarget)
              ? targetEntity.mongodb_save_data
              : logicalTarget;
          const discriminator = physicalTarget !== logicalTarget
            ? {
                field: targetEntity?.discriminator_field || 'collection_name',
                value: logicalTarget,
              }
            : undefined;

          const relationship: RelationshipDefinition = {
            name: nameRelation,
            sourceCollection,
            targetCollection: physicalTarget,
            localField: currentPath,
            foreignField: fieldDef.refValue || '_id',
            type: relType,
            ...(discriminator ? { discriminator } : {}),
          };

          // Handle many-to-many with junction table
          if (relType === 'many-to-many' && relation.junction) {
            relationship.junction = {
              table: relation.junction.table,
              localKey: relation.junction.localKey || `${sourceCollection}_id`,
              foreignKey: relation.junction.foreignKey || `${logicalTarget}_id`,
            };
          }

          relationships.push(relationship);
        }
      }

      // Check for file/multipleFiles widgets
      if (fieldDef.widget === 'file' || fieldDef.widget === 'multipleFiles') {
        relationships.push({
          name: nameRelation,
          sourceCollection,
          targetCollection: 'media',
          localField: currentPath,
          foreignField: '_id',
          type: fieldDef.widget === 'file' ? 'one-to-one' : 'one-to-many',
        });
      }

      // Handle nested objects
      if (fieldDef.type === 'object' && fieldDef?.properties) {
        const nestedRelations = this.parseRelationshipsFromSchema(
          fieldDef as JSONSchema,
          sourceCollection,
          currentPath
        );
        relationships.push(...nestedRelations);
      }

      // Handle array of objects
      if (
        fieldDef.type === 'array' &&
        fieldDef.items &&
        fieldDef.items?.properties
      ) {
        const arrayRelations = this.parseRelationshipsFromSchema(
          fieldDef.items as JSONSchema,
          sourceCollection,
          currentPath
        );
        relationships.push(...arrayRelations);
      }
    }

    return relationships;
  }

  /**
   * Create inverse relationship definition with mangox prefix
   */
  private createInverseRelationship(
    rel: RelationshipDefinition
  ): RelationshipDefinition {
    return {
      name: `mangox_${rel.sourceCollection}_${rel.name}`,
      sourceCollection: rel.targetCollection,
      targetCollection: rel.sourceCollection,
      localField: rel.foreignField,
      foreignField: rel.localField,
      type: this.invertRelationType(rel.type),
      junction: rel.junction
        ? {
            table: rel.junction.table,
            localKey: rel.junction.foreignKey || '',
            foreignKey: rel.junction.localKey || '',
          }
        : undefined,
    };
  }

  /**
   * Invert relationship type for reverse direction
   */
  private invertRelationType(
    type: RelationshipDefinition['type']
  ): RelationshipDefinition['type'] {
    switch (type) {
      case 'one-to-many':
        return 'many-to-one';
      case 'many-to-one':
        return 'one-to-many';
      case 'one-to-one':
        return 'one-to-one';
      case 'many-to-many':
        return 'many-to-many';
      default:
        return type;
    }
  }

  /**
   * Convert relationship type from schema format
   */
  private convertRelationType(
    type?: string
  ): 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' {
    if (!type) return 'one-to-many';

    const normalized = type.toLowerCase().replace(/\s+/g, '');

    switch (normalized) {
      case '1-1':
      case 'onetoone':
      case 'one-to-one':
        return 'one-to-one';

      case '1-n':
      case '1-*':
      case 'onetomany':
      case 'one-to-many':
        return 'one-to-many';

      case 'n-1':
      case '*-1':
      case 'manytoone':
      case 'many-to-one':
        return 'many-to-one';

      case 'n-n':
      case '*-*':
      case 'n-*':
      case '*-n':
      case 'manytomany':
      case 'many-to-many':
        return 'many-to-many';

      default:
        return 'one-to-many';
    }
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  /**
   * Get entity configuration by collection name
   */
  getEntity(collectionName: string): EntityConfig | null {
    return this.cache.get(collectionName) || null;
  }

  /**
   * Get plugin configuration for collection
   */
  getPlugins(collectionName: string): Record<string, unknown> {
    return this.pluginsCache.get(collectionName) || {};
  }

  /**
   * Check if plugin is enabled for collection
   */
  isPluginEnabled(collectionName: string, pluginName: string): boolean {
    const plugins = this.getPlugins(collectionName);
    const key = pluginName.startsWith('use_') ? pluginName : `use_${pluginName}`;
    return !!plugins[key];
  }

  /**
   * Get plugin value for collection
   */
  getPluginValue<T = unknown>(collectionName: string, pluginName: string): T | undefined {
    const plugins = this.getPlugins(collectionName);
    const key = pluginName.startsWith('use_') ? pluginName : `use_${pluginName}`;
    return plugins[key] as T | undefined;
  }

  /**
   * Get all loaded entities
   */
  getAllEntities(): EntityConfig[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get all collection names
   */
  getCollectionNames(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Check if collection exists
   */
  hasCollection(collectionName: string): boolean {
    return this.cache.has(collectionName);
  }

  /**
   * Reload entity configuration and re-register relationships
   */
  invalidate(collectionName: string): void {
    this.cache.delete(collectionName);
    this.pluginsCache.delete(collectionName);
    this.relationshipRegistry.removeBySource?.(collectionName);
  }

  async reload(collectionName: string, tenantSlug?: string): Promise<void> {
    // tenantSlug is forwarded to source.load to read the right scope from Redis
    // when called outside of an AsyncLocalStorage tenant context (e.g., setting CRUD).
    const entity = await this.source.load(collectionName, tenantSlug);
    if (entity) {
      this.cache.set(collectionName, entity);
      this.pluginsCache.set(collectionName, this.extractPlugins(entity));

      // Re-register relationships from json_schema
      if (entity.json_schema) {
        try {
          const relationships = this.parseRelationshipsFromSchema(
            entity.json_schema,
            collectionName
          );

          for (const rel of relationships) {
            this.relationshipRegistry.register(rel);
            const inverse = this.createInverseRelationship(rel);
            this.relationshipRegistry.register(inverse);
          }

          if (relationships.length > 0) {
            console.log(`[EntityConfigLoader] Re-registered ${relationships.length} relationships (+ ${relationships.length} inverse) for '${collectionName}':`, relationships.map(r => r.name));
          }
        } catch (e: any) {
          console.warn(`[EntityConfigLoader] Failed to parse relationships for '${collectionName}':`, e.message);
        }
      }

      // Re-register default relations (created_by, updated_by → user)
      for (const rel of this.buildDefaultRelations(collectionName)) {
        if (!this.relationshipRegistry.getByName(collectionName, rel.name)) {
          this.relationshipRegistry.register(rel);
        }
      }
    }
  }

  /**
   * Reload all entities
   */
  async reloadAll(): Promise<void> {
    this.cache.clear();
    this.pluginsCache.clear();
    this.initialized = false;
    await this.initialize();
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.pluginsCache.clear();
    this.initialized = false;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create an entity config loader
 */
export function createEntityConfigLoader(
  source: IEntityConfigSource,
  relationshipRegistry?: IRelationshipRegistry
): EntityConfigLoader {
  return new EntityConfigLoader(source, relationshipRegistry);
}

// ============================================================================
// SOURCE: Redis (qua SchemaManager)
// ============================================================================

/**
 * Reads the entity from Redis. This is the only source currently used at runtime.
 */
export class JSONEntityConfigSource implements IEntityConfigSource {
  async loadAll(): Promise<EntityConfig[]> {
    const { schemaManager } = await import('./manager');
    const all = await schemaManager.getAllEntitiesAllTenants();
    return Object.values(all) as EntityConfig[];
  }

  async load(collectionName: string, tenantSlug?: string): Promise<EntityConfig | null> {
    const { schemaManager } = await import('./manager');
    // RAW (no AJV convert) — keeps widget/typeRelation for parseRelationshipsFromSchema.
    // Converting to AJV is only needed when the validator runs (the Validator module calls it itself).
    return (await schemaManager.getEntityRaw(collectionName, tenantSlug ?? null)) as EntityConfig | null;
  }

  async exists(collectionName: string): Promise<boolean> {
    return (await this.load(collectionName)) !== null;
  }
}
