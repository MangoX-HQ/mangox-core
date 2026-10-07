/**
 * Debug logger — traces an entire request across modules as a tree.
 *
 * Toggle with env DEBUG=true. Off → every `dbg.*` is a no-op (zero cost).
 *
 * Pattern:
 *   dbg.group('schemaManager.rLoad', { collection, scope })
 *     dbg.step('redisKey', { key })
 *     dbg.step('pickRedis', { client: 'global' })
 *     dbg.step('HGETALL', { count: 7 })
 *   dbg.end()
 *
 * Output (1 file / request):
 *   logs/debug/YYYY-MM-DD/<unix-ms>-<rand>.log
 *
 * Layout:
 *   2026-05-28T10:55:00.123Z  GET /api/v1/tin-tuc → 200 (35ms)
 *   ├─ [auth] preHandler.jwt          { user: 'admin@x' }
 *   ├─ [common] withSlugContext
 *   │  ├─ [12ms] getSlug              { result: 'pptx' }
 *   │  └─ [13ms] getTeamId            { result: '6a17bf30...' }
 *   ├─ [loadAction] GET /tin-tuc
 *   │  ├─ [schemaManager.getAll] resource
 *   │  │  ├─ pickRedis                { client: 'global' }
 *   │  │  ├─ redisKey                 { key: 'schema:Mangox API:tenant:6a17bf30:pptx:resource' }
 *   │  │  └─ HGETALL                  { count: 7 }
 *   │  └─ resourceConfig.found        { slug: 'tin-tuc' }
 *   └─ [response] 200
 */

import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as path from 'path';

export const isDebugEnabled = (): boolean => process.env.DEBUG === 'true';

interface DebugStep {
  /** 'step' = leaf, 'group_start' = '▶', 'group_end' = pop */
  type: 'step' | 'group_start' | 'group_end';
  label: string;
  data?: any;
  /** ms since the request started */
  dt: number;
}

export interface DebugContext {
  id: string;
  startedAt: number;
  method: string;
  url: string;
  tenant?: string;
  user?: string;
  steps: DebugStep[];
  depth: number;
  /** Temporarily reserved for future stream output */
  finalized: boolean;
}

const storage = new AsyncLocalStorage<DebugContext>();
const LOG_DIR = path.resolve(__dirname, '../../../logs/debug');

/* ───────── public API ───────── */

