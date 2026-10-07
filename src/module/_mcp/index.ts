import { FastifyInstance } from 'fastify';
import { JWTGuard } from '../_auth/guards/jwt.guard';
import { registerApiKeyRoutes } from './api-key.controller';
import { registerMcpRoutes } from './mcp.controller';
import { registerOAuthDiscoveryRoutes } from './oauth/oauth.controller';

// Routes mounted under the API prefix (e.g. /api/v1/api-keys)
// — only the dashboard-side API key management lives here.
export async function McpRoutes(app: FastifyInstance, jwtGuard: JWTGuard) {
  await registerApiKeyRoutes(app, { jwtGuard });
}

// Routes mounted at the root of the host (no prefix).
// MCP endpoint + OAuth discovery + OAuth flow live here so that
// `https://<host>/mcp`, `/.well-known/*`, `/oauth/*` all resolve directly.
export async function McpOAuthRoutes(app: FastifyInstance) {
  await registerOAuthDiscoveryRoutes(app);
  await registerMcpRoutes(app);
}

export { apiKeyService, ApiKeyService } from './api-key.service';
export { mcpService, McpService } from './mcp.service';
export { mcpAuthenticate } from './mcp.guard';
export type { McpContext } from './mcp.guard';
export { oauthService, OAuthService } from './oauth/oauth.service';
export {
  composeEffectiveSchema,
  composeEffectiveSchemaForPolicy,
} from './schema-compose';
