/**
 * Core V2 - Schema Converter
 * Converts entity JSON schema to AJV-compatible format
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * Original field definition from entity schema
 */
export interface FieldDefinition {
  type?: string | string[];
  widget?: string;
  title?: string;
  description?: string;
  default?: unknown;
  required?: string[];
  properties?: Record<string, FieldDefinition>;
  items?: FieldDefinition;
  choices?: string | Array<{ key?: string; value?: string }>;
  enum?: unknown[];
  min?: number;
  max?: number;
  minLength?: number | string;
  maxLength?: number | string;
  pattern?: string;
  format?: string;
  'format-data'?: string;
  allowNull?: boolean;
  isMultiple?: boolean;
  typeRelation?: {
    type?: string;
    collection?: string;
    entity?: string;
  };
  refValue?: string;
  refValueAdmin?: string;
  [key: string]: unknown;
}

/**
 * AJV-compatible schema
 */
export interface AjvSchema {
  type: string | string[];
  properties?: Record<string, AjvSchema>;
  required?: string[];
  dependencies?: Record<string, unknown>;
  additionalProperties?: boolean;
  items?: AjvSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
  title?: string;
  description?: string;
  uniqueItems?: boolean;
  [key: string]: unknown;
}

/**
 * Conversion options
 */
export interface ConversionOptions {
  maxDepth?: number;
  strictMode?: boolean;
  includeDefaults?: boolean;
  additionalProperties?: boolean;
}

// ============================================================================
// SCHEMA CONVERTER
// ============================================================================

/**
 * Schema Converter class
 */
export class SchemaConverter {
  private options: Required<ConversionOptions>;
  private formatDataMap: Record<string, string> = {
    email: 'email',
    phone: 'phone',
    uri: 'uri',
    url: 'uri',
    date: 'date',
    'date-time': 'date-time',
    time: 'time',
  };

  constructor(options?: ConversionOptions) {
    this.options = {
      maxDepth: options?.maxDepth ?? 10,
      strictMode: options?.strictMode ?? false,
      includeDefaults: options?.includeDefaults ?? true,
      additionalProperties: options?.additionalProperties ?? false,
    };
  }

  // ============================================================================
  // MAIN CONVERSION
  // ============================================================================

  /**
   * Convert entity JSON schema to AJV-compatible format
   */
  convert(
    originalSchema: { properties?: Record<string, FieldDefinition>; required?: string[] },
    collectionName: string
  ): AjvSchema {
    return this.convertSchema(originalSchema, collectionName, 0);
  }

  /**
   * Internal schema conversion with depth tracking
   */
  private convertSchema(
    originalSchema: { properties?: Record<string, FieldDefinition>; required?: string[] },
    collectionName: string,
    depth: number
  ): AjvSchema {
    const schema: AjvSchema = {
      type: 'object',
      properties: {},
      required: originalSchema.required || [],
      dependencies: {},
      additionalProperties: this.options.additionalProperties,
    };

    if (depth > this.options.maxDepth) {
      console.warn(`Max depth ${this.options.maxDepth} reached for: ${collectionName}`);
      return schema;
    }

    const properties = originalSchema?.properties || {};

    for (const [fieldName, fieldDef] of Object.entries(properties)) {
      const ajvField = this.convertField(fieldDef, `${collectionName}.${fieldName}`, depth);
      if (schema?.properties) {
        schema.properties[fieldName] = ajvField;
      }
    }

    return schema;
  }

  /**
   * Convert a single field definition
   */
  private convertField(
    field: FieldDefinition,
    fieldPath: string,
    depth: number
  ): AjvSchema {
    const ajvField: AjvSchema = {
      type: field.type || 'string',
    };

    // Copy basic properties
    if (field.title) ajvField.title = field.title;
    if (field.description) ajvField.description = field.description;

    // Handle default values
    if (this.options.includeDefaults && field.default !== undefined) {
      ajvField.default = this.sanitizeDefault(field.default, field.type);
    }

    // Handle choices/enum
    this.handleChoices(field, ajvField);

    // Handle widget-specific conversion
    if (field.widget) {
      this.handleWidget(field, ajvField, fieldPath, depth);
    }

    // Handle min/max for strings
    this.handleStringConstraints(field, ajvField);

    // Handle nested objects
    if (field.type === 'object' && field?.properties) {
      this.handleNestedObject(field, ajvField, fieldPath, depth);
    }

    // Handle arrays
    if (field.type === 'array' && field.items) {
      this.handleArray(field, ajvField, fieldPath, depth);
    }

    return ajvField;
  }

