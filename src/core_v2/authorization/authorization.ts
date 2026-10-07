/**
 * Core V2 - Authorization Service
 * Access control, field filtering, and data validation
 *
 * Key improvements over v1:
 * - Config-driven (bypass lists, system fields)
 * - Separated concerns (validation, field filtering, permission checking)
 * - Better type safety
 * - Proper dependency injection
 */

import { RbacConfig, getGlobalConfig } from '../config';
import { Errors, ValidationError } from '../errors';
import { HttpMethod } from '../types';
import { AjvValidator, getGlobalValidator } from '../schema/validator';
import { IPermissionResolver, EntitySchema } from './permission-resolver';

// Re-export for backward compatibility
export type { IPermissionResolver, EntitySchema };

// ============================================================================
// INTERFACES (internal)
// ============================================================================

interface ActionPattern {
  action: HttpMethod;
  list_field?: string;
  custom_field?: CustomField[];
  scope?: 'all' | 'self' | 'assigned';
}

interface CustomField {
  field?: string;
  fields?: string;
  relation?: string;
  pattern?: string;
  enum?: string[];
}

// ============================================================================
// RBAC SERVICE
// ============================================================================

/**
 * RBAC Service - handles all role-based access control
 */
export class AuthorizationService {
  private config: RbacConfig;
  private permissionResolver: IPermissionResolver;
  private ajvValidator: AjvValidator;

  constructor(
    permissionResolver: IPermissionResolver,
    ajvValidator: AjvValidator,
    config?: RbacConfig
  ) {
    this.permissionResolver = permissionResolver;
    this.ajvValidator = ajvValidator;
    this.config = config || getGlobalConfig().rbac;
  }

  // ============================================================================
  // ACCESS CHECKS
  // ============================================================================

  /**
   * Check if user has access to perform action on collection
   */
  async hasAccess(
    collection: string,
    method: HttpMethod,
    _roles: string[]
  ): Promise<boolean> {
    // FRONT method: only public entities are accessible
    if (method === 'FRONT') {
      return await this.permissionResolver.isPublicEntity(collection);
    }

    // All other methods: any authenticated user has access
    return true;
  }

  /**
   * Ensure user has access, throw if not
   */
  async ensureAccess(
    collection: string,
    method: HttpMethod,
    roles: string[]
  ): Promise<void> {
    const hasAccess = await this.hasAccess(collection, method, roles);

    if (!hasAccess) {
      const action = this.methodToAction(method);
      throw Errors.accessDenied(action, collection, roles);
    }
  }

  // ============================================================================
  // FIELD ACCESS
  // ============================================================================

  /**
   * Get allowed fields for a collection/role/method combination
   */
  async getAllowedFields(
    collection: string,
    _roles: string[],
    method: HttpMethod,
    requestedFields?: string[]
  ): Promise<string[]> {
    // FRONT method on public entity: return requested fields as-is
    if (method === 'FRONT') {
      const isPublic = await this.permissionResolver.isPublicEntity(collection);
      if (isPublic) {
        return requestedFields || [];
      }
      return [];
    }

    // All other methods: return all fields from schema + system fields
    const allFields = new Set(await this.getAllFields(collection));
    this.addSystemFields(allFields);
    return this.filterRequestedFields(Array.from(allFields), requestedFields);
  }

  // ============================================================================
  // DATA VALIDATION
  // ============================================================================

  /**
   * Validate and filter data for create/update operations
   */
  async validateAndFilterData(
    collection: string,
    roles: string[],
    data: Record<string, unknown>,
    method: 'POST' | 'PUT' | 'PATCH',
    options?: { id?: string; strict?: boolean }
  ): Promise<Record<string, unknown>> {
    // Validate with AJV if entity has json_schema
    const entitySchema = await this.getEntitySchema(collection);
    if (entitySchema?.json_schema) {
      data = await this.validateData(collection, data, roles, method, {
        strict: options?.strict,
      });
    }

    // Get allowed fields
    const allowedFields = await this.getAllowedFields(collection, roles, method);

    // Filter data to only allowed fields
    const filteredData = this.filterDataByFields(data, allowedFields);

    // Add defaults for POST
    if (method === 'POST') {
      const entitySchema = await this.getEntitySchema(collection);
      this.addDefaultValues(filteredData, entitySchema);
    }

    return filteredData;
  }

