/**
 * Core V2 - Plugin Manager
 * Database-agnostic plugin system
 *
 * Key improvements over v1:
 * - No MongoDB-specific types in core plugin system
 * - Configurable plugin order
 * - Proper error handling
 * - Plugin lifecycle hooks
 */

import * as fs from 'fs';
import { IntermediateQuery, QueryResult } from '../query/intermediate';
import { PluginConfig, getGlobalConfig } from '../config';
import { Errors, PluginError, CoreError } from '../errors';

// TEMP debug: trace plugin gating for group-field → /tmp/seopath-debug.log
function _pmDbg(stage: string, data: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      '/tmp/seopath-debug.log',
      `${new Date().toISOString()} [pm:${stage}] ${JSON.stringify(data)}\n`,
    );
  } catch {}
}

// ============================================================================
// PLUGIN INTERFACES
// ============================================================================

/**
 * Plugin execution phase
 */
export type PluginPhase = 'before' | 'main' | 'after';

/**
 * Plugin context passed to plugin handlers
 */
export interface PluginContext {
  /** Target collection */
  collection: string;

  /** Entity configuration (from schema) */
  entityConfig: Record<string, unknown>;

  /** Current execution phase */
  phase: PluginPhase;

  /** Additional context data */
  data?: Record<string, unknown>;
}

/**
 * Plugin handler function signature
 */
export type PluginHandler<TQuery = unknown, TResult = unknown> = (
  query: IntermediateQuery,
  context: PluginContext,
  nativeQuery?: TQuery,
  result?: QueryResult<TResult>
) => Promise<void> | void;

/**
 * Plugin definition
 */
export interface PluginDefinition {
  /** Unique plugin name */
  name: string;

  /** Plugin description */
  description?: string;

  /** Phases this plugin runs in */
  phases: PluginPhase[];

  /** Handler for 'before' phase */
  before?: PluginHandler;

  /** Handler for 'main' phase (receives native query) */
  main?: PluginHandler;

  /** Handler for 'after' phase (receives result) */
  after?: PluginHandler;

  /** Priority (lower = runs first) */
  priority?: number;

  /** Dependencies (other plugin names) */
  dependencies?: string[];

  /** Whether plugin is enabled by default */
  enabled?: boolean;
}

/**
 * Registered plugin with runtime state
 */
interface RegisteredPlugin extends PluginDefinition {
  enabled: boolean;
}

// ============================================================================
// PLUGIN MANAGER
// ============================================================================

/**
 * Manages plugin registration and execution
 */
export class PluginManager {
  private plugins: Map<string, RegisteredPlugin> = new Map();
  private config: PluginConfig;

  constructor(config?: PluginConfig) {
    this.config = config || getGlobalConfig().plugins;
  }

  // ============================================================================
  // REGISTRATION
  // ============================================================================

  /**
   * Register a plugin
   * @param definition - Plugin definition
   *
   * If a plugin with the same name already exists, handlers are merged
   * (before, main, after) instead of overwriting completely.
   * This allows splitting a plugin into multiple files (e.g., before and after phases).
   */
  register(definition: PluginDefinition): void {
    if (this.plugins.has(definition.name)) {
      // Merge with existing plugin instead of overwriting
      const existing = this.plugins.get(definition.name)!;

      // Merge phases
      const mergedPhases = [...new Set([...existing.phases, ...definition.phases])];

      // Merge handlers (keep existing handlers if new definition doesn't have them)
      this.plugins.set(definition.name, {
        ...existing,
        ...definition,
        phases: mergedPhases as PluginPhase[],
        before: definition.before || existing.before,
        main: definition.main || existing.main,
        after: definition.after || existing.after,
        priority: Math.min(existing.priority || 999, definition.priority || 999),
        enabled: definition.enabled !== false && existing.enabled !== false,
      });
    } else {
      this.plugins.set(definition.name, {
        ...definition,
        enabled: definition.enabled !== false,
      });
    }
  }

  /**
   * Register multiple plugins
   * @param definitions - Array of plugin definitions
   */
  registerMany(definitions: PluginDefinition[]): void {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /**
   * Unregister a plugin
   * @param name - Plugin name
   */
  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  /**
   * Check if a plugin is registered
   * @param name - Plugin name
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Get a plugin definition
   * @param name - Plugin name
   */
  get(name: string): RegisteredPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Enable a plugin
   * @param name - Plugin name
   */
  enable(name: string): void {
    const plugin = this.plugins.get(name);
    if (plugin) {
      plugin.enabled = true;
    }
  }

  /**
   * Disable a plugin
   * @param name - Plugin name
   */
  disable(name: string): void {
    const plugin = this.plugins.get(name);
    if (plugin) {
      plugin.enabled = false;
    }
  }

  /**
   * List all registered plugins
   */
  list(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * List enabled plugins
   */
  listEnabled(): RegisteredPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.enabled);
  }

  // ============================================================================
  // EXECUTION
  // ============================================================================

