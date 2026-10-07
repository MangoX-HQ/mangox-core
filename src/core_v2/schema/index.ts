/**
 * Core V2 - Schema Module
 * Entity configuration, validation, and code generation
 */

// Entity Config Loader
export {
  EntityConfig,
  JSONSchema,
  JSONSchemaProperty,
  EntitiesData,
  IEntityConfigSource,
  EntityConfigLoader,
  createEntityConfigLoader,
  JSONEntityConfigSource,
} from './loader';

// AJV Validator
export {
  ValidationResult,
  ValidationError,
  ValidationOptions,
  AjvValidator,
  createAjvValidator,
  getGlobalValidator,
  resetGlobalValidator,
} from './validator';

// Schema Converter
export {
  FieldDefinition,
  AjvSchema,
  ConversionOptions,
  SchemaConverter,
  createSchemaConverter,
  convertToAjvSchema,
} from './converter';

// Schema Manager (single source of truth)
export {
  schemaManager,
  schema,
  SchemaCollection,
  EntitySchema,
} from './manager';

// Audit log emitter
export { logEmitter } from './events';
