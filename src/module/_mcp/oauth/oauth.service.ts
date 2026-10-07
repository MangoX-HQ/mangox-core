import * as crypto from 'crypto';
import { getCoreUnified } from '../../../configs/core';

const CLIENT_COLLECTION = 'oauth_client';
const CODE_COLLECTION = 'oauth_code';

const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_SEC = 60 * 60 * 12;

export interface OAuthClient {
  _id?: any;
  client_id: string;
  client_secret_hash?: string | null;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  scope?: string;
  created_at: Date;
}

export interface OAuthCode {
  _id?: any;
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  user_id: string;
  email: string;
  role_name: string;
  tenant_id?: string | null;
  api_key_id?: string | null;
  expires_at: Date;
  used: boolean;
  created_at: Date;
}

export interface RegisterClientInput {
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
}

export interface CreateCodeInput {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  user_id: string;
  email: string;
  role_name: string;
  tenant_id?: string | null;
  api_key_id?: string | null;
}

export interface ExchangeCodeInput {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role_name: string;
  tenant_id?: string | null;
  scope?: string;
  type: 'mcp_oauth';
  api_key_id?: string | null;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 32): string {
  return base64url(crypto.randomBytes(bytes));
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === 'plain') return verifier === challenge;
  if (method === 'S256') {
    const hash = crypto.createHash('sha256').update(verifier).digest();
    return base64url(hash) === challenge;
  }
  return false;
}

export class OAuthService {
  private db: any;
  private initialized = false;

  private async init() {
    if (this.initialized) return;
    this.db = await getCoreUnified().getInstanceDB('mongodb');
    try {
      await this.db.collection(CLIENT_COLLECTION).createIndex({ client_id: 1 }, { unique: true });
      await this.db.collection(CODE_COLLECTION).createIndex({ code: 1 }, { unique: true });
      await this.db.collection(CODE_COLLECTION).createIndex(
        { expires_at: 1 },
        { expireAfterSeconds: 0 },
      );
    } catch {
      // ignore index errors
    }
    this.initialized = true;
  }

  async registerClient(input: RegisterClientInput): Promise<OAuthClient> {
    await this.init();
    if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
      throw new Error('redirect_uris is required');
    }
    const client: OAuthClient = {
      client_id: randomToken(16),
      client_secret_hash: null,
      client_name: input.client_name || 'Unnamed Client',
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: input.token_endpoint_auth_method || 'none',
      grant_types: input.grant_types || ['authorization_code', 'refresh_token'],
      response_types: input.response_types || ['code'],
      scope: input.scope || 'mcp',
      created_at: new Date(),
    };
    const result = await this.db.collection(CLIENT_COLLECTION).insertOne(client);
    client._id = result.insertedId;
    return client;
  }

  async getClient(client_id: string): Promise<OAuthClient | null> {
    await this.init();
    return this.db.collection(CLIENT_COLLECTION).findOne({ client_id });
  }

  async createCode(input: CreateCodeInput): Promise<string> {
    await this.init();
    const code = randomToken(24);
    const record: OAuthCode = {
      code,
      client_id: input.client_id,
      redirect_uri: input.redirect_uri,
      code_challenge: input.code_challenge,
      code_challenge_method: input.code_challenge_method,
      scope: input.scope,
      user_id: input.user_id,
      email: input.email,
      role_name: input.role_name,
      tenant_id: input.tenant_id ?? null,
      api_key_id: input.api_key_id ?? null,
      expires_at: new Date(Date.now() + CODE_TTL_MS),
      used: false,
      created_at: new Date(),
    };
    await this.db.collection(CODE_COLLECTION).insertOne(record);
    return code;
  }

  async findCode(code: string): Promise<OAuthCode | null> {
    await this.init();
    return this.db.collection(CODE_COLLECTION).findOne({ code });
  }

  async markCodeUsed(code: string): Promise<void> {
    await this.init();
    await this.db.collection(CODE_COLLECTION).updateOne({ code }, { $set: { used: true } });
  }

  buildAccessTokenPayload(record: OAuthCode): AccessTokenPayload {
    return {
      sub: record.user_id,
      email: record.email,
      role_name: record.role_name,
      tenant_id: record.tenant_id,
      scope: record.scope,
      type: 'mcp_oauth',
      api_key_id: record.api_key_id ?? null,
    };
  }

  async exchangeCode(
    input: ExchangeCodeInput,
    jwtSign: (payload: any, opts?: any) => string | Promise<string>,
  ): Promise<{ access_token: string; expires_in: number; scope?: string }> {
    await this.init();
    const record: OAuthCode | null = await this.db
      .collection(CODE_COLLECTION)
      .findOne({ code: input.code });
    if (!record) throw new Error('invalid_grant: code not found');
    if (record.used) throw new Error('invalid_grant: code already used');
    if (new Date(record.expires_at) < new Date()) throw new Error('invalid_grant: code expired');
    if (record.client_id !== input.client_id) throw new Error('invalid_grant: client mismatch');
    if (record.redirect_uri !== input.redirect_uri) {
      throw new Error('invalid_grant: redirect_uri mismatch');
    }
    if (!verifyPkce(input.code_verifier, record.code_challenge, record.code_challenge_method)) {
      throw new Error('invalid_grant: PKCE verification failed');
    }

    await this.db
      .collection(CODE_COLLECTION)
      .updateOne({ code: input.code }, { $set: { used: true } });

    const payload: AccessTokenPayload = {
      sub: record.user_id,
      email: record.email,
      role_name: record.role_name,
      tenant_id: record.tenant_id,
      scope: record.scope,
      type: 'mcp_oauth',
      api_key_id: record.api_key_id ?? null,
    };

    const access_token = await jwtSign(payload, { expiresIn: ACCESS_TOKEN_TTL_SEC });

    return {
      access_token: typeof access_token === 'string' ? access_token : String(access_token),
      expires_in: ACCESS_TOKEN_TTL_SEC,
      scope: record.scope,
    };
  }

  validateRedirectUri(client: OAuthClient, redirect_uri: string): boolean {
    return client.redirect_uris.includes(redirect_uri);
  }
}

export const oauthService = new OAuthService();
