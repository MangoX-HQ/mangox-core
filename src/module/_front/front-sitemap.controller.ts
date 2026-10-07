import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getCoreUnified } from "../../configs/core";
import { OptionsInput } from "../../core_v2/compat";
import { runWithTenantSlug } from "../../core_v2/adapters/mongodb/tenant-context";
import { TENANT_SLUG } from "../../configs/tenant";

const GUEST_ROLE = "guest";
const STRIP_MARKERS = /\*\*.*?\*\*/g;

async function withSlugContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const headerTenantId = (request.headers["x-tenant-id"] as string) || undefined;
  if (!headerTenantId) return fn();
  const slug = TENANT_SLUG || headerTenantId;
  return runWithTenantSlug(slug, headerTenantId, fn);
}

function applyPagination(queryData: any) {
  if (queryData.page) {
    const limit = queryData.limit ?? 10;
    queryData.skip = `${(queryData.page - 1) * limit}`;
    delete queryData.page;
  }
}

function baseOptions(request: FastifyRequest): OptionsInput {
  return {
    databaseType: "mongodb",
    is_tenant: true,
    frontAPI: true,
    log: request.log,
    tenant_id: (request.headers["x-tenant-id"] as string) || undefined,
    roles: [GUEST_ROLE],
  };
}

