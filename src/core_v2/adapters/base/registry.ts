/**
 * Core V2 - Adapter Registry
 * Manages database adapters with factory pattern
 *
 * Key improvements over v1:
 * - Factory pattern for adapter creation
 * - Support for all database types (not just MongoDB)
 * - Proper singleton with lazy initialization
 * - Type-safe adapter retrieval
 */

import { DatabaseType } from '../../types';
import { AdapterConfig } from '../../config';
import { IDatabaseAdapter, IAdapterFactory, IRelationshipRegistry } from '../../interfaces/adapter.interface';
import { Errors, AdapterError } from '../../errors';

// ============================================================================
// ADAPTER REGISTRY
// ============================================================================

/**
 * Registry for managing database adapters
 */
export class AdapterRegistry {
  private static instance: AdapterRegistry | null = null;

  /** Registered adapter factories */
  private factories: Map<DatabaseType, IAdapterFactory> = new Map();

  /** Initialized adapter instances */
  private adapters: Map<DatabaseType, IDatabaseAdapter> = new Map();

  /** Relationship registry shared across adapters */
  private relationshipRegistry: IRelationshipRegistry | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get singleton instance
   */
  static getInstance(): AdapterRegistry {
    if (!AdapterRegistry.instance) {
      AdapterRegistry.instance = new AdapterRegistry();
    }
    return AdapterRegistry.instance;
  }

  /**
   * Reset singleton (for testing)
   */
  static resetInstance(): void {
    if (AdapterRegistry.instance) {
      // Dispose all adapters before reset
      AdapterRegistry.instance.disposeAll().catch(console.error);
      AdapterRegistry.instance = null;
    }
  }

  /**
   * Set the relationship registry
   */
  setRelationshipRegistry(registry: IRelationshipRegistry): void {
    this.relationshipRegistry = registry;
  }

  /**
   * Get the relationship registry
   */
  getRelationshipRegistry(): IRelationshipRegistry | null {
    return this.relationshipRegistry;
  }

  // ============================================================================
  // FACTORY MANAGEMENT
  // ============================================================================

  /**
   * Register an adapter factory
   * @param factory - The factory to register
   */
  registerFactory(factory: IAdapterFactory): void {
    this.factories.set(factory.type, factory);
  }

  /**
   * Unregister an adapter factory
   * @param type - Database type to unregister
   */
  unregisterFactory(type: DatabaseType): boolean {
    return this.factories.delete(type);
  }

  /**
   * Get a registered factory
   * @param type - Database type
   */
  getFactory(type: DatabaseType): IAdapterFactory | undefined {
    return this.factories.get(type);
  }

  /**
   * List all registered factory types
   */
  listFactoryTypes(): DatabaseType[] {
    return Array.from(this.factories.keys());
  }

  // ============================================================================
  // ADAPTER MANAGEMENT
  // ============================================================================

  /**
   * Initialize an adapter using its factory
   * @param config - Adapter configuration
   */
  async initializeAdapter(config: AdapterConfig): Promise<IDatabaseAdapter> {
    const factory = this.factories.get(config.type);

    if (!factory) {
      throw Errors.adapterNotFound(config.type);
    }

    if (!factory.supports(config)) {
      throw new AdapterError(
        'E6004',
        `Factory for '${config.type}' does not support the provided configuration`,
        { config }
      );
    }

    const adapter = await factory.create(config);
    this.adapters.set(config.type, adapter);

    return adapter;
  }

  /**
   * Initialize multiple adapters from configuration
   * @param configs - Map of adapter configurations
   */
  async initializeAll(configs: Record<string, AdapterConfig>): Promise<void> {
    const initPromises = Object.entries(configs).map(async ([key, config]) => {
      // Use the key as the type if not specified
      const adapterConfig: AdapterConfig = {
        ...config,
        type: config.type || (key as DatabaseType),
      };

      try {
        await this.initializeAdapter(adapterConfig);
      } catch (error) {
        console.error(`Failed to initialize adapter '${key}':`, error);
        throw error;
      }
    });

    await Promise.all(initPromises);
  }

  /**
   * Get an initialized adapter
   * @param type - Database type
   * @throws AdapterError if adapter not found or not initialized
   */
  getAdapter<T extends IDatabaseAdapter = IDatabaseAdapter>(type: DatabaseType): T {
    const adapter = this.adapters.get(type);

    if (!adapter) {
      throw Errors.adapterNotInitialized(type);
    }

    return adapter as T;
  }

  /**
   * Try to get an adapter (returns undefined if not found)
   * @param type - Database type
   */
  tryGetAdapter<T extends IDatabaseAdapter = IDatabaseAdapter>(type: DatabaseType): T | undefined {
    return this.adapters.get(type) as T | undefined;
  }

  /**
   * Check if an adapter is registered and initialized
   * @param type - Database type
   */
  hasAdapter(type: DatabaseType): boolean {
    const adapter = this.adapters.get(type);
    return adapter !== undefined && adapter.initialized;
  }

  /**
   * List all initialized adapters
   */
  listAdapters(): Map<DatabaseType, IDatabaseAdapter> {
    return new Map(this.adapters);
  }

  /**
   * Get adapter types that are initialized
   */
  listAdapterTypes(): DatabaseType[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Unregister and dispose an adapter
   * @param type - Database type
   */
  async unregisterAdapter(type: DatabaseType): Promise<boolean> {
    const adapter = this.adapters.get(type);

    if (!adapter) {
      return false;
    }

    await adapter.dispose();
    return this.adapters.delete(type);
  }

  /**
   * Dispose all adapters
   */
  async disposeAll(): Promise<void> {
    const disposePromises = Array.from(this.adapters.values()).map(async (adapter) => {
      try {
        await adapter.dispose();
      } catch (error) {
        console.error(`Error disposing adapter '${adapter.type}':`, error);
      }
    });

    await Promise.all(disposePromises);
    this.adapters.clear();
  }

  // ============================================================================
  // HEALTH CHECK
  // ============================================================================

  /**
   * Check health of all adapters
   * @returns Map of adapter types to their health status
   */
  async healthCheckAll(): Promise<Map<DatabaseType, boolean>> {
    const results = new Map<DatabaseType, boolean>();

    for (const [type, adapter] of this.adapters) {
      try {
        const healthy = await adapter.healthCheck();
        results.set(type, healthy);
      } catch {
        results.set(type, false);
      }
    }

    return results;
  }

  /**
   * Check health of a specific adapter
   * @param type - Database type
   */
  async healthCheck(type: DatabaseType): Promise<boolean> {
    const adapter = this.adapters.get(type);

    if (!adapter) {
      return false;
    }

    try {
      return await adapter.healthCheck();
    } catch {
      return false;
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

/**
 * Default adapter registry instance
 */
export const adapterRegistry = AdapterRegistry.getInstance();

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Get an adapter from the global registry
 */
export function getAdapter<T extends IDatabaseAdapter = IDatabaseAdapter>(type: DatabaseType): T {
  return adapterRegistry.getAdapter<T>(type);
}

/**
 * Check if an adapter is available
 */
export function hasAdapter(type: DatabaseType): boolean {
  return adapterRegistry.hasAdapter(type);
}
