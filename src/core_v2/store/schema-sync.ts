/**
 * SchemaSync — the single orchestrator for cache invalidation.
 *
 * Responsibilities:
 *  - Bootstrap: load every JSON file under json/ into Redis via schemaManager
 *  - Subscribe to jsonStore 'change' events → sync Redis + EntityConfigLoader + SQLite
 *
 * Every write path (API CRUD, manual user edits) must go through jsonStore.write/delete,
 * and must NOT call setSchemaCache/deleteSchemaCache/invalidateTenantCache directly anymore.
 */

import { jsonStore, JsonChangeEvent } from './json-store';
import { schemaManager, SchemaCollection, JSON_TYPES } from '../schema/manager';

class SchemaSync {
  private started = false;

  /**
   * Once at startup: loads all JSON into Redis.
   * Skips types that aren't schemas (i.e. only loads the declared JSON_TYPES).
   */
  async bootstrap(): Promise<void> {
    console.log('[SchemaSync] Bootstrap: JSON → Redis');

    // Wipe stale Redis entries before reloading
    await schemaManager.flushAllSchemas();

    // System
    for (const type of JSON_TYPES) {
      const items = jsonStore.list<any>('system', type);
      if (items.length === 0) continue;
      const map: Record<string, any> = {};
      for (const item of items) {
        const name = schemaManager.itemName(type, item);
        if (name) map[name] = item;
      }
      if (Object.keys(map).length > 0) {
        await schemaManager.saveAll(type, map);
        console.log(`[SchemaSync] system/${type}: ${Object.keys(map).length}`);
      }
    }

    // Tenants
    for (const scope of jsonStore.scopes()) {
      for (const type of JSON_TYPES) {
        const items = jsonStore.list<any>(scope, type);
        if (items.length === 0) continue;
        const map: Record<string, any> = {};
        for (const item of items) {
          const name = schemaManager.itemName(type, item);
          if (name) map[name] = item;
        }
        if (Object.keys(map).length > 0) {
          await schemaManager.saveAll(type, map, scope);
          console.log(`[SchemaSync] ${scope}/${type}: ${Object.keys(map).length}`);
        }
      }
      schemaManager.markTenantLoaded(scope);
    }

    schemaManager.markInitialized();
    console.log('[SchemaSync] Bootstrap done');
  }

  /** Subscribes to JsonStore events — called once after bootstrap */
  start(): void {
    if (this.started) return;
    this.started = true;
    jsonStore.on('change', (ev: JsonChangeEvent) => {
      this.handle(ev).catch((e) => console.warn('[SchemaSync] handle error:', e));
    });
    console.log('[SchemaSync] Listening JsonStore events');
  }

  private async handle(ev: JsonChangeEvent): Promise<void> {
    const { scope, type, slug, op } = ev;
    if (!(JSON_TYPES as readonly string[]).includes(type)) return;

    const tenantSlug = scope === 'system' ? null : scope;

    if (op === 'delete') {
      await schemaManager.delete(type as SchemaCollection, slug, tenantSlug);
      if (type === 'entity') await this.dropEntity(slug);
      return;
    }

    // op === 'write': re-read the file to make sure we get the current state (even when
    // it came from an fs edit), then update Redis.
    const data = jsonStore.read<any>(scope, type, slug);
    if (!data) {
      // the file was just written but isn't there on re-read → a race; skip it
      return;
    }

    const name = schemaManager.itemName(type, data) || slug;
    // Redis MUST be updated before EntityConfigLoader.reload (the loader reads from Redis)
    await schemaManager.set(type as SchemaCollection, name, data, tenantSlug);

    if (type === 'entity') {
      await this.reloadEntity(data, tenantSlug);
    }
  }

  // ---------- helpers ----------

  private async reloadEntity(data: any, tenantSlug: string | null): Promise<void> {
    const collectionName = data?.collection_name;
    if (!collectionName) return;
    try {
      const [{ getCoreUnified, getEntityConfigLoader }] = await Promise.all([
        import('../../configs/core'),
      ]);
      const registry = getCoreUnified().relationshipRegistry;
      registry?.removeBySource?.(collectionName);
      await getEntityConfigLoader().reload(collectionName, tenantSlug ?? undefined);
    } catch (e) {
      console.warn('[SchemaSync] reloadEntity failed:', e);
    }
  }

  private async dropEntity(collectionName: string): Promise<void> {
    try {
      const [{ getCoreUnified, getEntityConfigLoader }] = await Promise.all([
        import('../../configs/core'),
      ]);
      const registry = getCoreUnified().relationshipRegistry;
      registry?.removeBySource?.(collectionName);
      getEntityConfigLoader().invalidate(collectionName);
    } catch (e) {
      console.warn('[SchemaSync] dropEntity failed:', e);
    }
  }

}

export const schemaSync = new SchemaSync();