  /**
   * Get plugins to execute for a phase
   * @param phase - Execution phase
   * @param entityConfig - Entity configuration
   */
  private getPluginsForPhase(
    phase: PluginPhase,
    entityConfig: Record<string, unknown>
  ): RegisteredPlugin[] {
    // Get plugin order from config
    let orderedNames: string[];
    switch (phase) {
      case 'before':
        orderedNames = this.config.beforePlugins;
        break;
      case 'main':
        orderedNames = this.config.mainPlugins;
        break;
      case 'after':
        orderedNames = this.config.afterPlugins;
        break;
      default:
        orderedNames = [];
    }

    // Filter to enabled plugins that are in the phase order and have the phase handler
    const plugins: RegisteredPlugin[] = [];

    for (const name of orderedNames) {
      const plugin = this.plugins.get(name);

      if (!plugin) continue;
      if (!plugin.enabled) continue;
      if (!plugin.phases.includes(phase)) continue;

      // Check if entity has this plugin enabled
      const pluginKey = name.startsWith('use_') ? name : `use_${name}`;
      if (entityConfig[pluginKey] === false) continue;
      if (entityConfig[pluginKey] === undefined && !entityConfig[name]) {
        // Plugin not configured for this entity, check if it has explicit config
        const hasExplicitConfig = entityConfig[pluginKey] !== undefined || entityConfig[name] !== undefined;
        if (!hasExplicitConfig) continue;
      }

      plugins.push(plugin);
    }

    const cn = (entityConfig.collection_name as string) || (entityConfig.collectionName as string);
    if (cn === 'group-field') {
      _pmDbg('gate', {
        phase,
        collection_name: cn,
        use_slug: entityConfig.use_slug,
        use_seo_path: entityConfig.use_seo_path,
        use_seopath: (entityConfig as any).use_seopath,
        entityConfigKeys: Object.keys(entityConfig).filter((k) => k.startsWith('use_')),
        selected: plugins.map((p) => p.name),
      });
    }

    return plugins;
  }

  /**
   * Execute plugins for the 'before' phase
   * @param query - Intermediate query to modify
   * @param context - Plugin context
   */
  async executeBefore(
    query: IntermediateQuery,
    context: Omit<PluginContext, 'phase'>
  ): Promise<void> {
    const fullContext: PluginContext = { ...context, phase: 'before' };
    const plugins = this.getPluginsForPhase('before', context.entityConfig);

    for (const plugin of plugins) {
      if (!plugin.before) continue;

      try {
        await plugin.before(query, fullContext);
      } catch (error) {
        // CoreError (e.g. Authorization/Validation from the approval plugin) already has the correct
        // statusCode (403/400) → rethrow as-is, don't wrap it into a 500.
        if (error instanceof CoreError) throw error;
        throw Errors.pluginExecutionFailed(
          plugin.name,
          error instanceof Error ? error.message : 'Unknown error',
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Execute plugins for the 'main' phase
   * @param query - Intermediate query
   * @param nativeQuery - Native database query to modify
   * @param context - Plugin context
   */
  async executeMain<TQuery = unknown>(
    query: IntermediateQuery,
    nativeQuery: TQuery,
    context: Omit<PluginContext, 'phase'>
  ): Promise<void> {
    const fullContext: PluginContext = { ...context, phase: 'main' };
    const plugins = this.getPluginsForPhase('main', context.entityConfig);

    for (const plugin of plugins) {
      if (!plugin.main) continue;

      try {
        await plugin.main(query, fullContext, nativeQuery);
      } catch (error) {
        // CoreError (e.g. Authorization/Validation from the approval plugin) already has the correct
        // statusCode (403/400) → rethrow as-is, don't wrap it into a 500.
        if (error instanceof CoreError) throw error;
        throw Errors.pluginExecutionFailed(
          plugin.name,
          error instanceof Error ? error.message : 'Unknown error',
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Execute plugins for the 'after' phase
   * @param query - Intermediate query
   * @param result - Query result to modify
   * @param context - Plugin context
   */
  async executeAfter<TResult = unknown>(
    query: IntermediateQuery,
    result: QueryResult<TResult>,
    context: Omit<PluginContext, 'phase'>
  ): Promise<void> {
    const fullContext: PluginContext = { ...context, phase: 'after' };
    const plugins = this.getPluginsForPhase('after', context.entityConfig);

    for (const plugin of plugins) {
      if (!plugin.after) continue;

      try {
        await plugin.after(query, fullContext, undefined, result);
      } catch (error) {
        // CoreError (e.g. Authorization/Validation from the approval plugin) already has the correct
        // statusCode (403/400) → rethrow as-is, don't wrap it into a 500.
        if (error instanceof CoreError) throw error;
        throw Errors.pluginExecutionFailed(
          plugin.name,
          error instanceof Error ? error.message : 'Unknown error',
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  /**
   * Execute all phases in order
   * @param phase - Which phase to execute
   * @param query - Intermediate query
   * @param context - Plugin context
   * @param nativeQuery - Native query (for 'main' phase)
   * @param result - Query result (for 'after' phase)
   */
  async execute<TQuery = unknown, TResult = unknown>(
    phase: PluginPhase,
    query: IntermediateQuery,
    context: Omit<PluginContext, 'phase'>,
    nativeQuery?: TQuery,
    result?: QueryResult<TResult>
  ): Promise<void> {
    switch (phase) {
      case 'before':
        await this.executeBefore(query, context);
        break;
      case 'main':
        if (nativeQuery !== undefined) {
          await this.executeMain(query, nativeQuery, context);
        }
        break;
      case 'after':
        if (result !== undefined) {
          await this.executeAfter(query, result, context);
        }
        break;
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let globalPluginManager: PluginManager | null = null;

/**
 * Get global plugin manager instance
 */
export function getPluginManager(): PluginManager {
  if (!globalPluginManager) {
    globalPluginManager = new PluginManager();
  }
  return globalPluginManager;
}

/**
 * Set global plugin manager instance
 */
export function setPluginManager(manager: PluginManager): void {
  globalPluginManager = manager;
}

/**
 * Create a new plugin manager
 */
export function createPluginManager(config?: PluginConfig): PluginManager {
  return new PluginManager(config);
}

// ============================================================================
// HELPER: Create Plugin
// ============================================================================

/**
 * Helper function to create a plugin definition
 */
export function definePlugin(
  name: string,
  options: Omit<PluginDefinition, 'name'>
): PluginDefinition {
  return {
    name,
    ...options,
  };
}
