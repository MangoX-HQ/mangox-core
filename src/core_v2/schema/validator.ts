/**
 * Core V2 - AJV Validator
 * JSON Schema validation using AJV with format support
 */

import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import * as bcrypt from 'bcrypt';

// ============================================================================
// TYPES
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  data?: Record<string, unknown>;
}

export interface ValidationError {
  field: string;
  message: string;
  keyword: string;
  params?: Record<string, unknown>;
}

export interface ValidationOptions {
  method?: 'POST' | 'PUT' | 'PATCH' | 'GET' | 'GET-ALL' | 'DELETE' | 'FRONT';
  strict?: boolean;
  skipRequired?: boolean;
  additionalAllowedFields?: string[];
}

// ============================================================================
// ERROR FORMATTING
// ============================================================================

function formatValidationErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors) return [];

  return errors.map(error => {
    const fieldPath = error.instancePath || '/' + (error.params?.missingProperty || 'root');
    const field = fieldPath.replace(/^\//, '').replace(/\//g, '.');

    let message: string;
    switch (error.keyword) {
      case 'required':
        message = `Field '${error.params?.missingProperty}' is required`;
        break;
      case 'type':
        message = `Expected type '${error.params?.type}', ${error.message}`;
        break;
      case 'enum':
        message = `${error.message}, allowed: ${(error.params?.allowedValues as string[])?.join(', ')}`;
        break;
      case 'pattern':
        message = `Pattern mismatch: ${error.message}`;
        break;
      case 'minLength':
      case 'maxLength':
        message = `Length error: ${error.message}`;
        break;
      case 'minimum':
      case 'maximum':
        message = `Number range error: ${error.message}`;
        break;
      case 'format':
        message = `Format error: ${error.message}`;
        break;
      case 'additionalProperties':
        message = `Additional property not allowed: ${error.params?.additionalProperty}`;
        break;
      default:
        message = error.message || 'Validation error';
    }

    return {
      field: field || 'root',
      message,
      keyword: error.keyword,
      params: error.params as Record<string, unknown>,
    };
  });
}

// ============================================================================
// AJV VALIDATOR CLASS
// ============================================================================

export class AjvValidator {
  private ajv: Ajv;

  constructor(options?: {
    strict?: boolean;
    allErrors?: boolean;
    removeAdditional?: boolean;
    coerceTypes?: boolean;
  }) {
    this.ajv = new Ajv({
      strict: options?.strict ?? false,
      allErrors: options?.allErrors ?? true,
      removeAdditional: options?.removeAdditional ?? true,
      coerceTypes: options?.coerceTypes ?? true,
    });

    addFormats(this.ajv);
    this.addCustomFormats();
    this.addCustomKeywords();
  }

