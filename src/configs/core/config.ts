/**
 * Core V2 Configuration
 *
 * ALL CORE V2 CONFIG LIVES HERE
 * Just edit this file to change the config
 */

// ============================================================================
// RBAC CONFIG
// ============================================================================

export const RBAC_CONFIG = {
  // Collections that don't need RBAC checks
  bypassAccessList: [
    'system',
    'entity',
    'policy',
    'rolepermission',
  ],

  // Collections that projection doesn't apply to
  bypassProjectionList: [
    'entity',
    'user',
  ],

  // System fields - always returned in the response
  systemFields: [
    '_id',
    'created_at',
    'updated_at',
    'created_by',
    'updated_by',
    'tenant_id',
    'collection_name',
    'status_approve',
    'slug',
    'title',
    'system',
    'locale',
    'locale_id',
    'post_type',
    'blocks_position',
    'blocks_position_data',

    'parent_id',
    'parent_id_obj',
    'children',
    'is_root',
    'position',
    'deleted',
    'deleted_at',
    'deleted_by',

  ],

  // Fields that need date formatting
  dateFormatFields: [
    'created_at',
    'updated_at',
    'publish_start',
    'publish_end',
  ],

  // Plugin fields - fields added by plugins
  // When an entity enables a plugin, these fields will be allowed
  pluginFields: [
    { plugin: 'use_locale', fields: ['locale', 'locale_id', 'languages'] },
    { plugin: 'use_soft_delete', fields: ['deleted', 'deleted_at', 'deleted_by'] },
    { plugin: 'use_block', fields: ['blocks', 'blocks_position', 'blocks_position_data'] },
    { plugin: 'use_form_builder', fields: ['json_schema', 'ui_schema', 'entity_save_data', 'template_mail', 'settings', 'collection_name'] },
    { plugin: 'use_parent', fields: ['parent', 'parent_id', 'parent_id_obj', 'children', 'position', 'is_root'] },
    { plugin: 'use_seopath', fields: ['seopath'] },
    { plugin: 'use_slug', fields: ['slug'] },
    { plugin: 'use_posttype', fields: ['post_type'] },
    { plugin: 'use_history', fields: ['history', 'reason', 'rule'] },
    { plugin: 'use_approval_process', fields: ['status_approve', 'publish_start', 'publish_end'] },
    { plugin: 'use_pinned', fields: ['pinned'] },
    { plugin: 'use_timestamp', fields: ['created_at', 'updated_at'] },
  ],

  // Default role
  defaultRole: 'default',

  // Roles with admin privileges (bypass all RBAC)
  adminRoles: ['admin'],
};

// ============================================================================
// PLUGIN CONFIG
// ============================================================================

export const PLUGIN_CONFIG = {
  enabled: true,

  // Plugins that run in the BEFORE phase (before building the query)
  // Order matters - runs top to bottom
  beforePlugins: [
    'use_approval_process', // Validate/adjust status BEFORE any transform (before history in main/after)
    'use_locale',
    'use_timestamp',
    'use_slug',
    'use_parent',
    'use_get_parent', // Expand tree-relationship filters (category=eq → in.[con]) on read
    'use_soft_delete',
    'use_block',
    'use_generate_fields',
  ],

  // Plugins that run in the MAIN phase (after building the query, modify the native query)
  mainPlugins: [
    'use_pinned',
    'use_locale',
    'use_history',
    'use_parent',
    'use_form_builder',
  ],

  // Plugins that run in the AFTER phase (after the result is available)
  afterPlugins: [
    'use_slug',      // Seopath - handles the SEO path after insert/update
    'use_parent',    // Build tree structure
    'use_sync_relationship_multiply_language',
    'use_block',     // Populate block data
    'use_history',   // Handle history entries
  ],

  pluginOptions: {},
};

// ============================================================================
// CACHE CONFIG
// ============================================================================

export const CACHE_CONFIG = {
  enabled: true,
  defaultTTL: 3600,           // 1 hour
  keyPrefix: 'core:v2',
  compressionThreshold: 1024,
  excludeCollections: ['user_token', 'session'],
};

// ============================================================================
// QUERY CONFIG
// ============================================================================

export const QUERY_CONFIG = {
  defaultLimit: 20,
  maxLimit: 1000,
  includeIdInSort: true,
  defaultSort: {
    field: 'created_at',
    direction: 'desc' as const,
  },
};