export function debugStart(method: string, url: string): DebugContext {
  return {
    id: `${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    method,
    url,
    steps: [],
    depth: 0,
    finalized: false,
  };
}

export function enterDebug(ctx: DebugContext): void {
  if (!isDebugEnabled()) return;
  // enterWith: leaks ctx into the async chain — fine for Fastify request-scoped
  storage.enterWith(ctx);
}

export function getDebugCtx(): DebugContext | undefined {
  return storage.getStore();
}

/** Set metadata (call after auth/tenant has resolved). */
export function dbgMeta(meta: { tenant?: string; user?: string }): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (meta.tenant) ctx.tenant = meta.tenant;
  if (meta.user) ctx.user = meta.user;
}

/** Single step (leaf node). data will be truncated if too long. */
export function dbgStep(label: string, data?: any): void {
  if (!isDebugEnabled()) return;
  const ctx = storage.getStore();
  if (!ctx || ctx.finalized) return;
  ctx.steps.push({
    type: 'step',
    label,
    data: sanitize(data),
    dt: Date.now() - ctx.startedAt,
  });
}

/** Open a group — call dbgEnd() when done. Can be nested. */
export function dbgGroup(label: string, data?: any): void {
  if (!isDebugEnabled()) return;
  const ctx = storage.getStore();
  if (!ctx || ctx.finalized) return;
  ctx.steps.push({
    type: 'group_start',
    label,
    data: sanitize(data),
    dt: Date.now() - ctx.startedAt,
  });
  ctx.depth++;
}

export function dbgEnd(label?: string): void {
  if (!isDebugEnabled()) return;
  const ctx = storage.getStore();
  if (!ctx || ctx.finalized) return;
  ctx.depth = Math.max(0, ctx.depth - 1);
  ctx.steps.push({
    type: 'group_end',
    label: label ?? '',
    dt: Date.now() - ctx.startedAt,
  });
}

/** Helper: automatically opens/closes a group for an async fn. */
export async function dbgWrap<T>(
  label: string,
  fn: () => Promise<T>,
  meta?: any,
): Promise<T> {
  dbgGroup(label, meta);
  try {
    const r = await fn();
    return r;
  } catch (e: any) {
    dbgStep('!ERROR', { message: e?.message || String(e) });
    throw e;
  } finally {
    dbgEnd();
  }
}

/** Write file + flag finalized. status=HTTP status. */
export async function debugFinish(status: number): Promise<void> {
  if (!isDebugEnabled()) return;
  const ctx = storage.getStore();
  if (!ctx || ctx.finalized) return;
  ctx.finalized = true;

  const total = Date.now() - ctx.startedAt;
  const iso = new Date(ctx.startedAt).toISOString();
  const date = iso.slice(0, 10);
  const dir = path.join(LOG_DIR, date);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const fname = `${ctx.startedAt}-${ctx.id}-${status}.log`;
  const file = path.join(dir, fname);

  const lines = renderTree(ctx, status, total);
  try {
    fs.writeFileSync(file, lines.join('\n') + '\n');
  } catch (e: any) {
    console.warn('[debug-logger] write fail:', e.message);
  }
}

/* ───────── internals ───────── */

const MAX_DATA = 500;

function sanitize(data: any): any {
  if (data === undefined || data === null) return undefined;
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    if (s.length > MAX_DATA) return s.slice(0, MAX_DATA) + '…';
    return data;
  } catch { return String(data); }
}

function fmtData(data: any): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return '  ' + data;
  try { return '  ' + JSON.stringify(data); }
  catch { return '  ' + String(data); }
}

function renderTree(ctx: DebugContext, status: number, total: number): string[] {
  const out: string[] = [];
  const iso = new Date(ctx.startedAt).toISOString();
  const metaParts: string[] = [];
  if (ctx.tenant) metaParts.push(`tenant=${ctx.tenant}`);
  if (ctx.user) metaParts.push(`user=${ctx.user}`);
  const meta = metaParts.length ? '  ' + metaParts.join(' ') : '';
  out.push(`${iso}  ${ctx.method} ${ctx.url}${meta}  → ${status} (${total}ms)`);

  // Tree rendering: simulate parent-child by depth-tracking, draw box chars.
  // Pre-pass: convert the flat steps[] into tree nodes.
  interface Node { label: string; data: any; dt: number; children: Node[]; isGroup: boolean }
  const root: Node = { label: '', data: undefined, dt: 0, children: [], isGroup: true };
  const stack: Node[] = [root];
  for (const s of ctx.steps) {
    const top = stack[stack.length - 1];
    if (s.type === 'group_start') {
      const node: Node = { label: s.label, data: s.data, dt: s.dt, children: [], isGroup: true };
      top.children.push(node);
      stack.push(node);
    } else if (s.type === 'group_end') {
      if (stack.length > 1) stack.pop();
    } else {
      top.children.push({ label: s.label, data: s.data, dt: s.dt, children: [], isGroup: false });
    }
  }

  const draw = (node: Node, prefix: string, isLast: boolean, isRoot: boolean) => {
    if (!isRoot) {
      const branch = isLast ? '└─ ' : '├─ ';
      const marker = node.isGroup ? '▶ ' : '';
      out.push(`${prefix}${branch}[${node.dt}ms] ${marker}${node.label}${fmtData(node.data)}`);
    }
    const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
    node.children.forEach((c, i) => draw(c, childPrefix, i === node.children.length - 1, false));
  };
  draw(root, '', true, true);

  return out;
}
