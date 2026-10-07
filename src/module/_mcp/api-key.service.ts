import { ObjectId } from 'mongodb';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { getCoreUnified } from '../../configs/core';

const COLLECTION = 'user_api_key';
const KEY_PREFIX = 'mgs';

export interface ApiKeyRecord {
  _id?: any;
  user_id: string;
  email: string;
  role_name: string;
  tenant_id?: string | null;
  name: string;
  prefix: string;
  key_hash: string;
  last_used_at?: Date | null;
  expires_at?: Date | null;
  revoked_at?: Date | null;
  created_at: Date;
  /** Whitelist of MCP tool names this key can access.
   *  null/undefined → all tools enabled (default).
   *  []             → all tools disabled.
   *  [...]          → only listed tools. */
  mcp_enabled_tools?: string[] | null;
}

export interface CreateApiKeyInput {
  user_id: string;
  email: string;
  role_name: string;
  tenant_id?: string | null;
  name: string;
  expires_at?: Date | null;
  mcp_enabled_tools?: string[] | null;
}

export class ApiKeyService {
  private db: any;
  private initialized = false;

  private async init() {
    if (this.initialized) return;
    this.db = await getCoreUnified().getInstanceDB('mongodb');
    try {
      await this.db.collection(COLLECTION).createIndex({ prefix: 1 });
      await this.db.collection(COLLECTION).createIndex({ user_id: 1 });
    } catch {
      // ignore index errors
    }
    this.initialized = true;
  }

  async create(input: CreateApiKeyInput): Promise<{ key: string; record: ApiKeyRecord }> {
    await this.init();
    const prefix = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(24).toString('base64url');
    const fullKey = `${KEY_PREFIX}_${prefix}_${secret}`;
    const key_hash = await bcrypt.hash(fullKey, 10);

    const record: ApiKeyRecord = {
      user_id: input.user_id,
      email: input.email,
      role_name: input.role_name,
      tenant_id: input.tenant_id ?? null,
      name: input.name,
      prefix,
      key_hash,
      last_used_at: null,
      expires_at: input.expires_at ?? null,
      revoked_at: null,
      created_at: new Date(),
      mcp_enabled_tools: input.mcp_enabled_tools === undefined ? null : input.mcp_enabled_tools,
    };
    const result = await this.db.collection(COLLECTION).insertOne(record);
    record._id = result.insertedId;
    return { key: fullKey, record };
  }

  async getById(user_id: string, id: string): Promise<ApiKeyRecord | null> {
    await this.init();
    let oid: ObjectId;
    try {
      oid = new ObjectId(id);
    } catch {
      return null;
    }
    return this.db.collection(COLLECTION).findOne({ _id: oid, user_id }, { projection: { key_hash: 0 } });
  }

  async getEnabledToolsByKeyId(api_key_id: string): Promise<string[] | null> {
    await this.init();
    let oid: ObjectId;
    try {
      oid = new ObjectId(api_key_id);
    } catch {
      return null;
    }
    const rec = await this.db
      .collection(COLLECTION)
      .findOne({ _id: oid, revoked_at: null }, { projection: { mcp_enabled_tools: 1 } });
    if (!rec) return null;
    // null/undefined → all tools enabled
    return Array.isArray(rec.mcp_enabled_tools) ? rec.mcp_enabled_tools : null;
  }

  async updateEnabledTools(
    user_id: string,
    id: string,
    enabled: string[] | null,
  ): Promise<boolean> {
    await this.init();
    let oid: ObjectId;
    try {
      oid = new ObjectId(id);
    } catch {
      return false;
    }
    const result = await this.db
      .collection(COLLECTION)
      .updateOne({ _id: oid, user_id }, { $set: { mcp_enabled_tools: enabled } });
    return result.matchedCount > 0;
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    await this.init();
    const rec: ApiKeyRecord | null = await this.db
      .collection(COLLECTION)
      .findOne({ prefix, revoked_at: null });
    if (!rec) return null;
    if (rec.expires_at && new Date(rec.expires_at) < new Date()) return null;
    return rec;
  }

  async verifyAgainstRecord(fullKey: string, record: ApiKeyRecord): Promise<boolean> {
    if (!fullKey || !record?.key_hash) return false;
    const bcrypt = await import('bcrypt');
    return bcrypt.compare(fullKey, record.key_hash);
  }

  async listByUser(user_id: string, tenant_id?: string | null): Promise<ApiKeyRecord[]> {
    await this.init();
    const filter: any = { user_id, revoked_at: null };
    if (tenant_id) filter.tenant_id = tenant_id;
    return this.db
      .collection(COLLECTION)
      .find(filter, { projection: { key_hash: 0 } })
      .sort({ created_at: -1 })
      .toArray();
  }

  async revoke(user_id: string, id: string): Promise<boolean> {
    await this.init();
    let oid: ObjectId;
    try {
      oid = new ObjectId(id);
    } catch {
      return false;
    }
    const result = await this.db.collection(COLLECTION).updateOne(
      { _id: oid, user_id },
      { $set: { revoked_at: new Date() } },
    );
    return result.matchedCount > 0;
  }

  async verify(fullKey: string): Promise<ApiKeyRecord | null> {
    await this.init();
    if (!fullKey || typeof fullKey !== 'string') return null;
    if (!fullKey.startsWith(`${KEY_PREFIX}_`)) return null;

    const parts = fullKey.split('_');
    if (parts.length < 3) return null;
    const prefix = parts[1];

    const candidates: ApiKeyRecord[] = await this.db
      .collection(COLLECTION)
      .find({ prefix, revoked_at: null })
      .toArray();

    for (const rec of candidates) {
      if (rec.expires_at && new Date(rec.expires_at) < new Date()) continue;
      const ok = await bcrypt.compare(fullKey, rec.key_hash);
      if (ok) {
        this.db
          .collection(COLLECTION)
          .updateOne({ _id: rec._id }, { $set: { last_used_at: new Date() } })
          .catch(() => {});
        return rec;
      }
    }
    return null;
  }
}

export const apiKeyService = new ApiKeyService();
