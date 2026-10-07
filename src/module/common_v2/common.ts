import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { commonService } from "./common.service";
import {
  OptionsInput,
} from "../../core_v2/compat";
import { jwtGuard } from "../..";
import { modeHandler } from "../../middleware/mode-handler";


import { AppError } from "../../utils/app-error";

/**
 * Check if user has access to custom action based on policy
 * Returns error response if not allowed, null if allowed
 */

import { appSettings } from "../../configs/app-settings";

import * as fs from "fs";
import { loadAction } from "./utils/params";
import { schemaManager } from "../../core_v2/schema/manager";
import { dbgStep, dbgGroup, dbgEnd } from "../../core_v2/debug/debug-logger";

/**
 * Build roles[] for builderQuery. is_super_admin=true → adds 'super_admin' to bypass policy.
 * Also supports legacy role_system='admin'/'super_admin' for backward compatibility.
 */
function buildRoles(user: any): string[] {
  const out = new Set<string>();
  const isSuper =
    user?.is_super_admin === true ||
    user?.role_system === 'admin' ||
    user?.role_system === 'super_admin';
  if (isSuper) out.add('super_admin');

  // the user's role_name (data CRUD role: admin/editor/viewer/...). Team has been removed.
  if (user?.role_name) out.add(user.role_name);

  // Fallback always has a default so the policy lookup never misses
  if (out.size === 0) out.add('default');
  return Array.from(out);
}
/**
 * Single-tenant: no more x-tenant-id routing / AsyncLocalStorage. The slug is
 * fixed in env (`TENANT`); `loadAction()` reads the schema from the env scope. No-op wrapper.
 */
async function withSlugContext<T>(_request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  return fn();
}

/**
 * Get databaseType from entity schema (falls back to 'mongodb')
 */
