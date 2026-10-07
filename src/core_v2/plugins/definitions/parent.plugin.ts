/**
 * Core V2 - Parent Plugin
 * Handles tree structure with parent_id relationships.
 *
 * Ported from the production codebase (current_code core/plugin/
 * treeFormatValidate/{parent.ts,toTree.ts}) — the previous v2 reimpl was
 * incomplete (wrong depth handling, missing $graphLookup/locale filter).
 */

import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, QueryResult, isSingleData } from '../../query/intermediate';

// ============================================================================
// TREE HELPERS
// ============================================================================

interface TreeNode {
  _id?: string;
  locale_id?: string;
  parent_id?: string | string[];
  parent_id_obj?: unknown;
  is_root?: boolean;
  children?: TreeNode[];
  level?: number;
  position?: number;
  [key: string]: unknown;
}

/**
 * Build a nested tree from a root whose `children` is a FLAT array produced by
 * $graphLookup (each child carries a 0-based `level` depthField, pre-sorted by
 * {level, position}). Stack-by-level — identical to production toTree.ts.
 */
export function buildTreeFromFlat(flat: TreeNode[]): TreeNode[] {
  if (!flat || flat.length === 0) return [];

  const rootItem = flat[0];
  if (flat.length === 1 && rootItem.children && Array.isArray(rootItem.children)) {
    const root: TreeNode = { ...rootItem };
    const childrenFlat = root.children || [];

    const allNodes = childrenFlat.map((item) => {
      const node: TreeNode = { ...item };
      if (!node.children) node.children = [];
      return node;
    });

    root.children = [];
    const stack: TreeNode[] = [];

    allNodes.forEach((node) => {
      const level = node.level ?? 0;
      stack.length = level; // reset deeper levels (queue behavior)

      if (level === 0) {
        root.children!.push(node);
        stack[0] = node;
      } else {
        const parent = stack[level - 1];
        if (parent) {
          parent.children = parent.children || [];
          parent.children.push(node);
        } else {
          root.children!.push(node);
        }
        stack[level] = node;
      }
    });

    return [root];
  }

  return flat;
}

/**
 * Flatten a nested tree (from a tree-save PUT) into a flat array, recomputing
 * parent_id / parent_id_obj / is_root per node. Ported from toTree.ts; uses
 * the injected ObjectId validator instead of importing mongodb here.
 */
export function flattenTree(
  data: TreeNode | TreeNode[],
  parentId?: string,
  result: TreeNode[] = [],
): TreeNode[] {
  // Tree-save body is an array of roots — flatten each.
  if (Array.isArray(data)) {
    for (const node of data) flattenTree(node, parentId, result);
    return result;
  }

  const newData: TreeNode = {
    _id: data._id,
    position: data.position,
    is_root: true,
    parent_id: [],
    parent_id_obj: null,
  };

  if (parentId && objectIdValidator && objectIdValidator.isValid(parentId)) {
    newData.parent_id = [parentId];
    newData.parent_id_obj = objectIdValidator.create(parentId);
    newData.is_root = false;
  } else if (parentId) {
    newData.parent_id = [parentId];
    newData.is_root = false;
  }
  result.push(newData);

  if (data.children && Array.isArray(data.children)) {
    for (const child of data.children) {
      flattenTree(child, data._id, result);
    }
  }

  return result;
}

// ============================================================================
// OBJECT ID VALIDATOR (kept db-agnostic — registered at bootstrap)
// ============================================================================

export interface IObjectIdValidator {
  isValid(id: unknown): boolean;
  create(id: string): unknown;
}

let objectIdValidator: IObjectIdValidator | null = null;

export function setObjectIdValidator(validator: IObjectIdValidator): void {
  objectIdValidator = validator;
}

