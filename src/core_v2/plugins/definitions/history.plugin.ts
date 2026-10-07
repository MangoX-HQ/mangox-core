/**
 * Core V2 - History Plugin
 * Tracks change history for records
 * Saves history to a separate collection
 */

import {
  definePlugin,
  PluginDefinition,
  PluginContext,
} from "../plugin-manager";
import { IntermediateQuery, isSingleData, QueryResult } from "../../query/intermediate";

// ============================================================================
// HISTORY INTERFACES
// ============================================================================

/**
 * History entry saved to separate collection
 */
export interface HistoryEntry {
  /** Reference to the original record (ObjectId) */
  record_id: unknown;
  /** Collection name of the original record */
  collection: string;
  /** User who made the change */
  user: {
    _id: string;
    name: string;
  };
  /** When the change was made */
  timestamp: Date;
  /** Action type: insert, update, delete */
  action: 'insert' | 'update' | 'delete';
  /** Status rule name */
  rule?: string;
  /** Reason for the change (e.g., rejection reason) */
  reason?: string;
  /** Status code */
  status_approve?: string;
  /** Changed data */
  changes?: Record<string, unknown>;
  /** Tenant ID */
  tenant_id?: string;
}

/**
 * Interface for user lookup
 */
export interface IUserLookup {
  getUserName(userId: string): Promise<string>;
}

/**
 * Interface for history database operations
 */
export interface IHistoryOperations {
  /** Insert a history entry to the history collection */
  insert(entry: HistoryEntry, session?: unknown): Promise<void>;
  /** Find history entries for a record */
  findByRecordId(recordId: string, collection: string): Promise<HistoryEntry[]>;
}

let userLookup: IUserLookup | null = null;
let historyOperations: IHistoryOperations | null = null;

export function setUserLookup(lookup: IUserLookup): void {
  userLookup = lookup;
}

export function getUserLookup(): IUserLookup | null {
  return userLookup;
}

export function setHistoryOperations(operations: IHistoryOperations): void {
  historyOperations = operations;
}

export function getHistoryOperations(): IHistoryOperations | null {
  return historyOperations;
}

// ============================================================================
// STATUS HELPERS
// ============================================================================

/**
 * Get rule name from status code
 */
function getStatusRule(status: string): string {
  const statusMap: Record<string, string> = {
    "0": "published",
    "1": "unpublished",
    "-1": "draft",
    "-2": "reject",
    "2": "send to review",
    "3": "send to publish",
    "-3": "waiting",
  };
  return statusMap[status] || status;
}

/**
 * Create history entry for separate collection
 */
async function createHistoryEntry(
  recordId: unknown,
  collection: string,
  action: 'insert' | 'update' | 'delete',
  data: Record<string, unknown>,
  userId: string,
  tenantId?: string
): Promise<HistoryEntry> {
  const userName = userLookup
    ? await userLookup.getUserName(userId)
    : "Unknown";
  const status = String(data.status_approve || "");

  return {
    record_id: recordId,
    collection: collection,
    action: action,
    user: {
      _id: userId,
      name: userName,
    },
    rule: getStatusRule(status),
    status_approve: status,
    reason: data.reason as string | undefined,
    changes: data,
    tenant_id: tenantId,
    timestamp: new Date(),
  };
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * History plugin - tracks change history
 *
 * Entity config:
 * - use_history: true/false - Enable/disable plugin
 *
 * Query options:
 * - history: true - Include history in read results
 */
export const historyPlugin: PluginDefinition = definePlugin("use_history", {
  description: "Tracks change history for records and saves to separate collection",
  phases: ["main", "after"],
  priority: 40,
  enabled: true,

  after: async (
    query: IntermediateQuery,
    _context: PluginContext,
    _nativeQuery?: unknown,
    result?: QueryResult
  ): Promise<void> => {
    // Skip if no history operations configured
    if (!historyOperations) {
      console.warn('[HistoryPlugin] History operations not configured, skipping...');
      return; 
    }

    // Skip read operations
    if (query.type === "read") return;

    const userId = query.metadata?.user?.user_id;
    if (!userId) return;

    const tenantId = query.metadata?.user?.tenant_id;
    const collection = query.collection;
    const session = query.metadata?.options?.session;

    switch (query.type) {
      case "insert": {
        // Get inserted record from result
        const insertedData = result?.data?.[0] as Record<string, unknown> | undefined;
        if (!insertedData?._id) return;

        const historyEntry = await createHistoryEntry(
          insertedData._id, // Keep as ObjectId
          collection,
          'insert',
          insertedData,
          userId,
          tenantId
        );

        await historyOperations.insert(historyEntry, session);
        break;
      }

      case "update":
      case "updateMany": {
        // Get updated data from query.data (the changes being applied)
        if (!isSingleData(query.data)) return;
        const updateData = query.data;

        // Get the record ID from result or security filters
        const updatedRecord = result?.data?.[0] as Record<string, unknown> | undefined;
        let recordId: unknown = updatedRecord?._id;

        if (!recordId) {
          // Try to get from security filters (usually _id filter)
          const idFilter = query.securityFilters?.find(f => f.field === '_id');
          recordId = idFilter?.value;
        }

        if (!recordId) return;

        const historyEntry = await createHistoryEntry(
          recordId, // Keep as ObjectId
          collection,
          'update',
          updateData,
          userId,
          tenantId
        );

        await historyOperations.insert(historyEntry, session);
        break;
      }

      case "delete": {
        // Get deleted record ID
        const deletedRecord = result?.data?.[0] as Record<string, unknown> | undefined;
        let recordId: unknown = deletedRecord?._id;

        if (!recordId) {
          const idFilter = query.securityFilters?.find(f => f.field === '_id');
          recordId = idFilter?.value;
        }

        if (!recordId) return;

        const historyEntry = await createHistoryEntry(
          recordId, // Keep as ObjectId
          collection,
          'delete',
          deletedRecord || {},
          userId,
          tenantId
        );

        await historyOperations.insert(historyEntry, session);
        break;
      }
    }
  },

  main: (
    query: IntermediateQuery,
    _context: PluginContext,
    nativeQuery?: unknown
  ): void => {
    if (query.type !== "read") return;
    if (!Array.isArray(nativeQuery)) return;

    const options = query.metadata?.options || {};

    // If history option is explicitly false, exclude history
    if (options.history === false) {
      nativeQuery.push({ $project: { history: 0 } });
      return;
    }

    const historyLimit = typeof options.historyLimit === 'number' ? options.historyLimit : 20;

    // Tenant isolation: only return history belonging to the tenant being queried (prevents leaking
    // data when multiple tenants share the same DB). Every history record must have a tenant_id.
    const lookupTenantId = query.metadata?.user?.tenant_id;
    const pipeline: any[] = [];
    if (lookupTenantId) {
      pipeline.push({ $match: { tenant_id: lookupTenantId } });
    }
    pipeline.push({ $sort: { timestamp: -1 } });
    pipeline.push({ $limit: historyLimit });

    // $lookup with localField/foreignField + pipeline (MongoDB 5.0+)
    nativeQuery.push({
      $lookup: {
        from: 'history',
        localField: '_id',
        foreignField: 'record_id',
        pipeline,
        as: 'history',
      },
    });
  },
});

export default historyPlugin;
