/**
 * Core V2 - Locale Plugin
 * Validates locale uniqueness on insert
 */

import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, isSingleData } from '../../query/intermediate';
import { Errors } from '../../errors';
import { ObjectId } from 'mongodb';
import { typeLocale } from '../../compat';

// ============================================================================
// LOCALE CHECKER INTERFACE
// ============================================================================

/**
 * Interface for checking locale existence
 * This is injected to avoid direct database dependency
 */
export interface ILocaleChecker {
  checkLocaleExists(
    collection: string,
    localeId: string,
    locale: string
  ): Promise<boolean>;
}

// Global locale checker instance
let localeChecker: ILocaleChecker | null = null;

/**
 * Set the locale checker implementation
 */
export function setLocaleChecker(checker: ILocaleChecker): void {
  localeChecker = checker;
}

/**
 * Get the locale checker implementation
 */
export function getLocaleChecker(): ILocaleChecker | null {
  return localeChecker;
}

const validateLocaleInsert = async (
  query: IntermediateQuery,
  _context: PluginContext
): Promise<void> => {
  // Only handle single data operations
    if (!isSingleData(query.data)) {
      return;
    }

    const data = query.data;
    if (!data._id || !(data._id instanceof ObjectId)) {
      data._id = new ObjectId();
    }
    if (!data.locale_id) {
      data.locale_id = (data._id as any).toString();
    }
    if (!data.locale) {
      data.locale = "vi"
    }

    // Check if locale checker is available
    if (!localeChecker) {
      console.warn('[use_locale] Locale checker not configured, skipping validation');
      return;
    }

    const exists = await localeChecker.checkLocaleExists(
      query.collection,
      data.locale_id as string,
      data.locale as string
    );

    if (exists) {
      throw Errors.validation(
        `Locale already exists: ${data.locale_id} - ${data.locale}`,
        { field: 'locale', value: data.locale, localeId: data.locale_id }
      );
    }
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Locale plugin - validates locale uniqueness
 *
 * Entity config:
 * - use_locale: true/false - Enable/disable plugin
 */
export const localePlugin: PluginDefinition = definePlugin('use_locale', {
  description: 'Validates locale uniqueness on insert',
  phases: ['before', 'main'],
  priority: 5,
  enabled: true,

  before: async (query: IntermediateQuery, context: PluginContext): Promise<void> => {
    switch (query.type) {
      case 'insert':
        await validateLocaleInsert(query, context);
        break;
      default:
        // No action
        break;
    }
  },

  main: (query: IntermediateQuery, context: PluginContext, nativeQuery?: unknown): void => {
    // For MongoDB: Add locale-specific handling to pipeline
    if (query.type !== 'read') {
      return;
    }

    // Add $lookup to find all documents with same locale_id and populate languages array
    if (Array.isArray(nativeQuery)) {
      // Find and remove any existing languages $match (will be re-added at the end if needed)
      const matchIndex = nativeQuery.findIndex((item) => {
        return (
          typeof item === 'object' &&
          item !== null &&
          '$match' in item &&
          typeof (item as any)['$match'] === 'object' &&
          (item as any)['$match'] !== null &&
          'languages' in (item as any)['$match']
        );
      });

      const matchLanguage =
        matchIndex >= 0
          ? (nativeQuery[matchIndex] as any)['$match']['languages']['$in']
          : null;

      if (matchIndex >= 0) {
        // Remove match stage - will be re-added after languages is computed
        nativeQuery.splice(matchIndex, 1);
      }

      // Add $lookup to find documents with same locale_id.
      // For polymorphic collections (mongodb_save_data) we must `from` the physical
      // collection AND scope by `collection_name = logical entity` — otherwise
      // sibling logical entities sharing the same store leak into `languages`.
      const lookupFrom = query.physicalCollection || query.collection;
      const polymorphicFilter = query.physicalCollection
        ? { collection_name: query.collection }
        : {};

      // Tenant isolation: only count languages for records in the same tenant.
      const localeLookupTenantId = query.metadata?.user?.tenant_id;
      const tenantMatchPart = localeLookupTenantId
        ? { tenant_id: localeLookupTenantId }
        : {};

      nativeQuery.push(
        {
          $lookup: {
            from: lookupFrom,
            localField: 'locale_id',
            foreignField: 'locale_id',
            pipeline: [
              {
                $match: {
                  ...tenantMatchPart,
                  ...polymorphicFilter,
                  $expr: {
                    $ne: [{ $ifNull: ['$locale_id', null] }, null],
                  },
                },
              },
            ],
            as: 'sameLocale',
          },
        },
        {
          $addFields: {
            languages: {
              $filter: {
                input: {
                  $map: {
                    input: { $ifNull: ['$sameLocale', []] },
                    as: 'doc',
                    in: '$$doc.locale',
                  },
                },
                as: 'lang',
                cond: { $ne: ['$$lang', null] },
              },
            },
          },
        },
        {
          $project: {
            sameLocale: 0,
          },
        }
      );

      // Re-add languages filter if it existed
      if (matchLanguage) {
        let languagesArray: string[];

        if (typeof matchLanguage === 'string') {
          languagesArray = matchLanguage
            .slice(1, -1)
            .split(',')
            .map((lang: string) => lang.trim());
        } else {
          languagesArray = matchLanguage;
        }

        nativeQuery.push({
          $match: {
            $expr: {
              $setEquals: [{ $ifNull: ['$languages', []] }, languagesArray],
            },
          },
        });
      }
    }
  },
});

export default localePlugin;