  private addCustomFormats(): void {
    this.ajv.addFormat('objectId', /^[0-9a-fA-F]{24}$/);
    this.ajv.addFormat('phone', /^(\+84|84|0)?[1-9]\d{8,9}$/);
    this.ajv.addFormat('slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }

  private addCustomKeywords(): void {
    this.ajv.addKeyword({
      keyword: 'toDate',
      modifying: true,
      compile: () => (data, ctx) => {
        if (typeof data === 'string') {
          const newTime = data.replace('Z', '+00:00');
          const d = new Date(newTime);
          if (!isNaN(d.getTime()) && ctx) {
            ctx.parentData[ctx.parentDataProperty] = d;
            return true;
          }
        }
        return true;
      },
    });

    this.ajv.addKeyword({
      keyword: 'toHash',
      modifying: true,
      compile: () => (data, ctx) => {
        if (typeof data === 'string' && data.length > 0 && ctx) {
          ctx.parentData[ctx.parentDataProperty] = bcrypt.hashSync(data, 10);
        }
        return true;
      },
    });
  }

  // ============================================================================
  // VALIDATION
  // ============================================================================

  /**
   * Validate data against a raw schema (dynamic - schema comes from SchemaManager)
   * Schema is compiled on-the-fly, no pre-registration needed.
   */
  validateWithSchema(
    rawSchema: Record<string, unknown>,
    data: Record<string, unknown>,
    options: ValidationOptions = {}
  ): ValidationResult {
    let schema = this.sanitizeSchema(rawSchema);
    const dataCopy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;

    if (options.additionalAllowedFields && options.additionalAllowedFields.length > 0) {
      if (!schema.properties) {
        schema.properties = {};
      }
      const properties = schema.properties as Record<string, unknown>;
      options.additionalAllowedFields.forEach(field => {
        if (!properties[field]) {
          properties[field] = {
            type: ['string', 'number', 'boolean', 'object', 'array', 'null']
          };
        }
      });
    }

    if (options.method === 'PATCH') {
      schema.required = [];
      this.makeFieldsOptional(schema);
    }

    if (options.skipRequired) {
      schema.required = [];
    }

    try {
      const validator = this.ajv.compile(schema);
      const isValid = validator(dataCopy);

      return {
        valid: isValid,
        errors: isValid ? [] : formatValidationErrors(validator.errors),
        data: isValid ? dataCopy : undefined,
      };
    } catch (error: any) {
      return {
        valid: false,
        errors: [{
          field: 'root',
          message: `Validation error: ${error.message}`,
          keyword: 'validation',
        }],
      };
    }
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const sanitized = JSON.parse(JSON.stringify(schema));
    return this.sanitizeObject(sanitized);
  }

  private sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
    if (!obj || typeof obj !== 'object') return obj;

    if (obj.maxLength === null || obj.maxLength === undefined) {
      delete obj.maxLength;
    } else if (typeof obj.maxLength === 'string') {
      const maxLen = parseInt(obj.maxLength as string);
      if (isNaN(maxLen) || maxLen <= 0) {
        delete obj.maxLength;
      } else {
        obj.maxLength = maxLen;
      }
    }

    if (obj.minLength !== undefined && typeof obj.minLength === 'string') {
      const minLen = parseInt(obj.minLength as string);
      if (isNaN(minLen) || minLen < 0) {
        delete obj.minLength;
      } else {
        obj.minLength = minLen;
      }
    }

    if (obj.enum && Array.isArray(obj.enum) && (obj.enum as unknown[]).length === 0) {
      delete obj.enum;
    }

    if (obj.type === 'string' && typeof obj.default === 'boolean') {
      obj.default = String(obj.default);
    }

    if (obj.required && !Array.isArray(obj.required)) {
      obj.required = [];
    }

    if (obj.dependencies === undefined) {
      obj.dependencies = {};
    }

    if (obj?.properties && typeof obj?.properties === 'object') {
      const props = obj?.properties as Record<string, unknown>;
      for (const key in props) {
        props[key] = this.sanitizeObject(props[key] as Record<string, unknown>);
      }
    }

    if (obj.items && typeof obj.items === 'object') {
      obj.items = this.sanitizeObject(obj.items as Record<string, unknown>);
    }

    return obj;
  }

  private makeFieldsOptional(schema: Record<string, unknown>): void {
    if (!schema || typeof schema !== 'object') return;

    if (schema.required) {
      schema.required = [];
    }

    if (schema.properties) {
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      Object.values(properties).forEach((fieldSchema) => {
        if (fieldSchema && typeof fieldSchema === 'object' && fieldSchema.type === 'object') {
          this.makeFieldsOptional(fieldSchema);
        }
      });
    }
  }
}

// ============================================================================
// FACTORY & SINGLETON
// ============================================================================

let globalValidator: AjvValidator | null = null;

export function createAjvValidator(options?: {
  strict?: boolean;
  allErrors?: boolean;
  removeAdditional?: boolean;
  coerceTypes?: boolean;
}): AjvValidator {
  return new AjvValidator(options);
}

export function getGlobalValidator(): AjvValidator {
  if (!globalValidator) {
    globalValidator = new AjvValidator();
  }
  return globalValidator;
}

export function resetGlobalValidator(): void {
  globalValidator = null;
}
