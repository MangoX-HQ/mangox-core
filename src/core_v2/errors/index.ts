/**
 * Core V2 - Error System
 * Proper error hierarchy with contextual information
 *
 * Key improvements over v1:
 * - Consistent error naming
 * - Better error context
 * - Proper error codes
 * - Serializable error responses
 */

// ============================================================================
// ERROR CODES
// ============================================================================

export const ErrorCodes = {
  // Configuration Errors (1xxx)
  CONFIG_INVALID: 'E1001',
  CONFIG_MISSING_REQUIRED: 'E1002',
  ADAPTER_NOT_CONFIGURED: 'E1003',

  // Authentication/Authorization Errors (2xxx)
  AUTH_ACCESS_DENIED: 'E2001',
  AUTH_INVALID_TOKEN: 'E2002',
  AUTH_EXPIRED_TOKEN: 'E2003',
  AUTH_INSUFFICIENT_PERMISSIONS: 'E2004',
  RBAC_NO_PERMISSION: 'E2005',
  RBAC_FIELD_RESTRICTED: 'E2006',

  // Validation Errors (3xxx)
  VALIDATION_FAILED: 'E3001',
  VALIDATION_REQUIRED_FIELD: 'E3002',
  VALIDATION_INVALID_TYPE: 'E3003',
  VALIDATION_INVALID_FORMAT: 'E3004',
  VALIDATION_SCHEMA_MISMATCH: 'E3005',

  // Query Errors (4xxx)
  QUERY_INVALID: 'E4001',
  QUERY_CONVERSION_FAILED: 'E4002',
  QUERY_EXECUTION_FAILED: 'E4003',
  QUERY_TIMEOUT: 'E4004',
  QUERY_UNSUPPORTED_OPERATOR: 'E4005',

  // Resource Errors (5xxx)
  RESOURCE_NOT_FOUND: 'E5001',
  RESOURCE_ALREADY_EXISTS: 'E5002',
  RESOURCE_CONFLICT: 'E5003',

  // Adapter Errors (6xxx)
  ADAPTER_NOT_FOUND: 'E6001',
  ADAPTER_NOT_INITIALIZED: 'E6002',
  ADAPTER_CONNECTION_FAILED: 'E6003',
  ADAPTER_OPERATION_FAILED: 'E6004',

  // Relationship Errors (7xxx)
  RELATIONSHIP_NOT_FOUND: 'E7001',
  RELATIONSHIP_INVALID: 'E7002',
  RELATIONSHIP_CIRCULAR: 'E7003',

  // Plugin Errors (8xxx)
  PLUGIN_NOT_FOUND: 'E8001',
  PLUGIN_EXECUTION_FAILED: 'E8002',
  PLUGIN_INVALID_CONFIG: 'E8003',

  // Cache Errors (9xxx)
  CACHE_CONNECTION_FAILED: 'E9001',
  CACHE_OPERATION_FAILED: 'E9002',

  // Internal Errors (10xx)
  INTERNAL_ERROR: 'E1000',
  NOT_IMPLEMENTED: 'E1010', // was 'E1001' — collided with CONFIG_INVALID
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// ============================================================================
// ERROR CODE TO HTTP STATUS MAPPING
// ============================================================================

const errorCodeToStatus: Record<string, number> = {
  // 1xxx - Config errors -> 500
  E1100: 500,
  E1101: 500,
  E1102: 500,

  // 2xxx - Auth errors -> 401/403
  E2001: 403,
  E2002: 401,
  E2003: 401,
  E2004: 403,
  E2005: 403,
  E2006: 403,

  // 3xxx - Validation errors -> 400
  E3001: 400,
  E3002: 400,
  E3003: 400,
  E3004: 400,
  E3005: 400,

  // 4xxx - Query errors -> 400/500
  E4001: 400,
  E4002: 500,
  E4003: 500,
  E4004: 408,
  E4005: 400,

  // 5xxx - Resource errors -> 404/409
  E5001: 404,
  E5002: 409,
  E5003: 409,

  // 6xxx - Adapter errors -> 500/503
  E6001: 500,
  E6002: 500,
  E6003: 503,
  E6004: 500,

  // 7xxx - Relationship errors -> 400/500
  E7001: 400,
  E7002: 400,
  E7003: 400,

  // 8xxx - Plugin errors -> 500
  E8001: 500,
  E8002: 500,
  E8003: 500,

  // 9xxx - Cache errors -> 503
  E9001: 503,
  E9002: 500,

  // 1xxx - Configuration errors -> 500
  E1001: 500,
  E1002: 500,
  E1003: 500,

  // 10xx - Internal errors -> 500/501
  E1000: 500,
  E1010: 501,
};

export function getHttpStatus(code: ErrorCode): number {
  return errorCodeToStatus[code] || 500;
}

// ============================================================================
// BASE ERROR CLASS
// ============================================================================

export interface ErrorContext {
  collection?: string;
  field?: string;
  roles?: string[];
  query?: unknown;
  originalError?: Error;
  [key: string]: unknown;
}

export interface SerializedError {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    statusCode: number;
    timestamp: string;
    context?: ErrorContext;
    stack?: string;
  };
}

