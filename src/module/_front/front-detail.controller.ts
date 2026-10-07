import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getCoreUnified, withTenant } from "../../configs/core";
import { OptionsInput, schemaManager } from "../../core_v2/compat";
import { runWithTenantSlug } from "../../core_v2/adapters/mongodb/tenant-context";
import { TENANT_SLUG } from "../../configs/tenant";
import { AppError } from "../../utils/app-error";
import { createMetadata } from "./helper/createMetadata";

const GUEST_ROLE = "guest";
const SENSITIVE_FIELDS = new Set([
  "password",
  "role",
  "role_name",
  "email",
  "role_system",
  "status",
  "updated_by",
  "history",
  "reason",
  "rule",
  "language",
  "json_schema",
  "ui_schema",
]);

function sanitize(data: any): any {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(sanitize);
  if (typeof data !== "object") return data;
  if ((data as any).constructor !== Object) return data;
  const out: any = {};
  for (const [key, value] of Object.entries(data)) {
    const last = key.split(".").pop()?.toLowerCase() || key.toLowerCase();
    if (SENSITIVE_FIELDS.has(last)) continue;
    out[key] = sanitize(value);
  }
  return out;
}

async function withSlugContext<T>(
  request: FastifyRequest,
  fn: () => Promise<T>,
): Promise<T> {
  const headerTenantId = (request.headers["x-tenant-id"] as string) || undefined;
  if (!headerTenantId) return fn();
  const slug = TENANT_SLUG || headerTenantId;
  return runWithTenantSlug(slug, headerTenantId, fn);
}

async function getEntityDatabaseType(
  collectionName: string,
  tenantId?: string,
): Promise<string> {
  const tenantSlug = TENANT_SLUG || null;
  let entity: any = tenantSlug
    ? await schemaManager.getEntityForTenant(collectionName, tenantSlug)
    : null;
  if (!entity) entity = await schemaManager.getEntity(collectionName);
  return entity?.databaseType || "mongodb";
}

async function baseOptions(
  request: FastifyRequest,
  tenant_id: string,
  collectionName: string,
): Promise<OptionsInput> {
  const locale = (request.query as any)?.locale;
  return {
    databaseType: (await getEntityDatabaseType(collectionName, tenant_id)) as any,
    is_tenant: true,
    frontAPI: true,
    log: request.log,
    tenant_id,
    roles: [GUEST_ROLE],
    // ?locale= → core injects a $match {locale} into the $lookup of the use_locale relation (query-level).
    ...(locale != null ? { localeFilter: String(locale) } : {}),
  } as OptionsInput;
}

function entitySlugs(entity: any): string[] {
  const slugs = new Set<string>();
  if (entity?.collection_name) slugs.add(entity.collection_name);
  if (entity?.mongodb_collection_name) slugs.add(entity.mongodb_collection_name);
  if (Array.isArray(entity?.languages)) {
    for (const language of entity.languages) {
      if (language?.slug) slugs.add(language.slug);
    }
  }
  return Array.from(slugs);
}

/**
 * Relations pointing to a META-collection (entity / collection name definitions) rather than
 * actual record data: `entity` (meta-collection defining the entity) and
 * `mongodb_collection_name` (e.g. the post_type field links a post-type by collection NAME).
 * Embedding these fields is meaningless — there's nothing to populate, it adds query overhead, and
 * it overwrites the original value with an empty [] (e.g. post_type loses ["hoi-vien"]).
 */
const META_RELATION_TARGETS = new Set(["entity", "mongodb_collection_name"]);
function isEntityRelation(def: any): boolean {
  if (def?.widget !== "relation") return false;
  const tr = def?.typeRelation;
  return META_RELATION_TARGETS.has(tr?._id) || META_RELATION_TARGETS.has(tr?.title);
}

/** Names of fields with a relation/file/multipleFiles widget (excluding relation → entity). */
function getRelationFields(props: Record<string, any>): string[] {
  return Object.entries<any>(props)
    .filter(([, def]) => def && typeof def === "object" &&
      ((def.widget === "relation" && !isEntityRelation(def)) ||
        def.widget === "file" || def.widget === "multipleFiles"))
    .map(([k]) => k);
}

