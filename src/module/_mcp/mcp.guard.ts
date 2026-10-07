import { FastifyRequest, FastifyInstance } from 'fastify';
import { apiKeyService } from './api-key.service';
import { getTenantSlug } from '../../configs/tenant';
import { verifyToken } from '../../configs/jwt-verify';

/** Single-tenant: tenant is fixed via the env `TENANT` (team/user_team removed). */
async function resolveTenantForUser(_userId: string, _roleName?: string): Promise<string | undefined> {
  return getTenantSlug() || undefined;
}

export interface McpContext {
  user_id: string;
  email: string;
  role_name: string;
  tenant_id?: string;
  source: 'api_key' | 'oauth';
  api_key_id?: string;
}

export async function mcpAuthenticate(
  request: FastifyRequest,
  app?: FastifyInstance,
): Promise<McpContext | null> {
  const tenant_id = (request.headers['x-tenant-id'] as string) || undefined;

  // 1) Bearer (OAuth flow) — used by Claude.ai web custom connector
  const authz = (request.headers['authorization'] as string) || '';
  if (authz.toLowerCase().startsWith('bearer ')) {
    const token = authz.slice(7).trim();
    if (token) {
      // 1a) MGS API key passed via Bearer (Claude.ai connectors that don't expose
      //     custom headers can paste the key directly). Format: mgs_<prefix>_<secret>.
      if (token.startsWith('mgs_')) {
        const record = await apiKeyService.verify(token);
        if (record) {
          const resolvedTenant = tenant_id || record.tenant_id || getTenantSlug() || undefined;
          if (!resolvedTenant) return null;
          return {
            user_id: record.user_id,
            email: record.email,
            role_name: record.role_name,
            tenant_id: resolvedTenant,
            source: 'api_key',
            api_key_id: record._id?.toString?.() || String(record._id),
          };
        }
      }
      try {
        {
          // Verify RS256 (SSO public key) or HS256 (JWT_SECRET) — auto-detected.
          const payload = verifyToken(token) as any;
          if (payload?.sub && payload?.role_name) {
            // Resolve tenant fallback: header > token claim > DB lookup of user's tenant.
            // Older OAuth tokens were minted with tenant_id=null when login used an
            // API key (bug fixed elsewhere). Lookup gives us the right tenant
            // without forcing every existing client to re-authenticate.
            const resolved = tenant_id || payload.tenant_id || (await resolveTenantForUser(payload.sub, payload.role_name));
            return {
              user_id: payload.sub,
              email: payload.email,
              role_name: payload.role_name,
              tenant_id: resolved,
              source: 'oauth',
              api_key_id: payload.api_key_id || undefined,
            };
          }
          // Fall back: regular auth JWT (id field)
          if (payload?.id && payload?.role_name) {
            const resolved = tenant_id || payload.id_tenant || (await resolveTenantForUser(payload.id, payload.role_name));
            return {
              user_id: payload.id,
              email: payload.email,
              role_name: payload.role_name,
              tenant_id: resolved,
              source: 'oauth',
              api_key_id: payload.api_key_id || undefined,
            };
          }
        }
      } catch {
        // invalid token — fall through
      }
    }
  }

  // 2) X-MCP-Key header OR ?key= / ?api_key= in query string
  //    (query string lets users embed the key directly in the connector URL,
  //    e.g. https://mcp.example.com/mcp?key=mgs_xxx_yyy — useful for clients
  //    like Claude.ai web that don't expose custom header config.)
  const query = (request.query || {}) as Record<string, any>;
  const headerKey =
    (request.headers['x-mcp-key'] as string) ||
    (request.headers['x-api-key'] as string) ||
    (typeof query.key === 'string' ? query.key : '') ||
    (typeof query.api_key === 'string' ? query.api_key : '') ||
    '';
  if (headerKey) {
    const record = await apiKeyService.verify(headerKey);
    if (record) {
      const resolvedTenant = tenant_id || record.tenant_id;
      // tenant_id is mandatory — without it core-service skips security filter
      // and data from all tenants leaks. Reject the auth so user re-creates the key.
      if (!resolvedTenant) return null;
      return {
        user_id: record.user_id,
        email: record.email,
        role_name: record.role_name,
        tenant_id: resolvedTenant,
        source: 'api_key',
        api_key_id: record._id?.toString?.() || String(record._id),
      };
    }
  }

  return null;
}
