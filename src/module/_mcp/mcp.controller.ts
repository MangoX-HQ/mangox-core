import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { mcpService } from './mcp.service';
import { mcpAuthenticate } from './mcp.guard';
import { withTenant } from '../../configs/core/adapter';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: any;
  method: string;
  params?: any;
}

const SERVER_INFO = {
  name: 'mgs-mcp',
  version: '0.1.0',
};

const CAPABILITIES = {
  tools: { listChanged: false },
};

// Supported MCP protocol revisions, newest first. We echo back whichever the
// client requests if we support it, otherwise our highest. claude.ai web uses
// 2025-03-26; older clients still send 2024-11-05.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PROTOCOL_VERSION = SUPPORTED_PROTOCOLS[0];

function rpcResult(id: any, result: any) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: any, code: number, message: string, data?: any) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

export async function registerMcpRoutes(app: FastifyInstance) {
  app.post(
    '/mcp',
    {
      schema: {
        tags: ['mcp'],
        summary: 'MCP JSON-RPC endpoint',
        description:
          'Authenticate with header X-MCP-Key. Optional X-Tenant-Id for multi-tenant.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Streamable HTTP transport (MCP 2025-03-26+) requires Mcp-Session-Id.
      // We're stateless — auth context lives on the bearer token — so just
      // echo back whatever session id the client sent, or mint one on initialize.
      const incomingSessionId = (request.headers['mcp-session-id'] as string) || '';
      const sessionId = incomingSessionId || `mgs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      reply.header('Mcp-Session-Id', sessionId);

      const ctx = await mcpAuthenticate(request, app);
      if (!ctx) {
        const proto =
          (request.headers['x-forwarded-proto'] as string) ||
          (request as any).protocol ||
          'http';
        const host =
          (request.headers['x-forwarded-host'] as string) ||
          (request.headers['host'] as string) ||
          'localhost';
        const resourceMetadata = `${proto}://${host}/.well-known/oauth-protected-resource`;
        return reply
          .code(401)
          .header(
            'WWW-Authenticate',
            `Bearer realm="mgs-mcp", resource_metadata="${resourceMetadata}"`,
          )
          .send(rpcError(null, -32001, 'Authentication required'));
      }

      const rpc = request.body as JsonRpcRequest;
      if (!rpc || rpc.jsonrpc !== '2.0' || !rpc.method) {
        return reply.send(rpcError(rpc?.id ?? null, -32600, 'Invalid Request'));
      }

      try {
        switch (rpc.method) {
          case 'initialize': {
            const requested = (rpc.params as any)?.protocolVersion as string | undefined;
            const negotiated = requested && SUPPORTED_PROTOCOLS.includes(requested)
              ? requested
              : PROTOCOL_VERSION;
            return reply.send(
              rpcResult(rpc.id, {
                protocolVersion: negotiated,
                capabilities: CAPABILITIES,
                serverInfo: SERVER_INFO,
              }),
            );
          }

          case 'notifications/initialized':
          case 'initialized':
            return reply.code(204).send();

          case 'ping':
            return reply.send(rpcResult(rpc.id, {}));

          case 'tools/list': {
            // tools/list reads policies via getPolicies() which uses AsyncLocalStorage
            // tenant slug. Set the context so tenant-scoped policies are merged in
            // — otherwise only system policies are visible and most are filtered out.
            const tools = await withTenant(ctx.tenant_id, () => mcpService.listTools(ctx));
            return reply.send(rpcResult(rpc.id, { tools }));
          }

          case 'tools/call': {
            const params = (rpc.params || {}) as { name: string; arguments?: any };
            if (!params.name) {
              return reply.send(rpcError(rpc.id, -32602, 'Missing tool name'));
            }
            try {
              const data = await withTenant(ctx.tenant_id, () => mcpService.callTool(ctx, params.name, params.arguments || {}, {
                log: request.log,
              }));
              return reply.send(
                rpcResult(rpc.id, {
                  content: [
                    {
                      type: 'text',
                      text:
                        typeof data === 'string' ? data : JSON.stringify(data, null, 2),
                    },
                  ],
                  isError: false,
                }),
              );
            } catch (err: any) {
              request.log.error({ err }, '[MCP] tools/call failed');
              return reply.send(
                rpcResult(rpc.id, {
                  content: [{ type: 'text', text: err?.message || 'Tool call failed' }],
                  isError: true,
                }),
              );
            }
          }

          default:
            return reply.send(
              rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`),
            );
        }
      } catch (error: any) {
        request.log.error({ err: error }, '[MCP] handler error');
        return reply.send(
          rpcError(rpc.id, -32000, error?.message || 'Internal error'),
        );
      }
    },
  );
}
