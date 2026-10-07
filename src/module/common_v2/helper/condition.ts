import { IntermediateQueryResult } from "../../../core_v2/compat";
import { getDeepValue } from "./helper";

export interface QueryBuilderRule {
  field?: string;
  operator?: string;
  value?: any;
  combinator?: string;
  rules?: QueryBuilderRule[];
}

/**
 * Evaluates a react-querybuilder style condition against a context map.
 *
 * Two leaf-rule shapes are supported:
 *
 *   1. Existence check (legacy):  `{ value: "<alias>" }`
 *      Passes if `context[alias].data.length > 0`.
 *
 *   2. Field comparison:          `{ field, operator, value }`
 *      `field` is `<alias>.<path>` — e.g. `wallet.credit_balance`. The path
 *      resolves against the first row of `context[alias].data` (or the entry
 *      itself if there's no `.data`). Supported operators:
 *        eq, neq, gt, gte, lt, lte, in, nin, exists, notexists, contains
 *
 * Useful for policy guards like "block when credit_balance <= 0".
 */
export const evaluateContextCondition = (
  condition: QueryBuilderRule | null | undefined,
  context: Record<string, IntermediateQueryResult>,
): boolean => {
  if (!condition) return true;

  const resolveField = (fieldPath: string): unknown => {
    const [alias, ...rest] = fieldPath.split(".");
    const entry: any = context[alias];
    if (!entry) return undefined;
    const base = Array.isArray(entry?.data) ? entry.data[0] : entry;
    if (rest.length === 0) return base;
    return getDeepValue(rest.join(":"), base);
  };

  const evalOperator = (op: string, a: unknown, b: unknown): boolean => {
    switch (op) {
      case "eq":         return String(a) === String(b);
      case "neq":        return String(a) !== String(b);
      case "gt":         return Number(a) >  Number(b);
      case "gte":        return Number(a) >= Number(b);
      case "lt":         return Number(a) <  Number(b);
      case "lte":        return Number(a) <= Number(b);
      case "in":         return Array.isArray(b) && b.map(String).includes(String(a));
      case "nin":        return !(Array.isArray(b) && b.map(String).includes(String(a)));
      case "exists":     return a !== undefined && a !== null && a !== "";
      case "notexists":  return a === undefined || a === null || a === "";
      case "contains":   return typeof a === "string" && typeof b === "string" && a.includes(b);
      default:           return false;
    }
  };

  const evaluate = (node: QueryBuilderRule): boolean => {
    if (!node.rules) {
      // Field comparison: { field, operator, value }
      if (node.field && node.operator) {
        const fieldValue = resolveField(node.field);
        // Alias-only field (e.g. "wallet"): treat exists/notexists as alias-existence check
        if (!node.field.includes(".") && (node.operator === "exists" || node.operator === "notexists")) {
          const entry: any = context[node.field];
          const has = !!(entry && Array.isArray(entry.data) && entry.data.length > 0);
          return node.operator === "exists" ? has : !has;
        }
        return evalOperator(node.operator, fieldValue, node.value);
      }
      // Legacy alias-only leaf: { value: "<alias>" } — passes if data exists
      const alias = typeof node.value === "string" ? node.value : undefined;
      if (!alias) return true;
      const entry: any = context[alias];
      return !!(entry && Array.isArray(entry.data) && entry.data.length > 0);
    }

    const results = node.rules.map((rule) => evaluate(rule));
    if (results.length === 0) return true;
    const combinator = (node.combinator ?? "and").toLowerCase();
    if (combinator === "or") return results.some((r) => r);
    return results.every((r) => r);
  };

  return evaluate(condition);
};