export function getObjectIdValidator(): IObjectIdValidator | null {
  return objectIdValidator;
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

export const parentPlugin: PluginDefinition = definePlugin('use_parent', {
  description: 'Handles tree structure with parent_id relationships',
  phases: ['before', 'main', 'after'],
  priority: 30,
  enabled: true,

  before: (query: IntermediateQuery, context: PluginContext): void => {
    const options = query.metadata?.options || {};
    const data = query.data;

    if (options.tree) {
      if (query.type === 'read') {
        query.sort = [
          { field: 'position', direction: 'desc' },
          ...(query.sort || []),
        ];
        query.securityFilters.push({
          field: 'is_root',
          operator: 'eq',
          value: true,
        });
      } else if (
        (query.type === 'update' || query.type === 'updateMany' || query.type === 'bulkUpdate') &&
        data
      ) {
        // Tree-save: flatten nested children → bulkUpdate of flat rows with
        // recomputed parent_id/is_root/position.
        const d: any = data;
        // core-service.update() + the /many controller strip `_id` from data
        // into the query filter. flattenTree needs the root _id to link
        // children — recover it from the userFilter / securityFilters.
        if (d && !Array.isArray(d) && !d._id) {
          const conds: any[] = [
            ...((query.userFilter as any)?.conditions || []),
            ...((query.securityFilters as any[]) || []),
          ];
          const idCond = conds.find(
            (c) => (c?.field === '_id' || c?.field === 'id') && c?.value,
          );
          if (idCond) d._id = String(idCond.value);
        }
        query.type = 'bulkUpdate';
        query.data = flattenTree(data as TreeNode | TreeNode[]) as unknown as typeof query.data;
      }
    } else if (
      isSingleData(data) &&
      (query.type === 'insert' || query.type === 'update' || query.type === 'updateMany')
    ) {
      const parentId = data.parent_id;
      if (parentId && objectIdValidator) {
        if (typeof parentId === 'string' && objectIdValidator.isValid(parentId)) {
          data.parent_id_obj = objectIdValidator.create(parentId);
          data.is_root = false;
        } else if (
          Array.isArray(parentId) &&
          parentId.length > 0 &&
          objectIdValidator.isValid(parentId[0])
        ) {
          data.parent_id_obj = objectIdValidator.create(parentId[0]);
          data.is_root = false;
        } else if (Array.isArray(parentId) && parentId.length === 0) {
          data.parent_id = [];
          data.is_root = true;
          data.parent_id_obj = null;
        }
      } else if (parentId === null || (Array.isArray(parentId) && parentId.length === 0)) {
        data.parent_id = [];
        data.is_root = true;
        data.parent_id_obj = null;
      }
    }
  },

  main: (query: IntermediateQuery, context: PluginContext, nativeQuery?: unknown): void => {
    const options = query.metadata?.options || {};
    if (!Array.isArray(nativeQuery) || !options.tree || query.type !== 'read') {
      return;
    }

    const pipeline = nativeQuery as Record<string, unknown>[];
    if (pipeline.some((s) => s && typeof s === 'object' && '$graphLookup' in s)) {
      return; // already injected
    }

    const ec = (context.entityConfig as Record<string, unknown>) || {};
    const fromCollection =
      (ec.mongodb_save_data as string) ||
      (ec.collection_name as string) ||
      context.collection;
    const locale =
      ((query.metadata as Record<string, any>)?.originalParams?.locale as string) ?? 'vi';
    const useParent = !!ec.use_parent;

    // Production semantics: use_parent entities restrict the graph walk to
    // non-deleted nodes; otherwise restrict by locale. The locale $filter
    // below always trims cross-locale descendants regardless.
    const restrictSearchWithMatch = useParent
      ? { $or: [{ deleted: { $exists: false } }, { deleted: false }] }
      : { locale };

    // Insert AFTER the root page ($limit) but BEFORE the relation $lookups /
    // $project. The v2 query builder injects a `parent_id → locale_id`
    // relation $lookup that rewrites `parent_id` into objects; if $graphLookup
    // ran after that, connectToField:'parent_id' would match objects and find
    // nothing. (Production didn't have that auto-join, hence its push-at-end.)
    const stages: Record<string, unknown>[] = [
      {
        $graphLookup: {
          from: fromCollection,
          startWith: '$locale_id',
          connectFromField: 'locale_id',
          connectToField: 'parent_id',
          as: 'children',
          maxDepth: 2, // production cap → up to 3 levels deep
          depthField: 'level',
          restrictSearchWithMatch,
        },
      },
      {
        $set: {
          children: {
            $filter: {
              input: '$children',
              as: 'child',
              cond: { $eq: ['$$child.locale', locale] },
            },
          },
        },
      },
      {
        $set: {
          children: {
            $sortArray: {
              input: '$children',
              sortBy: { level: 1, position: 1 },
            },
          },
        },
      },
      {
        $addFields: {
          _posMissing: {
            $cond: [{ $eq: [{ $type: '$position' }, 'missing'] }, 1, 0],
          },
          _posIsNull: { $cond: [{ $eq: ['$position', null] }, 1, 0] },
        },
      },
      { $sort: { _posMissing: 1, _posIsNull: 1, position: 1 } },
      { $unset: ['_posMissing', '_posIsNull'] },
    ];

    const limitIdx = pipeline.findIndex(
      (s) => s && typeof s === 'object' && '$limit' in s,
    );
    const insertAt = limitIdx >= 0 ? limitIdx + 1 : pipeline.length;
    pipeline.splice(insertAt, 0, ...stages);
  },

  after: (
    query: IntermediateQuery,
    context: PluginContext,
    nativeQuery?: unknown,
    result?: QueryResult,
  ): void => {
    if (query.type !== 'read' || !result?.data || result.data.length === 0) {
      return;
    }
    const options = query.metadata?.options || {};
    if (!options.tree) return;

    if (result.data.length === 1) {
      result.data = buildTreeFromFlat(result.data as TreeNode[]) as typeof result.data;
    } else {
      result.data = (result.data as TreeNode[]).map((item) => {
        const processed = buildTreeFromFlat([item]);
        return processed[0] || item;
      }) as typeof result.data;
    }
  },
});

export default parentPlugin;