/**
 * Base error class for all Core V2 errors
 */
export class CoreError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly context: ErrorContext;
  public readonly timestamp: Date;

  constructor(
    code: ErrorCode,
    message: string,
    context: ErrorContext = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = getHttpStatus(code);
    this.context = context;
    this.timestamp = new Date();

    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Serialize error for API response
   */
  toJSON(includeStack = false): SerializedError {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
        timestamp: this.timestamp.toISOString(),
        context: Object.keys(this.context).length > 0 ? this.context : undefined,
        stack: includeStack ? this.stack : undefined,
      },
    };
  }

  /**
   * Create error with additional context
   */
  withContext(additionalContext: ErrorContext): CoreError {
    return new (this.constructor as typeof CoreError)(
      this.code,
      this.message,
      { ...this.context, ...additionalContext }
    );
  }
}

// ============================================================================
// SPECIFIC ERROR CLASSES
// ============================================================================

/**
 * Configuration errors
 */
export class ConfigurationError extends CoreError {
  constructor(code: ErrorCode, message: string, context?: ErrorContext) {
    super(code, message, context);
  }
}

/**
 * Authorization errors
 */
export class AuthorizationError extends CoreError {
  constructor(code: ErrorCode, message: string, context?: ErrorContext) {
    super(code, message, context);
  }
}

/**
 * Validation errors
 */
export class ValidationError extends CoreError {
  public readonly validationErrors: Array<{ field?: string; message: string }>;

  constructor(
    code: ErrorCode,
    message: string,
    validationErrors: Array<{ field?: string; message: string }> = [],
    context?: ErrorContext
  ) {
    super(code, message, context);
    this.validationErrors = validationErrors;
  }

  toJSON(includeStack = false): SerializedError {
    const base = super.toJSON(includeStack);
    return {
      ...base,
      error: {
        ...base.error,
        context: {
          ...base.error.context,
          validationErrors: this.validationErrors,
        },
      },
    };
  }
}

/**
 * Query errors
 */
export class QueryError extends CoreError {
  constructor(code: ErrorCode, message: string, context?: ErrorContext) {
    super(code, message, context);
  }
}

/**
 * Resource not found errors
 */
export class NotFoundError extends CoreError {
  constructor(code: ErrorCode, message: string, context?: ErrorContext) {
    super(code, message, { ...context });
  }
}

/**
 * Adapter/Database errors
 */
export class AdapterError extends CoreError {
  constructor(code: ErrorCode, message: string, context?: ErrorContext) {
    super(code, message, context);
  }
}

/**
 * Relationship errors
 */
export class RelationshipError extends CoreError {
  constructor(code: ErrorCode, message: string, context?: ErrorContext) {
    super(code, message, context);
  }
}

/**
 * Plugin errors
 */
export class PluginError extends CoreError {
  constructor(code: ErrorCode, message: string, context?: ErrorContext) {
    super(code, message, context);
  }
}

// ============================================================================
// ERROR FACTORIES
// ============================================================================

/**
 * Error factory functions for consistent error creation
 */
