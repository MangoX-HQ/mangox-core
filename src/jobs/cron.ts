/**
 * Dynamic Cron Service (single-tenant) — NOT change streams (no replica set needed).
 *
 * - Config is read from the `cron-job` collection in this tenant container's DB.
 * - On boot: read active cron-job docs → register with node-cron.
 * - Changing config: does NOT watch the DB. Call the reload API (POST /cron/reload) to reload.
 *   No polling, no replica set.
 * - Job tick runs an aggregate on the DB; persists via $merge/$out right inside the pipeline.
 *
 * Toggle via env CRON_JOB=true (appSettings.cronjob).
 *
 * cron-job doc shape (keep the current format as-is):
 *   {
 *     _id, title,
 *     cron_expression: "every-10s ...",    // 5 or 6 fields (seconds supported)
 *     is_active: boolean,
 *     collection_name: string,             // collection the aggregate runs on
 *     arrgregate: string|any[],            // pipeline for selecting + transforming ($match, $addFields)
 *     setup: [{ merge: string|object }],   // stage that writes back ($merge/$out) — appended at the end
 *     timezone?: string,
 *   }
 * Full pipeline = arrgregate + setup[].merge → $merge persists itself (no replica set needed).
 */
import cron, { ScheduledTask } from 'node-cron';
import { Db } from 'mongodb';
import { getTenantDb, getTenantId } from '../core_v2/adapters/mongodb/tenant-context';
import { appSettings } from '../configs/app-settings';

export interface CronJobConfig {
  _id: unknown;
  title?: string;
  cron_expression: string;
  is_active?: boolean;
  tenant_id?: string;
  collection_name?: string;
  arrgregate?: string | unknown[];
  setup?: { merge: string | unknown }[];
  timezone?: string;
}

/** Parse JSON (string) or passthrough array/object → array of stages. */
function parseLoose(input: string | unknown | undefined): unknown[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === 'object') return [input];
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      parsed = new Function('return (' + s + ')')();
    }
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return [];
}

/** Merge every $addFields/$set stage in arrgregate into a single changed-fields object. */
function extractChangedFields(stages: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const st of stages) {
    const s = st as Record<string, any>;
    if (s && typeof s === 'object') {
      if (s.$addFields) Object.assign(out, s.$addFields);
      if (s.$set) Object.assign(out, s.$set);
    }
  }
  return out;
}

class DynamicCronService {
  /** key = jobId → task */
  private jobs = new Map<string, ScheduledTask>();
  private enabled = String(appSettings.cronjob) === 'true';

  /** Called once at boot. */
  async init(): Promise<void> {
    if (!this.enabled) {
      console.log('[Cron] Disabled (CRON_JOB != true)');
      return;
    }
    await this.reload();
  }

  /** Reload all jobs from the cron-job collection (called from the API when config changes). */
  async reload(): Promise<number> {
    if (!this.enabled) return 0;
    this.stopAll();

    const db = getTenantDb();
    if (!db) {
      console.warn('[Cron] getTenantDb() null, bỏ qua reload');
      return 0;
    }
    const configs = (await db
      .collection('cron-job')
      .find({ is_active: true })
      .toArray()) as unknown as CronJobConfig[];

    let count = 0;
    for (const cfg of configs) {
      if (this.register(db, cfg)) count++;
    }
    console.log(`[Cron] Đăng ký ${count}/${configs.length} job`);
    return count;
  }

  private register(db: Db, cfg: CronJobConfig): boolean {
    if (!cfg.cron_expression || !cron.validate(cfg.cron_expression)) {
      console.warn(`[Cron] "${cfg.title}" cron_expression không hợp lệ: ${cfg.cron_expression}`);
      return false;
    }
    const key = String(cfg._id);
    const task = cron.schedule(
      cfg.cron_expression,
      () => {
        this.process(db, cfg).catch((e) =>
          console.error(`[Cron] job "${cfg.title}" lỗi:`, e?.message || e),
        );
      },
      cfg.timezone ? { timezone: cfg.timezone, name: key } : { name: key },
    );
    this.jobs.set(key, task);
    return true;
  }

  /**
   * Run a single job: aggregate (arrgregate + $merge) → $merge persists itself. Afterward, write
   * history (user System) for each changed doc into the `history` collection.
   */
  private async process(db: Db, cfg: CronJobConfig): Promise<void> {
    if (!cfg.collection_name) return;
    const main = parseLoose(cfg.arrgregate);
    const tail = (cfg.setup || []).flatMap((s) => parseLoose(s?.merge));
    const fullPipeline = [...main, ...tail];
    if (!fullPipeline.length) return;

    // 1) Get the _id of docs about to change (for history logging).
    const affected = (await db
      .collection(cfg.collection_name)
      .aggregate([...main, { $project: { _id: 1 } }] as any[])
      .toArray()) as { _id: unknown }[];

    // 2) Persist qua $merge.
    await db.collection(cfg.collection_name).aggregate(fullPipeline as any[]).toArray();

    // 3) History (user System).
    if (affected.length) {
      await this.writeHistory(db, cfg, affected.map((d) => d._id), main);
    }
  }

  /** Write history into the `history` collection for the cron docs that just changed. */
  private async writeHistory(
    db: Db,
    cfg: CronJobConfig,
    recordIds: unknown[],
    selectStages: unknown[],
  ): Promise<void> {
    const changes = extractChangedFields(selectStages);
    const status = String((changes as any).status_approve ?? (changes as any).status ?? '');
    const now = new Date();
    const tenantId = cfg.tenant_id || getTenantId() || undefined;
    const entries = recordIds.map((rid) => ({
      record_id: rid,
      collection: cfg.collection_name,
      action: 'update' as const,
      user: { _id: null, name: 'System' },
      rule: cfg.title || status,
      status_approve: status,
      reason: null,
      changes,
      tenant_id: tenantId,
      timestamp: now,
    }));
    try {
      await db.collection('history').insertMany(entries, { ordered: false });
    } catch (e: any) {
      console.error(`[Cron] ghi history "${cfg.title}" lỗi:`, e?.message || e);
    }
  }

  /** Stop all jobs. */
  stopAll(): void {
    for (const task of this.jobs.values()) {
      try {
        task.stop();
      } catch {
        /* noop */
      }
    }
    this.jobs.clear();
  }
}

export const dynamicCronService = new DynamicCronService();
export default dynamicCronService;
