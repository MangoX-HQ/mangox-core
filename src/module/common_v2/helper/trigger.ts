/**
 * Policy trigger executor.
 *
 * After a main operation (create/update/delete/etc) completes, the matched
 * policy may declare a `trigger` block describing follow-up side effects.
 * Trigger actions run AFTER the main op (so they see the actual result) and
 * support a small placeholder DSL:
 *
 *   @options:<path>           — request options (user_id, tenant_id, body...)
 *   @context:<alias>:<field>  — policy.data records (auto-deref `.data[0]`)
 *   @result:<path>            — return value of the main operation
 *   @prev:<actionId>:<field>  — return value of an earlier trigger action
 *   @env:<VAR>                — process env
 *   @now                      — ISO timestamp
 *
 * Action types:
 *   type: "entity"  — pick adapter via core-service (entity.databaseType),
 *                     adapter executes the operation against its native API.
 *   type: "http"    — fetch the given URL.
 *
 * The executor never touches adapters directly; the service layer picks the
 * adapter so a trigger writing to a SQLite-backed entity works the same as
 * one writing to MongoDB.
 */

import { getCoreUnified } from '../../../configs/core';
import { deleteCacheByEntity } from './cache';
import { getDeepValue } from './helper';

const MUTATING_OPS = new Set(['insert', 'insertMany', 'update', 'updateMany', 'delete', 'deleteMany']);

export interface TriggerAction {
  id: string;
  type: 'entity' | 'http';
  // entity (adapter-agnostic via core-service)
  entity?: string;
  operation?: 'insert' | 'insertMany' | 'update' | 'updateMany' | 'delete' | 'deleteMany' | 'find' | 'findOne' | 'aggregate';
  filter?: Record<string, unknown>;
  data?: any;
  update?: any;
  pipeline?: any[];
  collection?: string; // optional override of the physical target
  // http
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  // common
  onFailure?: 'continue' | 'stop';
}

export interface TriggerConfig {
  trigger_id?: string;
  event?: string;
  parallel?: boolean;
  actions: TriggerAction[];
}

export interface TriggerInvocation {
  options?: any;
  context?: any;
  result?: any;
}

/** Resolve a single token (no recursion into arrays/objects). */
function resolveToken(token: string, ctx: any): any {
  if (token === '@now') return new Date().toISOString();
  if (token.startsWith('@options:')) return getDeepValue(token.slice(9), ctx.options);
  if (token.startsWith('@result:')) return getDeepValue(token.slice(8), ctx.result);
  if (token.startsWith('@prev:')) return getDeepValue(token.slice(6), ctx.prev);
  if (token.startsWith('@env:')) return process.env[token.slice(5)];
  if (token.startsWith('@context:')) {
    const path = token.slice(9);
    const [alias, ...rest] = path.split(':');
    const root = ctx.context?.[alias];
    if (!root) return undefined;
    const base = (rest[0] === 'data' || !root.data)
      ? root
      : (Array.isArray(root.data) ? root.data[0] : root);
    return getDeepValue(rest.join(':'), base);
  }
  // Numeric transform: `@neg:<inner>` returns -value of the inner token.
  // Useful for `$inc: { credit_balance: "@neg:@result:size" }` to deduct.
  if (token.startsWith('@neg:')) {
    const inner = token.slice(5);
    const innerToken = inner.startsWith('@') ? inner : `@${inner}`;
    const v = resolveToken(innerToken, ctx);
    return typeof v === 'number' ? -v : v;
  }
  return token;
}

/** Walk a value tree and resolve `@...` tokens against `ctx`. */
function resolveDeep(value: any, ctx: any): any {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.startsWith('@')) return resolveToken(value, ctx);
    return value;
  }
  if (Array.isArray(value)) return value.map(v => resolveDeep(v, ctx));
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, ctx);
    return out;
  }
  return value;
}

async function runEntityAction(action: TriggerAction): Promise<unknown> {
  if (!action.entity || !action.operation) {
    throw new Error(`entity trigger action '${action.id}' requires entity + operation`);
  }
  return getCoreUnified().getCore().executeAction(action.entity, {
    operation: action.operation,
    collection: action.collection,
    filter: action.filter,
    data: action.data,
    update: action.update,
    pipeline: action.pipeline,
  });
}

async function runHttpAction(action: TriggerAction): Promise<any> {
  if (!action.url) throw new Error(`http trigger action '${action.id}' requires url`);
  const method = (action.method ?? 'POST').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(action.headers ?? {}) };
  const init: RequestInit = { method, headers };
  if (action.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof action.body === 'string' ? action.body : JSON.stringify(action.body);
  }
  const resp = await fetch(action.url, init);
  const ct = (resp.headers.get('content-type') ?? '').toLowerCase();
  const payload = ct.includes('application/json')
    ? await resp.json().catch(() => null)
    : await resp.text().catch(() => null);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${action.url}`);
  return payload;
}

/**
 * Execute a trigger config. Returns map of `actionId → output`.
 * Sequential by default; pass `parallel: true` to run actions concurrently.
 * Per-action `onFailure: "continue"` keeps the pipeline alive on errors.
 */
export async function executeTrigger(
  trigger: TriggerConfig | null | undefined,
  ctx: TriggerInvocation,
): Promise<Record<string, any>> {
  if (!trigger?.actions?.length) return {};
  const outputs: Record<string, any> = {};

  const runOne = async (action: TriggerAction) => {
    const resolved = resolveDeep(action, { ...ctx, prev: outputs }) as TriggerAction;
    try {
      const out = resolved.type === 'http'
        ? await runHttpAction(resolved)
        : await runEntityAction(resolved);
      outputs[action.id] = out;
      // Invalidate context cache for entities the trigger just mutated, so the
      // next request re-fetches fresh data (e.g. credit_balance after deduct).
      if (resolved.type === 'entity' && resolved.entity && resolved.operation && MUTATING_OPS.has(resolved.operation)) {
        deleteCacheByEntity(resolved.entity);
      }
    } catch (err) {
      const fail = action.onFailure ?? 'stop';
      if (fail === 'continue') {
        outputs[action.id] = { error: (err as Error)?.message ?? String(err) };
        return;
      }
      throw err;
    }
  };

  if (trigger.parallel) {
    await Promise.all(trigger.actions.map(runOne));
  } else {
    for (const action of trigger.actions) await runOne(action);
  }
  return outputs;
}