  /**
   * Filter data object to only include allowed fields
   */
  private filterDataByFields(
    data: Record<string, unknown>,
    allowedFields: string[]
  ): Record<string, unknown> {
    if (allowedFields.length === 0) {
      return data;
    }

    const filtered: Record<string, unknown> = {};
    const allowedSet = new Set(allowedFields);

    for (const [key, value] of Object.entries(data)) {
      // Check exact match or prefix match (for nested fields)
      if (allowedSet.has(key) || allowedFields.some((f) => f.startsWith(`${key}.`))) {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  // ============================================================================
  // DATA VALIDATION
  // ============================================================================

  /**
   * Validate data against entity schema with RBAC field filtering
   * Similar to old core's validateDataV2()
   */
  private async validateData(
    collection: string,
    data: Record<string, unknown>,
    roles: string[],
    method: HttpMethod,
    options: {
      strict?: boolean;
      entitySchema?: Record<string, unknown>;
    } = {}
  ): Promise<Record<string, unknown>> {
    // Get entity schema dynamically from SchemaManager (always up-to-date)
    const entitySchema = await this.getEntitySchema(collection);

    if (!entitySchema?.json_schema) {
      throw Errors.validation(`Entity schema not found for collection: ${collection}`);
    }

    // Collect system fields
    const systemFields = [...this.config.systemFields];

    // Collect plugin fields from entity schema
    const fieldPlugins = [
      { field: '_id,locale,locale_id,languages', plugin: 'use_locale' },
      { field: 'blocks,blocks_position', plugin: 'use_block' },
      { field: 'parent,parent_id,parent_id_obj,children,position,is_root', plugin: 'use_parent' },
      { field: 'seopath', plugin: 'use_seopath' },
      { field: 'slug', plugin: 'use_slug' },
      { field: 'post_type', plugin: 'use_posttype' },
      { field: 'history,reason', plugin: 'use_history' },
      { field: 'status_approve,publish_start,publish_end', plugin: 'use_approval_process' },
      { field: 'pinned', plugin: 'use_pinned' },
    ];

    for (const fp of fieldPlugins) {
      if (entitySchema[fp.plugin]) {
        fp.field.split(',').forEach(f => {
          if (!systemFields.includes(f)) {
            systemFields.push(f);
          }
        });
      }
    }

    // Validate with AJV using dynamic schema from SchemaManager
    const validationResult = this.ajvValidator.validateWithSchema(
      entitySchema.json_schema as Record<string, unknown>,
      data,
      {
        method: method as 'GET' | 'GET-ALL' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'FRONT',
        strict: options.strict ?? true,
        additionalAllowedFields: systemFields,
      }
    );

    if (!validationResult.valid) {
      const errorMessage = validationResult.errors
        .map(e => `${e.field}: ${e.message}`)
        .join('; ');
      throw Errors.validation(`Data validation failed: ${errorMessage}`);
    }

    // Return validated data
    return validationResult.data || data;
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  /**
   * Convert HTTP method to action name
   * Supports both standard HTTP methods and custom actions
   */
  private methodToAction(method: HttpMethod): string {
    switch (method) {
      case 'GET':
      case 'GET-ALL':
      case 'FRONT':
        return 'read';
      case 'POST':
        return 'create';
      case 'PUT':
      case 'PATCH':
        return 'update';
      case 'DELETE':
        return 'delete';
      default:
        // Custom actions (like 'GET-ADMIN', 'POST-APPROVE', etc.)
        // Return the action as-is for RBAC lookup
        return method.toLowerCase();
    }
  }


  /**
   * Get entity schema - reads from SchemaManager (single source of truth)
   */
  private async getEntitySchema(collection: string): Promise<EntitySchema | null> {
    // Read from SchemaManager (updated by SchemaSync when the JSON file changes)
    const { schemaManager } = await import('../schema/manager');
    const entity = await schemaManager.getEntity(collection);
    if (entity) {
      return entity as EntitySchema;
    }

    // Fallback to permission resolver (loads from database)
    return await this.permissionResolver.getEntitySchema(collection);
  }

  /**
   * Get all fields from entity schema
   */
  private async getAllFields(collection: string): Promise<string[]> {
    const schema = await this.getEntitySchema(collection);

    if (!schema?.json_schema?.properties) {
      return [];
    }

    return this.flattenSchemaFields(schema.json_schema?.properties);
  }

  /**
   * Flatten nested schema properties to dot-notation fields
   */
  private flattenSchemaFields(
    properties: Record<string, unknown>,
    prefix = ''
  ): string[] {
    const fields: string[] = [];

    for (const [key, value] of Object.entries(properties)) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      const fieldDef = value as Record<string, unknown>;

      if (fieldDef.type === 'object' && fieldDef?.properties) {
        fields.push(
          ...this.flattenSchemaFields(
            fieldDef?.properties as Record<string, unknown>,
            fieldPath
          )
        );
      } else if (
        fieldDef.type === 'array' &&
        (fieldDef.items as Record<string, unknown>)?.properties
      ) {
        fields.push(
          ...this.flattenSchemaFields(
            (fieldDef.items as Record<string, unknown>)?.properties as Record<string, unknown>,
            fieldPath
          )
        );
      } else {
        fields.push(fieldPath);
      }
    }

    return fields;
  }

  /**
   * Add system fields to allowed set
   */
  private addSystemFields(fields: Set<string>): void {
    for (const field of this.config.systemFields) {
      fields.add(field);
    }
  }

  /**
   * Filter by requested fields
   * System fields are always included
   */
  private filterRequestedFields(
    allowed: string[],
    requested?: string[]
  ): string[] {
    if (!requested || requested.length === 0) {
      return allowed;
    }

    // Handle wildcard select: return all allowed fields
    if (requested.includes('*')) {
      return allowed;
    }

    const requestedSet = new Set(requested);
    const systemFieldsSet = new Set(this.config.systemFields);

    const filtered = allowed.filter(
      (f) =>
        requestedSet.has(f) ||
        requested.some((r) => f.startsWith(`${r}.`)) ||
        systemFieldsSet.has(f)  // Always include system fields
    );

    // Include join alias fields (mangox_ prefix) - these are virtual fields
    // created by $lookup, not real entity fields, so they won't be in allowed
    for (const r of requested) {
      if (r.startsWith('mangox_') && !filtered.includes(r)) {
        filtered.push(r);
      }
    }

    return filtered;
  }

  /**
   * Add default values to data
   */
  private addDefaultValues(
    data: Record<string, unknown>,
    schema: EntitySchema | null
  ): void {
    if (!schema?.json_schema?.properties) return;

    const properties = schema.json_schema?.properties as Record<string, Record<string, unknown>>;

    for (const [key, fieldDef] of Object.entries(properties)) {
      if (data[key] === undefined && fieldDef.default !== undefined) {
        data[key] = fieldDef.default;
      }
    }
  }

}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new RBAC service
 */
export function createAuthorizationService(
  permissionResolver: IPermissionResolver,
  ajvValidator?: AjvValidator,
  config?: RbacConfig
): AuthorizationService {
  return new AuthorizationService(
    permissionResolver,
    ajvValidator || getGlobalValidator(),
    config
  );
}
