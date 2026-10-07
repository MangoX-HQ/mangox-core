import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AppError } from "../../utils/app-error";
import { OptionsInput } from "../../core_v2/compat";
import { mediaMinioService } from "../_media/media-minio.service";
import { runWithTenantSlug } from "../../core_v2/adapters/mongodb/tenant-context";
import { TENANT_SLUG } from "../../configs/tenant";
import { frontFormBuilderService } from "./front-form-builder.service";

const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx", ".png", ".jpg", ".jpeg", ".gif", ".webp"];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB default fallback

async function withSlugContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const headerTenantId = (request.headers["x-tenant-id"] as string) || undefined;
  if (!headerTenantId) return fn();
  const slug = TENANT_SLUG || headerTenantId;
  return runWithTenantSlug(slug, headerTenantId, fn);
}

function getFileSchemaFields(formBuilder: any): string[] {
  const props = formBuilder?.json_schema?.properties || {};
  return Object.keys(props).filter(
    (k) => props[k].widget === "file" || props[k].widget === "multipleFiles",
  );
}

function isValidExtension(filename: string): boolean {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf("."));
  return ALLOWED_EXTENSIONS.includes(ext);
}

class FrontFormBuilderController {
  async submit(request: FastifyRequest, reply: FastifyReply) {
    return withSlugContext(request, () => this._submit(request, reply));
  }

  private async _submit(request: FastifyRequest, reply: FastifyReply) {
    const { slug } = request.params as { slug: string };
    const { locale } = (request.query as any) || {};
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    const options: OptionsInput = {
      databaseType: "mongodb",
      is_tenant: true,
      frontAPI: true,
      log: request.log,
      tenant_id: tenantHeader,
      roles: ["guest"],
    };

    const { formBuilder } = await frontFormBuilderService.getFormBuilder(
      slug,
      locale ?? "vi",
      options,
    );
    if (!formBuilder) throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Form builder not found" });

    const formData = await this.parseFormData(request, formBuilder, tenantHeader);
    const result = await frontFormBuilderService.submit(slug, locale ?? "vi", formData, options);
    if (result?.statusCode) reply.statusCode = result.statusCode;
    return result;
  }

  private async parseFormData(
    request: FastifyRequest,
    formBuilder: any,
    tenant_id?: string,
  ): Promise<any> {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      const body = (request as any).body;
      if (body && typeof body === "object") return body;
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: "[ERROR] Please check the form data. Maybe missing some fields" });
    }

    const schemaFileFields = getFileSchemaFields(formBuilder);
    const data: any = {};
    let fileCount = 0;
    let uploadedFile: { buffer: Buffer; filename: string; mimetype: string } | null = null;

    for await (const part of (request as any).parts()) {
      if (part.type === "file") {
        fileCount++;
        if (fileCount > 1) {
          throw new AppError({
            statusCode: 400,
            code: 'BAD_REQUEST',
            message: "[ERROR] Chỉ được phép upload 1 file mỗi lần. Vui lòng chỉ gửi 1 file.",
          });
        }
        if (!part.filename || !isValidExtension(part.filename)) {
          throw new AppError({
            statusCode: 400,
            code: 'BAD_REQUEST',
            message: "[ERROR] Chỉ được phép upload file định dạng .pdf, .doc, .docx, .png, .jpg, .jpeg, .gif, .webp",
          });
        }
        const fileBuffer = await part.toBuffer();
        if (fileBuffer.length > MAX_FILE_SIZE) {
          const mb = (fileBuffer.length / (1024 * 1024)).toFixed(2);
          const limitMb = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
          throw new AppError({
            statusCode: 400,
            code: 'BAD_REQUEST',
            message: `[ERROR] File quá lớn. Kích thước: ${mb}MB. Giới hạn: ${limitMb}MB.`,
          });
        }
        uploadedFile = { buffer: fileBuffer, filename: part.filename, mimetype: part.mimetype };
        continue;
      }
      data[part.fieldname] = part.value;
    }

    if (uploadedFile) {
      const fakeFile = {
        filename: uploadedFile.filename,
        mimetype: uploadedFile.mimetype,
        size: uploadedFile.buffer.length,
        toBuffer: async () => uploadedFile!.buffer,
      };
      // cv:true → saved into a separate form-builder bucket (kept apart from the media dashboard).
      const media: any = await mediaMinioService.create(
        { title: uploadedFile.filename, alt: uploadedFile.filename },
        fakeFile,
        tenant_id,
        undefined,
        { cv: true },
      );
      const targetField = schemaFileFields[0] ?? "file";
      data[targetField] = media._id?.toString?.() ?? media.id;
    }

    return data;
  }
}

export async function FrontFormBuilderRoutes(app: FastifyInstance) {
  const controller = new FrontFormBuilderController();
  app.post("/front/form-builder-content/:slug", controller.submit.bind(controller));
}
