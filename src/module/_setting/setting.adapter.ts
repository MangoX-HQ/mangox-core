import { getCoreUnified } from '../../configs/core';
import { jsonStore } from '../../core_v2/store';
import { AppError } from '../../utils/app-error';

export const ALLOWED_TYPES = ['entity', 'action', 'resource', 'policy', 'role', 'rule', 'setting', 'form-setting', 'api-config'];

export interface SettingListOptions {
  page?: number;
  limit?: number;
  filters?: Record<string, string>; // dynamic filters from query params
  /**
   * Field projection. `*` or empty → get everything. `A,B,C` → only get the listed
   * fields (e.g. `collection_name` → just the collection_name field).
   */
  select?: string;
}

export interface SettingListResult {
  data: any[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Parse filter value operators:
 *   resource=notification           → exact match (or includes if field is array)
 *   resource=in.["a","b"]           → field value intersects with given array
 *   title=like.admin                → field contains substring (case-insensitive)
 *   title=contains."admin"          → field contains substring (case-insensitive, quoted)
 *   title=eq."admin"                → exact match (quoted)
 *   title=neq."admin"               → not equal
 *   count=gt.5                      → greater than
 *   count=gte.5                     → greater than or equal
 *   count=lt.10                     → less than
 *   count=lte.10                    → less than or equal
 *   title=isnull                    → field is null/undefined
 *   title=notnull                   → field is not null/undefined
 */
function parseValue(raw: string): any {
  // Strip surrounding quotes if present: "value" → value
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

export function matchFilter(item: any, key: string, raw: string): boolean {
  const fieldValue = item[key];

  // isnull / notnull
  if (raw === 'isnull') return fieldValue === null || fieldValue === undefined;
  if (raw === 'notnull') return fieldValue !== null && fieldValue !== undefined;

  // in.[...] operator
  if (raw.startsWith('in.')) {
    try {
      const arr = JSON.parse(raw.slice(3));
      if (Array.isArray(fieldValue)) return fieldValue.some((v: any) => arr.includes(v));
      return arr.includes(fieldValue);
    } catch {
      return false;
    }
  }

  // contains. operator (case-insensitive, value may be quoted)
  if (raw.startsWith('contains.')) {
    const search = parseValue(raw.slice(9)).toString().toLowerCase();
    if (typeof fieldValue === 'string') return fieldValue.toLowerCase().includes(search);
    if (Array.isArray(fieldValue)) return fieldValue.some((v: any) => String(v).toLowerCase().includes(search));
    return false;
  }

  // like. operator (case-insensitive contains)
  if (raw.startsWith('like.')) {
    const search = parseValue(raw.slice(5)).toString().toLowerCase();
    if (typeof fieldValue === 'string') return fieldValue.toLowerCase().includes(search);
    if (Array.isArray(fieldValue)) return fieldValue.some((v: any) => String(v).toLowerCase().includes(search));
    return false;
  }

  // eq. operator
  if (raw.startsWith('eq.')) {
    const val = parseValue(raw.slice(3));
    if (Array.isArray(fieldValue)) return fieldValue.includes(val);
    return fieldValue == val;
  }

  // neq. operator
  if (raw.startsWith('neq.')) {
    const val = parseValue(raw.slice(4));
    if (Array.isArray(fieldValue)) return !fieldValue.includes(val);
    return fieldValue != val;
  }

  // gt. / gte. / lt. / lte. operators
  if (raw.startsWith('gte.')) return Number(fieldValue) >= Number(parseValue(raw.slice(4)));
  if (raw.startsWith('gt.'))  return Number(fieldValue) >  Number(parseValue(raw.slice(3)));
  if (raw.startsWith('lte.')) return Number(fieldValue) <= Number(parseValue(raw.slice(4)));
  if (raw.startsWith('lt.'))  return Number(fieldValue) <  Number(parseValue(raw.slice(3)));

  // exact match / includes (no operator prefix)
  if (Array.isArray(fieldValue)) return fieldValue.includes(raw);
  return String(fieldValue) === raw;
}

/**
 * Detail-first JSON Setting Adapter
 *
 * Source of truth: detail files (e.g. entity/course.json, resource/user.json)
 * ALL files (entity.json, resource.json): read-only, auto-rebuilt from detail files
 *
 * Slug is the primary identifier for all lookups.
 */
export class JsonSettingAdapter {
  /** 'system' | 'team_id/tenant_slug' | null (= system) */
  private scope: string | null;

  /**
   * @param scope - composite scope 'team_id/tenant_slug' or null for system.
   *   Legacy: a plain 'tenant_slug' string is still accepted but will NOT
   *   resolve the new folder — only passed in by old callers (now deprecated).
   */
  constructor(scope: string | null = null) {
    this.scope = scope;
  }

  /**
   * Build an adapter from a tenant id OR slug. Resolves via the DB tenant to get
   * `<team_id>/<tenant_slug>` (composite scope) — the new folder layout.
   * Throws if team_id is missing (legacy tenant not yet migrated) OR the tenant does not exist.
   */
  static async forTenant(idOrSlug: string | null | undefined): Promise<JsonSettingAdapter> {
    if (!idOrSlug) return new JsonSettingAdapter(null);
    const db = await getCoreUnified().getInstanceDB('mongodb');
    const { ObjectId } = await import('mongodb');
    const isHex = /^[0-9a-f]{24}$/i.test(idOrSlug);
    const filter = isHex
      ? { $or: [{ _id: new ObjectId(idOrSlug) }, { slug: idOrSlug }] }
      : { slug: idOrSlug };
    const rec = await db
      .collection('tenant')
      .findOne(filter, { projection: { slug: 1, team_id: 1 } });
    if (!rec?.slug) {
      throw AppError.badRequest(`Cannot resolve tenant for id=${idOrSlug}`, 'TENANT_NOT_RESOLVED');
    }
    if (!rec.team_id) {
      throw AppError.badRequest(
        `Tenant '${rec.slug}' chưa có team_id — chạy migration trước khi dùng folder mới`,
        'TENANT_MISSING_TEAM',
      );
    }
    return new JsonSettingAdapter(`${String(rec.team_id)}/${rec.slug}`);
  }

  // ---------------------------------------------------------------------------
  // Detail file helpers (delegate to jsonStore) — COPY-ON-WRITE model
  // ---------------------------------------------------------------------------

  /**
   * Write target scope:
   *   tenant scope → ALWAYS the tenant folder (copy-on-write — never touches system)
   *   system scope → the system folder
   * System files can ONLY be edited via source code (edit the file directly + restart/watcher).
   */
  private writeDetail(type: string, slug: string, data: any): void {
    const scope = this.scope || 'system';
    jsonStore.write(scope, type, slug, data);
  }

  /**
   * Delete only removes the file in the current scope (a system file in tenant scope is
   * read-only — delete is NOT allowed). Returns false if the slug does not exist in that scope.
   */
  private deleteDetail(type: string, slug: string): boolean {
    const scope = this.scope || 'system';
    if (!jsonStore.exists(scope, type, slug)) {
      // The slug may be in system (tenant scope cannot see it to edit/delete)
      if (this.scope && jsonStore.exists('system', type, slug)) {
        throw AppError.forbidden(
          `Cannot delete system ${type} '${slug}' from tenant scope (system items are read-only)`,
        );
      }
      return false;
    }
    return jsonStore.delete(scope, type, slug);
  }

  // ---------------------------------------------------------------------------
  // Read ALL (for admin list view — merges system + tenant)
  // ---------------------------------------------------------------------------

  private readAll(type: string): any[] {
    const scope = this.scope || 'system';
    return jsonStore.listMerged<any>(scope, type);
  }

  // ---------------------------------------------------------------------------
  // Strip metadata fields before saving
  // ---------------------------------------------------------------------------

  private static METADATA_KEYS = new Set([
    '_id', 'created_by', 'updated_by', 'created_at', 'updated_at',
    'system', 'tenant_id', 'locale', 'blocks_position', '__v',
  ]);

  private stripMetadata(data: any): any {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(data)) {
      if (!JsonSettingAdapter.METADATA_KEYS.has(key)) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  // Convert populated relation objects back to slug strings before writing
  // e.g. { _id: "admin", slug: "admin" } → "admin"
  private static toSlug(v: any): string {
    if (typeof v === 'string') return v;
    return v?.slug || v?.collection_name || v?._id || '';
  }

  private static RELATION_FIELDS: Record<string, string[]> = {
    policy: ['root_entity', 'role', 'resource', 'action'],
    resource: ['entity', 'action'],
    setting: ['resource', 'action', 'role'],
  };

  private normalizeRelations(type: string, data: any): any {
    const fields = JsonSettingAdapter.RELATION_FIELDS[type];
    if (!fields) return data;
    const result = { ...data };
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(result, field)) continue;
      const val = result[field];
      if (Array.isArray(val)) {
        result[field] = val.map(JsonSettingAdapter.toSlug).filter(Boolean);
      } else if (val !== null && val !== undefined && typeof val === 'object') {
        result[field] = JsonSettingAdapter.toSlug(val);
      }
      // primitive (string/number) → keep as-is
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Slug resolver: find slug from item (entity uses collection_name)
  // ---------------------------------------------------------------------------

  private findSlug(item: any): string {
    return item.slug || item.collection_name || '';
  }

  private findBySlug(items: any[], slug: string): any | undefined {
    return items.find((item) => this.findSlug(item) === slug);
  }

  // ---------------------------------------------------------------------------
  // CRUD operations (write to detail, then rebuild ALL)
  // ---------------------------------------------------------------------------

  private populateRelations(type: string, items: any[]): any[] {
    if (type !== 'policy') return items;

    const entities: any[] = this.readAll('entity');
    const entityByCollection: Record<string, any> = {};
    for (const e of entities) {
      const key = e.collection_name;
      if (key) entityByCollection[key] = { _id: key, title: e.title, slug: key, collection_name: e.collection_name || key };
    }

    return items.map((item) => {
      const populated = { ...item };

      if (Array.isArray(item.root_entity)) {
        populated.root_entity = item.root_entity.map((v: any) => {
          if (typeof v !== 'string') return v;
          return entityByCollection[v] || { _id: v, title: v, slug: v, collection_name: v };
        });
      }

      if (Array.isArray(item.role)) {
        populated.role = item.role.map((v: any) => {
          if (typeof v !== 'string') return v;
          return { _id: v, title: v, slug: v };
        });
      }

      return populated;
    });
  }

  list(type: string, options: SettingListOptions = {}): SettingListResult {
    let items = this.readAll(type);

    // Apply dynamic filters
    if (options.filters) {
      for (const [key, raw] of Object.entries(options.filters)) {
        items = items.filter((item) => matchFilter(item, key, raw));
      }
    }

    // Pagination
    const total = items.length;
    const page = Math.max(1, options.page || 1);
    const limit = Math.max(1, Math.min(100, options.limit || 10));
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const sliced = items.slice(offset, offset + limit).map((item) => {
      // Ensure every item has _id so frontend can use it for delete/edit
      const base = !item._id
        ? { ...item, _id: item.slug || item.collection_name || '' }
        : item;
      return base;
    });
    let data = this.populateRelations(type, sliced);

    // Field projection: select=*/empty → everything; select=A,B,C → only those fields
    const select = (options.select || '').trim();
    if (select && select !== '*') {
      const fields = select.split(',').map((f) => f.trim()).filter(Boolean);
      if (fields.length > 0) {
        data = data.map((item: any) => {
          const projected: Record<string, any> = {};
          for (const f of fields) {
            if (Object.prototype.hasOwnProperty.call(item, f)) projected[f] = item[f];
          }
          return projected;
        });
      }
    }

    return { data, pagination: { page, limit, total, totalPages } };
  }

  getBySlug(type: string, slug: string): any | null {
    const items = this.readAll(type);
    const found = this.findBySlug(items, slug) || null;
    if (!found) return null;
    return this.populateRelations(type, [found])[0];
  }

  async create(type: string, data: any, opts?: { gen?: boolean }): Promise<any | null> {
    const items = this.readAll(type);
    // Entities are identified by collection_name (not slug/title) — the filename
    // must equal collection_name, otherwise PUT/lookup will create duplicate files. Other
    // types use slug instead, falling back to title.
    let slug = type === 'entity'
      ? data.collection_name
      : (data.slug || data.title?.toLowerCase().replace(/\s+/g, '-'));
    if (!slug) return null;

    // Auto-generate unique slug if duplicate
    if (items.some((item) => this.findSlug(item) === slug)) {
      return null
    }

    const cleaned = this.normalizeRelations(type, this.stripMetadata(data));
    // Entities use collection_name as their identifier — don't stuff a `slug` field in.
    if (type !== 'entity') cleaned.slug = slug;

    if (type === 'entity' && opts?.gen) this.applyEntityDefaults(cleaned);

    this.writeDetail(type, slug, cleaned);
    if (type === 'entity') {
      if (cleaned.permissions) this.generateFromPermissions(cleaned);
      else if (opts?.gen) this.generateDefaultScaffold(cleaned);
    }
    return cleaned;
  }

  async replace(type: string, slug: string, data: any): Promise<any | null> {
    const items = this.readAll(type);
    const existing = this.findBySlug(items, slug);
    if (!existing) return null;

    const cleaned = this.normalizeRelations(type, this.stripMetadata(data));
    const oldSlug = this.findSlug(existing);
    const newSlug = this.findSlug(cleaned) || oldSlug;

    // If slug changed, remove old detail file
    if (oldSlug && oldSlug !== newSlug) {
      this.deleteDetail(type, oldSlug);
    }

    this.writeDetail(type, newSlug, cleaned);
    if (type === 'entity' && cleaned.permissions) this.generateFromPermissions(cleaned);
    return cleaned;
  }

  async patch(type: string, slug: string, partial: any): Promise<any | null> {
    const items = this.readAll(type);
    const existing = this.findBySlug(items, slug);
    if (!existing) return null;

    const cleanedPartial = this.normalizeRelations(type, this.stripMetadata(partial));
    const merged = { ...existing, ...cleanedPartial };
    const detailSlug = this.findSlug(existing);

    this.writeDetail(type, detailSlug, merged);
    if (type === 'entity' && merged.permissions) this.generateFromPermissions(merged);
    return merged;
  }

  async delete(type: string, slug: string): Promise<boolean> {
    const items = this.readAll(type);
    const existing = this.findBySlug(items, slug);
    if (!existing) return false;

    const detailSlug = this.findSlug(existing);
    this.deleteDetail(type, detailSlug);
    return true;
  }

  async deleteMany(type: string, slugs: string[]): Promise<any[]> {
    const items = this.readAll(type);
    const deleted: any[] = [];

    for (const item of items) {
      const itemSlug = this.findSlug(item);
      if (slugs.includes(itemSlug)) {
        this.deleteDetail(type, itemSlug);
        deleted.push(item);
      }
    }
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Auto-generate resource + policies from entity.permissions
  // ---------------------------------------------------------------------------

  generateFromPermissions(entityData: any): void {
    const permissions = entityData.permissions;
    if (!permissions || typeof permissions !== 'object') return;

    const collectionName = entityData.collection_name;
    if (!collectionName) return;

    const roles = Object.keys(permissions);
    if (roles.length === 0) return;

    // Union of all actions across all roles
    const allActions = Array.from(
      new Set(roles.flatMap((role) => permissions[role]?.actions || []))
    );

    // Upsert resource
    const existingResources = this.readAll('resource');
    const existingResource = this.findBySlug(existingResources, collectionName);

    const resourceData: any = {
      title: entityData.title || collectionName,
      slug: collectionName,
      entity: [collectionName],
      action: allActions,
    };

    if (existingResource) {
      this.writeDetail('resource', collectionName, { ...existingResource, ...resourceData });
    } else {
      this.writeDetail('resource', collectionName, resourceData);
    }

    // Upsert 1 policy per role
    const existingPolicies = this.readAll('policy');

    for (const role of roles) {
      const rolePerms = permissions[role];
      if (!rolePerms) continue;

      const roleActions: string[] = rolePerms.actions || [];

      // Support both legacy `select` array and new rich `condition` string
      let condition: string = rolePerms.condition || '';
      if (!condition && Array.isArray(rolePerms.select) && rolePerms.select.length > 0) {
        condition = `select=${rolePerms.select.join(',')}`;
      }

      const policySlug = `${collectionName}-${role}`;

      const policyData: any = {
        title: `${collectionName} - ${role}`,
        slug: policySlug,
        type: 'local',
        root_entity: [collectionName],
        resource: [collectionName],
        role: [role],
        action: roleActions,
        condition,
        condtion_body: rolePerms.condtion_body || '',
        data: rolePerms.data || [],
      };

      const existingPolicy = this.findBySlug(existingPolicies, policySlug);
      if (existingPolicy) {
        this.writeDetail('policy', policySlug, { ...existingPolicy, ...policyData });
      } else {
        this.writeDetail('policy', policySlug, policyData);
      }
    }

    console.log(`[AutoGen] ✓ Generated resource + ${roles.length} policies for entity: ${collectionName}`);
  }

  // ---------------------------------------------------------------------------
  // Default scaffolding when entity created without explicit `permissions`
  // ---------------------------------------------------------------------------

  private applyEntityDefaults(entityData: any): void {
    if (entityData.use_slug === undefined) entityData.use_slug = true;
    if (entityData.use_seo_path === undefined) entityData.use_seo_path = true;
  }

  // widgets treated as level-1 relations (file = media reference)
  private static RELATION_WIDGETS = new Set(['relation', 'file']);

  // Scan entity json_schema for level-1 relation fields → ['category()', 'featured_image()']
  private collectRelationSelects(entityData: any): string[] {
    const props = entityData?.json_schema?.properties;
    if (!props || typeof props !== 'object') return [];
    return Object.entries(props)
      .filter(([, field]: [string, any]) =>
        JsonSettingAdapter.RELATION_WIDGETS.has(field?.widget),
      )
      .map(([key]) => `${key}()`);
  }

  private generateDefaultScaffold(entityData: any): void {
    const collectionName = entityData.collection_name;
    if (!collectionName) return;

    const ADMIN_ACTIONS = ['list', 'read', 'create', 'update', 'delete'];
    const GUEST_ACTIONS = ['list-public', 'read-public'];

    // Auto-pull every level-1 relation as full populate, e.g. category()
    const relSelects = this.collectRelationSelects(entityData);
    const adminCondition = [
      'select=*',
      'created_by(username,full_name)',
      'updated_by(username,full_name)',
      ...relSelects,
    ].join(',');
    const guestCondition = ['select=*', ...relSelects].join(',');

    // 1. Resource
    const existingResources = this.readAll('resource');
    if (!this.findBySlug(existingResources, collectionName)) {
      const resourceData = {
        title: entityData.title || collectionName,
        slug: collectionName,
        entity: [collectionName],
        is_tenant: true,
        action: [...ADMIN_ACTIONS, ...GUEST_ACTIONS],
      };
      this.writeDetail('resource', collectionName, resourceData);
    }

    // 2. Admin policy
    const existingPolicies = this.readAll('policy');
    const adminSlug = `policy-${collectionName}-admin`;
    if (!this.findBySlug(existingPolicies, adminSlug)) {
      const adminPolicy: any = {
        title: `policy ${collectionName} admin`,
        slug: adminSlug,
        resource: [collectionName],
        action: ADMIN_ACTIONS,
        role: ['admin'],
        root_entity: [collectionName],
        condition: adminCondition,
        data: [],
        condition_context: null,
        condtion_body: '',
        code_context: '',
        code: '',
        piority: '0',
      };
      this.writeDetail('policy', adminSlug, adminPolicy);
    }

    // 3. Guest policy
    const guestSlug = `policy-${collectionName}-guest`;
    if (!this.findBySlug(existingPolicies, guestSlug)) {
      const guestPolicy: any = {
        title: `policy ${collectionName} guest`,
        slug: guestSlug,
        resource: [collectionName],
        action: GUEST_ACTIONS,
        role: ['guest'],
        root_entity: [collectionName],
        condition: guestCondition,
        data: [],
        condition_context: null,
        condtion_body: '',
        code_context: '',
        code: '',
        piority: '0',
      };
      this.writeDetail('policy', guestSlug, guestPolicy);
    }

    console.log(`[AutoGen] ✓ Scaffolded resource + admin + guest policies for entity: ${collectionName}`);
  }

}
