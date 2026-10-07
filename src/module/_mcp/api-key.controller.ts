import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { apiKeyService } from './api-key.service';
import { JWTGuard } from '../_auth/guards/jwt.guard';
import { AuthResponseHelper } from '../_auth/dto/response.dto';
import { mcpService } from './mcp.service';
import { withTenant } from '../../configs/core/adapter';

export interface ApiKeyControllerDeps {
  jwtGuard: JWTGuard;
}

export async function registerApiKeyRoutes(app: FastifyInstance, deps: ApiKeyControllerDeps) {
  const { jwtGuard } = deps;

  app.post(
    '/api-keys',
    {
      preHandler: jwtGuard.preHandler.bind(jwtGuard),
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            expires_at: { type: 'string', format: 'date-time' },
            mcp_enabled_tools: {
              type: ['array', 'null'],
              items: { type: 'string' },
              description: 'Whitelist of MCP tool names. null/omitted = all tools enabled.',
            },
          },
        },
        tags: ['mcp'],
        summary: 'Create a personal API key for MCP',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request.headers as any).user;
      if (!user?.id) {
        return reply.code(401).send(AuthResponseHelper.error('Unauthorized', 401, 'Unauthorized'));
      }
      const { name, expires_at, mcp_enabled_tools } = request.body as {
        name: string;
        expires_at?: string;
        mcp_enabled_tools?: string[] | null;
      };
      const tenant_id = (request.headers['x-tenant-id'] as string) || user.id_tenant || null;
      const { key, record } = await apiKeyService.create({
        user_id: user.id,
        email: user.email,
        role_name: user.role_name,
        tenant_id,
        name,
        expires_at: expires_at ? new Date(expires_at) : null,
        mcp_enabled_tools: mcp_enabled_tools ?? null,
      });
      return reply.code(201).send(
        AuthResponseHelper.success({
          key,
          id: record._id,
          name: record.name,
          prefix: record.prefix,
          expires_at: record.expires_at,
          created_at: record.created_at,
        }),
      );
    },
  );

  app.get(
    '/api-keys',
    {
      preHandler: jwtGuard.preHandler.bind(jwtGuard),
      schema: {
        tags: ['mcp'],
        summary: 'List API keys for current user',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request.headers as any).user;
      if (!user?.id) {
        return reply.code(401).send(AuthResponseHelper.error('Unauthorized', 401, 'Unauthorized'));
      }
      const tenant_id = (request.headers['x-tenant-id'] as string) || null;
      const list = await apiKeyService.listByUser(user.id, tenant_id);
      return reply.send(AuthResponseHelper.success(list));
    },
  );

  app.delete(
    '/api-keys/:id',
    {
      preHandler: jwtGuard.preHandler.bind(jwtGuard),
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        tags: ['mcp'],
        summary: 'Revoke an API key',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request.headers as any).user;
      if (!user?.id) {
        return reply.code(401).send(AuthResponseHelper.error('Unauthorized', 401, 'Unauthorized'));
      }
      const { id } = request.params as { id: string };
      const ok = await apiKeyService.revoke(user.id, id);
      if (!ok) {
        return reply.code(404).send(AuthResponseHelper.error('API key not found', 404, 'Not Found'));
      }
      return reply.send(AuthResponseHelper.success({ revoked: true }));
    },
  );

  // Preview tools for a NEW key — uses current request's tenant + user role.
  // Frontend calls this on the "create key" form to populate checkbox list.
  app.get(
    '/api-keys/mcp-tools',
    {
      preHandler: jwtGuard.preHandler.bind(jwtGuard),
      schema: {
        tags: ['mcp'],
        summary: 'Preview MCP tools available for a new key (uses current tenant + role)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request.headers as any).user;
      if (!user?.id) {
        return reply.code(401).send(AuthResponseHelper.error('Unauthorized', 401, 'Unauthorized'));
      }
      const tenant_id = ((request as any).tenantId as string) || (request.headers['x-tenant-id'] as string) || user.id_tenant || undefined;
      const role_name = user.role_name || 'admin';
      const tools = await withTenant(tenant_id, () => mcpService.listAvailableTools(role_name, tenant_id));
      return reply.send(AuthResponseHelper.success({ available: tools, enabled: null }));
    },
  );

  // Preview tools for an EXISTING key — derives tenant+role from the key
  // record, returns current whitelist so the frontend can prefill checkboxes.
  app.get(
    '/api-keys/:id/mcp-tools',
    {
      preHandler: jwtGuard.preHandler.bind(jwtGuard),
      schema: {
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        tags: ['mcp'],
        summary: 'List MCP tools available for an API key and which are enabled',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request.headers as any).user;
      if (!user?.id) {
        return reply.code(401).send(AuthResponseHelper.error('Unauthorized', 401, 'Unauthorized'));
      }
      const { id } = request.params as { id: string };
      const record = await apiKeyService.getById(user.id, id);
      if (!record) {
        return reply.code(404).send(AuthResponseHelper.error('API key not found', 404, 'Not Found'));
      }
      const tenant_id = record.tenant_id || undefined;
      const tools = await withTenant(tenant_id, () => mcpService.listAvailableTools(record.role_name, tenant_id));
      return reply.send(
        AuthResponseHelper.success({
          available: tools,
          enabled: record.mcp_enabled_tools ?? null,
        }),
      );
    },
  );

  // Replace whitelist for an existing key. Pass `enabled: null` to clear and
  // re-enable everything.
  app.put(
    '/api-keys/:id/mcp-tools',
    {
      preHandler: jwtGuard.preHandler.bind(jwtGuard),
      schema: {
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            enabled: { type: ['array', 'null'], items: { type: 'string' } },
          },
        },
        tags: ['mcp'],
        summary: 'Update MCP tool whitelist for an API key',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request.headers as any).user;
      if (!user?.id) {
        return reply.code(401).send(AuthResponseHelper.error('Unauthorized', 401, 'Unauthorized'));
      }
      const { id } = request.params as { id: string };
      const { enabled } = request.body as { enabled: string[] | null };
      const ok = await apiKeyService.updateEnabledTools(user.id, id, enabled ?? null);
      if (!ok) {
        return reply.code(404).send(AuthResponseHelper.error('API key not found', 404, 'Not Found'));
      }
      return reply.send(AuthResponseHelper.success({ updated: true, enabled: enabled ?? null }));
    },
  );
}