/**
 * Build an embed token for a relation/file field, with 2-LEVEL POPULATE: if it's a relation and
 * the target entity has further child relation/file fields, nest `name(rel_con(),...)`, otherwise `name()`.
 * `embedName` = top-level field name OR `<parent>_<child>` for fields inside a nested object.
 */
function buildRelationEmbed(
  embedName: string,
  def: any,
  allEntities: Record<string, any>,
): string {
  if (def.widget === "relation") {
    const targetName = def?.typeRelation?._id || def?.typeRelation?.title || def?.typeRelation?.collection_name;
    const nestedProps = targetName ? allEntities[targetName]?.json_schema?.properties : null;
    if (nestedProps) {
      const nestedRels = getRelationFields(nestedProps);
      if (nestedRels.length > 0) {
        return `${embedName}(${nestedRels.map((r) => `${r}()`).join(",")})`;
      }
    }
  }
  return `${embedName}()`;
}

/**
 * Build the select populate relation/file from json_schema (TAKEN FROM the entity object cached
 * in schemaManager — doesn't re-parse the json). Prefers the client's ?select when present.
 *
 * 2-LEVEL populate: for each relation field, if the target entity (looked up via typeRelation._id =
 * collection_name — the key of getAllEntities) itself has a relation/file, nest further as
 * `field(rel_con(),...)`; otherwise just `field()`. File/multipleFiles is always 1 level.
 */
async function buildDetailSelect(jsonSchema: any, clientSelect?: string): Promise<string> {
  if (clientSelect) return clientSelect;
  const props = jsonSchema?.properties;
  if (!props || typeof props !== "object") return "*";

  // getAllEntities() is tenant-aware via ALS — includes both system and the current tenant's entities.
  const allEntities = await schemaManager.getAllEntities();

  const parts: string[] = [];
  for (const [fieldName, def] of Object.entries<any>(props)) {
    if (!def || typeof def !== "object") continue;

    // TOP-LEVEL relation/file → 2-level embed. Excluding relation → entity.
    if (def.widget === "relation" || def.widget === "file" || def.widget === "multipleFiles") {
      if (isEntityRelation(def)) continue;
      parts.push(buildRelationEmbed(fieldName, def, allEntities));
      continue;
    }

    // NESTED object (e.g. `section`) containing a child relation/file field: the loader registers the relation
    // named `<parent>_<child>` (path joined with '_'). The embed with the same name populates CORRECTLY into
    // section.<child>, and still gets 2 levels (e.g. section_domain(tag_group())) thanks to buildRelationEmbed.
    if (def.type === "object" && def.properties && typeof def.properties === "object") {
      const childProps = def.properties;
      for (const child of getRelationFields(childProps)) {
        parts.push(buildRelationEmbed(`${fieldName}_${child}`, childProps[child], allEntities));
      }
    }
  }

  return parts.length ? `*,${parts.join(",")}` : "*";
}

async function findEntityBySeopath(seopath: any): Promise<any | null> {
  const rawEntitySlug = Array.isArray(seopath?.entity_slug)
    ? seopath.entity_slug
    : [seopath?.entity_slug];
  const wanted = new Set(rawEntitySlug.filter(Boolean));
  if (wanted.size > 0) {
    const entities = await schemaManager.getAllEntities();
    const bySlug = Object.values(entities).find((entity: any) =>
      entitySlugs(entity).some((slug) => wanted.has(slug)),
    );
    if (bySlug) return bySlug;
  }

  return seopath?.entity_save_data
    ? await schemaManager.getEntity(seopath.entity_save_data)
    : null;
}

async function findPostTypeEntity(postTypeCollectionName: string): Promise<any | null> {
  const entities = await schemaManager.getAllEntities();
  return Object.values(entities).find((entity: any) => {
    if (!entity?.use_posttype) return false;
    const languageSlugs = Array.isArray(entity.languages)
      ? entity.languages.map((lang: any) => lang?.slug).filter(Boolean)
      : [];
    return (
      languageSlugs.includes(postTypeCollectionName) ||
      entity.mongodb_collection_name === postTypeCollectionName ||
      entity.collection_name === postTypeCollectionName
    );
  }) ?? null;
}

