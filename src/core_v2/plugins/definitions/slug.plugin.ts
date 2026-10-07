/**
 * Core V2 - Slug Plugin
 * Generates unique slugs for content
 */

import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, isSingleData } from '../../query/intermediate';

// ============================================================================
// SLUG CHECKER INTERFACE
// ============================================================================

/**
 * Interface for checking slug uniqueness
 */
export interface SlugScope {
  /** Logical entity name to scope uniqueness (e.g., 'post_market'). When set,
   * uniqueness is per-entity within tenant. When omitted, falls back to
   * global-tenant-scope. */
  entitySlug?: string;
  /** Tenant identifier. Required for proper isolation in multi-tenant setups. */
  tenantId?: string;
}

export interface ISlugChecker {
  checkSlugExists(collection: string, slug: string, excludeId?: string, scope?: SlugScope): Promise<boolean>;
  findExistingSlug(collection: string, slug: string, relatedId?: string, scope?: SlugScope): Promise<{
    exists: boolean;
    isOwned: boolean;
    hasRedirect: boolean;
  }>;
}

// Global slug checker instance
let slugChecker: ISlugChecker | null = null;

/**
 * Set the slug checker implementation
 */
export function setSlugChecker(checker: ISlugChecker): void {
  slugChecker = checker;
}

/**
 * Get the slug checker implementation
 */
export function getSlugChecker(): ISlugChecker | null {
  return slugChecker;
}

// ============================================================================
// SLUG HELPERS
// ============================================================================

/**
 * Generate a base slug from title
 */
function generateBaseSlug(title: string): string {
  return String(title)
    .toLowerCase()
    // Vietnamese-specific letters that NFD doesn't decompose (\u0111/\u0110).
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'd')
    .normalize('NFD')
    // Remove combining diacritics (NFD-decomposed accents)
    .replace(/[\u0300-\u036f]/g, '')
    // Replace non-alphanumeric (except Unicode letters/numbers and spaces) with hyphen
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    // Replace multiple spaces/hyphens with single hyphen
    .replace(/[\s-]+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '');
}

/**
 * Generate a unique slug by appending `-2` suffix.
 * If MongoDB still rejects (rare race condition), the adapter's E11000 retry
 * path will increment the counter further (-3, -4, ...).
 */
function generateUniqueSlug(baseSlug: string): string {
  return `${baseSlug}-2`;
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Slug plugin - generates unique slugs
 *
 * Entity config:
 * - use_slug: true/false - Enable/disable plugin
 */
export const slugPlugin: PluginDefinition = definePlugin('use_slug', {
  description: 'Generates unique slugs for content',
  phases: ['before'],
  priority: 15,
  enabled: true,

  before: async (query: IntermediateQuery, context: PluginContext): Promise<void> => {
    // Only handle single data operations
    if (!isSingleData(query.data)) return;

    const data = query.data;
    const id = query.metadata?.hints?.id as string | undefined;

    // Scope per-entity: query.collection is now ALWAYS the logical entity name
    // (core-service translates physical via query.physicalCollection separately).
    const scope: SlugScope = {
      entitySlug:   (data.post_type ? (Array.isArray(data.post_type) ? data.post_type[0] : data.post_type) : query.collection),
      tenantId: (data.tenant_id as string | undefined) ?? (query.options as any)?.tenant_id,
    };

    switch (query.type) {
      case 'insert': {
        const title = (data.title || data.slug || 'unknown') as string;
        const baseSlug = data.slug ? String(data.slug) : generateBaseSlug(title);

        if (!slugChecker) {
          // No checker available, just use base slug
          data.slug = baseSlug;
          query.metadata.options = {
            ...query.metadata.options,
            no_save_seo_path: false,
          };
          return;
        }

        const result = await slugChecker.findExistingSlug('seopath', baseSlug, undefined, scope);

        if (!result.exists) {
          data.slug = baseSlug;
          query.metadata.options = {
            ...query.metadata.options,
            no_save_seo_path: false,
          };
        } else {
          // Generate unique slug
          data.slug = generateUniqueSlug(baseSlug);
          query.metadata.options = {
            ...query.metadata.options,
            no_save_seo_path: false,
          };
        }
        break;
      }

      case 'update': {
        if (!id) return;

        if (!data.slug) {
          query.metadata.options = {
            ...query.metadata.options,
            no_save_seo_path: true,
          };
          return;
        }

        const baseSlug = String(data.slug);

        if (!slugChecker) {
          data.slug = baseSlug;
          return;
        }

        const result = await slugChecker.findExistingSlug('seopath', baseSlug, id, scope);

        if (!result.exists) {
          data.slug = baseSlug;
          query.metadata.options = {
            ...query.metadata.options,
            no_save_seo_path: false,
          };
        } else if (result.isOwned) {
          data.slug = baseSlug;
          query.metadata.options = {
            ...query.metadata.options,
            no_save_seo_path: result.hasRedirect ? false : true,
          };
        } else {
          data.slug = generateUniqueSlug(baseSlug);
          query.metadata.options = {
            ...query.metadata.options,
            no_save_seo_path: false,
          };
        }
        break;
      }

      case 'updateMany':
        // Remove slug from bulk updates
        delete data.slug;
        break;
    }
  },
});

export default slugPlugin;
