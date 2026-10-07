import { IntermediateQueryResult, OptionsInput } from "../../../configs/core";
import { FilterGroup } from "../../../core_v2";

export const getDataFromPrefix = (obj: any, prefix: string) => {
  if (prefix === '') {
    return obj;
  }
  const keys = prefix.split(".");
  const result = getValueRecursive(obj, keys);
  
  // Flatten and deduplicate nested arrays at the end
  return flattenAndDeduplicate(result);
}

/**
 * Flatten nested arrays and remove duplicates
 */
const flattenAndDeduplicate = (value: any): any => {
  if (!Array.isArray(value)) return value;

  const hasNestedArray = value.some((item: any) => Array.isArray(item));
  if (!hasNestedArray) return value;

  const flatten = (arr: any[]): any[] => {
    const result: any[] = [];
    for (const item of arr) {
      if (Array.isArray(item)) {
        result.push(...flatten(item));
      } else {
        result.push(item);
      }
    }
    return result;
  };

  const flattened = flatten(value);
  const seen = new Set();
  const unique: any[] = [];

  for (const item of flattened) {
    const key =
      typeof item === "object" && item !== null ? JSON.stringify(item) : item;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  return unique;
};

/**
 * Recursively get value from nested object/array structure using dot notation path
 */
const getValueRecursive = (current: any, keys: string[]): any => {
  // Base case: no more keys to process
  if (keys.length === 0) return current;

  // Handle null/undefined
  if (current === null || current === undefined) return undefined;

  const [firstKey, ...remainingKeys] = keys;

  // Handle arrays - recursively process each item
  if (Array.isArray(current)) {
    return current.map((item: any) => getValueRecursive(item, keys));
  }

  // Handle objects
  if (typeof current === "object") {
    const nextValue = current[firstKey];
    return getValueRecursive(nextValue, remainingKeys);
  }

  // Primitive value - cannot traverse further
  return undefined;
};

/**
 * Get deep value from object using dot notation path
 * Handles nested arrays and objects
 */
export const getDeepValue = (path: string, obj: any): any => {
  if (!path || path === "") return obj;

  const keys = path.split(":");
  const result = getValueRecursive(obj, keys);

  // Flatten and deduplicate nested arrays at the end
  return flattenAndDeduplicate(result);
};


// execute

export const excuteDataWithCondition = (
  filterCondition: FilterGroup,
  data: any,
): boolean => {
  if (!filterCondition) {
    return true;
  }

  const evaluateCondition = (condition: FilterGroup): boolean => {
    console.log('Evaluating condition:', JSON.stringify(condition, null, 2));
    const results: boolean[] = [];

    // Evaluate direct conditions
    if (condition.conditions && condition.conditions.length > 0) {
      for (const cond of condition.conditions) {
        const fieldValue = cond.field.includes('.')
          ? getDataFromPrefix(data, cond.field)
          : data[cond.field];
        let result = false;

        switch (cond.operator) {
          case 'eq':
            // Normalize both values to strings for ObjectId comparison
            result = String(fieldValue) === String(cond.value);
            break;
          case 'neq':
            result = String(fieldValue) !== String(cond.value);
            break;
          case 'gt':
            result = fieldValue > (cond.value as any);
            break;
          case 'lt':
            result = fieldValue < (cond.value as any);
            break;
          case 'gte':
            result = fieldValue >= (cond.value as any);
            break;
          case 'lte':
            result = fieldValue <= (cond.value as any);
            break;
          case 'in':
            {
              // Parse value using helper function
              const valueArray = parseArrayValue(cond.value);
              console.log('IN condition values:', valueArray, fieldValue);
              // Handle array field values (e.g., entity: ['id1', 'id2'])
              if (Array.isArray(fieldValue)) {
                // Check if any element in fieldValue exists in valueArray
                const normalizedField = fieldValue?.map(v => String(v));
                const normalizedValues = valueArray?.map(v => String(v));
                result = normalizedField.some(fv => normalizedValues.includes(fv));
                console.log('Array field comparison:', {
                  normalizedField,
                  normalizedValues,
                  result
                });
              } else {
                // Single field value
                const normalizedField = String(fieldValue);
                const normalizedValues = valueArray?.map(v => String(v));
                result = normalizedValues.includes(normalizedField);
                console.log('Single field comparison:', {
                  normalizedField,
                  normalizedValues,
                  result
                });
              }
            }
            break;
          case 'nin':
            {
              // Parse value using helper function
              const valueArray = parseArrayValue(cond.value);

              // Handle array field values
              if (Array.isArray(fieldValue)) {
                // Check if NO element in fieldValue exists in valueArray
                const normalizedField = fieldValue?.map(v => String(v));
                const normalizedValues = valueArray?.map(v => String(v));
                result = !normalizedField.some(fv => normalizedValues.includes(fv));
              } else {
                // Single field value
                const normalizedField = String(fieldValue);
                const normalizedValues = valueArray?.map(v => String(v));
                result = !normalizedValues.includes(normalizedField);
              }
            }
            break;
          case 'like':
          case 'ilike':
            // SQL LIKE: % = any chars, _ = single char
            {
              const pattern = String(cond.value).replace(/%/g, '.*').replace(/_/g, '.');
              const flags = cond.operator === 'ilike' ? 'i' : '';
              result = new RegExp(`^${pattern}$`, flags).test(String(fieldValue));
            }
            break;
          case 'regex':
            result = new RegExp(String(cond.value)).test(String(fieldValue));
            break;
          case 'exists':
            {
              const exists = fieldValue !== undefined && fieldValue !== null;
              const expectTrue = String(cond.value).toLowerCase() !== 'false';
              result = expectTrue ? exists : !exists;
            }
            break;
          case 'null':
            result = fieldValue === null || fieldValue === undefined;
            break;
          case 'notnull':
            result = fieldValue !== null && fieldValue !== undefined;
            break;
          case 'contains':
            result = String(fieldValue).includes(String(cond.value));
            break;
          case 'not_contains':
            result = !String(fieldValue).includes(String(cond.value));
            break;
          case 'startswith':
            result = String(fieldValue).startsWith(String(cond.value));
            break;
          case 'not_startswith':
            result = !String(fieldValue).startsWith(String(cond.value));
            break;
          case 'endswith':
            result = String(fieldValue).endsWith(String(cond.value));
            break;
          case 'not_endswith':
            result = !String(fieldValue).endsWith(String(cond.value));
            break;
          case 'between':
            // value should be [min, max]
            if (Array.isArray(cond.value) && cond.value.length === 2) {
              result = fieldValue >= cond.value[0] && fieldValue <= cond.value[1];
            } else {
              result = false;
            }
            break;
          case 'not_between':
            // value should be [min, max]
            if (Array.isArray(cond.value) && cond.value.length === 2) {
              result = fieldValue < cond.value[0] || fieldValue > cond.value[1];
            } else {
              result = false;
            }
            break;
          default:
            result = false;
        }

        results.push(result);
      }
    }

    // Evaluate nested conditions
    if (condition.nested && condition.nested.length > 0) {
      for (const nestedCond of condition.nested) {
        const nestedResult = evaluateCondition(nestedCond);
        results.push(nestedResult);
      }
    }

    // No conditions means always true
    if (results.length === 0) {
      return true;
    }

    // Apply logical operator
    let finalResult: boolean;
    switch (condition.operator) {
      case 'and':
        finalResult = results.every(res => res);
        break;
      case 'or':
        finalResult = results.some(res => res);
        break;
      case 'not':
        finalResult = !results.every(res => res);
        break;
      default:
        // Default to AND
        finalResult = results.every(res => res);
    }
    console.log('Condition result:', {
      operator: condition.operator,
      results,
      finalResult
    });
    return finalResult;
  };

  return evaluateCondition(filterCondition);
}

export const excuteDatasWithCondition = (
  obj: any,
  data: Record<string, IntermediateQueryResult<any>>,
): boolean => {
  if (!obj) return true;

  const evaluate = (node: any): boolean => {
    // Leaf rule: { field, operator, value } where value is an alias
    if (!node.rules) {
      const alias = node.value;
      const entry = data[alias];
      return !!(entry && entry.data && entry.data.length > 0);
    }

    // Group node: { combinator, rules }
    const results = node.rules.map((rule: any) => evaluate(rule));

    if (results.length === 0) return true;

    const combinator = (node.combinator ?? 'and').toLowerCase();
    if (combinator === 'or') {
      return results.some((r: boolean) => r);
    }
    return results.every((r: boolean) => r);
  };

  return evaluate(obj);
}

/**
 * Parse array-like string to actual array
 * Handles formats:
 * - '["id1", "id2"]' (JSON)
 * - '[id1, id2]' (MongoDB-like)
 * - 'id1,id2' (CSV)
 * - 'id1' (single value)
 */
const parseArrayValue = (value: any): any[] => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [value];
  }

  const trimmed = value.trim();

  // Try JSON parse first
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      // Not valid JSON, try manual parsing
      // Remove brackets
      const content = trimmed.slice(1, -1).trim();
      if (!content) return [];

      // Split by comma and clean each value
      return content.split(',')?.map(v => {
        const cleaned = v.trim();
        // Remove quotes if present
        if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
            (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
          return cleaned.slice(1, -1);
        }
        return cleaned;
      }).filter(v => v); // Remove empty strings
    }
  }

  // CSV format (comma-separated)
  if (trimmed.includes(',')) {
    return trimmed.split(',')?.map(v => v.trim()).filter(v => v);
  }

  // Single value
  return [trimmed];
};
