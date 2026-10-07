import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { jwtGuard } from "../..";
import { getPolicies } from "../_setting/setting-mode";
import { AppError } from "../../utils/app-error";
import { mediaMinioService } from "../_media/media-minio.service";
import { runWithTenantSlug } from "../../core_v2/adapters/mongodb/tenant-context";
import { TENANT_SLUG } from "../../configs/tenant";

/**
 * Private Documents Controller (runtime single-tenant)
 * Streams private documents (CVs...) from MinIO/R2 by id.
 *
 * DIFFERENT from the old documents controller (which used rbacMiddleware.hasAccess): access
 * here is gated by CHECKING POLICY — is there a policy `resource:'media', action:'read'` for
 * the user's role (super_admin bypasses)? No matching policy → 403.
 *
 * Different from the Studio version: uses TENANT_SLUG (single-tenant) instead of tenantConnectionManager;
 * missing x-tenant-id falls back to the bucket env (getCV(id) does not need tenant_id).
 */

/** Run fn within the tenant scope so getPolicies can see the tenant (via getTenantScope). */
async function withTenantContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const headerTenantId = (request.headers["x-tenant-id"] as string) || undefined;
  if (!headerTenantId) return fn();
  const slug = TENANT_SLUG || headerTenantId;
  return runWithTenantSlug(slug, headerTenantId, fn);
}

/**
 * Gates reading private documents with POLICY (instead of RBAC middleware):
 * requires a policy json `resource:['media']`, `action:['read']`, `role:[...]` (system/tenant)
 * matching the user's role. super_admin bypasses. No match → 403.
 */
async function ensureReadMediaPolicy(request: FastifyRequest): Promise<void> {
  const user = (request.headers.user as any) || {};
  if (user.is_super_admin === true || user.role_system === "admin" || user.role_system === "super_admin") return;
  const roles = [user.role_name ?? "default"];
  const policies = await getPolicies({
    resource: { $in: ["media"] },
    action: { $in: ["read"] },
    role: { $in: roles },
  });
  if (!policies?.length) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Access denied: không có policy read media cho role này",
      expose: true,
    });
  }
}

class PrivateDocumentsController {
  /** Sanitize the filename for the Content-Disposition header (strip control/invalid characters). */
  private sanitizeFilename(filename: string): string {
    if (!filename) return "file";
    let sanitized = filename.replace(/[\x00-\x1F\x7F-\x9F\n\r\t]/g, "");
    sanitized = sanitized.replace(/[\\"\r\n]/g, "");
    sanitized = sanitized.replace(/[^\x20-\x7E -￿]/g, "");
    sanitized = sanitized.trim();
    return sanitized || "file";
  }

  /** Content-Disposition — RFC 5987 when the filename has non-ASCII characters. */
  private formatContentDisposition(filename: string, disposition: "inline" | "attachment" = "inline"): string {
    const sanitized = this.sanitizeFilename(filename);
    const hasNonASCII = /[^\x20-\x7E]/.test(sanitized);
    if (hasNonASCII) {
      const asciiFallback = sanitized.replace(/[^\x20-\x7E]/g, "_");
      const encoded = encodeURIComponent(sanitized);
      return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
    }
    return `${disposition}; filename="${sanitized}"`;
  }

  async getDetails(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const tenant_id = (request.headers["x-tenant-id"] as string) || undefined;

    return withTenantContext(request, async () => {
      // Gate access with POLICY (not RBAC middleware). No policy → throw 403.
      await ensureReadMediaPolicy(request);

      try {
        const result = await mediaMinioService.getCV(id, tenant_id);
        if (!result) {
          reply.statusCode = 404;
          return { statusCode: 404, code: "NOT_FOUND", msg: "Document not found" };
        }
        if (result?.statusCode) {
          reply.statusCode = result.statusCode;
          return result;
        }

        reply.header("Content-Type", result.contentType);
        try {
          reply.header("Content-Disposition", this.formatContentDisposition(result.filename, "inline"));
        } catch (headerError: any) {
          request.log.error({ error: headerError, filename: result.filename }, "Error setting Content-Disposition");
          reply.header("Content-Disposition", 'inline; filename="document"');
        }
        if (result.contentType.startsWith("image/")) {
          reply.header("Cache-Control", "public, max-age=31536000");
        }
        return reply.send(result.stream);
      } catch (error: any) {
        if (error instanceof AppError) throw error; // 403/404… keep the original status
        request.log.error({ error, id }, "Error streaming private document");
        reply.statusCode = 500;
        return { statusCode: 500, code: "INTERNAL_ERROR", msg: "Error streaming file", error: error?.message };
      }
    });
  }
}

const privateDocumentsController = new PrivateDocumentsController();

export async function PrivateDocumentsRoutes(app: FastifyInstance) {
  app.get(
    "/documents/:id",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    privateDocumentsController.getDetails.bind(privateDocumentsController),
  );
}
