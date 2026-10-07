/**
 * Core V2 - Data Access Compatibility Layer
 * Provides stub implementations for Core V1 data access functions
 *
 * These are temporary stubs that return empty/default values.
 * Full implementation should be migrated from Core V1 or reimplemented.
 */

export interface AccessPolicy {
  custom_scope?: string;
  custom_data_scope?: { data: Record<string, any> };
  custom_query?: Record<string, any>;
}

/**
 * Stub: Handle MongoDB REST query with access policy
 * Returns params unchanged if no access provided
 */
export function handleMongoRestQueryPlayerOne(
  params: Record<string, any>,
  access: AccessPolicy | null | undefined
): Record<string, any> {
  if (!access) return params;

  const result = { ...params };

  // Merge custom_query if provided
  if (access.custom_query && typeof access.custom_query === 'object') {
    for (const [key, value] of Object.entries(access.custom_query)) {
      if (value !== undefined && value !== null) {
        // If the key already exists, try to merge or override based on type
        if (result[key] !== undefined) {
          // For string values with operators like "in.[...]", merge them
          if (typeof result[key] === 'string' && typeof value === 'string') {
            // Simple override for now
            result[key] = value;
          } else {
            result[key] = value;
          }
        } else {
          result[key] = value;
        }
      }
    }
  }

  // Handle custom_scope
  if (access.custom_scope && typeof access.custom_scope === 'string') {
    // Parse and apply custom scope conditions
    // Format: "field=operator.value"
    const scopeParts = access.custom_scope.split(',');
    for (const part of scopeParts) {
      const trimmed = part.trim();
      if (trimmed) {
        const [field, condition] = trimmed.split('=');
        if (field && condition) {
          result[field] = condition;
        }
      }
    }
  }

  return result;
}

/**
 * Stub: Get database access for collection
 * Returns empty access policy (no restrictions)
 */
export async function callDatabaseGetAccess(
  _collection: string,
  _roles: string[],
  _layer: string,
  _action: 'GET-ALL' | 'GET' | 'POST' | 'PUT' | 'PATCH',
  _options?: Record<string, any>
): Promise<AccessPolicy | null> {
  // TODO: Implement proper policy lookup from database
  // For now, return null (no restrictions)
  return null;
}

/**
 * Stub: Get global database access for collection
 * Returns empty access policy (no restrictions)
 */
export async function callDatabaseGetAccessGlobal(
  _collection: string,
  _action: 'GET-ALL' | 'GET' | 'POST' | 'PUT' | 'PATCH'
): Promise<AccessPolicy | null> {
  // TODO: Implement proper global policy lookup
  // For now, return null (no restrictions)
  return null;
}
