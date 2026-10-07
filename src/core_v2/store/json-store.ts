/**
 * JsonStore — single source of truth for JSON files under json/
 *
 * - FS I/O (read/write/delete/list) — no cache, no Redis
 * - Singleton watcher over the whole JSON_DIR, emits {scope,type,slug,op} events
 * - mtime tracking to filter out events caused by our own write() (avoid self-trigger)
 *
 * Layout:
 *   json/system/<type>/<slug>.json                         → scope = 'system'
 *   json/<team_id>/<tenant_slug>/<type>/<slug>.json        → scope = 'team_id/tenant_slug'
 *
 * `scope` is an opaque string that may contain `/`. Every path/Redis key treats it as
 * a single segment — `path.join` handles the slash in scope automatically; Redis allows slashes.
 *
 * Subscribe to events via jsonStore.on('change', handler).
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

export type JsonOp = 'write' | 'delete';

export interface JsonChangeEvent {
  scope: string;            // 'system' or 'team_id/tenant_slug'
  type: string;             // entity | action | resource | policy | role | setting | form-setting | api-config | ...
  slug: string;             // filename without .json
  op: JsonOp;
  source: 'api' | 'fs';     // api = triggered by write()/delete(); fs = detected by the watcher
}

const JSON_DIR = path.resolve(__dirname, '../../../json');

// debounce per (scope,type,slug) — batches multiple fs events that fire close together
const DEBOUNCE_MS = 200;

class JsonStore extends EventEmitter {
  /** Tracks the mtime of files just written/deleted via the API so the watcher can skip self-triggers */
  private lastApiMtime = new Map<string, number>();
  /** Pending debounce timers cho fs events */
  private pendingFsTimers = new Map<string, NodeJS.Timeout>();
  private watcher: fs.FSWatcher | null = null;

  // ---------- path helpers ----------

  private dirOf(scope: string, type: string): string {
    return path.join(JSON_DIR, scope, type);
  }

  private fileOf(scope: string, type: string, slug: string): string {
    return path.join(this.dirOf(scope, type), `${slug}.json`);
  }

  /**
   * Parses a path relative to JSON_DIR into {scope,type,slug}, or null if it doesn't match.
   * Supports 2 layouts:
   *   3 parts: system / type / file       → scope = 'system'
   *   4 parts: team_id / tenant_slug / type / file → scope = 'team_id/tenant_slug'
   */
  private parsePath(rel: string): { scope: string; type: string; slug: string } | null {
    const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 3) {
      const [scope, type, file] = parts;
      if (!file.endsWith('.json')) return null;
      return { scope, type, slug: file.replace(/\.json$/, '') };
    }
    if (parts.length === 4) {
      const [team, tenant, type, file] = parts;
      if (!file.endsWith('.json')) return null;
      return { scope: `${team}/${tenant}`, type, slug: file.replace(/\.json$/, '') };
    }
    return null;
  }

  // ---------- read ----------

  read<T = any>(scope: string, type: string, slug: string): T | null {
    const fp = this.fileOf(scope, type, slug);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  exists(scope: string, type: string, slug: string): boolean {
    return fs.existsSync(this.fileOf(scope, type, slug));
  }

  /** Reads all slug.json files in a folder. No caching. */
  list<T = any>(scope: string, type: string): T[] {
    const dir = this.dirOf(scope, type);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
          catch (e: any) {
            console.warn(`[JsonStore] Skipping malformed JSON: ${dir}/${f} — ${e.message}`);
            return null;
          }
        })
        .filter((v): v is T => v !== null);
    } catch {
      return [];
    }
  }

  /**
   * Merges system + tenant by slug/collection_name (tenant overrides system).
   * Scope 'system' → returns only system items.
   */
  listMerged<T = any>(scope: string, type: string): T[] {
    const systemItems = this.list<any>('system', type);
    if (!scope || scope === 'system') return systemItems as T[];
    const tenantItems = this.list<any>(scope, type);
    const tenantKeys = new Set(
      tenantItems.map((i: any) => i.slug || i.collection_name).filter(Boolean),
    );
    return [
      ...systemItems.filter((i: any) => !tenantKeys.has(i.slug || i.collection_name)),
      ...tenantItems,
    ] as T[];
  }

  /**
   * Lists tenant scopes = every 2-level `<team_id>/<tenant_slug>` subfolder under
   * JSON_DIR (except 'system'). Returns 'team_id/tenant_slug' consistently (forward slash).
   */
  scopes(): string[] {
    if (!fs.existsSync(JSON_DIR)) return [];
    const out: string[] = [];
    let teams: string[];
    try {
      teams = fs.readdirSync(JSON_DIR).filter((f) => {
        if (f === 'system') return false;
        if (f.endsWith('.json')) return false;
        try { return fs.statSync(path.join(JSON_DIR, f)).isDirectory(); }
        catch { return false; }
      });
    } catch { return []; }
    for (const team of teams) {
      const teamDir = path.join(JSON_DIR, team);
      try {
        for (const tenant of fs.readdirSync(teamDir)) {
          if (tenant.endsWith('.json')) continue;
          try {
            if (fs.statSync(path.join(teamDir, tenant)).isDirectory()) {
              out.push(`${team}/${tenant}`);
            }
          } catch {}
        }
      } catch {}
    }
    return out;
  }

  // ---------- write ----------

  write(scope: string, type: string, slug: string, data: any): void {
    const fp = this.fileOf(scope, type, slug);
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    this.markApiMutation(fp);
    this.emitChange({ scope, type, slug, op: 'write', source: 'api' });
  }

  delete(scope: string, type: string, slug: string): boolean {
    const fp = this.fileOf(scope, type, slug);
    if (!fs.existsSync(fp)) return false;
    this.markApiMutation(fp);
    fs.unlinkSync(fp);
    this.emitChange({ scope, type, slug, op: 'delete', source: 'api' });
    return true;
  }

  private markApiMutation(fp: string): void {
    // Save the "current" mtime — watcher events arriving with mtime <= this value will be dropped.
    // Use Date.now() because fs.statSync right after write can lag by 1 tick.
    this.lastApiMtime.set(fp, Date.now() + 50);
  }

  private emitChange(ev: JsonChangeEvent): void {
    this.emit('change', ev);
  }

  // ---------- watcher ----------

  startWatch(): void {
    if (this.watcher) return;
    if (!fs.existsSync(JSON_DIR)) fs.mkdirSync(JSON_DIR, { recursive: true });

    // recursive watch over the entire JSON_DIR (Linux: needs kernel ≥ 5.x; Node 20+ supports it well)
    try {
      this.watcher = fs.watch(JSON_DIR, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const parsed = this.parsePath(String(filename));
        if (!parsed) return;
        this.scheduleFsEvent(parsed);
      });
      console.log(`[JsonStore] Watching ${JSON_DIR}`);
    } catch (err) {
      console.warn('[JsonStore] startWatch failed:', err);
    }
  }

  stopWatch(): void {
    if (!this.watcher) return;
    try { this.watcher.close(); } catch {}
    this.watcher = null;
    for (const t of this.pendingFsTimers.values()) clearTimeout(t);
    this.pendingFsTimers.clear();
  }

  private scheduleFsEvent(parsed: { scope: string; type: string; slug: string }): void {
    const fp = this.fileOf(parsed.scope, parsed.type, parsed.slug);
    const key = fp;

    // debounce: multiple events firing close together (atomic write = rename) → wait DEBOUNCE_MS
    const existing = this.pendingFsTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingFsTimers.delete(key);
      this.processFsEvent(fp, parsed);
    }, DEBOUNCE_MS);
    this.pendingFsTimers.set(key, timer);
  }

  private processFsEvent(fp: string, parsed: { scope: string; type: string; slug: string }): void {
    // Filter: if this event was caused by our own write()/delete() → skip it
    const apiStamp = this.lastApiMtime.get(fp);
    if (apiStamp && Date.now() < apiStamp) {
      this.lastApiMtime.delete(fp);
      return;
    }

    const exists = fs.existsSync(fp);
    this.emitChange({ ...parsed, op: exists ? 'write' : 'delete', source: 'fs' });
  }
}

export const jsonStore = new JsonStore();
