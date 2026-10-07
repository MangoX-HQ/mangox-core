/**
 * Core V2 - REST API Adapter Factory
 */

import { IAdapterFactory } from '../../interfaces/adapter.interface';
import { AdapterConfig } from '../../config';
import { DatabaseType } from '../../types';
import { RestApiAdapter, createRestApiAdapter } from './adapter';

export class RestApiAdapterFactory implements IAdapterFactory<RestApiAdapter> {
  readonly type: DatabaseType = 'rest';

  async create(config: AdapterConfig): Promise<RestApiAdapter> {
    const adapter = createRestApiAdapter();
    await adapter.initialize(config);
    return adapter;
  }

  supports(config: AdapterConfig): boolean {
    return config.type === 'rest';
  }
}

export const restApiAdapterFactory = new RestApiAdapterFactory();
