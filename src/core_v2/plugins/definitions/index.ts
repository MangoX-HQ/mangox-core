/**
 * Core V2 - Plugin Definitions Index
 */

// Plugin definitions
export { timestampPlugin } from './timestamp.plugin';
export { softDeletePlugin } from './soft-delete.plugin';
export { localePlugin, setLocaleChecker, getLocaleChecker, ILocaleChecker } from './locale.plugin';
export { slugPlugin, setSlugChecker, getSlugChecker, ISlugChecker } from './slug.plugin';
export {
  seopathPlugin,
  setSeopathOperations,
  getSeopathOperations,
  setEntitySchemaGetter,
  getEntitySchemaGetter,
  ISeopathOperations,
  SeopathRecord,
  EntitySchema,
} from './seopath.plugin';
export {
  parentPlugin,
  setObjectIdValidator,
  getObjectIdValidator,
  IObjectIdValidator,
  buildTreeFromFlat,
  flattenTree,
} from './parent.plugin';
export {
  historyPlugin,
  setUserLookup,
  getUserLookup,
  IUserLookup,
  setHistoryOperations,
  getHistoryOperations,
  IHistoryOperations,
  HistoryEntry,
} from './history.plugin';
export {
  blockPlugin,
  setBlockOperations,
  getBlockOperations,
  IBlockOperations,
  BlockItem,
} from './block.plugin';
export { pinPlugin } from './pin.plugin';
export {
  generatorPlugin,
  GeneratorType,
  GeneratorConfig,
} from './generator.plugin';
export {
  syncRelationshipPlugin,
  setSyncRelationshipOperations,
  getSyncRelationshipOperations,
  ISyncRelationshipOperations,
  RelationshipInfo,
} from './sync-relationship.plugin';
export {
  approvalProcessPlugin,
  setApprovalOperations,
  getApprovalOperations,
  IApprovalOperations,
  ApprovalRule,
  ApprovalPermission,
} from './approval-process.plugin';
export { getParentPlugin } from './get-parent.plugin';
export { formBuilderPlugin } from './form-builder.plugin';

// All plugins array for easy registration
import { timestampPlugin } from './timestamp.plugin';
import { softDeletePlugin } from './soft-delete.plugin';
import { localePlugin } from './locale.plugin';
import { slugPlugin } from './slug.plugin';
import { seopathPlugin } from './seopath.plugin';
import { parentPlugin } from './parent.plugin';
import { historyPlugin } from './history.plugin';
import { blockPlugin } from './block.plugin';
import { pinPlugin } from './pin.plugin';
import { generatorPlugin } from './generator.plugin';
import { syncRelationshipPlugin } from './sync-relationship.plugin';
import { approvalProcessPlugin } from './approval-process.plugin';
import { getParentPlugin } from './get-parent.plugin';
import { formBuilderPlugin } from './form-builder.plugin';
import { PluginDefinition } from '../plugin-manager';

/**
 * All built-in plugins
 */
export const builtInPlugins: PluginDefinition[] = [
  approvalProcessPlugin, // Run first for status validation
  timestampPlugin,
  softDeletePlugin,
  localePlugin,
  slugPlugin,
  seopathPlugin, // After slug plugin
  parentPlugin,
  getParentPlugin, // Expand tree relationship filters (use_get_parent) on read
  historyPlugin,
  blockPlugin,
  pinPlugin,
  generatorPlugin,
  syncRelationshipPlugin,
  formBuilderPlugin,
];

/**
 * Register all built-in plugins with a plugin manager
 */
export function registerBuiltInPlugins(pluginManager: { registerMany: (plugins: PluginDefinition[]) => void }): void {
  pluginManager.registerMany(builtInPlugins);
}
