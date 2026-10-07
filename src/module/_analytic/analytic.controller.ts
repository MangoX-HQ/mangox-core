/**
 * Analytics CRM — submission + lead stats for the dashboard.
 *
 * GET /analytic/crm?from=&to=&form=  → 1 combined payload:
 *   overview, submissions_by_form/stage/day, attribution (utm), leads_by_assignee.
 *
 * Scope by role: super_admin/admin see the WHOLE tenant; other roles (e.g. `user`) only see
 * submissions of leads assigned to themselves (assigned_to = current user).
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getCoreUnified } from "../../configs/core";

class AnalyticController {
  private async ctx(request: FastifyRequest) {
    const tenantId = request.headers["x-tenant-id"] as string | undefined;
    // Verify JWT (signed) — this route doesn't go through the policy layer, so it self-verifies to block anonymous access.
    let user: any = null;
    try { user = await (request as any).jwtVerify(); } catch { user = null; }
    if (!user) {
      const h = (request.headers as any).user; // Some flows already attach a decoded token
      if (h && typeof h === "object") user = h;
    }
    const userId = user?.id || user?._id || user?.sub;
    const role = user?.role_name || user?.role_system;
    const isAdmin = !!user?.is_super_admin || role === "admin" || role === "super_admin";
    return { tenantId, userId, isAdmin };
  }

  async crm(request: FastifyRequest, reply: FastifyReply) {
    const { tenantId, userId, isAdmin } = await this.ctx(request);
    if (!tenantId) {
      reply.statusCode = 400;
      return { statusCode: 400, message: "Missing X-Tenant-ID" };
    }
    if (!userId) {
      reply.statusCode = 401;
      return { statusCode: 401, message: "Unauthorized" };
    }
    const q = (request.query as any) || {};
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    const formId = q.form || null;
    const locale = q.locale === "en" ? "en" : "vi"; // only changes the displayed TITLE; count always merges vi+en

    const db = await getCoreUnified().getInstanceDB("mongodb", tenantId);
    const sub = db.collection("form-builder-content");
    const leadCol = db.collection("lead");

    // ── Scope: regular role → only leads assigned to themselves ──────────────
    const leadMatch: any = { tenant_id: tenantId };
    if (!isAdmin) leadMatch.assigned_to = userId; // mongo matches even when assigned_to is an array containing userId
    const subMatch: any = { tenant_id: tenantId };
    if (formId) subMatch.form_builder = formId;
    if (!isAdmin) {
      const myLeadIds = (await leadCol.find(leadMatch, { projection: { _id: 1 } }).toArray())
        .map((l: any) => l._id.toString());
      subMatch.lead_id = { $in: myLeadIds };
    }
    // range filter (created_at) applies to the "in_range" part + breakdown
    const rangeMatch: any = { ...subMatch };
    if (from || to) {
      rangeMatch.created_at = {};
      if (from) rangeMatch.created_at.$gte = from;
      if (to) rangeMatch.created_at.$lte = to;
    }

    const topN = (field: string) => sub.aggregate([
      { $match: { ...rangeMatch, [field]: { $nin: [null, ""] } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]).toArray();

    const [
      submissions_total, leads_total, submissions_in_range,
      byFormRaw, byStage, byDay,
      bySource, byMedium, byCampaign,
      byAssignee,
      forms,
    ] = await Promise.all([
      sub.countDocuments(subMatch),
      leadCol.countDocuments(leadMatch),
      sub.countDocuments(rangeMatch),
      sub.aggregate([{ $match: rangeMatch }, { $group: { _id: "$form_builder", count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
      sub.aggregate([{ $match: rangeMatch }, { $group: { _id: { $ifNull: ["$form_stage", "new"] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
      sub.aggregate([
        { $match: rangeMatch },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      topN("utm_source"), topN("utm_medium"), topN("utm_campaign"),
      leadCol.aggregate([{ $match: leadMatch }, { $group: { _id: { $ifNull: ["$assigned_to", "unassigned"] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
      db.collection("form-builder").find({ tenant_id: tenantId }, { projection: { title: 1, mongodb_collection_name: 1, locale: 1, locale_id: 1 } }).toArray(),
    ]);

    // form-builder is use_locale (vi/en share the same locale_id) → MERGE submissions by locale_id group
    // (count SHARED across vi+en); displayed title follows ?locale= (default vi).
    const idToGroup: Record<string, string> = {};
    const groupTitle: Record<string, Record<string, string>> = {};
    forms.forEach((f: any) => {
      const id = f._id.toString();
      const gid = String(f.locale_id || id);
      idToGroup[id] = gid;
      (groupTitle[gid] ||= {})[f.locale || "vi"] = f.title;
    });
    const titleOf = (gid: string) =>
      groupTitle[gid]?.[locale] || groupTitle[gid]?.vi || Object.values(groupTitle[gid] || {})[0] || null;
    const byGroup: Record<string, number> = {};
    for (const r of byFormRaw as any[]) {
      const gid = idToGroup[String(r._id)] || String(r._id);
      byGroup[gid] = (byGroup[gid] || 0) + r.count;
    }
    const submissions_by_form = Object.entries(byGroup)
      .map(([gid, count]) => ({ form: gid, title: titleOf(gid), count }))
      .sort((a, b) => b.count - a.count);

    return {
      statusCode: 200,
      data: {
        scope: isAdmin ? "all" : "assigned",
        locale,
        range: { from: q.from || null, to: q.to || null },
        overview: {
          submissions_total,
          leads_total,
          submissions_in_range,
        },
        submissions_by_form,
        submissions_by_stage: byStage.map((r: any) => ({ form_stage: r._id, count: r.count })),
        submissions_by_day: byDay.map((r: any) => ({ date: r._id, count: r.count })),
        attribution: {
          by_source: bySource.map((r: any) => ({ utm_source: r._id, count: r.count })),
          by_medium: byMedium.map((r: any) => ({ utm_medium: r._id, count: r.count })),
          by_campaign: byCampaign.map((r: any) => ({ utm_campaign: r._id, count: r.count })),
        },
        leads_by_assignee: byAssignee.map((r: any) => ({ assigned_to: r._id, count: r.count })),
      },
      meta: "",
    };
  }
}

export async function AnalyticRoutes(app: FastifyInstance) {
  const controller = new AnalyticController();
  app.get("/analytic/crm", controller.crm.bind(controller));
}
