import { getPolicies, getFormSettingBySlug } from '../_setting/setting-mode';
import { JsonSettingAdapter } from '../_setting/setting.adapter';
import { getTenantScope } from '../../configs/tenant';
import { composeEffectiveSchema } from './schema-compose';
import { commonService } from '../common_v2/common.service';
import { OptionsInput } from '../../configs/core';
import { schemaManager } from '../../core_v2/schema/manager';
import { McpContext } from './mcp.guard';
import { mediaMinioService } from '../_media/media-minio.service';
import { apiKeyService } from './api-key.service';
import { AppError } from '../../utils/app-error';

// In dev mode (SETTING=development), these collections live in json/*.json
// files (loaded into schemaManager cache at startup) — not in MongoDB.
// Reads should hit the cache so MCP shows the actual definitions.
const META_COLLECTIONS = new Set([
  'entity',
  'collection',
  'policy',
  'action',
  'code',
  'resource',
  'form',
  'validation',
]);

// System entities — MCP tools for these are blocked regardless of policies.
const SYSTEM_ENTITIES = new Set([
  'action',
  'code',
  'entity',
  'form-setting',
  'policy',
  'resource',
  'role',
  'setting',
  'tenant',
  'user',
  'user-profile',
]);

interface ActionDef {
  slug: string;
  title?: string;
  method: string;
  path: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
  _meta: {
    resource: string;
    action: string;
    entity: string;
    policy_slug: string;
    method: string;
    path: string;
    needs_id: boolean;
    form?: string | null;
  };
}

export interface CallExtras {
  log?: any;
}

export class McpService {
  private actionsCache: Record<string, ActionDef> | null = null;

  /** Reset the in-memory action cache — call after reseeding Redis (/admin/reload). */
  clearCache(): void {
    this.actionsCache = null;
  }

  /** Read actions from Redis (system + tenant env scope). Config is pre-seeded, read-only. */
  private async getActions(_tenantId?: string): Promise<Record<string, ActionDef>> {
    if (this.actionsCache) return this.actionsCache;
    const sysMap = (await schemaManager.getAll('action')) ?? {};
    const scope = getTenantScope();
    const tenantMap = scope ? ((await schemaManager.getAll('action', scope)) ?? {}) : {};
    const map: Record<string, ActionDef> = {};
    for (const a of [...Object.values(sysMap), ...Object.values(tenantMap)] as ActionDef[]) {
      if (a?.slug) map[a.slug] = a;
    }
    this.actionsCache = map;
    return map;
  }

