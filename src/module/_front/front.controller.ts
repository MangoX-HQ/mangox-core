import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getCoreUnified } from "../../configs/core";
import { commonService } from "../common_v2/common.service";
import { OptionsInput } from "../../core_v2/compat";
import { modeHandler } from "../../middleware/mode-handler";
import { AppError } from "../../utils/app-error";
import { loadAction } from "../common_v2/utils/params";
import { schemaManager } from "../../core_v2/schema/manager";
import { runWithTenantSlug } from "../../core_v2/adapters/mongodb/tenant-context";
import { TENANT_SLUG } from "../../configs/tenant";
import pathfile from "path";
import fs from "fs";
const GUEST_ROLE = "guest";

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

function stripFrontPrefix(rawPath: string): string {
  const p = rawPath.startsWith("/") ? rawPath : "/" + rawPath;
  if (p === "/front" || p === "/front/") return "/";
  if (p.startsWith("/front/")) return p.slice(6);
  return p;
}

function ensureTenant(request: FastifyRequest, reply: FastifyReply, is_tenant: boolean) {
  if (is_tenant && !request.headers["x-tenant-id"]) {
    reply.statusCode = 400;
    return { statusCode: 400, msg: "Error tenant" };
  }
  (request as any).tenantId = request.headers["x-tenant-id"];
  request.headers["x-tenant-id"] = undefined;
  return null;
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

function firstEntitySlug(entitySlug: any): string {
  return Array.isArray(entitySlug) ? entitySlug[0] : entitySlug;
}

async function buildFrontMetaData(seopath: any): Promise<Record<string, any> | null> {
  if (!seopath) return null;
  const entity = await findEntityBySeopath(seopath);
  const entitySlug = firstEntitySlug(seopath.entity_slug);
  const hasParentSlug = !!entity?.use_posttype && !!entitySlug;
  const slug = hasParentSlug ? `${entitySlug}/${seopath.slug}` : seopath.slug;
  const redirectTo = seopath.redirect_url
    ? (hasParentSlug ? `${entitySlug}/${seopath.redirect_url}` : seopath.redirect_url)
    : null;

  return {
    slug,
    entity_slug: entitySlug,
    entity: entity?.collection_name || seopath.entity_save_data,
    entity_field: entitySlug,
    type: seopath.redirect_url ? "redirect" : "direct",
    redirect_to: redirectTo,
  };
}

async function attachFrontMetaData(result: any, options: OptionsInput): Promise<void> {
  if (!Array.isArray(result?.data) || result.data.length === 0) return;

  const ids = result.data
    .map((item: any) => item?._id?.toString?.() ?? item?._id)
    .filter(Boolean);
  if (ids.length === 0) return;

  const uniqueIds = Array.from(new Set(ids));
  const seopathResult = await getCoreUnified().getCore().findAll(
    {
      related_id: `in.[${uniqueIds.join(",")}]`,
      select: "*",
    },
    "seopath",
    ["admin"],
    options,
  );
  const seopathMap = new Map(
    (seopathResult.data ?? []).map((sp: any) => [
      Array.isArray(sp.related_id) ? sp.related_id[0] : null,
      sp,
    ]),
  );

  for (const item of result.data) {
    const id = item?._id?.toString?.() ?? item?._id;
    const metaData = await buildFrontMetaData(seopathMap.get(id));
    if (metaData) item.meta_data = metaData;
  }
}

class FrontController {
  async getResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._getResource(request, reply));
  }

  async _getResource(request: FastifyRequest, reply: FastifyReply) {
    const queryData = request.query as any;
    const path = stripFrontPrefix("/" + ((request.params as any)["*"] || ""));
    const { action: preContext, resource, is_tenant, params } = await loadAction(
      path,
      "GET",
      { onlyPublic: true },
    );
    Object.assign(queryData, params);
    if (!resource || !preContext) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Resource not found" });
    }
    const roles: string[] = [GUEST_ROLE];
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const options: OptionsInput = {
      databaseType: (await getEntityDatabaseType(
        resource,
        is_tenant ? tenantHeader : undefined,
      )) as any,
      is_tenant,
      frontAPI: true,
      path: path.split("/"),
      log: request.log,
      tree: queryData.tree ?? undefined,
      tenant_id: is_tenant ? tenantHeader : undefined,
      history: queryData.history ?? undefined,
      headers: request.headers as Record<string, string>,
      roles,
    };
    const tenantErr = ensureTenant(request, reply, is_tenant);
    if (tenantErr) return tenantErr;

    delete queryData.tree;
    delete queryData.history;
    const result = await commonService.getQuery(
      resource,
      preContext,
      queryData,
      roles,
      params,
      options,
    );
    await attachFrontMetaData(result, options);
    if (result?.statusCode) reply.statusCode = result.statusCode;
    return result;
  }

  async postResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._postResource(request, reply));
  }

  async _postResource(request: FastifyRequest, reply: FastifyReply) {
    const path = stripFrontPrefix("/" + ((request.params as any)["*"] || ""));
    const { action: preContext, resource, is_tenant, params } = await loadAction(
      path,
      "POST",
      { onlyPublic: true },
    );
    if (!resource || !preContext) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Resource not found" });
    }
    const body: any = request.body;
    const roles: string[] = [GUEST_ROLE];
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const options: OptionsInput = {
      databaseType: (await getEntityDatabaseType(
        resource,
        is_tenant ? tenantHeader : undefined,
      )) as any,
      is_tenant,
      frontAPI: true,
      path: path.split("/"),
      log: request.log,
      tenant_id: is_tenant ? tenantHeader : undefined,
      action: "POST",
      body,
      roles,
    };
    const tenantErr = ensureTenant(request, reply, is_tenant);
    if (tenantErr) return tenantErr;

    const newBody = { ...body, tenant_id: options.tenant_id };
    const result = await commonService.postQuery(
      resource,
      preContext,
      newBody,
      roles,
      options,
    );
    if (result?.statusCode) reply.statusCode = result.statusCode;
    return result;
  }

  async patchResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._patchResource(request, reply));
  }

  async _patchResource(request: FastifyRequest, reply: FastifyReply) {
    const path = stripFrontPrefix("/" + ((request.params as any)["*"] || ""));
    const { action: preContext, resource, is_tenant, params } = await loadAction(
      path,
      "PATCH",
      { onlyPublic: true },
    );
    if (!resource || !preContext) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Resource not found" });
    }
    const queryData: Record<string, any> = request.query as Record<string, any>;
    const body: any = request.body;
    await modeHandler.getWithModeHandler(request, "PUT");
    const roles: string[] = [GUEST_ROLE];
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const options: OptionsInput = {
      databaseType: (await getEntityDatabaseType(
        resource,
        is_tenant ? tenantHeader : undefined,
      )) as any,
      is_tenant,
      frontAPI: true,
      path: path.split("/"),
      log: request.log,
      tenant_id: is_tenant ? tenantHeader : undefined,
      tree: queryData.tree ?? undefined,
      partial: true,
      body,
      roles,
    };
    const tenantErr = ensureTenant(request, reply, is_tenant);
    if (tenantErr) return tenantErr;

    delete queryData.tree;
    body.tenant_id = options.tenant_id;
    const result = await commonService.patchQuery(
      resource,
      preContext,
      params,
      body,
      roles,
      options,
    );
    if (result?.statusCode) reply.statusCode = result.statusCode;
    return result;
  }

  async putResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._putResource(request, reply));
  }

  async _putResource(request: FastifyRequest, reply: FastifyReply) {
    const path = stripFrontPrefix("/" + ((request.params as any)["*"] || ""));
    const { action: preContext, resource, is_tenant, params } = await loadAction(
      path,
      "PUT",
      { onlyPublic: true },
    );
    if (!resource || !preContext) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Resource not found" });
    }
    const queryData: Record<string, any> = request.query as Record<string, any>;
    const body: any = request.body;
    await modeHandler.getWithModeHandler(request, "PUT");
    const roles: string[] = [GUEST_ROLE];
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const options: OptionsInput = {
      databaseType: (await getEntityDatabaseType(
        resource,
        is_tenant ? tenantHeader : undefined,
      )) as any,
      is_tenant,
      frontAPI: true,
      path: path.split("/"),
      log: request.log,
      tenant_id: is_tenant ? tenantHeader : undefined,
      tree: queryData.tree ?? undefined,
      partial: true,
      body,
      roles,
    };
    const tenantErr = ensureTenant(request, reply, is_tenant);
    if (tenantErr) return tenantErr;

    delete queryData.tree;
    body.tenant_id = options.tenant_id;
    const result = await commonService.putQuery(
      resource,
      preContext,
      params,
      body,
      roles,
      options,
    );
    if (result?.statusCode) reply.statusCode = result.statusCode;
    return result;
  }

  async deleteResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._deleteResource(request, reply));
  }

  async _deleteResource(request: FastifyRequest, reply: FastifyReply) {
    const path = stripFrontPrefix("/" + ((request.params as any)["*"] || ""));
    const { action: preContext, resource, is_tenant, params } = await loadAction(
      path,
      "DELETE",
      { onlyPublic: true },
    );
    if (!resource || !preContext) {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Resource not found" });
    }
    const queryData: Record<string, any> = request.query as Record<string, any>;
    if (queryData["ids"] && typeof queryData["ids"] === "string") {
      const ids = queryData["ids"] as string;
      queryData["id"] = `in.[${ids.split(",").join(",")}]`;
      delete queryData["ids"];
    }
    const roles: string[] = [GUEST_ROLE];
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const options: OptionsInput = {
      databaseType: (await getEntityDatabaseType(
        resource,
        is_tenant ? tenantHeader : undefined,
      )) as any,
      is_tenant,
      frontAPI: true,
      log: request.log,
      tenant_id: is_tenant ? tenantHeader : undefined,
      action: "DELETE",
      roles,
    };
    const tenantErr = ensureTenant(request, reply, is_tenant);
    if (tenantErr) return tenantErr;

    const result = await commonService.deleteQuery(
      resource,
      preContext,
      Object.entries(params).length > 0 ? params : queryData,
      roles,
      options,
    );
    if (result?.statusCode) reply.statusCode = result.statusCode;
    return result;
  }
}

export async function FrontRoutesV2(app: FastifyInstance) {
  const controller = new FrontController();

  app.put("/front/*", controller.putResource.bind(controller));
  app.get("/front/*", controller.getResource.bind(controller));
  app.post("/front/*", controller.postResource.bind(controller));
  app.patch("/front/*", controller.patchResource.bind(controller));
  app.delete("/front/*", controller.deleteResource.bind(controller));
}