async function getEntityDatabaseType(collectionName: string, _tenantId?: string): Promise<string> {
  const entity = await schemaManager.getEntity(collectionName);
  return entity?.databaseType || 'mongodb';
}
class CommonController {
  async getResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._getResource(request, reply));
  }

  async _getResource(request: FastifyRequest, reply: FastifyReply) {
    const user: any = request.headers.user;
    const queryData = request.query as any;
    const path = "/" + ((request.params as any)["*"] || "");
    console.log("[CommonController] Requested resource path:", path);
    dbgGroup('[common] _getResource GET', { path });
    const roles = buildRoles(user);
    dbgGroup('loadAction', { method: 'GET' });
    const {action: preContext, resource, is_tenant, params} = await loadAction(path, "GET", { excludePublic: true });
    dbgStep('loadAction.result', { resource, is_tenant, hasAction: !!preContext });
    dbgEnd();
    // merger params into queryData
    Object.assign(queryData, params);
    if (!resource) {
      dbgStep('!Resource not found', { path });
      dbgEnd();
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Resource not found" });
    }
    const options: OptionsInput = {
      databaseType: await getEntityDatabaseType(resource, is_tenant ? (request.headers["x-tenant-id"] as string) : undefined) as any,
      is_tenant: is_tenant,
      path: path.split("/"),
      log: request.log,
      tree: queryData.tree ?? undefined,
      tenant_id: is_tenant
        ? (request.headers["x-tenant-id"] as any) ?? undefined
        : undefined,
      history: queryData.history ?? undefined,
      user_id: user?.id || user?._id || undefined,
      headers: request.headers as Record<string, string>,
      roles
    };
    if (
      is_tenant &&
      !request.headers["x-tenant-id"]
    ) {
      reply.statusCode = 400;
      return {
        statusCode: 400,
        msg: "Error tenant",
      };
    } else {
      // Snapshot tenant_id BEFORE clearing the header — response interceptor
      // (logging) reads from request.tenantId so it's not lost when the
      // header is cleared for defensive isolation downstream.
      (request as any).tenantId = request.headers["x-tenant-id"];
      request.headers["x-tenant-id"] = undefined;
    }

    // option from action request
    
    delete queryData.tree;
    delete queryData.history;
    const result = await commonService.getQuery(
      resource,
      preContext,
      queryData,
      roles,
      params,
      options
    );    if (result?.statusCode) {
      reply.statusCode = result.statusCode;
    }
    return result;
  }

  async postResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._postResource(request, reply));
  }

  async _postResource(request: FastifyRequest, reply: FastifyReply) {
    const path = "/" + ((request.params as any)["*"] || "");
    const {action: preContext, resource, is_tenant, params} = await loadAction(path, "POST", { excludePublic: true });

    if (!resource) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Resource not found" });
    }
    const body: any = request.body;
    const roles = buildRoles(request.headers.user as any);
    const options: OptionsInput = {
      databaseType: await getEntityDatabaseType(resource, is_tenant ? (request.headers["x-tenant-id"] as string) : undefined) as any,
      is_tenant: is_tenant,
      path: path.split("/"),
      log: request.log,
      user_id: (request.headers.user as any)?.id ?? "default",
      tenant_id: is_tenant
        ? (request.headers["x-tenant-id"] as any) ?? undefined
        : undefined,
      action: "POST",
      body,
      roles
    };
    if (
      is_tenant &&
      !request.headers["x-tenant-id"]
    ) {
      reply.statusCode = 400;
      return {
        statusCode: 400,
        msg: "Error tenant",
      };
    } else {
      // Snapshot tenant_id BEFORE clearing the header — response interceptor
      // (logging) reads from request.tenantId so it's not lost when the
      // header is cleared for defensive isolation downstream.
      (request as any).tenantId = request.headers["x-tenant-id"];
      request.headers["x-tenant-id"] = undefined;
    }
    

    let newBody = { ...body };
    newBody["tenant_id"] = options.tenant_id;
    console.log(options)

    const result = await commonService.postQuery(
      resource,
      preContext,
      newBody,
      roles,
      options
    );

    // Single-tenant: entity auto-generation (resource/action/policy) has been removed —
    // the schema is generated via Studio then the image is rebuilt, no auto-gen at runtime.

    // Set status code from result
    if (result?.statusCode) {
      reply.statusCode = result.statusCode;
    }

    return result;
  }

  async patchResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._patchResource(request, reply));
  }

  async _patchResource(request: FastifyRequest, reply: FastifyReply) {
    const path = "/" + ((request.params as any)["*"] || "");
    console.log("[CommonController] Requested resource path:", path);
    const {action: preContext, resource, is_tenant, params} = await loadAction(path, "PATCH", { excludePublic: true });
    if (!resource) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Resource not found" });
    }
    const queryData: Record<string, any> = request.query as Record<string, any>;
    const body: any = request.body;
    await modeHandler.getWithModeHandler(request, "PUT");
    const roles = buildRoles(request.headers.user as any);
     const options: OptionsInput = {
      databaseType: await getEntityDatabaseType(resource, is_tenant ? (request.headers["x-tenant-id"] as string) : undefined) as any,
      is_tenant: is_tenant,
      path: path.split("/"),
      user_id: (request.headers.user as any)?.id ?? "default",
      log: request.log,
      tenant_id: is_tenant
        ? (request.headers["x-tenant-id"] as any) ?? undefined
        : undefined,
      tree: queryData.tree ?? undefined,
      partial: true,
      body,
      roles
    };
    if (
      is_tenant &&
      !request.headers["x-tenant-id"]
    ) {
      reply.statusCode = 400;
      return {
        statusCode: 400,
        msg: "Error tenant",
      };
    } else {
      // Snapshot tenant_id BEFORE clearing — response interceptor (log) reads from request.tenantId
      (request as any).tenantId = request.headers["x-tenant-id"];
      request.headers["x-tenant-id"] = undefined;
    }


    delete queryData.tree;

    body.tenant_id = options.tenant_id;

    const result = await commonService.patchQuery(
      resource,
      preContext,
      params,
      body,
      roles,
      options
    );
    if (result?.statusCode) {
      reply.statusCode = result.statusCode;
    }

    return result;
  }

  async deleteResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._deleteResource(request, reply));
  }

  async _deleteResource(request: FastifyRequest, reply: FastifyReply) {
    const path = "/" + ((request.params as any)["*"] || "");
    console.log("[CommonController] Requested resource path:", path);
    const {action: preContext, resource, is_tenant, params} = await loadAction(path, "DELETE", { excludePublic: true });
    if (!resource) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Resource not found" });
    }
    const queryData: Record<string, any> = request.query as Record<string, any>;
    if (queryData["ids"] && typeof queryData["ids"] === "string") {
      const ids = queryData["ids"] as string;
      queryData["id"] = `in.[${ids.split(",").join(",")}]`;
      delete queryData["ids"];
    }
    const roles = buildRoles(request.headers.user as any);
    const options: OptionsInput = {
      databaseType: await getEntityDatabaseType(resource, is_tenant ? (request.headers["x-tenant-id"] as string) : undefined) as any,
      is_tenant: is_tenant,
      log: request.log,
      user_id: (request.headers.user as any)?.id ?? "default",
      tenant_id: is_tenant
        ? (request.headers["x-tenant-id"] as any) ?? undefined
        : undefined,
      action: "DELETE",
      roles
    };
    
    if (
      is_tenant &&
      !request.headers["x-tenant-id"]
    ) {
      reply.statusCode = 400;
      return {
        statusCode: 400,
        msg: "Error tenant",
      };
    } else {
      // Snapshot tenant_id BEFORE clearing — response interceptor (log) reads from request.tenantId
      (request as any).tenantId = request.headers["x-tenant-id"];
      request.headers["x-tenant-id"] = undefined;
    }
    
    const result = await commonService.deleteQuery(
      resource,
      preContext,
      (Object.entries(params).length > 0) ? params: queryData,
      roles,
      options
    );
    if (result?.statusCode) {
      reply.statusCode = result.statusCode;
    }

    return result;
  }

  async putResource(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._putResource(request, reply));
  }

  async _putResource(request: FastifyRequest, reply: FastifyReply) {
    const path = "/" + ((request.params as any)["*"] || "");
    console.log("[CommonController] Requested resource path:", path);
    const {action: preContext, resource, is_tenant, params} = await loadAction(path, "PUT", { excludePublic: true });
    if (!resource) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Resource not found" });
    }
    const queryData: Record<string, any> = request.query as Record<string, any>;
    const body: any = request.body;
    await modeHandler.getWithModeHandler(request, "PUT");
    const roles = buildRoles(request.headers.user as any);
    const options: OptionsInput = {
      databaseType: await getEntityDatabaseType(resource, is_tenant ? (request.headers["x-tenant-id"] as string) : undefined) as any,
      is_tenant: is_tenant,
      path: path.split("/"),
      user_id: (request.headers.user as any)?.id ?? "default",
      log: request.log,
      tenant_id: is_tenant
        ? (request.headers["x-tenant-id"] as any) ?? undefined
        : undefined,
      tree: queryData.tree ?? undefined,
      partial: true,
      body,
      roles
    };
    if (
      is_tenant &&
      !request.headers["x-tenant-id"]
    ) {
      reply.statusCode = 400;
      return {
        statusCode: 400,
        msg: "Error tenant",
      };
    } else {
      // Snapshot tenant_id BEFORE clearing — response interceptor (log) reads from request.tenantId
      (request as any).tenantId = request.headers["x-tenant-id"];
      request.headers["x-tenant-id"] = undefined;
    }


    delete queryData.tree;

    body.tenant_id = options.tenant_id;

    const result = await commonService.putQuery(
      resource,
      preContext,
      params,
      body,
      roles,
      options
    );
    if (result?.statusCode) {
      reply.statusCode = result.statusCode;
    }
    return result;
  }

  // Dedicated bulk endpoint — PUT/PATCH /:entityName/many. Ported from the
  // production hard-coded `partialUpdateManyEntity`: loop partialUpdate per
  // top-level item so each is a valid object (validation runs before plugins).
  // For tree-save the parent plugin flattens each item's nested `children`.
  // A dedicated route (registered as `/:entityName/many`) is required so it
  // wins over the `/*` wildcard and isn't shadowed by the `:id` action.
  async partialUpdateMany(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._partialUpdateMany(request, reply));
  }

  async _partialUpdateMany(request: FastifyRequest, reply: FastifyReply) {
    const entityName = (request.params as any).entityName as string;
    const path = `/${entityName}/many`;
    const { resource, is_tenant } = await loadAction(path, "PUT", { excludePublic: true });
    if (!resource) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Resource not found" });
    }
    const queryData: Record<string, any> = request.query as Record<string, any>;
    const body: any = request.body;
    if (!Array.isArray(body)) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "Body must be an array for /many" });
    }
    await modeHandler.getWithModeHandler(request, "PUT");
    const roles = buildRoles(request.headers.user as any);
    const options: OptionsInput = {
      databaseType: await getEntityDatabaseType(resource, is_tenant ? (request.headers["x-tenant-id"] as string) : undefined) as any,
      is_tenant: is_tenant,
      path: path.split("/"),
      user_id: (request.headers.user as any)?.id ?? "default",
      log: request.log,
      tenant_id: is_tenant
        ? (request.headers["x-tenant-id"] as any) ?? undefined
        : undefined,
      tree: queryData.tree ?? undefined,
      partial: true,
      body,
      roles,
    };
    if (is_tenant && !request.headers["x-tenant-id"]) {
      reply.statusCode = 400;
      return { statusCode: 400, msg: "Error tenant" };
    }
    // Snapshot tenant_id BEFORE clearing — response interceptor reads request.tenantId
    (request as any).tenantId = request.headers["x-tenant-id"];
    request.headers["x-tenant-id"] = undefined;

    const results = await Promise.all(
      (body as any[]).map((item) => {
        const id = item._id || item.id;
        const { _id, id: _omit, ...rest } = item;
        return commonService.partialUpdate(
          resource,
          id,
          { ...rest, tenant_id: options.tenant_id },
          roles,
          options,
        );
      }),
    );
    const first: any = results[0];
    if (first?.statusCode && first.statusCode >= 400) {
      reply.statusCode = first.statusCode;
    }
    return {
      message: "Partial update successful",
      statusCode: 200,
      data: results,
    };
  }
}

export async function CommonRoutesV2(app: FastifyInstance) {
  const controller = new CommonController();

  // Dedicated bulk routes — MUST be registered before the `/*` wildcard so
  // `/:entity/many` resolves here (not shadowed by the wildcard / `:id` action).
  app.put(
    "/:entityName/many",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.partialUpdateMany.bind(controller)
  );
  app.patch(
    "/:entityName/many",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.partialUpdateMany.bind(controller)
  );

  // Register routes with wildcard first (less specific, matches longer paths)
  // Put pinned entity
  app.put(
    "/*",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.putResource.bind(controller)
  );
  // Get entity list
  app.get(
    "/*",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.getResource.bind(controller)
  );

  // Create new entity
  app.post(
    "/*",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.postResource.bind(controller)
  );

  // Update entity
  app.patch(
    "/*",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.patchResource.bind(controller)
  );

  app.delete(
    "/*",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.deleteResource.bind(controller)
  );
}
