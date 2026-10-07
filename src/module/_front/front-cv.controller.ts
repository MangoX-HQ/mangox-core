import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getCoreUnified } from "../../configs/core";
import { appSettings } from "../../configs/app-settings";
import { OptionsInput } from "../../core_v2/compat";
import { AppError } from "../../utils/app-error";
import { mediaMinioService } from "../_media/media-minio.service";
import { runWithTenantSlug } from "../../core_v2/adapters/mongodb/tenant-context";
import { TENANT_SLUG } from "../../configs/tenant";

const GUEST_ROLE = "guest";

async function withSlugContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const headerTenantId = (request.headers["x-tenant-id"] as string) || undefined;
  if (!headerTenantId) return fn();
  const slug = TENANT_SLUG || headerTenantId;
  return runWithTenantSlug(slug, headerTenantId, fn);
}

class FrontCvController {
  async upload(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._upload(request, reply));
  }

  private async _upload(request: FastifyRequest, reply: FastifyReply) {
    if (!(request.headers["content-type"] || "").includes("multipart/form-data")) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "multipart/form-data required" });
    }
    const file: any = await (request as any).file();
    if (!file) throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "File is required" });

    const fields = file.fields || {};
    const pick = (key: string): string | undefined => {
      const f = fields[key];
      if (!f) return undefined;
      return typeof f.value === "string" ? f.value : undefined;
    };

    const data = {
      title: pick("media[0][title]") || file.filename,
      alt: pick("media[0][alt]") || file.filename,
      folder: pick("media[0][folder]"),
      name: pick("name"),
      email: pick("email"),
      phone: pick("phone"),
      applied_position: pick("applied_position"),
    };

    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const options: OptionsInput = {
      databaseType: "mongodb",
      is_tenant: true,
      frontAPI: true,
      log: request.log,
      tenant_id: tenantHeader,
      roles: [GUEST_ROLE],
    };

    const media = await mediaMinioService.createCV(
      { title: data.title, alt: data.alt, folder: data.folder },
      file,
      tenantHeader,
    );

    const cvBody = {
      name: data.name,
      email: data.email,
      phone: data.phone,
      applied_position: data.applied_position,
      featured_image: media.id,
    };

    const core = getCoreUnified().getCore();
    const created: any = await core.create("cv-documents", cvBody, ["admin"], options);

    const docs = Array.isArray(created?.data) ? created.data : [created];
    if (docs?.[0]) {
      docs[0].objectName = media.objectName;
      const bucketPrefix = appSettings.minio.cv?.bucketName
        ? `${appSettings.minio.cv.bucketName}/`
        : "";
      docs[0].path = `${appSettings.minio.public}/${bucketPrefix}${media.objectName}`;
    }
    return created;
  }
}

export async function FrontCvRoutes(app: FastifyInstance) {
  const controller = new FrontCvController();
  app.post("/front/cv", controller.upload.bind(controller));
}
