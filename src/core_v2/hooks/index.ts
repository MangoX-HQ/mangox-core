/**
 * Hook system for CoreAdapter — inserts business logic before/after a DB mutation.
 *
 * Register:
 *   registerHook('team', 'beforeInsert', async (doc, ctx) => { ... })
 *   registerHook('tenant', 'beforeInsert', async (doc, ctx) => { ... })
 *
 * Exec order: follows registration order. Hook throws → abort + propagate the error.
 * `ctx.user` is available (current request user via headers.user). `ctx.options`
 * = the OptionsInput passed into CoreAdapter.create/update.
 */

export type HookEvent =
  | 'beforeInsert' | 'afterInsert'
  | 'beforeUpdate' | 'afterUpdate'
  | 'beforeDelete' | 'afterDelete';

export interface HookContext {
  collection: string;
  event: HookEvent;
  user?: any;
  options?: any;
  /** PUT/PATCH: id of the doc being updated; insert/delete: undefined */
  docId?: string;
  /** PUT/PATCH: existing doc before the update (best-effort, may be null) */
  existing?: any;
}

export type HookFn = (doc: any, ctx: HookContext) => Promise<void> | void;

interface Registry {
  [collection: string]: Partial<Record<HookEvent, HookFn[]>>;
}

const registry: Registry = {};

export function registerHook(collection: string, event: HookEvent, fn: HookFn): void {
  if (!registry[collection]) registry[collection] = {};
  const arr = registry[collection][event] ?? [];
  arr.push(fn);
  registry[collection][event] = arr;
}

export async function runHooks(
  collection: string,
  event: HookEvent,
  doc: any,
  ctx: Omit<HookContext, 'collection' | 'event'>,
): Promise<void> {
  const fns = registry[collection]?.[event];
  if (!fns || fns.length === 0) return;
  const fullCtx: HookContext = { ...ctx, collection, event };
  for (const fn of fns) {
    await fn(doc, fullCtx);
  }
}

export function clearHooks(collection?: string): void {
  if (collection) delete registry[collection];
  else for (const k of Object.keys(registry)) delete registry[k];
}

export function listHooks(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [c, byEvent] of Object.entries(registry)) {
    out[c] = Object.keys(byEvent);
  }
  return out;
}
