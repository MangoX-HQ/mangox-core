import { getCoreUnified, ICoreUnified } from "../../configs/core";
import { withTenant } from "../../configs/core/adapter";
import {
  ComparisonOperator,
  IntermediateQueryResult,
  OptionsInput,
  useLocale,
} from "../../core_v2/compat";
import { FastifyRequest } from "fastify";
import { builderQuery } from "./helper/builder";
import { executeCode } from "./helper/excute";

/**
 * Helper to get core global instance
 * Supports both Core V1 and Core V2
 */
export interface PaginatedResult<T> {
  limit: number;
  skip: number;
  documents: T[];
  count: number;
}

class CommonService {
  constructor() {
    // Core unified is accessed via getCoreUnified() helper
  }

  async getQuery(
    resource: string,
    action: any,
    queryData: any = {},
    roles: string[] = ["default"],
    params: Record<string, any> = {},
    options?: OptionsInput,
    request?: FastifyRequest,
  ): Promise<IntermediateQueryResult<any>> {
    // no build here it on action request

    queryData["limit"] = queryData["limit"] ? queryData["limit"] : "10";
    queryData["skip"] = "0";
    if (queryData.page) {
      const limit = queryData.limit ?? 10;
      queryData["skip"] = `${(queryData.page - 1) * limit}`;
      delete queryData.page;
    }

    if (!queryData.order) {
      queryData.order = "-created_at,-updated_at,-timestamp,-_id";
    }

    return withTenant(options?.tenant_id as string | undefined, () => this._getQuery(resource, action, queryData, roles, params, options, request));
  }

  private async _getQuery(
    resource: string,
    action: any,
    queryData: any,
    roles: string[],
    params: Record<string, any>,
    options?: OptionsInput,
    request?: FastifyRequest,
  ): Promise<IntermediateQueryResult<any>> {
    console.log("Query data before builder:", queryData);

    // use_locale + GET detail-by-id + ?locale=<x>: the FE passes the _id of the MAIN version
    // (= the group's locale_id) but wants a different language version → filter by locale_id instead of
    // _id, so `locale=<x>` (a regular filter) picks the right version. With NO locale, keep
    // the detail as-is by _id (no change to old behaviour). detailId comes from options.resource_id
    // (Studio) or queryData.id/_id (runtime — resource_id not set). locale_id is a
    // string → the filter-converter does NOT coerce it to ObjectId (only coerces field==="_id"/*._id).
    const __detailId = options?.resource_id ?? (queryData as any)?.id ?? (queryData as any)?._id;
    if (__detailId && (queryData as any)?.locale != null) {
      const [isLocale, localeField] = await useLocale(resource);
      if (isLocale && localeField && localeField !== "_id") {
        queryData[localeField] = __detailId;
        delete queryData.id;
        delete queryData._id;
      }
    }

    // ?locale= → set localeFilter cho core: relation use_locale (join foreignField='locale_id')
    // automatically injects $match {locale} inside $lookup → embeds return only the correct-language version (for every API, no post-processing).
    if (options && (queryData as any)?.locale != null) {
      (options as any).localeFilter = String((queryData as any).locale);
    }

    let { entity, conditions, functionName } = await builderQuery(
      queryData,
      action,
      resource,
      roles,
      undefined,
      options,
    );

    // entity stays LOGICAL — core-service handles polymorphic routing internally
    const result = await getCoreUnified()
      .getCore()
      .findAll(conditions as any, entity, roles, options);

    if (result.data.length > 0 && options?.databaseType === 'mongodb') {
      const ids = result.data?.map((item) => item._id.toString());
      const querySeopath = {
        related_id: `in.[${ids.join(",")}]`,
        select: "*,entity_id()",
      };
      const seopathResult = await getCoreUnified()
        .getCore()
        .findAll(querySeopath, "seopath", ["admin"], options);
      const seopathMap = new Map(
        seopathResult.data?.map((sp) => [
          sp.related_id ? sp.related_id[0] : null,
          sp,
        ]),
      );

      for (const value of result.data) {
        const sp = seopathMap.get(value._id.toString());
        if (sp && sp.entity_id?.[0]?.collection_name) {
          const fullpath = sp.entity_id?.[0]?.use_posttype
            ? sp.entity_slug + "/" + sp.slug
            : sp.slug;
          value["meta_data"] = {
            slug: fullpath,

            redirect_to: null,
            type: "direct",
            entity: sp.entity_id?.[0]?.collection_name,
          };
        }
      }
    }
    return functionName ? await executeCode(functionName, result, options) : result;
  }

  async postQuery(
    resource: string,
    action: any,
    createDto: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ) {
    return withTenant(options?.tenant_id as string | undefined, async () => this._postQuery(resource, action, createDto, roles, options));
  }

  private async _postQuery(
    resource: string,
    action: any,
    createDto: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ) {
    let { entity, functionName, body, context, trigger } = await builderQuery(
      {},
      action,
      resource,
      roles,
      createDto,
      options,
    );
    // entity stays LOGICAL — core-service auto-resolves mongodb_save_data
    // and tags body with the discriminator (collection_name by default).
    const core = getCoreUnified().getCore();
    // Pass policy context downstream so REST adapter's request_template.body
    // can reference `@context:<alias>:<field>` records loaded from policy.data.
    const optsWithCtx = { ...options, policyContext: context };
    const result = await core.create(entity, body, roles, optsWithCtx);

    // Run policy.trigger AFTER the main op — see helper/trigger.ts for the DSL.
    if (trigger?.actions?.length) {
      const { executeTrigger } = await import('./helper/trigger');
      await executeTrigger(trigger, { options, context, result }).catch((err) => {
        console.error('[trigger] postQuery failed', { trigger_id: trigger.trigger_id, err });
      });
    }

    return functionName ? await executeCode(functionName, result, options) : result;
  }

