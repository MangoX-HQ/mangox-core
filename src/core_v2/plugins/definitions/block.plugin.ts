/**
 * Core V2 - Block Plugin
 * Handles block content management for entities
 */

import {
  definePlugin,
  PluginDefinition,
  PluginContext,
} from "../plugin-manager";
import {
  IntermediateQuery,
  QueryResult,
  isSingleData,
} from "../../query/intermediate";
import { ObjectId } from "mongodb";

// ============================================================================
// BLOCK INTERFACES
// ============================================================================

/**
 * Block item structure
 */
export interface BlockItem {
  _id?: string;
  type?: "create" | "update" | "delete";
  entity_content?: string;
  locale?: string;
  tenant_id?: string;
  [key: string]: unknown;
}

/**
 * Bulk operation result
 */
export interface BulkOperationResult {
  insertedIds?: Record<number, string>;
  modifiedCount?: number;
  deletedCount?: number;
}

/**
 * Interface for block operations
 */
export interface IBlockOperations {
  bulkWrite(
    collection: string,
    operations: unknown[],
    session?: unknown,
  ): Promise<BulkOperationResult>;
  findOne(
    collection: string,
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  find(
    collection: string,
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown[]>;
  invalidateCache(collections: string[]): Promise<void>;
}

let blockOperations: IBlockOperations | null = null;

export function setBlockOperations(ops: IBlockOperations): void {
  blockOperations = ops;
}

export function getBlockOperations(): IBlockOperations | null {
  return blockOperations;
}

// ============================================================================
// BLOCK HELPERS
// ============================================================================

/**
 * Convert to ObjectId safely
 */
function toObjectIdSafe(
  id: unknown,
  converter?: (id: string) => unknown,
): unknown {
  if (!converter) return id;
  if (typeof id === "string") {
    return converter(id);
  }
  return id;
}

/**
 * Process block items for bulk operations
 */
function processBlocksForBulk(
  blocks: BlockItem[],
  entityId: string,
  locale: string,
  tenantId: string,
  existingBlocks: string[], 
  generateId: () => ObjectId,
): { operations: unknown[]; newBlockIds: string[] } {
  const operations: unknown[] = [];
  const newBlockIds: string[] = [];

  for (const item of blocks) {
    if (item._id && existingBlocks.includes(item._id)) {
      // Update existing block
      const { _id, type, ...updateData } = item;
      // The client sends _id as a string; block-content._id stores an ObjectId → MUST coerce,
      // otherwise the filter {_id:"..."} won't match the ObjectId → update silently affects 0 docs
      // (the content block does NOT change). toObjectIdSafe returns null if not hex → keep it as a string.
      const filterId = toObjectIdSafe(_id, (v) => new ObjectId(v)) || _id;
      operations.push({
        updateOne: {
          filter: { _id: filterId },
          update: { $set: updateData },
          upsert: false,
        },
      });
      newBlockIds.push(_id);
    } else {
      // Create new block — store _id as an ObjectId for consistency (so later updates can match).
      const newId = toObjectIdSafe(item._id, (v) => new ObjectId(v)) || generateId();
      const { _id, type, ...createData } = item;
      operations.push({
        insertOne: {
          document: {
            _id: newId,
            ...createData,
            entity_content: entityId,
            locale,
            tenant_id: tenantId,
          },
        },
      });
      newBlockIds.push(newId.toString());
    }
  }

  // Mark deleted blocks (existingId is a string → coerce to ObjectId to match the real _id)
  for (const existingId of existingBlocks) {
    if (!blocks.find((b) => b._id === existingId)) {
      operations.push({
        updateOne: {
          filter: { _id: toObjectIdSafe(existingId, (v) => new ObjectId(v)) || existingId },
          update: { $set: { deleted: true } },
        },
      });
    }
  }

  return { operations, newBlockIds };
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Block plugin - manages block content
 *
 * Entity config:
 * - use_block: true/false - Enable/disable plugin
 */
export const blockPlugin: PluginDefinition = definePlugin("use_block", {
  description: "Handles block content management for entities",
  phases: ["before", "after"],
  priority: 50,
  enabled: true,

  before: async (
    query: IntermediateQuery,
    context: PluginContext,
  ): Promise<void> => {
    if (!blockOperations) {
      console.warn("[use_block] Block operations not configured, skipping");
      return;
    }

    // Only handle single data operations (not bulk)
    if (!isSingleData(query.data)) {
      return;
    }

    const data = query.data;
    if (!Array.isArray(data.blocks_position)) {
      return;
    }

    const session = query.metadata?.options?.session;
    const locale = (data.locale as string) || "vi";
    const tenantId = (data.tenant_id as string) || "";
    const generateId = () => new ObjectId();

    switch (query.type) {
      case "insert": {
        const entityId = toObjectIdSafe(data._id, (id) => new ObjectId(id)) || generateId().toString();
        data._id = entityId;

        const blocks = (data.blocks_position as BlockItem[]).map((item) => ({
          ...item,
          _id: generateId(),
          // entity_content is always stored as a string for consistency with the update branch
          // (toObjectIdSafe above can return an ObjectId when data._id is already present).
          entity_content: String(entityId),
          locale,
          tenant_id: tenantId,
        }));

        if (blocks.length > 0) {
          const operations = blocks.map((block) => ({
            insertOne: { document: block },
          }));

          const result = await blockOperations.bulkWrite(
            "block-content",
            operations,
            session,
          );
          data.blocks_position = blocks.map((b) => b._id.toString());
          await blockOperations.invalidateCache([
            "block-content",
            query.collection,
          ]);
        }
        break;
      }

      case "update": {
        // entityId (record _id) is only used to assign entity_content to NEW blocks. Taken from
        // hints.id, falling back to the entity_content the client sends along with the block.
        const id =
          (query.metadata?.hints?.id as string) ||
          ((data.blocks_position as any[]).find((b) => b?.entity_content)
            ?.entity_content as string) ||
          "";
        if (!id) return;

        // Existing blocks — used to decide update-vs-mark-deleted. The collection is LOGICAL
        // so findOne may return null (the data lives in post-type-content): do NOT return, treat
        // it as if there's no existing block. processBlocksForBulk still normalizes correctly: a block with
        // an _id → upsert by the block's _id; no _id → create new.
        // Existing blocks — query block-content DIRECTLY by entity_content (record id),
        // do NOT fetch the parent record (entity is LOGICAL in post-type-content → findOne returns null →
        // mark-deleted wouldn't run). Correct for polymorphic entities too.
        const existingDocs = (await blockOperations.find(
          "block-content",
          { entity_content: id, deleted: { $ne: true } },
          { session },
        )) as Record<string, unknown>[];
        const existingBlocks = existingDocs.map((b) => String(b._id));
        const { operations, newBlockIds } = processBlocksForBulk(
          data.blocks_position as BlockItem[],
          id,
          locale,
          tenantId,
          existingBlocks,
          () => generateId(),
        );

        if (operations.length > 0) {
          await blockOperations.bulkWrite("block-content", operations, session);
          data.blocks_position = newBlockIds;
          await blockOperations.invalidateCache([
            "block-content",
            query.collection,
          ]);
        }
        break;
      }

      case "delete": {
        const id = query.metadata?.hints?.id as string;
        if (!id) return;

        // Mark block-content deleted by entity_content (do NOT fetch the parent record).
        const blocks = (await blockOperations.find(
          "block-content",
          { entity_content: id, deleted: { $ne: true } },
          { session },
        )) as Record<string, unknown>[];

        const operations = blocks.map((b) => ({
          updateOne: {
            filter: { _id: b._id },
            update: { $set: { deleted: true } },
          },
        }));

        if (operations.length > 0) {
          await blockOperations.bulkWrite("block-content", operations, session);
          await blockOperations.invalidateCache([
            "block-content",
            query.collection,
          ]);
        }
        break;
      }

      case "deleteMany": {
        const ids = query.metadata?.hints?.id as string[];
        if (!ids || !Array.isArray(ids) || ids.length === 0) return;

        const blocks = (await blockOperations.find(
          "block-content",
          { entity_content: { $in: ids }, deleted: { $ne: true } },
          { session },
        )) as Record<string, unknown>[];

        const operations = blocks.map((b) => ({
          updateOne: {
            filter: { _id: b._id },
            update: { $set: { deleted: true } },
          },
        }));

        if (operations.length > 0) {
          await blockOperations.bulkWrite("block-content", operations, session);
          await blockOperations.invalidateCache([
            "block-content",
            query.collection,
          ]);
        }
        break;
      }
    }
  },

  after: async (
    query: IntermediateQuery,
    context: PluginContext,
    nativeQuery?: unknown,
    result?: QueryResult,
  ): Promise<void> => {
    if (query.type !== "read" || !result?.data || result.data.length !== 1) {
      return;
    }

    if (!blockOperations) return;

    const item = result.data[0] as Record<string, unknown>;
    const rawPositions = item.blocks_position as any[];

    if (!rawPositions || !Array.isArray(rawPositions) || rawPositions.length === 0) {
      return;
    }

    // Corrupted data: blocks_position directly stores the block OBJECT (already embedded) instead of an array
    // of IDs — just use the embedded object as blocks_position_data, to avoid a 500.
    const embedded = rawPositions.filter(
      (b) => b && typeof b === "object" && !(b instanceof ObjectId) && b.content !== undefined,
    );
    if (embedded.length > 0) {
      item.blocks_position_data = embedded;
      return;
    }

    // Standard case: an array of IDs. Only convert actual 24-char hex strings → ObjectId (ObjectId.isValid
    // is more lenient than `new ObjectId` in bson 6.x → easily throws "Argument passed in does not
    // match the accepted types" and a 500). Drop empty elements.
    const blockIds = rawPositions
      .filter((id) => id != null)
      .map((id) => {
        if (id instanceof ObjectId) return id;
        if (typeof id === "string" && /^[a-fA-F0-9]{24}$/.test(id)) {
          try { return new ObjectId(id); } catch { return id; }
        }
        return id;
      });
    // Fetch block content
    const blocks = await blockOperations.find("block-content", {
      _id: { $in: blockIds },
    });

    item.blocks_position_data = blocks;
  },
});

export default blockPlugin;