/** Safely decode a single segment (skip if percent-encoding is invalid). */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Split the part after `/front/detail/*` into a segment array: convert every `%2f` → `/` then
 * split on `/` (decoded, empty segments removed). Whether the client sends `A/B/C` or `A%2FB%2FC`,
 * both produce the same array `["A","B","C"]`.
 */
function parseDetailPath(rest: string | undefined): string[] {
  return String(rest || "")
    .replace(/%2f/gi, "/")
    .split("/")
    .map(safeDecode)
    .filter(Boolean);
}

class FrontDetailController {
  /**
   * A single route `/front/detail/*`. Splits the path (`%2f`→`/`) into a segment array
   * then routes:
   *  - 1 segment → ALWAYS one-layer.
   *  - >1 segment: if the first element is a post-type (use_posttype) → two-layer (postType =
   *    first element, SEOPathSlug = the rest); otherwise joins 'A/B/C' → one-layer.
   * Runs inside withSlugContext so findPostTypeEntity reads the correct tenant schema.
   */
  async detail(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._detail(request, reply));
  }

  private async _detail(request: FastifyRequest, reply: FastifyReply) {
    const segments = parseDetailPath((request.params as any)?.["*"]);
    if (segments.length === 0) {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Content not found" });
    }
    // 1 segment → always one-layer.
    if (segments.length === 1) {
      (request.params as any).slug = segments[0];
      return this._detailOneLayer(request, reply);
    }
    // >1 segment: is the first element a post-type? → two-layer; otherwise join back together → one-layer.
    const [first, ...rest] = segments;
    if (await findPostTypeEntity(first)) {
      (request.params as any).postTypeCollectionName = first;
      (request.params as any).SEOPathSlug = rest.join("/");
      return this._detailTwoLayer(request, reply);
    }
    (request.params as any).slug = segments.join("/");
    return this._detailOneLayer(request, reply);
  }

  async detailOneLayer(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._detailOneLayer(request, reply));
  }

  private async _detailOneLayer(request: FastifyRequest, reply: FastifyReply) {
    const { slug } = request.params as { slug: string };
    const tenant_id = (request.headers["x-tenant-id"] as string) || undefined;
    if (!tenant_id) throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Error tenant" });
    (request as any).tenantId = tenant_id;
    request.headers["x-tenant-id"] = undefined;

    const query = (request.query as any) || {};
    const options = await baseOptions(request, tenant_id, "seopath");
    const core = getCoreUnified().getCore();

    query.slug = `eq.${slug}`;
    query.tenant_id = `eq.${tenant_id}`;
    
    return withTenant(tenant_id, async () => {
      try {

        const seopath = await core.findAll(
          query,
          "seopath",
          ["admin"],
          options,
        );
        if (!seopath || seopath.data.length === 0) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Content not found" });
        }

        const entitySaveData = seopath.data[0]?.entity_save_data;
        if (!entitySaveData) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Content not found" });
        }
        const detailEntity = await findEntityBySeopath(seopath.data[0]);
        if (detailEntity?.use_posttype) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "This is not one layer detail" });
        }

        const relatedId = seopath.data[0]?.related_id?.[0];
        if (!relatedId) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Content not found" });
        }

        // entity_save_data is the real collection to query (page/category/...) —
        // not the entity that owns the slug.
        const detailCollection = entitySaveData;
        const dataOptions = await baseOptions(request, tenant_id, detailCollection);
        const data = await core.findById(
          detailCollection,
          {
            select: await buildDetailSelect(
              detailEntity?.json_schema,
              (request.query as any)?.select,
            ),
          },
          relatedId,
          ["admin"],
          dataOptions,
        );
        if (!data?.data?.length) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Content not found" });
        }
        let dataWithLocale: any = { data: [] };
        if (data.data[0].locale_id) {
          dataWithLocale = await core.findAll(
            { locale_id: `eq.${data.data[0].locale_id}` },
            "seopath",
            ["admin"],
            options,
          );
        }
        data.data[0].meta_data = createMetadata(
          seopath.data[0],
          undefined,
          dataWithLocale.data,
        );
        data.data = sanitize(data.data);
        return data;
      } catch (error: any) {
        throw error;
      }
    });
  }

  async detailTwoLayer(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._detailTwoLayer(request, reply));
  }

  private async _detailTwoLayer(request: FastifyRequest, reply: FastifyReply) {
    const { postTypeCollectionName, SEOPathSlug } = request.params as {
      postTypeCollectionName: string;
      SEOPathSlug: string;
    };
    const tenant_id = (request.headers["x-tenant-id"] as string) || undefined;
    if (!tenant_id) throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Error tenant" });
    (request as any).tenantId = tenant_id;
    request.headers["x-tenant-id"] = undefined;

    const query = (request.query as any) || {};
    const options = await baseOptions(request, tenant_id, "seopath");
    const core = getCoreUnified().getCore();

    const postTypeMeta = await findPostTypeEntity(postTypeCollectionName);
    if (!postTypeMeta) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Post type not found" });
    }

    const postTypeCollection =
      postTypeMeta.collection_name ||
      postTypeMeta.mongodb_collection_name ||
      postTypeCollectionName;

    return withTenant(tenant_id, async () => {
      try {
        const seopathQuery = { slug: `eq.${SEOPathSlug}`, entity_slug: `eq.${postTypeCollectionName}` };
        const seopath = await core.findAll(
          seopathQuery,
          "seopath",
          ["admin"],
          options,
        );
        if (!seopath || seopath.data.length === 0) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Content not found" });
        }

        const entitySaveData = seopath.data[0]?.entity_save_data;
        if (!entitySaveData) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Content not found" });
        }
        const entity = await findEntityBySeopath(seopath.data[0]);
        if (!entity?.use_posttype) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "This is not two layer detail" });
        }

        const relatedId = seopath.data[0]?.related_id?.[0];
        if (!relatedId) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Content not found" });
        }

        const filter: any = {
          _id: `eq.${relatedId}`,
          select: await buildDetailSelect(
            entitySaveData === "category" ? entity?.json_schema : postTypeMeta?.json_schema,
            query.select,
          ),
        };
        if (
          entitySaveData === "post-type-content" ||
          entitySaveData === "category"
        ) {
          filter["post_type"] = postTypeCollection;
        }

        // Query by LOGICAL collection name (e.g. 'linh-vuc') when the entity is polymorphic
        // (mongodb_save_data = post-type-content) — because relationships are registered by LOGICAL
        // name; core-service routes it to the physical one automatically. If queried using 'post-type-content'
        // then getByName('post-type-content', rel) = null → embed is dropped → relation is NOT
        // populated. For standalone entities (category…), entitySaveData IS the real collection.
        const isPolymorphic = postTypeMeta?.mongodb_save_data === entitySaveData;
        const detailCollection = isPolymorphic ? postTypeCollection : entitySaveData;
        const entityOptions = {
          ...(await baseOptions(request, tenant_id, detailCollection)),
          postTypeCollectionName: postTypeCollection,
        } as OptionsInput;
        const detailQuery = { ...query, ...filter };
        const result = await core.findAll(
          detailQuery,
          detailCollection,
          ["admin"],
          entityOptions,
        );
        if (!result?.data?.length) {
          throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Content not found" });
        }
        let dataWithLocale: any = { data: [] };
        if (result.data[0].locale_id) {
          dataWithLocale = await core.findAll(
            { locale_id: `eq.${result.data[0].locale_id}` },
            "seopath",
            ["admin"],
            options,
          );
        }
        result.data[0].meta_data = createMetadata(
          seopath.data[0],
          entity,
          dataWithLocale.data,
        );
        result.data = sanitize(result.data);
        return result;
      } catch (error: any) {
        throw error;
      }
    });
  }
}

export async function FrontDetailRoutes(app: FastifyInstance) {
  const controller = new FrontDetailController();
  // A single route: captures the entire path after /front/detail/ (including multiple '/' or
  // '%2f'), controller.detail splits and routes one-layer / two-layer itself.
  app.get("/front/detail/*", controller.detail.bind(controller));
}
