import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { oauthService, ACCESS_TOKEN_TTL_SEC } from './oauth.service';
import { renderLoginPage } from './login-page';
import { AuthService } from '../../_auth/auth.service';
import { apiKeyService } from '../api-key.service';

const SUPPORTED_SCOPES = ['mcp'];

function getOrigin(request: FastifyRequest): string {
  const proto =
    (request.headers['x-forwarded-proto'] as string) ||
    (request as any).protocol ||
    'http';
  const host =
    (request.headers['x-forwarded-host'] as string) ||
    (request.headers['host'] as string) ||
    'localhost';
  return `${proto}://${host}`;
}

function parseFormBody(body: any): Record<string, string> {
  if (!body) return {};
  if (typeof body === 'string') {
    const params = new URLSearchParams(body);
    const out: Record<string, string> = {};
    params.forEach((v, k) => (out[k] = v));
    return out;
  }
  return body as Record<string, string>;
}

export async function registerOAuthDiscoveryRoutes(app: FastifyInstance) {
  const authService = new AuthService();

  app.get('/.well-known/oauth-protected-resource', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = getOrigin(request);
    return reply.send({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
      resource_documentation: `${origin}/docs`,
    });
  });

  app.get('/.well-known/oauth-protected-resource/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = getOrigin(request);
    return reply.send({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
    });
  });

  app.get('/.well-known/oauth-authorization-server', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = getOrigin(request);
    return reply.send({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SUPPORTED_SCOPES,
    });
  });

  // Dynamic Client Registration (RFC 7591)
  app.post('/oauth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as any;
    try {
      const client = await oauthService.registerClient({
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: body.token_endpoint_auth_method,
        grant_types: body.grant_types,
        response_types: body.response_types,
        scope: body.scope,
      });
      return reply.code(201).send({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        scope: client.scope,
        client_id_issued_at: Math.floor(client.created_at.getTime() / 1000),
      });
    } catch (err: any) {
      return reply.code(400).send({
        error: 'invalid_client_metadata',
        error_description: err?.message || 'Registration failed',
      });
    }
  });

  // Authorization endpoint
  // Two modes:
  //   1) client_id is an API key prefix (12 hex chars) → no login, auto-issue code.
  //      User authenticates implicitly by knowing the matching client_secret (full key)
  //      which is verified at /oauth/token.
  //   2) client_id is a registered OAuth client → show login page (api_key OR email/password).
  app.get('/oauth/authorize', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string>;
    const required = ['client_id', 'redirect_uri', 'response_type', 'code_challenge'];
    for (const k of required) {
      if (!q[k]) {
        return reply.code(400).send({ error: 'invalid_request', error_description: `Missing ${k}` });
      }
    }
    if (q.response_type !== 'code') {
      return reply.code(400).send({ error: 'unsupported_response_type' });
    }

    // Mode 1: client_id is an API key prefix
    if (/^[0-9a-f]{12}$/.test(q.client_id)) {
      const apiKey = await apiKeyService.findByPrefix(q.client_id);
      if (apiKey) {
        if (!q.redirect_uri.startsWith('https://')) {
          return reply
            .code(400)
            .send({ error: 'invalid_request', error_description: 'redirect_uri must be https://' });
        }
        const code = await oauthService.createCode({
          client_id: q.client_id,
          redirect_uri: q.redirect_uri,
          code_challenge: q.code_challenge,
          code_challenge_method: q.code_challenge_method || 'plain',
          scope: q.scope || 'mcp',
          user_id: apiKey.user_id,
          email: apiKey.email,
          role_name: apiKey.role_name,
          tenant_id: apiKey.tenant_id || null,
          api_key_id: apiKey._id?.toString?.() || String(apiKey._id),
        });
        const url = new URL(q.redirect_uri);
        url.searchParams.set('code', code);
        if (q.state) url.searchParams.set('state', q.state);
        return reply.code(302).header('location', url.toString()).send();
      }
    }

    // Mode 2: registered OAuth client → show login page
    const client = await oauthService.getClient(q.client_id);
    if (!client) {
      return reply.code(400).send({ error: 'invalid_client' });
    }
    if (!oauthService.validateRedirectUri(client, q.redirect_uri)) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
    }
    const html = renderLoginPage({
      client_name: client.client_name,
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      state: q.state || '',
      code_challenge: q.code_challenge,
      code_challenge_method: q.code_challenge_method || 'plain',
      scope: q.scope || 'mcp',
      response_type: q.response_type,
    });
    return reply.type('text/html').send(html);
  });

  // Authorization endpoint — handle login submit (api_key OR email/password)
  app.post('/oauth/authorize', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseFormBody(request.body);
    const {
      api_key,
      email,
      password,
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      scope,
      response_type,
    } = body;

    if (!client_id || !redirect_uri || !code_challenge || !response_type) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const client = await oauthService.getClient(client_id);
    if (!client) {
      return reply.code(400).send({ error: 'invalid_client' });
    }
    if (!oauthService.validateRedirectUri(client, redirect_uri)) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'redirect_uri mismatch' });
    }

    const renderError = (msg: string) =>
      renderLoginPage({
        client_name: client.client_name,
        client_id,
        redirect_uri,
        state: state || '',
        code_challenge,
        code_challenge_method: code_challenge_method || 'plain',
        scope: scope || 'mcp',
        response_type,
        error: msg,
      });

    let user_id: string | null = null;
    let user_email: string | null = null;
    let user_role: string | null = null;
    let user_tenant: string | null = null;

    if (api_key && api_key.trim()) {
      const record = await apiKeyService.verify(api_key.trim());
      if (!record) {
        return reply.code(401).type('text/html').send(renderError('Invalid or revoked API key'));
      }
      user_id = record.user_id;
      user_email = record.email;
      user_role = record.role_name;
      user_tenant = record.tenant_id || null;
    } else if (email && password) {
      let user: any = null;
      try {
        user = await authService.validateCredentials(email, password);
      } catch {
        user = null;
      }
      if (!user) {
        return reply.code(401).type('text/html').send(renderError('Invalid email or password'));
      }
      user_id = user._id?.toString?.() || user.id || String(user._id);
      user_email = user.email;
      user_role = user.role_name || 'user';
      user_tenant =
        Array.isArray(user.role) && user.role[0]?.tenant_id?._id
          ? user.role[0].tenant_id._id.toString()
          : Array.isArray(user.role) && typeof user.role[0]?.tenant_id === 'string'
            ? user.role[0].tenant_id
            : null;
    } else {
      return reply
        .code(400)
        .type('text/html')
        .send(renderError('Provide an API key or email + password'));
    }

    const code = await oauthService.createCode({
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method: code_challenge_method || 'plain',
      scope: scope || 'mcp',
      user_id: user_id!,
      email: user_email!,
      role_name: user_role!,
      tenant_id: user_tenant,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    return reply.code(302).header('location', url.toString()).send();
  });

  // Token endpoint
  // Two modes:
  //   1) Code was issued for an API key prefix (api_key_id set on code) →
  //      verify body.client_secret against the api_key, ignore PKCE.
  //   2) Code was issued for a registered OAuth client → verify PKCE.
  app.post('/oauth/token', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseFormBody(request.body);
    const grant_type = body.grant_type;
    const jwtSign = (app as any).jwt.sign.bind((app as any).jwt);

    if (grant_type !== 'authorization_code') {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }

    if (!body.code || !body.client_id || !body.redirect_uri) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'Missing code/client_id/redirect_uri' });
    }

    try {
      const codeRecord = await oauthService.findCode(body.code);
      if (!codeRecord) throw new Error('code not found');
      if (codeRecord.used) throw new Error('code already used');
      if (new Date(codeRecord.expires_at) < new Date()) throw new Error('code expired');
      if (codeRecord.client_id !== body.client_id) throw new Error('client mismatch');
      if (codeRecord.redirect_uri !== body.redirect_uri) throw new Error('redirect_uri mismatch');

      // Mode 1: API-key-bound code
      if (codeRecord.api_key_id) {
        if (!body.client_secret) {
          throw new Error('client_secret required');
        }
        const apiKey = await apiKeyService.findByPrefix(body.client_id);
        if (!apiKey || apiKey._id?.toString?.() !== codeRecord.api_key_id) {
          throw new Error('client_secret invalid');
        }
        const ok = await apiKeyService.verifyAgainstRecord(body.client_secret, apiKey);
        if (!ok) {
          throw new Error('client_secret invalid');
        }

        await oauthService.markCodeUsed(body.code);
        const payload = oauthService.buildAccessTokenPayload(codeRecord);
        const access_token = await jwtSign(payload, { expiresIn: ACCESS_TOKEN_TTL_SEC });
        return reply.send({
          access_token,
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_SEC,
          scope: codeRecord.scope,
        });
      }

      // Mode 2: standard OAuth client + PKCE
      if (!body.code_verifier) {
        throw new Error('code_verifier required');
      }
      const client = await oauthService.getClient(body.client_id);
      if (!client) {
        return reply.code(400).send({ error: 'invalid_client' });
      }
      const result = await oauthService.exchangeCode(
        {
          code: body.code,
          client_id: body.client_id,
          redirect_uri: body.redirect_uri,
          code_verifier: body.code_verifier,
        },
        jwtSign,
      );
      return reply.send({
        access_token: result.access_token,
        token_type: 'Bearer',
        expires_in: result.expires_in,
        scope: result.scope,
      });
    } catch (err: any) {
      return reply.code(400).send({
        error: 'invalid_grant',
        error_description: err?.message || 'invalid_grant',
      });
    }
  });
}
