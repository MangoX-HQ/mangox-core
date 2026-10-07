/**
 * Core V2 - MongoDB Adapter Factory
 */

import { IAdapterFactory, IRelationshipRegistry } from '../../interfaces/adapter.interface';
import { AdapterConfig } from '../../config';
import { DatabaseType } from '../../types';
import { MongoDBAdapter, createMongoDBAdapter } from './adapter';
import { getRelationshipRegistry } from '../base/relationship-registry';

// ============================================================================
// MONGODB ADAPTER FACTORY
// ============================================================================

/**
 * Factory for creating MongoDB adapters
 */
export class MongoDBAdapterFactory implements IAdapterFactory<MongoDBAdapter> {
  readonly type: DatabaseType = 'mongodb';

  private relationshipRegistry: IRelationshipRegistry;

  constructor(relationshipRegistry?: IRelationshipRegistry) {
    this.relationshipRegistry = relationshipRegistry || getRelationshipRegistry();
  }

  /**
   * Create a new MongoDB adapter instance
   */
  async create(config: AdapterConfig): Promise<MongoDBAdapter> {
    const adapter = createMongoDBAdapter(this.relationshipRegistry);
    await adapter.initialize(config);
    return adapter;
  }

  /**
   * Check if factory supports the configuration
   */
  supports(config: AdapterConfig): boolean {
    // Check if type matches
    if (config.type !== 'mongodb') {
      return false;
    }

    // Must have connection string or host
    if (!config.connectionString && !config.host) {
      return false;
    }

    return true;
  }
}

/**
 * Create a new MongoDB adapter factory
 */
export function createMongoDBAdapterFactory(
  relationshipRegistry?: IRelationshipRegistry
): MongoDBAdapterFactory {
  return new MongoDBAdapterFactory(relationshipRegistry);
}

/**
 * Default factory instance
 */
export const mongoDBAdapterFactory = new MongoDBAdapterFactory();