  // ============================================================================
  // WIDGET HANDLERS
  // ============================================================================

  /**
   * Handle widget-specific conversions
   */
  private handleWidget(
    field: FieldDefinition,
    ajvField: AjvSchema,
    fieldPath: string,
    depth: number
  ): void {
    switch (field.widget) {
      case 'dateTime':
      case 'date-time':
      case 'date':
        ajvField.type = 'string';
        ajvField.format = 'date-time';
        ajvField.pattern = '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})?)?$';
        break;

      case 'numberInput':
      case 'range':
        ajvField.type = 'number';
        if (typeof field.min === 'number') ajvField.minimum = field.min;
        if (typeof field.max === 'number') ajvField.maximum = field.max;
        break;

      case 'password':
        ajvField.type = 'string';
        ajvField.toHash = true;
        this.handleStringConstraints(field, ajvField);
        if (field.pattern) ajvField.pattern = field.pattern;
        break;

      case 'shortAnswer':
      case 'longAnswer':
      case 'UriKeyGen':
        ajvField.type = 'string';
        this.handleStringConstraints(field, ajvField);
        if (field['format-data'] && this.formatDataMap[field['format-data']]) {
          ajvField.format = this.formatDataMap[field['format-data']];
        }
        if (field.pattern) ajvField.pattern = field.pattern;
        break;

      case 'radio':
        ajvField.type = field.allowNull ? ['string', 'null'] : 'string';
        if (field.allowNull && Array.isArray(ajvField.enum)) {
          ajvField.enum = [...ajvField.enum, null];
        }
        break;

      case 'select':
        if (field.isMultiple && field.choices) {
          ajvField.type = 'array';
          ajvField.items = {
            type: field.allowNull ? ['string', 'null'] : 'string',
            enum: ajvField.enum,
          };
          delete ajvField.enum;
        } else {
          ajvField.type = field.allowNull ? ['string', 'null'] : 'string';
          if (field.allowNull && Array.isArray(ajvField.enum)) {
            ajvField.enum = [...ajvField.enum, null];
          }
        }
        break;

      case 'checkbox':
        if (field.choices && Array.isArray(field.choices) && field.choices.length > 0) {
          ajvField.type = 'array';
          ajvField.items = {
            type: 'string',
            enum: this.extractEnumValues(field.choices),
          };
          ajvField.uniqueItems = true;
          delete ajvField.enum;
        } else {
          ajvField.type = 'boolean';
        }
        break;

      case 'boolean':
        ajvField.type = 'boolean';
        break;

      case 'relation':
        ajvField.type = ['array', 'string', 'null'];
        ajvField.items = { type: ['string', 'null'] };
        // Keep typeRelation for relationship registry
        if (field.typeRelation) (ajvField as any).typeRelation = field.typeRelation;
        (ajvField as any).widget = 'relation';
        break;

      case 'file':
      case 'multipleFiles':
      case 'multiImage':
        ajvField.type = ['array', 'string', 'null'];
        ajvField.items = {
          type: ['string', 'null'],
        };
        break;

      case 'condition':
      case 'href':
        ajvField.type = 'object';
        break;

      case 'array':
        ajvField.type = 'array';
        ajvField.items = { type: 'object' };
        break;

      case 'icon':
      case 'function':
      case 'break':
      case 'dataWidget':
        ajvField.type = 'string';
        break;
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Handle choices/enum conversion
   */
  private handleChoices(field: FieldDefinition, ajvField: AjvSchema): void {
    if (!field.choices) return;

    if (typeof field.choices === 'string') {
      // Format: "label1:value1\nlabel2:value2"
      const pairs = field.choices.split('\n').filter(Boolean);
      ajvField.enum = pairs.map(pair => {
        const [, value] = pair.split(':');
        return value?.trim() || pair.trim();
      });
    } else if (Array.isArray(field.choices)) {
      ajvField.enum = this.extractEnumValues(field.choices);
    }

    // Remove empty enum
    if (Array.isArray(ajvField.enum) && ajvField.enum.length === 0) {
      delete ajvField.enum;
    }
  }

  /**
   * Extract enum values from choices array
   */
  private extractEnumValues(choices: Array<{ key?: string; value?: string } | string>): unknown[] {
    return choices.map(choice => {
      if (typeof choice === 'string') return choice;
      return choice.value || choice.key || '';
    });
  }

  /**
   * Handle string constraints (min/max length)
   */
  private handleStringConstraints(field: FieldDefinition, ajvField: AjvSchema): void {
    if (field.minLength !== undefined) {
      const minLen = typeof field.minLength === 'string'
        ? parseInt(field.minLength)
        : field.minLength;
      if (!isNaN(minLen) && minLen >= 0) {
        ajvField.minLength = minLen;
      }
    }

    if (field.maxLength !== undefined) {
      const maxLen = typeof field.maxLength === 'string'
        ? parseInt(field.maxLength)
        : field.maxLength;
      if (!isNaN(maxLen) && maxLen > 0) {
        ajvField.maxLength = maxLen;
      }
    }

    // Handle min/max as string length for string types
    if (ajvField.type === 'string' || (Array.isArray(ajvField.type) && ajvField.type.includes('string'))) {
      if (typeof field.min === 'number' && !ajvField.minLength) {
        ajvField.minLength = field.min;
      }
      if (typeof field.max === 'number' && !ajvField.maxLength) {
        ajvField.maxLength = field.max;
      }
    }
  }

  /**
   * Handle nested object conversion
   */
  private handleNestedObject(
    field: FieldDefinition,
    ajvField: AjvSchema,
    fieldPath: string,
    depth: number
  ): void {
    ajvField.type = 'object';
    ajvField.additionalProperties = this.options.additionalProperties;

    const nestedSchema = this.convertSchema(
      {
        properties: field?.properties,
        required: field.required || [],
      },
      fieldPath,
      depth + 1
    );

    ajvField.properties = nestedSchema?.properties;
    if (field.required && field.required.length > 0) {
      ajvField.required = field.required;
    }
  }

  /**
   * Handle array conversion
   */
  private handleArray(
    field: FieldDefinition,
    ajvField: AjvSchema,
    fieldPath: string,
    depth: number
  ): void {
    ajvField.type = 'array';

    if (field.items?.properties) {
      const nestedSchema = this.convertSchema(
        {
          properties: field.items?.properties,
          required: field.items.required || [],
        },
        fieldPath,
        depth + 1
      );

      ajvField.items = {
        type: 'object',
        properties: nestedSchema?.properties,
        additionalProperties: this.options.additionalProperties,
      };

      if (field.items.required && field.items.required.length > 0) {
        ajvField.items.required = field.items.required;
      }
    } else if (field.items) {
      ajvField.items = this.convertField(field.items, fieldPath, depth + 1);
    }
  }

  /**
   * Sanitize default value based on type
   */
  private sanitizeDefault(defaultValue: unknown, type?: string | string[]): unknown {
    const primaryType = Array.isArray(type) ? type[0] : type;

    switch (primaryType) {
      case 'string':
        if (Array.isArray(defaultValue)) return '';
        if (typeof defaultValue === 'boolean') return String(defaultValue);
        return defaultValue;

      case 'array':
        if (!Array.isArray(defaultValue)) return [];
        return defaultValue;

      case 'object':
        if (typeof defaultValue !== 'object' || defaultValue === null) return {};
        return defaultValue;

      case 'number':
        if (typeof defaultValue === 'string') {
          const num = parseFloat(defaultValue);
          return isNaN(num) ? 0 : num;
        }
        return defaultValue;

      case 'boolean':
        if (typeof defaultValue === 'string') {
          return defaultValue === 'true';
        }
        return defaultValue;

      default:
        return defaultValue;
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a new schema converter
 */
export function createSchemaConverter(options?: ConversionOptions): SchemaConverter {
  return new SchemaConverter(options);
}

/**
 * Convert schema (convenience function)
 */
export function convertToAjvSchema(
  originalSchema: { properties?: Record<string, FieldDefinition>; required?: string[] },
  collectionName: string,
  options?: ConversionOptions
): AjvSchema {
  const converter = new SchemaConverter(options);
  return converter.convert(originalSchema, collectionName);
}
