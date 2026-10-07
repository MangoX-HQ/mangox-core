/**
 * Core V2 - Get-Parent Plugin (use_get_parent)
 *
 * Expands TREE relationship filters on READ: a frontend filter `<field>=eq.<_id>` → the plugin fetches
 * ALL descendants (every level) of that _id, then rewrites it to `<field>=in.[_id, child, grandchild, ...]`.
 *
 * Per-entity config: `use_get_parent: "category,tag"` (list of fields to expand).
 * Does not hard-code 'category' — each field's target collection comes from the RelationshipRegistry
 * (already tenant-scoped). The tree is traversed via `$graphLookup` on `parent_id_obj` (stored by the parent plugin).
 */
import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, Filter, FieldCondition, isFilterGroup, isFieldCondition } from '../../query/intermediate';
import { getRelationshipRegistry } from '../../adapters/base/relationship-registry';
import { getTenantDb } from '../../adapters/mongodb/tenant-context';

/** Collects every FieldCondition (keeping REFERENCES so they can be mutated in place) from a Filter — recurses into group/array. */
function collectConditions(filter: Filter | undefined): FieldCondition[] {
  if (!filter) return [];
  if (Array.isArray(filter)) return filter.flatMap((f) => collectConditions(f as Filter));
  if (isFilterGroup(filter)) {
    return [
      ...(filter.conditions || []),
      ...((filter.nested || []).flatMap((g) => collectConditions(g as Filter))),
    ];
  }
  if (isFieldCondition(filter)) return [filter];
  return [];
}

/**
 * Gets [rootId, ...all descendants flattened] for a node in a tree collection.
 * Traverses via the `parent_id` field (an array of STRINGs = parent _id — the parent plugin/importer convention).
 * Uses in-memory BFS: _id is an ObjectId while parent_id is a string, so $graphLookup can't
 * match them directly; load (_id, parent_id) and traverse by STRING comparison, which is reliable.
 */
async function getSubtreeIds(coll: string, rootId: string): Promise<string[]> {
  const db = getTenantDb();
  if (!db) return [rootId];
  try {
    const all = await db.collection(coll).find({}, { projection: { _id: 1, parent_id: 1 } }).toArray();
    const childrenOf = new Map<string, string[]>();
    for (const c of all) {
      const pids = Array.isArray((c as any).parent_id)
        ? (c as any).parent_id
        : (c as any).parent_id != null ? [(c as any).parent_id] : [];
      for (const p of pids) {
        const ps = String(p);
        (childrenOf.get(ps) ?? childrenOf.set(ps, []).get(ps)!).push(String(c._id));
      }
    }
    const result = [rootId];
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const ch of childrenOf.get(cur) || []) {
        if (!seen.has(ch)) { seen.add(ch); result.push(ch); queue.push(ch); }
      }
    }
    return result;
  } catch {
    return [rootId];
  }
}

export const getParentPlugin: PluginDefinition = definePlugin('use_get_parent', {
  description: 'Expand filter quan hệ cây: <field>=eq.<id> → in.[id + tất cả con]',
  phases: ['before'],
  priority: 20,
  enabled: true,

  before: async (query: IntermediateQuery, context: PluginContext): Promise<void> => {
    if (query.type !== 'read') return;
    const cfg = (context.entityConfig as any)?.use_get_parent;
    const fields = String(cfg || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!fields.length) return;

    const reg = getRelationshipRegistry();
    const conds = collectConditions(query.userFilter);
    for (const field of fields) {
      const cond = conds.find((c) => c.field === field && c.operator === 'eq' && c.value != null);
      if (!cond) continue;
      // Target collection comes from the RelationshipRegistry (already tenant-scoped). Falls back to the entity's json_schema
      // in case the registry hasn't registered this field yet.
      let target = reg.findByLocalField(context.collection, field)?.targetCollection;
      if (!target) {
        const def = (context.entityConfig as any)?.json_schema?.properties?.[field];
        target = def?.typeRelation?._id ? String(def.typeRelation._id) : undefined;
      }
      if (!target) continue;
      const ids = await getSubtreeIds(target, String(cond.value));
      if (ids.length > 1) {
        cond.operator = 'in';
        cond.value = ids;
      }
    }
  },
});