export const Errors = {
  // Authorization Errors
  accessDenied: (action: string, collection: string, roles: string[]) =>
    new AuthorizationError(
      ErrorCodes.AUTH_ACCESS_DENIED,
      `Access denied: Cannot ${action} on collection '${collection}'`,
      { collection, roles, action }
    ),

  accessDeniedRead: (collection: string, roles: string[]) =>
    Errors.accessDenied('read', collection, roles),

  accessDeniedCreate: (collection: string, roles: string[]) =>
    Errors.accessDenied('create', collection, roles),

  accessDeniedUpdate: (collection: string, roles: string[]) =>
    Errors.accessDenied('update', collection, roles),

  accessDeniedDelete: (collection: string, roles: string[]) =>
    Errors.accessDenied('delete', collection, roles),

  fieldRestricted: (field: string, collection: string, roles: string[]) =>
    new AuthorizationError(
      ErrorCodes.RBAC_FIELD_RESTRICTED,
      `Field '${field}' is not accessible for your role`,
      { field, collection, roles }
    ),

  // Validation Errors
  validationFailed: (errors: Array<{ field?: string; message: string }>) =>
    new ValidationError(
      ErrorCodes.VALIDATION_FAILED,
      `Validation failed: ${errors.map(e => e.message).join('; ')}`,
      errors
    ),

  requiredField: (field: string) =>
    new ValidationError(
      ErrorCodes.VALIDATION_REQUIRED_FIELD,
      `Field '${field}' is required`,
      [{ field, message: `Field '${field}' is required` }]
    ),

  invalidFormat: (field: string, expected: string) =>
    new ValidationError(
      ErrorCodes.VALIDATION_INVALID_FORMAT,
      `Field '${field}' has invalid format, expected: ${expected}`,
      [{ field, message: `Expected format: ${expected}` }]
    ),

  validation: (message: string, context?: ErrorContext) =>
    new ValidationError(
      ErrorCodes.VALIDATION_FAILED,
      message,
      [{ message }],
      context
    ),

  // Query Errors
  queryInvalid: (reason: string, query?: unknown) =>
    new QueryError(
      ErrorCodes.QUERY_INVALID,
      `Invalid query: ${reason}`,
      { query }
    ),

  queryExecutionFailed: (reason: string, query?: unknown, originalError?: Error) =>
    new QueryError(
      ErrorCodes.QUERY_EXECUTION_FAILED,
      `Query execution failed: ${reason}`,
      { query, originalError }
    ),

  unsupportedOperator: (operator: string) =>
    new QueryError(
      ErrorCodes.QUERY_UNSUPPORTED_OPERATOR,
      `Unsupported operator: '${operator}'`,
      { operator }
    ),

  // Resource Errors
  notFound: (collection: string, id?: string) =>
    new NotFoundError(
      ErrorCodes.RESOURCE_NOT_FOUND,
      id
        ? `Resource not found: ${collection}/${id}`
        : `Resource not found in collection: ${collection}`,
      { collection, id }
    ),

  alreadyExists: (collection: string, identifier: string) =>
    new CoreError(
      ErrorCodes.RESOURCE_ALREADY_EXISTS,
      `Resource already exists: ${collection}/${identifier}`,
      { collection, identifier }
    ),

  // Adapter Errors
  adapterNotFound: (type: string) =>
    new AdapterError(
      ErrorCodes.ADAPTER_NOT_FOUND,
      `Database adapter not found: '${type}'`,
      { adapterType: type }
    ),

  adapterNotInitialized: (type: string) =>
    new AdapterError(
      ErrorCodes.ADAPTER_NOT_INITIALIZED,
      `Database adapter not initialized: '${type}'`,
      { adapterType: type }
    ),

  connectionFailed: (type: string, reason: string, originalError?: Error) =>
    new AdapterError(
      ErrorCodes.ADAPTER_CONNECTION_FAILED,
      `Database connection failed for '${type}': ${reason}`,
      { adapterType: type, originalError }
    ),

  // Relationship Errors
  relationshipNotFound: (name: string, collection: string) =>
    new RelationshipError(
      ErrorCodes.RELATIONSHIP_NOT_FOUND,
      `Relationship '${name}' not found for collection '${collection}'`,
      { relationshipName: name, collection }
    ),

  // Plugin Errors
  pluginExecutionFailed: (pluginName: string, reason: string, originalError?: Error) =>
    new PluginError(
      ErrorCodes.PLUGIN_EXECUTION_FAILED,
      `Plugin '${pluginName}' failed: ${reason}`,
      { pluginName, originalError }
    ),

  // Internal Errors
  internal: (message: string, originalError?: Error) =>
    new CoreError(
      ErrorCodes.INTERNAL_ERROR,
      message,
      { originalError }
    ),

  notImplemented: (feature: string) =>
    new CoreError(
      ErrorCodes.NOT_IMPLEMENTED,
      `Feature not implemented: ${feature}`,
      { feature }
    ),
};

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}

export function isAuthorizationError(error: unknown): error is AuthorizationError {
  return error instanceof AuthorizationError;
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

// ============================================================================
// ERROR HANDLER UTILITY
// ============================================================================

/**
 * Wrap unknown errors into CoreError
 */
export function wrapError(error: unknown, defaultMessage = 'An unexpected error occurred'): CoreError {
  if (isCoreError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new CoreError(
      ErrorCodes.INTERNAL_ERROR,
      error.message || defaultMessage,
      { originalError: error }
    );
  }

  return new CoreError(
    ErrorCodes.INTERNAL_ERROR,
    defaultMessage,
    { originalError: error as Error }
  );
}