  async putQuery(
    resource: string,
    action: any,
    queryData: Record<string, any>,
    createDto: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ): Promise<any> {
    return withTenant(options?.tenant_id as string | undefined, () => this._putQuery(resource, action, queryData, createDto, roles, options));
  }

  private async _putQuery(
    resource: string,
    action: any,
    queryData: Record<string, any>,
    createDto: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ): Promise<any> {
    let { entity, conditions, functionName, body, context, trigger } = await builderQuery(
      queryData,
      action,
      resource,
      roles,
      createDto,
      options,
    );

    // entity stays LOGICAL — core-service handles polymorphic routing internally
    const result = await getCoreUnified()
      .getCore()
      .partialUpdate(entity, conditions, body, roles, options);
    if (trigger?.actions?.length) {
      const { executeTrigger } = await import('./helper/trigger');
      await executeTrigger(trigger, { options, context, result }).catch((err) => {
        console.error('[trigger] putQuery failed', { trigger_id: trigger.trigger_id, err });
      });
    }
    return functionName ? await executeCode(functionName, result, options) : result;
  }

  async patchQuery(
    resource: string,
    action: any,
    queryData: Record<string, any>,
    createDto: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ): Promise<any> {
    return withTenant(options?.tenant_id as string | undefined, () => this._patchQuery(resource, action, queryData, createDto, roles, options));
  }

  private async _patchQuery(
    resource: string,
    action: any,
    queryData: Record<string, any>,
    createDto: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ): Promise<any> {
    let { entity, conditions, functionName, body, context, trigger } = await builderQuery(
      queryData,
      action,
      resource,
      roles,
      createDto,
      options,
    );

    // entity stays LOGICAL — core-service handles polymorphic routing
    const result = await getCoreUnified()
      .getCore()
      .partialUpdate(entity, conditions, body, roles, options);

    if (trigger?.actions?.length) {
      const { executeTrigger } = await import('./helper/trigger');
      await executeTrigger(trigger, { options, context, result }).catch((err) => {
        console.error('[trigger] patchQuery failed', { trigger_id: trigger.trigger_id, err });
      });
    }
    return functionName ? await executeCode(functionName, result, options) : result;
  }

  async deleteQuery(
    resource: string,
    action: any,
    queryData: Record<string, any>,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ): Promise<any> {
    return withTenant(options?.tenant_id as string | undefined, () => this._deleteQuery(resource, action, queryData, roles, options));
  }

  private async _deleteQuery(
    resource: string,
    action: any,
    queryData: Record<string, any>,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ): Promise<any> {
    const { entity, conditions, functionName, context, trigger } = await builderQuery(
      queryData,
      action,
      resource,
      roles,
      options,
    );

    // entity stays LOGICAL — core-service handles polymorphic routing
    const result = await getCoreUnified()
      .getCore()
      .deleteMany(entity, conditions, roles, options);
    if (trigger?.actions?.length) {
      const { executeTrigger } = await import('./helper/trigger');
      await executeTrigger(trigger, { options, context, result }).catch((err) => {
        console.error('[trigger] deleteQuery failed', { trigger_id: trigger.trigger_id, err });
      });
    }
    return functionName ? await executeCode(functionName, result, options) : result;
  }
  // ============================================================================
  // V1 COMPATIBILITY METHODS (used by entity.ts)
  // ============================================================================

  async findAllQuery(
    entityName: string,
    queryData: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ) {
    return getCoreUnified().getCore().findAll(queryData, entityName, roles, options);
  }

  async findOne(
    entityName: string,
    queryData: any,
    id: string,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ) {
    const conditions = { ...queryData, _id: `eq.${id}` };
    return getCoreUnified().getCore().findAll(conditions, entityName, roles, options);
  }

  async create(
    entityName: string,
    body: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ) {
    return getCoreUnified().getCore().create(body, entityName, roles, options);
  }

  async partialUpdate(
    entityName: string,
    id: string,
    body: any,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ) {
    // CoreAdapter.update(collection, query, data, roles, options) — args were
    // previously swapped (body as collection) → "Collection name is required".
    return getCoreUnified().getCore().update(entityName, id, body, roles, options);
  }

  async hardDelete(
    entityName: string,
    id: string,
    roles: string[] = ["default"],
    options?: OptionsInput,
  ) {
    const result = await getCoreUnified().getCore().delete(entityName, id, roles, options);
    return { success: result, statusCode: result ? 200 : 404 };
  }

  async hardDeleteMany(
    entityName: string,
    ids: string[],
    roles: string[] = ["default"],
    options?: OptionsInput,
  ) {
    const results = await Promise.all(
      ids.map((id) => getCoreUnified().getCore().delete(entityName, id, roles, options)),
    );
    const allSuccess = results.every(Boolean);
    return { success: allSuccess, statusCode: allSuccess ? 200 : 404 };
  }
}

export const commonService = new CommonService();