class FrontSitemapController {
  async getSitemapPage(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._getSitemapPage(request, reply));
  }

  private async _getSitemapPage(request: FastifyRequest, reply: FastifyReply) {
    const queryData: any = {
      ...(request.query as any),
      // published (status="1") OR status not set; do NOT add tenant_id (or +
      // field filter conflict → 0; tenant is already scoped via withSlugContext + is_tenant).
      or: 'status=eq."1",status=exists.false',
    };
    applyPagination(queryData);

    const core = getCoreUnified().getCore();
    const result = await core.findAll(queryData, "page", [GUEST_ROLE], baseOptions(request));

    return {
      ...result,
      data: result.data.map((item: any) => ({
        _id: item._id,
        slug: typeof item.slug === "string" ? item.slug.replace(STRIP_MARKERS, "") : item.slug,
        locale: item.locale,
      })),
    };
  }

  async getSitemapPost(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._getSitemapPost(request, reply));
  }

  private async _getSitemapPost(request: FastifyRequest, reply: FastifyReply) {
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const queryData: any = {
      ...(request.query as any),
      redirect_url: null,
      entity_save_data: "in.[post-type-content,category]",
      tenant_id: tenantHeader,
    };
    applyPagination(queryData);

    const core = getCoreUnified().getCore();
    const result = await core.findAll(queryData, "seopath", [GUEST_ROLE], baseOptions(request));

    return {
      ...result,
      data: result.data
        .filter((i: any) => i.entity_slug && typeof i.entity_slug === "string")
        .map((item: any) => ({
          _id: item._id,
          slug: `${item.entity_slug}/${(item.slug || "").replace(STRIP_MARKERS, "")}`,
          entity: item.entity_save_data,
          locale: item.locale,
        })),
    };
  }

  async getSitemapPostV2(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._getSitemapPostV2(request, reply));
  }

  private async _getSitemapPostV2(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as Array<{ post_type: string; limit?: number }>;
    if (!Array.isArray(body) || body.length === 0) return [];

    const options = baseOptions(request);
    const core = getCoreUnified().getCore();

    const postTypes = await core.findAll(
      {
        use_posttype: "eq.true",
        mongodb_collection_name: `in.[${body.map((i) => `"${i.post_type}"`).join(",")}]`,
      },
      "entity",
      ["admin"],
      options,
    );

    const page = (request.query as any)?.page;
    const merged: any[] = [];

    await Promise.all(
      postTypes.data.map(async (postType: any) => {
        const cfg = body.find((i) => i.post_type === postType.mongodb_collection_name);
        const limit = cfg?.limit ?? 999999;
        const baseQuery: any = {
          entity_id: `in.[${postType._id.toString()}]`,
          redirect_url: null,
          entity_save_data: "in.[post-type-content,category]",
          limit: `${limit}`,
          order: "-created_at",
        };
        if (page) baseQuery.skip = `${(page - 1) * limit}`;

        const [vi, en, jp] = await Promise.all([
          core.findAll({ ...baseQuery, locale: "eq.vi" }, "seopath", [GUEST_ROLE], options),
          core.findAll({ ...baseQuery, locale: "eq.en" }, "seopath", [GUEST_ROLE], options),
          core.findAll({ ...baseQuery, locale: "eq.jp" }, "seopath", [GUEST_ROLE], options),
        ]);

        const combined = [
          ...(vi.data ?? []),
          ...(en.data ?? []),
          ...(jp.data ?? []),
        ].map((item: any) => ({
          _id: item._id,
          slug: `${item.entity_slug}/${(item.slug || "").replace(STRIP_MARKERS, "")}`,
          entity: item.entity_save_data,
          locale: item.locale,
        }));
        if (combined.length > 0) merged.push(...combined);
      }),
    );

    return merged;
  }

  async getSitemapBlocks(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._getSitemapBlocks(request, reply));
  }

  private async _getSitemapBlocks(request: FastifyRequest, reply: FastifyReply) {
    const queryData = { ...(request.query as any) };
    applyPagination(queryData);

    const core = getCoreUnified().getCore();
    const tenants = await core.findAll(
      {
        ...queryData,
        or: 'status=eq."1",status=exists.false',
        select: "_id,title,domain,description,theme_config,slug",
      },
      "tenant",
      ["admin"],
      { databaseType: "mongodb" } as OptionsInput,
    );

    await Promise.all(
      tenants.data.map(async (tenant: any) => {
        tenant.blocksContent = [];
        tenant.header = "";
        tenant.footer = "";

        const menus = await core.findAll(
          {
            tenant_id: `eq.${tenant._id}`,
            select: "_id,title,slug,groupfield",
          },
          "menu",
          ["admin"],
          { databaseType: "mongodb" } as OptionsInput,
        );

        const groupfieldIds = new Set<string>();
        for (const menu of menus.data) {
          if (!Array.isArray(menu.groupfield)) continue;
          for (const id of menu.groupfield) {
            if (id) groupfieldIds.add(typeof id === "object" ? id.toString() : id);
          }
        }

        let gfMap = new Map<string, string>();
        if (groupfieldIds.size > 0) {
          const gfResult = await core.findAll(
            { _id: `in.[${Array.from(groupfieldIds).join(",")}]`, select: "_id,slug" },
            "group-field",
            ["admin"],
            { databaseType: "mongodb" } as OptionsInput,
          );
          gfMap = new Map(gfResult.data.map((gf: any) => [gf._id.toString(), gf.slug]));
        }

        for (const menu of menus.data) {
          const slugs = (menu.groupfield || [])
            .map((id: any) => gfMap.get(typeof id === "object" ? id.toString() : id))
            .filter(Boolean);
          const title = (menu.title || "").toString().toLowerCase();
          if (title === "header") tenant.header = slugs;
          if (title === "footer") tenant.footer = slugs;
        }

        const blocks = await core.findAll(
          {
            tenant_id: `eq.${tenant._id}`,
            deleted: "exists.false",
            select: "_id,key",
          },
          "block-content",
          ["admin"],
          { databaseType: "mongodb" } as OptionsInput,
        );

        const uniqueKeys = [
          ...new Set(blocks.data.map((i: any) => (i.key || "").split("___")[0])),
        ].filter(Boolean);
        tenant.blocksContent.push(...uniqueKeys);
      }),
    );

    return { ...tenants, data: tenants.data };
  }
}

export async function FrontSitemapRoutes(app: FastifyInstance) {
  const controller = new FrontSitemapController();
  app.get("/front/sitemap/page", controller.getSitemapPage.bind(controller));
  app.get("/front/sitemap/post", controller.getSitemapPost.bind(controller));
  app.post("/front/sitemap/post-v2", controller.getSitemapPostV2.bind(controller));
  app.get("/front/sitemap/blocks", controller.getSitemapBlocks.bind(controller));
}