  /**
   * Built-in MCP tools that bypass the policy machinery. Hardcoded because
   * the underlying module (media-minio) doesn't have policy-based RBAC yet
   * — same access level as direct HTTP calls (any authenticated user).
   */
  private getBuiltinTools(): McpTool[] {
    const stub = (action: string, method: string, path: string) => ({
      resource: 'media',
      action,
      entity: 'media',
      policy_slug: `builtin:media-${action}`,
      method,
      path,
      needs_id: action === 'delete',
      form: null,
    });
    return [
      {
        name: 'media__upload',
        description: 'Upload a file into media storage. Provide either `url` (server fetches it) or `data_base64` + `filename` + `mimetype`. Returns media id + public URL.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Public URL of file to fetch and upload' },
            data_base64: { type: 'string', description: 'Base64-encoded file content (alternative to url)' },
            filename: { type: 'string', description: 'Output filename (required when using data_base64; optional with url — derived from URL path)' },
            mimetype: { type: 'string', description: 'MIME type, e.g. "image/png" (required when using data_base64; auto-detected from URL response when omitted)' },
          },
          additionalProperties: false,
        },
        _meta: stub('upload', 'POST', '/'),
      },
      {
        name: 'media__list',
        description: 'List media in the current tenant. Filter by filename substring with `q`. Paginated.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Filename substring to filter (case-insensitive regex)' },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          },
          additionalProperties: false,
        },
        _meta: stub('list', 'GET', '/'),
      },
      {
        name: 'media__delete',
        description: 'Delete a media object by id. Removes both DB record and MinIO object.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Media _id' },
          },
          required: ['id'],
          additionalProperties: false,
        },
        _meta: stub('delete', 'DELETE', '/:id'),
      },
      ...this.getBuiltinEntityTools(),
    ];
  }

  /**
   * Built-in MCP tools for managing entity definitions (schema/collection
   * configs). Bypass the policy machinery + SYSTEM_ENTITIES block because the
   * correct write path is JsonSettingAdapter (writes json/<tenant>/entity/
   * <slug>.json + invalidates schema cache), NOT commonService.postQuery.
   * Create always runs with gen=true (applyEntityDefaults + scaffold).
   */
  private getBuiltinEntityTools(): McpTool[] {
    const stub = (action: string, method: string, p: string) => ({
      resource: 'entity',
      action,
      entity: 'entity',
      policy_slug: `builtin:entity-${action}`,
      method,
      path: p,
      needs_id: p.includes(':slug'),
      form: null,
    });
    const entityFields = {
      title: { type: 'string', description: 'Human-readable name, e.g. "Khách Hàng"' },
      collection_name: { type: 'string', description: 'Mongo collection / slug, snake_case, e.g. "customer". Used as the entity slug.' },
      databaseType: { type: 'string', default: 'mongodb', description: 'Usually "mongodb"' },
      is_active: { type: 'boolean', default: true },
      use_timestamp: { type: 'boolean', default: true, description: 'Auto created_at/updated_at' },
      public_entity: { type: 'boolean', default: false },
      json_schema: {
        type: 'object',
        description: 'JSON Schema of the entity. Shape: { type:"object", properties:{ <field>:{ title, type, widget, filter } } }. Common widgets: shortAnswer, numberInput, select, textarea, datePicker.',
      },
    };
    return [
      {
        name: 'entity__list',
        description: 'List entity definitions (schema/collection configs) in the current tenant. Use this first to see what already exists before creating.',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Filter by collection_name/title substring' },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          additionalProperties: false,
        },
        _meta: stub('list', 'GET', '/'),
      },
      {
        name: 'entity__read',
        description: 'Get one entity definition by its slug (collection_name).',
        inputSchema: {
          type: 'object',
          properties: { slug: { type: 'string', description: 'Entity slug = collection_name' } },
          required: ['slug'],
          additionalProperties: false,
        },
        _meta: stub('read', 'GET', '/:slug'),
      },
      // Single-tenant: config entity is READ-ONLY — don't advertise create/update.
    ];
  }

  private async callEntityTool(ctx: McpContext, action: string, args: any): Promise<any> {
    // Single-tenant: config entity is READ-ONLY (pre-seeded in Redis). Scope = env.
    const adapter = new JsonSettingAdapter(getTenantScope() || null);

    if (action === 'list') {
      const q: string = typeof args?.q === 'string' ? args.q : '';
      return adapter.list('entity', {
        page: Math.max(1, parseInt(args?.page) || 1),
        limit: Math.min(100, Math.max(1, parseInt(args?.limit) || 20)),
        filters: q ? { collection_name: q } : undefined,
      });
    }
    if (action === 'read') {
      if (!args?.slug) throw AppError.badRequest('slug is required', 'SLUG_REQUIRED');
      const data = await adapter.getBySlug('entity', args.slug);
      if (!data) throw AppError.notFound('Entity', args.slug);
      return data;
    }
    if (action === 'create' || action === 'update') {
      throw AppError.forbidden('Config entity read-only ở single-tenant (sửa qua Studio + reseed Redis).');
    }
    throw AppError.badRequest(`Unknown entity action: ${action}`, 'UNKNOWN_ACTION');
  }

  private async callMediaTool(ctx: McpContext, action: string, args: any): Promise<any> {
    if (action === 'upload') {
      let buffer: Buffer;
      let filename: string;
      let mimetype: string;
      if (args?.url) {
        const resp = await fetch(args.url);
        if (!resp.ok) throw AppError.badRequest(`Failed to fetch URL: HTTP ${resp.status}`, 'FETCH_FAILED');
        buffer = Buffer.from(await resp.arrayBuffer());
        const urlObj = new URL(args.url);
        filename = args.filename || (urlObj.pathname.split('/').pop() || 'file');
        mimetype = args.mimetype || resp.headers.get('content-type') || 'application/octet-stream';
      } else if (args?.data_base64) {
        if (!args.filename) throw AppError.badRequest('filename is required when using data_base64', 'FILENAME_REQUIRED');
        if (!args.mimetype) throw AppError.badRequest('mimetype is required when using data_base64', 'MIMETYPE_REQUIRED');
        buffer = Buffer.from(args.data_base64, 'base64');
        filename = args.filename;
        mimetype = args.mimetype;
      } else {
        throw AppError.badRequest('Provide either `url` or `data_base64` to upload', 'UPLOAD_INPUT_REQUIRED');
      }
      const result = await mediaMinioService.uploadBuffer(buffer, filename, mimetype, ctx.tenant_id, ctx.user_id);
      return {
        id: result.id,
        url: result.path,
        filename: result.objectName,
        mimetype: result.mimetype,
        size: result.size,
      };
    }
    if (action === 'list') {
      const page = Math.max(1, parseInt(args?.page) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(args?.limit) || 20));
      const q: string = typeof args?.q === 'string' ? args.q : '';
      // listObjects parses search[0] as "any:any:<q>" — must always pass one
      // element even when q is empty (otherwise split crashes on undefined).
      const search = [`q:q:${q}`];
      return await mediaMinioService.listObjects(undefined, true, page, limit, search, ctx.tenant_id);
    }
    if (action === 'delete') {
      if (!args?.id) throw AppError.badRequest('id is required', 'ID_REQUIRED');
      return await mediaMinioService.delete(args.id);
    }
    throw AppError.badRequest(`Unknown media action: ${action}`, 'UNKNOWN_ACTION');
  }

  /**
   * Build the full unfiltered tool list for a (tenant_id, role_name) pair.
   * Includes built-in tools + every action exposed by a matching policy.
   * Doesn't apply per-key whitelist — use `listTools(ctx)` for that.
   */
  async listAvailableTools(role_name: string, tenant_id?: string): Promise<McpTool[]> {
    const actionsMap = await this.getActions(tenant_id);
    const policies = await getPolicies({ role: { $in: [role_name] } });

    const tools: McpTool[] = [...this.getBuiltinTools()];
    const seen = new Set<string>(tools.map(t => t.name));

    for (const policy of policies) {
      const resource = Array.isArray(policy.resource) ? policy.resource[0] : policy.resource;
      const entity = Array.isArray(policy.root_entity) ? policy.root_entity[0] : policy.root_entity;
      if (!resource || !entity) continue;
      if (SYSTEM_ENTITIES.has(entity)) continue;

      const actions: string[] = Array.isArray(policy.action)
        ? policy.action
        : policy.action
          ? [policy.action]
          : [];

      // Per-policy MCP whitelist: if policy.mcp_actions is set, expose only
      // those actions to MCP. Otherwise fall back to policy.action.
      const mcpActions: string[] | undefined = Array.isArray(policy.mcp_actions)
        ? policy.mcp_actions
        : undefined;
      const exposedActions = mcpActions ? actions.filter(a => mcpActions.includes(a)) : actions;

      const formSetting = policy.form ? await getFormSettingBySlug(policy.form) : null;

      for (const actionSlug of exposedActions) {
        const actionDef = actionsMap[actionSlug];
        if (!actionDef) continue;

        // Use `__` as resource/action separator — Claude.ai MCP frontend rejects
        // `.` (pattern ^[a-zA-Z0-9_-]{1,64}$). Double-underscore avoids collision
        // with slugs that already contain single underscore (e.g. `pptx_render`).
        const toolName = `${resource}__${actionSlug}`;
        if (seen.has(toolName)) continue;
        seen.add(toolName);

        const inputSchema = await this.buildInputSchema(actionDef, entity, formSetting);

        tools.push({
          name: toolName,
          description: this.describe(actionDef, resource, entity, policy),
          inputSchema,
          _meta: {
            resource,
            action: actionSlug,
            entity,
            policy_slug: policy.slug,
            method: actionDef.method,
            path: actionDef.path,
            needs_id: (actionDef.path || '').includes(':id'),
            form: policy.form || null,
          },
        });
      }
    }
    return tools;
  }

  async listTools(ctx: McpContext): Promise<McpTool[]> {
    const all = await this.listAvailableTools(ctx.role_name, ctx.tenant_id);
    // Per-key whitelist: applies only when authenticated via API key.
    // OAuth tokens (no api_key_id) skip the filter — they see everything
    // the role allows.
    if (!ctx.api_key_id) return all;
    const enabled = await apiKeyService.getEnabledToolsByKeyId(ctx.api_key_id);
    if (enabled === null) return all; // null = all enabled (default)
    const allowed = new Set(enabled);
    return all.filter(t => allowed.has(t.name));
  }

  private describe(action: ActionDef, resource: string, entity: string, policy: any): string {
    const title = action.title || action.slug;
    const formNote = policy.form ? ` (form: ${policy.form})` : '';
    return `${title} ${resource} (entity: ${entity})${formNote}`;
  }

  private async buildInputSchema(action: ActionDef, entity: string, formSetting: any): Promise<any> {
    const method = (action.method || '').toUpperCase();
    const needsId = (action.path || '').includes(':id');

    if (method === 'GET' || method === 'DELETE') {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      if (needsId) {
        properties.id = { type: 'string', description: 'Resource ID' };
        required.push('id');
      }
      if (action.slug === 'list') {
        properties.limit = { type: 'integer', minimum: 1, maximum: 200, default: 10 };
        properties.page = { type: 'integer', minimum: 1, default: 1 };
        properties.order = {
          type: 'string',
          description: 'Order spec, e.g. "-created_at,name"',
        };
        properties.filter = {
          type: 'object',
          description:
            'MongoREST filters, e.g. { name: "like.*abc*", status: "eq.active" }',
          additionalProperties: { type: 'string' },
        };
      }
      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      };
    }

    const effective = await composeEffectiveSchema(entity, formSetting);
    const properties: Record<string, any> = { ...effective.properties };
    const required = [...effective.required];
    if (needsId) {
      properties.id = { type: 'string', description: 'Resource ID' };
      if (!required.includes('id')) required.push('id');
    }
    return {
      type: 'object',
      properties,
      required,
      additionalProperties: effective.additionalProperties,
    };
  }

  async callTool(ctx: McpContext, toolName: string, args: any, extras: CallExtras = {}) {
    // Per-key whitelist enforcement — same set as listTools so AI can't call
    // a hidden tool by guessing the name.
    if (ctx.api_key_id) {
      const enabled = await apiKeyService.getEnabledToolsByKeyId(ctx.api_key_id);
      if (enabled !== null && !enabled.includes(toolName)) {
        throw AppError.forbidden(`Tool '${toolName}' is disabled for this API key`);
      }
    }

    // Tool names use `__` to separate resource and action (see listTools).
    // Backward-compat: also accept legacy `.` separator from older clients.
    const sepIdx = toolName.indexOf('__') >= 0
      ? toolName.indexOf('__')
      : toolName.indexOf('.');
    const sepLen = toolName.indexOf('__') >= 0 ? 2 : 1;
    if (sepIdx < 0) throw AppError.badRequest(`Invalid tool name: ${toolName}`, 'INVALID_TOOL_NAME');
    const resource = toolName.slice(0, sepIdx);
    const actionSlug = toolName.slice(sepIdx + sepLen);

    // Built-in media tools — bypass policy machinery (same access as HTTP routes)
    if (resource === 'media') {
      return this.callMediaTool(ctx, actionSlug, args || {});
    }

    // Built-in entity tools — bypass SYSTEM_ENTITIES block + policy machinery,
    // route to JsonSettingAdapter so writes land in json/<tenant>/entity/.
    if (resource === 'entity') {
      return this.callEntityTool(ctx, actionSlug, args || {});
    }

    const actionDef = (await this.getActions(ctx.tenant_id))[actionSlug];
    if (!actionDef) throw AppError.badRequest(`Unknown action: ${actionSlug}`, 'UNKNOWN_ACTION');

    // Block system entities from being accessed via MCP
    const policies = await getPolicies({ role: { $in: [ctx.role_name] }, resource: { $in: [resource] } });
    const entity = Array.isArray(policies[0]?.root_entity) ? policies[0].root_entity[0] : policies[0]?.root_entity;
    if (entity && SYSTEM_ENTITIES.has(entity)) {
      throw AppError.forbidden(`Access denied: system entity '${entity}' cannot be accessed via MCP`);
    }

    const roles = [ctx.role_name];
    const method = (actionDef.method || '').toUpperCase();
    const incoming = { ...(args || {}) };
    const id = incoming.id;
    delete incoming.id;

    const baseOptions: OptionsInput = {
      databaseType: 'mongodb',
      is_tenant: !!ctx.tenant_id,
      user_id: ctx.user_id,
      tenant_id: ctx.tenant_id,
      roles,
      log: extras.log,
    };

    if (method === 'GET') {
      if (META_COLLECTIONS.has(resource)) {
        return await this.readFromSchemaCache(resource, id, incoming);
      }

      const queryData: Record<string, any> = {};
      if (id) queryData.id = id;
      if (incoming.limit !== undefined) queryData.limit = String(incoming.limit);
      if (incoming.page !== undefined) queryData.page = incoming.page;
      if (incoming.order !== undefined) queryData.order = incoming.order;
      if (incoming.filter && typeof incoming.filter === 'object') {
        for (const [k, v] of Object.entries(incoming.filter)) {
          queryData[k] = v as any;
        }
      }
      const params = id ? { id } : {};
      return await commonService.getQuery(resource, actionDef, queryData, roles, params, baseOptions);
    }

    if (method === 'POST') {
      const body: any = { ...incoming, tenant_id: ctx.tenant_id };
      console.log('[MCP] POST', { resource, ctx_tenant: ctx.tenant_id, body_tenant: body.tenant_id });
      return await commonService.postQuery(resource, actionDef, body, roles, {
        ...baseOptions,
        action: 'POST' as any,
        body,
      });
    }

    if (method === 'PUT') {
      const params = id ? { id } : {};
      const body: any = { ...incoming, tenant_id: ctx.tenant_id };
      return await commonService.putQuery(resource, actionDef, params, body, roles, {
        ...baseOptions,
        partial: true,
        body,
      } as any);
    }

    if (method === 'PATCH') {
      const params = id ? { id } : {};
      const body: any = { ...incoming, tenant_id: ctx.tenant_id };
      return await commonService.patchQuery(resource, actionDef, params, body, roles, {
        ...baseOptions,
        partial: true,
        body,
      } as any);
    }

    if (method === 'DELETE') {
      const queryData: Record<string, any> = {};
      if (id) queryData.id = id;
      return await commonService.deleteQuery(resource, actionDef, queryData, roles, {
        ...baseOptions,
        action: 'DELETE' as any,
      });
    }

    throw AppError.badRequest(`Unsupported method: ${method}`, 'UNSUPPORTED_METHOD');
  }

  private async readFromSchemaCache(resource: string, id: any, args: any) {
    const cache = await schemaManager.getCache();
    const items: any[] = Object.values(cache[resource] || {});

    if (id) {
      const found = items.find(
        (it: any) =>
          String(it._id) === String(id) ||
          it.slug === id ||
          it.collection_name === id,
      );
      return {
        data: found ? [found] : [],
        count: found ? 1 : 0,
        statusCode: 200,
        metadata: { source: 'schema-cache', collection: resource },
      };
    }

    let filtered = items;
    if (args.filter && typeof args.filter === 'object') {
      filtered = items.filter((it: any) => {
        for (const [k, v] of Object.entries(args.filter)) {
          const sv = String(v).replace(/^eq\./, '');
          const itemVal = it[k];
          if (Array.isArray(itemVal)) {
            if (!itemVal.map(String).includes(sv)) return false;
          } else if (String(itemVal) !== sv) {
            return false;
          }
        }
        return true;
      });
    }

    const limit = parseInt(String(args.limit ?? 10), 10) || 10;
    const page = parseInt(String(args.page ?? 1), 10) || 1;
    const skip = (page - 1) * limit;
    const sliced = filtered.slice(skip, skip + limit);

    return {
      data: sliced,
      count: filtered.length,
      statusCode: 200,
      metadata: { source: 'schema-cache', collection: resource },
      pagination: {
        current_page: page,
        last_page: Math.max(1, Math.ceil(filtered.length / limit)),
        total: filtered.length,
        hasMore: skip + sliced.length < filtered.length,
      },
    };
  }
}

export const mcpService = new McpService();
