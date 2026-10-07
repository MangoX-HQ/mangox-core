import nodemailer from "nodemailer";
import handlebars from "handlebars";
import { ObjectId } from "mongodb";
import { getCoreUnified } from "../../configs/core";
import { OptionsInput } from "../../core_v2/compat";
import { AppError } from "../../utils/app-error";
import { appSettings } from "../../configs/app-settings";
import { getGlobalValidator } from "../../core_v2/schema";
import { resolveTenantBuckets } from "../_media/helpers/tenant-bucket";

interface MailOptions {
  subject: string;
  from: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  html: string;
  attachments?: any[];
}

interface FormBuilderData {
  _id: any;
  json_schema: any;
  fields_attachments?: string;
  template_mail?: any;
}

interface TemplateMail {
  notification_mail?: {
    is_active: boolean;
    send_subject: string;
    send_body: string;
    send_to: string;
    send_to_cc?: string;
    send_to_bcc?: string;
    attachments_field?: string;
  };
  reply_mail?: {
    is_active: boolean;
    send_subject: string;
    send_body: string;
    send_to: string;
  };
}

/** Per-tenant mail configuration, read from the `config-settings` entity (the `mail` group). */
interface TenantMailConfig {
  is_active?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  mail_pass?: string;
  from?: string;
  from_name?: string;
}

/** Transporter + resolved From address for a tenant. */
interface ResolvedMailer {
  transporter: nodemailer.Transporter;
  from: string;
}

class FrontFormBuilderService {
  /**
   * Reads the tenant's mail config from the `config-settings` entity (the `mail` group) and builds
   * the transporter. Does NOT fall back to .env: missing config / is_active off / missing
   * host|user|password → returns null so the caller SKIPS sending mail + logs it (each tenant must
   * configure this themselves). Reads fresh on every submit (form submits are low-frequency) so it isn't cached
   * — avoids using stale creds right after an admin changes the config.
   */
  private async resolveMailer(tenantId?: string): Promise<ResolvedMailer | null> {
    if (!tenantId) return null;
    let mail: TenantMailConfig | undefined;
    try {
      const db = await getCoreUnified().getInstanceDB("mongodb", tenantId);
      const doc = await db.collection("config-settings").findOne({});
      mail = (doc as any)?.mail;
    } catch (err) {
      console.error(`[front-form-builder] đọc config-settings tenant ${tenantId} lỗi`, err);
      return null;
    }
    if (!mail || mail.is_active === false) return null;
    if (!mail.host || !mail.user || !mail.mail_pass) return null;

    const port = Number(mail.port) || 587;
    // secure=true = implicit TLS, ONLY correct for port 465. STARTTLS ports (587/25/2525) must
    // use secure=false and then upgrade to TLS. Many tenants mistakenly configure 587 + secure=true
    // → nodemailer performs an implicit TLS handshake on a STARTTLS port → SSL error "wrong version number",
    // mail fails SILENTLY (fire-and-forget). Force secure based on the port to prevent this mistake.
    let secure = mail.secure ?? port === 465;
    if (secure && port !== 465) secure = false;
    const transporter = nodemailer.createTransport({
      host: mail.host,
      port,
      secure,
      requireTLS: !secure, // secure=false → STARTTLS is mandatory (never sends plaintext)
      auth: { user: mail.user, pass: mail.mail_pass },
    });
    // `from` may already be the full form "Name <email>" → use it as-is, do NOT wrap it further with
    // from_name (to avoid nesting "Name <Name <email>>"). Only prepend the name when from is a bare email.
    let from: string;
    if (mail.from && mail.from.includes("<")) {
      from = mail.from;
    } else {
      const fromEmail = mail.from || mail.user!;
      from = mail.from_name ? `"${mail.from_name}" <${fromEmail}>` : fromEmail;
    }
    return { transporter, from };
  }

