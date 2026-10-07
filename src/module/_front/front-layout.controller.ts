import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getCoreUnified } from "../../configs/core";
import { OptionsInput } from "../../core_v2/compat";
import { AppError } from "../../utils/app-error";
import { runWithTenantSlug } from "../../core_v2/adapters/mongodb/tenant-context";
import { TENANT_SLUG } from "../../configs/tenant";

const GUEST_ROLE = "guest";
const MENU_FIELDS = ["header", "footer", "sidebar"] as const;

async function withSlugContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const headerTenantId = (request.headers["x-tenant-id"] as string) || undefined;
  if (!headerTenantId) return fn();
  const slug = TENANT_SLUG || headerTenantId;
  return runWithTenantSlug(slug, headerTenantId, fn);
}

function collectGroupfieldIds(layouts: any[]): Set<string> {
  const ids = new Set<string>();
  for (const layout of layouts) {
    if (!Array.isArray(layout?.templates)) continue;
    for (const template of layout.templates) {
      for (const field of MENU_FIELDS) {
        const menus = template?.[field];
        if (!Array.isArray(menus)) continue;
        for (const menu of menus) {
          if (!Array.isArray(menu?.groupfield)) continue;
          for (const id of menu.groupfield) {
            if (id) ids.add(typeof id === "object" ? id.toString() : id);
          }
        }
      }
    }
  }
  return ids;
}

function replaceGroupfieldIds(layouts: any[], idMap: Map<string, any>): void {
  for (const layout of layouts) {
    if (!Array.isArray(layout?.templates)) continue;
    for (const template of layout.templates) {
      for (const field of MENU_FIELDS) {
        const menus = template?.[field];
        if (!Array.isArray(menus)) continue;
        for (const menu of menus) {
          if (!Array.isArray(menu?.groupfield)) continue;
          menu.groupfield = menu.groupfield.map((id: any) => {
            const key = typeof id === "object" ? id.toString() : id;
            return idMap.get(key) ?? id;
          });
        }
      }
    }
  }
}

class FrontLayoutController {
  async getLayout(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._getLayout(request, reply));
  }

  async _getLayout(request: FastifyRequest, reply: FastifyReply) {
    const queryData = { ...(request.query as any) };
    queryData.or = queryData.or
      ? `${queryData.or},status=eq."1",status=exists.false`
      : 'status=eq."1",status=exists.false';

    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const options: OptionsInput = {
      databaseType: "mongodb",
      is_tenant: true,
      frontAPI: true,
      log: request.log,
      tenant_id: tenantHeader,
      headers: request.headers as Record<string, string>,
      roles: [GUEST_ROLE],
    };

    const core = getCoreUnified().getCore();
    const result = await core.findAll(queryData, "layout", [GUEST_ROLE], options);

    if (!result?.data?.length) {
      if (result?.statusCode) reply.statusCode = result.statusCode;
      return result;
    }

    const ids = collectGroupfieldIds(result.data);
    if (ids.size > 0) {
      const groupfieldResult = await core.findAll(
        { _id: `in.[${Array.from(ids).join(",")}]` },
        "group-field",
        ["admin"],
        { databaseType: "mongodb", tenant_id: tenantHeader },
      );
      const idMap = new Map<string, any>(
        groupfieldResult.data.map((item: any) => [item._id.toString(), item]),
      );
      replaceGroupfieldIds(result.data, idMap);
    }

    if (result?.statusCode) reply.statusCode = result.statusCode;
    return result;
  }
}

export async function FrontLayoutRoutes(app: FastifyInstance) {
  const controller = new FrontLayoutController();
  app.get("/front/layout", controller.getLayout.bind(controller));
}
