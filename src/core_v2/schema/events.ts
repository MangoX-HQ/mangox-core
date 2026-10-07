/**
 * Audit log emitter.
 *
 * The schema cache (entity/policy/resource/...) syncs via JsonStore → SchemaSync,
 * there's no separate event bus anymore. This module only keeps logEmitter to write audit logs
 * to the `logs` collection (per-tenant if tenant_id is present).
 */

import { EventEmitter } from "stream";
import { getCoreUnified } from "../../configs/core";

export const logEmitter = new EventEmitter();

logEmitter.on("writeLog", async (log) => {
  try {
    const tenantId = log?.tenant_id || undefined;
    const db = await getCoreUnified().getInstanceDB("mongodb", tenantId);
    await db.collection("logs").insertOne(log);
  } catch (err) {
    console.error("[logEmitter] Log error:", err);
  }
});