  private replaceVars(template: string, data: any): string {
    if (!template || !data) return template;
    return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
      const k = key.trim();
      return data[k] !== undefined ? data[k] : match;
    });
  }

  private splitEmails(s?: string): string[] {
    if (!s) return [];
    return s.split(",").map((e) => e.trim()).filter(Boolean);
  }

  async getFormBuilder(
    slug: string,
    locale: string,
    options: OptionsInput,
  ): Promise<{ formBuilder: FormBuilderData; templateMail: TemplateMail | null }> {
    // Read form-builder with a raw Mongo query (bypassing core.findAll/policy): only need
    // json_schema + template_mail to submit, and since form-builder json_schema is deeply nested,
    // going through core/relation resolve is both redundant and heavy (has caused OOM before). Fetch it directly by slug.
    const db = await getCoreUnified().getInstanceDB("mongodb", options?.tenant_id);
    const formBuilder = (await db.collection("form-builder").findOne({
      mongodb_collection_name: slug,
      locale: locale || "vi",
    })) as unknown as FormBuilderData | null;
    if (!formBuilder) throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: "Form builder not found" });

    // `template_mail` is stored as an array [<id>] (an unpopulated relation). Not embedded via
    // policy because joining on a deeply nested form json_schema causes OOM → take the id then fetch the
    // template-mail record with one extra (lightweight) fetch. If it's already an object (already populated), use it directly.
    const templateMail = await this.resolveTemplateMail(formBuilder?.template_mail, options?.tenant_id);
    return { formBuilder, templateMail };
  }

  private async resolveTemplateMail(
    templateMailField: any,
    tenantId?: string,
  ): Promise<TemplateMail | null> {
    const first = Array.isArray(templateMailField) ? templateMailField[0] : templateMailField;
    if (!first) return null;
    if (typeof first === "object") return first as TemplateMail; // already populated

    try {
      const db = await getCoreUnified().getInstanceDB("mongodb", tenantId);
      const doc = await db
        .collection("template-mail")
        .findOne({ _id: new ObjectId(String(first)) });
      return (doc as any) ?? null;
    } catch (err) {
      console.error("[front-form-builder] fetch template-mail lỗi", err);
      return null;
    }
  }

  /**
   * Verify reCAPTCHA according to the tenant's config-settings (token sent by FE in the `token` field):
   *  - has `captcha_v3_secret_key` → use v3: check `success` AND `score >= 0.5` (v3 takes priority even when both are present).
   *  - only has `captcha_v2_secret_key` → use v2 (checkbox/invisible, NO score): only check `success`.
   *  - no secret configured at all → SKIP (doesn't block submit).
   * token === 'SKIP_RECAPTCHA' → skip. Captcha enabled but token missing → 400. Verify fail → 403.
   * Config read error → doesn't block (fail-open, to avoid breaking the form due to infra errors).
   */
  private async verifyCaptcha(
    tenantId: string | undefined,
    token: any,
  ): Promise<{ ok: boolean; statusCode?: number; message?: string }> {
    if (!tenantId) return { ok: true };
    let v2Secret: string | undefined;
    let v3Secret: string | undefined;
    try {
      const db = await getCoreUnified().getInstanceDB("mongodb", tenantId);
      const doc: any = await db.collection("config-settings").findOne({});
      v2Secret = doc?.captcha_v2_secret_key || undefined;
      v3Secret = doc?.captcha_v3_secret_key || undefined;
    } catch (err) {
      console.error(`[front-form-builder] đọc captcha config tenant ${tenantId} lỗi`, err);
      return { ok: true };
    }
    // v3 takes priority (even when both are present); else v2; else not configured → skip
    const useV3 = !!v3Secret;
    const secret = useV3 ? v3Secret : v2Secret;
    if (!secret) return { ok: true };

    const t = typeof token === "string" ? token.trim() : "";
    if (!t) return { ok: false, statusCode: 400, message: "Missing reCAPTCHA token" };
    if (t === "SKIP_RECAPTCHA") return { ok: true };

    try {
      const url = `https://www.google.com/recaptcha/api/siteverify?secret=${encodeURIComponent(
        secret,
      )}&response=${encodeURIComponent(t)}`;
      const res = await fetch(url, { method: "POST" });
      const v: any = await res.json();
      // v3: needs success + score; v2: only needs success (no score)
      const passed = useV3
        ? v?.success === true && typeof v?.score === "number" && v.score >= 0.5
        : v?.success === true;
      if (!passed) {
        console.error("[front-form-builder] reCAPTCHA failed:", v);
        return { ok: false, statusCode: 403, message: "reCAPTCHA verification failed" };
      }
      return { ok: true };
    } catch (err) {
      console.error("[front-form-builder] reCAPTCHA verify error", err);
      return { ok: false, statusCode: 403, message: "reCAPTCHA verification failed" };
    }
  }

  async submit(slug: string, locale: string, data: any, options: OptionsInput) {
    // reCAPTCHA: FE sends the `token` along with the request. Verify against config-settings (v3>v2>skip) BEFORE saving.
    // Strip the token out of data (not saved into the record, and never passed through AJV validation).
    const captchaToken = data?.token;
    if (data && typeof data === "object" && "token" in data) delete data.token;
    const captcha = await this.verifyCaptcha(options?.tenant_id, captchaToken);
    if (!captcha.ok) {
      return { statusCode: captcha.statusCode ?? 403, success: false, message: captcha.message };
    }

    // Attribution: FE sends utm_*/gclid/fbclid/referrer/landing_page along with the request → stripped from data (bypasses AJV),
    // saved directly into the form-builder-content record to classify the submission source.
    const TRACK_KEYS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid','referrer','landing_page','page_url'];
    const tracking: any = {};
    for (const k of TRACK_KEYS) {
      if (data && typeof data === 'object' && k in data) {
        if (data[k] != null && data[k] !== '') tracking[k] = data[k];
        delete data[k];
      }
    }
    // FE may send the page URL at submit time under the key 'url' → mapped to page_url
    if (data && typeof data === 'object' && 'url' in data) {
      if (!tracking.page_url && data.url) tracking.page_url = data.url;
      delete data.url;
    }

    const { formBuilder, templateMail } = await this.getFormBuilder(slug, locale, options);

    const validator = getGlobalValidator();
    const ajvResult = validator.validateWithSchema(formBuilder.json_schema, data);
    if (!ajvResult.valid || !ajvResult.data) {
      return {
        statusCode: 400,
        message: (ajvResult.errors || []).map((e: any) => e.message || e).join("; "),
        fieldErrors: ajvResult.errors,
      };
    }
    const filteredData: any = ajvResult.data;
    if (data?.page) filteredData.page = data.page;
    if (options?.tenant_id) filteredData.tenant_id = options.tenant_id;
    if (data?.locale) filteredData.locale = data.locale;

    const now = new Date();
    const db = await getCoreUnified().getInstanceDB("mongodb", options?.tenant_id);
    const createPayload: any = {
      ...filteredData,
      ...tracking,                 // utm_*/gclid/fbclid/referrer/landing_page/page_url
      form_stage: "new",           // default processing stage
      tenant_id: options?.tenant_id,
      created_at: now,
      updated_at: now,
      form_builder: formBuilder._id.toString(),
    };
    const insert = await db.collection("form-builder-content").insertOne(createPayload);
    const savedData: any = { _id: insert.insertedId, ...createPayload };

    // CRM: upsert lead (dedup by email → E.164 phone) + assign lead_id. Lead errors must NOT break the submit.
    try {
      const leadId = await this.upsertLead(options?.tenant_id, insert.insertedId, data);
      if (leadId) savedData.lead_id = leadId.toString();
    } catch (err) {
      console.error("[front-form-builder] upsertLead failed", err);
    }

    // Sending mail runs in the BACKGROUND (fire-and-forget) — SMTP can take a few seconds, must NOT let
    // it block the response. The form is already saved; mail errors are just logged.
    void this.processEmailsAsync(templateMail, filteredData, options).catch((err) =>
      console.error("[front-form-builder] email background failed", err),
    );

    return { statusCode: 200, msg: "Form submitted successfully", data: savedData };
  }

  /** Normalize a phone number to E.164 (supports international). A domestic number without '+' uses the default country code (VN 84). */
  private normPhone(p: any, defaultCC = "84"): string {
    let s = String(p ?? "").replace(/[^\d+]/g, "");        // keep digits + '+'
    if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
    if (s.startsWith("00")) return "+" + s.slice(2);
    if (s.startsWith("0")) return "+" + defaultCC + s.slice(1);
    return s ? "+" + s : "";
  }

  /**
   * Upsert a CRM lead from a submission. Dedup: EMAIL (raw) → fallback to normalized E.164 phone, within the same tenant.
   * 1 person = 1 lead across ALL form types. Only fills in contact fields that are empty (doesn't overwrite data an admin edited by hand).
   * Assigns form-builder-content.lead_id. No email and no phone → skip (returns null).
   */
  private async upsertLead(tenantId: string | undefined, submissionId: any, data: any): Promise<any> {
    if (!tenantId) return null;
    const email = String(data?.email || "").trim().toLowerCase() || null;
    const phoneRaw = data?.so_dien_thoai || null;
    const phoneNorm = this.normPhone(phoneRaw) || null;
    if (!email && !phoneNorm) return null;

    const db = await getCoreUnified().getInstanceDB("mongodb", tenantId);
    const now = new Date();
    const contact: Record<string, any> = {
      email,
      full_name: data?.ho_ten || data?.ho_ten_founder || null,
      phone: phoneRaw,
      phone_normalized: phoneNorm,
      company: data?.to_chuc || data?.ten_doanh_nghiep || null,
    };

    const or: any[] = [];
    if (email) or.push({ email });
    if (phoneNorm) or.push({ phone_normalized: phoneNorm });
    const existing = await db.collection("lead").findOne({ tenant_id: tenantId, $or: or });

    let leadId: any;
    if (existing) {
      leadId = existing._id;
      const fill: Record<string, any> = {};   // only fills in fields that are empty
      for (const k of Object.keys(contact)) {
        if (contact[k] != null && contact[k] !== "" && (existing[k] == null || existing[k] === "")) fill[k] = contact[k];
      }
      await db.collection("lead").updateOne(
        { _id: leadId },
        { $set: { last_submitted_at: now, updated_at: now, ...fill }, $inc: { submission_count: 1 } },
      );
    } else {
      const ins = await db.collection("lead").insertOne({
        ...contact,
        submission_count: 1,
        last_submitted_at: now,
        tenant_id: tenantId,
        created_at: now,
        updated_at: now,
        collection_name: "lead",
      });
      leadId = ins.insertedId;
    }

    await db.collection("form-builder-content").updateOne(
      { _id: submissionId },
      { $set: { lead_id: leadId.toString() } },
    );
    return leadId;
  }

  private async processEmailsAsync(
    templateMail: TemplateMail | null,
    filteredData: any,
    options: OptionsInput,
  ): Promise<void> {
    if (!templateMail) return;

    const wantsMail =
      !!templateMail.notification_mail?.is_active || !!templateMail.reply_mail?.is_active;
    if (!wantsMail) return;

    // Mail config comes FROM THE TENANT (config-settings), no longer uses .env.
    const mailer = await this.resolveMailer(options?.tenant_id);
    if (!mailer) {
      console.warn(
        `[front-form-builder] tenant ${options?.tenant_id} chưa cấu hình mail (config-settings) — bỏ qua gửi mail`,
      );
      return;
    }

    const tasks: Promise<any>[] = [];

    if (templateMail.notification_mail?.is_active) {
      try {
        const compile = handlebars.compile(templateMail.notification_mail.send_body || "");
        const html = compile(filteredData);
        const mail: MailOptions = {
          subject: this.replaceVars(templateMail.notification_mail.send_subject || "", filteredData),
          from: mailer.from,
          to: this.splitEmails(templateMail.notification_mail.send_to),
          cc: this.splitEmails(templateMail.notification_mail.send_to_cc),
          bcc: this.splitEmails(templateMail.notification_mail.send_to_bcc),
          html,
          attachments: await this.buildAttachments(templateMail, filteredData, options),
        };
        tasks.push(mailer.transporter.sendMail(mail as any));
      } catch (err) {
        console.error("[front-form-builder] notification mail prepare failed", err);
      }
    }

    if (templateMail.reply_mail?.is_active) {
      try {
        const compile = handlebars.compile(templateMail.reply_mail.send_body || "");
        const html = compile(filteredData);
        const mail: MailOptions = {
          subject: this.replaceVars(templateMail.reply_mail.send_subject || "", filteredData),
          from: mailer.from,
          to: this.replaceVars(templateMail.reply_mail.send_to || "", filteredData),
          html,
        };
        tasks.push(mailer.transporter.sendMail(mail as any));
      } catch (err) {
        console.error("[front-form-builder] reply mail prepare failed", err);
      }
    }

    const results = await Promise.allSettled(tasks);
    results.forEach((r) => {
      if (r.status === "rejected") {
        console.error("[front-form-builder] gửi mail thất bại:", (r.reason as any)?.message || r.reason);
      }
    });
  }

  private async buildAttachments(
    templateMail: TemplateMail,
    filteredData: any,
    options: OptionsInput,
  ): Promise<any[]> {
    const field = templateMail.notification_mail?.attachments_field;
    if (!field || !filteredData[field]) return [];
    try {
      const ids = Array.isArray(filteredData[field]) ? filteredData[field] : [filteredData[field]];
      const media = await getCoreUnified()
        .getCore()
        .findAll({ _id: `in.[${ids.join(",")}]` }, "media", ["admin"], options);
      // Form-builder files live in cvBucket → use cvPublicUrl; regular files → publicUrl.
      const { bucket, publicUrl, cvBucket, cvPublicUrl } = await resolveTenantBuckets(options.tenant_id);
      return media.data.map((item: any) => {
        const base = (cvBucket && cvBucket !== bucket && item.bucketName === cvBucket) ? cvPublicUrl : publicUrl;
        return {
          filename: item.fileName,
          mimeType: item.mimeType,
          path: `${base}/${item.fileName}`,
        };
      });
    } catch (err) {
      console.error("[front-form-builder] attachments build failed", err);
      return [];
    }
  }
}

export const frontFormBuilderService = new FrontFormBuilderService();
