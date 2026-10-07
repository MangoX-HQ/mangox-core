/**
 * Core V2 - Permission Adapter (Compatibility Layer)
 * Provides backward-compatible PermissionAdapter class
 *
 * This wraps Core V2's AuthorizationService to match Core V1's API
 */

import { AuthorizationService, createAuthorizationService } from '../authorization/authorization';
import { createPermissionResolver, createMongoDBPermissionDatabase } from '../authorization/permission-resolver';

/**
 * PermissionAdapter - backward compatible class
 * Wraps Core V2's AuthorizationService
 */
export class PermissionAdapter {
  private authService: AuthorizationService | null = null;
  private adapter: any;

  constructor(adapter: any) {
    this.adapter = adapter;
  }

  /**
   * Initialize AuthorizationService lazily
   */
  private async initAuthorizationService(): Promise<AuthorizationService> {
    if (!this.authService) {
      try {
        // Try to get database connection from adapter
        const db = this.adapter?.getDb?.() || this.adapter?.db;
        if (db) {
          const permissionDb = createMongoDBPermissionDatabase(db);
          const resolver = createPermissionResolver(permissionDb);
          this.authService = createAuthorizationService(resolver, undefined); // Use global AjvValidator
        } else {
          // Fallback: create with null resolver (all access granted)
          this.authService = createAuthorizationService({
            getEntitySchema: async () => null,
            isPublicEntity: async () => false,

          }, undefined);
        }
      } catch (error) {
        console.warn('[PermissionAdapter] Failed to initialize AuthorizationService:', error);
        // Return a permissive service if initialization fails
        this.authService = createAuthorizationService({
          getEntitySchema: async () => null,
          isPublicEntity: async () => false,
        }, undefined);
      }
    }
    return this.authService;
  }

  /**
   * Check if roles have access to entity for given method
   */
  async hasAccess(
    entityName: string,
    method: string,
    userRoles: string[]
  ): Promise<boolean> {
    try {
      const service = await this.initAuthorizationService();
      return service.hasAccess(entityName, method as any, userRoles);
    } catch (error) {
      console.warn('[PermissionAdapter] hasAccess error:', error);
      // Default to allowed if error
      return true;
    }
  }

  /**
   * Filter body based on RBAC rules
   * Uses AuthorizationService.validateAndFilterData internally
   */
  async filterBody(
    data: any,
    entityName: string,
    roles: string[],
    method: string,
    _options?: any
  ): Promise<any> {
    try {
      const service = await this.initAuthorizationService();
      // Use validateAndFilterData which is the equivalent method
      const methodMap: Record<string, 'POST' | 'PUT' | 'PATCH'> = {
        'POST': 'POST',
        'PUT': 'PUT',
        'PATCH': 'PATCH'
      };
      const mappedMethod = methodMap[method.toUpperCase()] || 'PUT';
      return service.validateAndFilterData(entityName, roles, data, mappedMethod);
    } catch (error) {
      console.warn('[PermissionAdapter] filterBody error:', error);
      return data;
    }
  }

  /**
   * Get custom fields for entity and roles
   * Uses AuthorizationService.getAllowedFields internally
   */
  async getCustomFields(
    entityName: string,
    roles: string[],
    method: string
  ): Promise<Record<string, any>> {
    try {
      const service = await this.initAuthorizationService();
      // Use getAllowedFields and convert to custom fields format
      const allowedFields = await service.getAllowedFields(entityName, roles, method as any);
      // Return as a record of field names -> true
      const result: Record<string, any> = {};
      for (const field of allowedFields) {
        result[field] = true;
      }
      return result;
    } catch (error) {
      console.warn('[PermissionAdapter] getCustomFields error:', error);
      return {};
    }
  }
}
