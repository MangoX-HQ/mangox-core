/**
 * Core V2 - MongoDB Filter Converter
 * Converts intermediate filter conditions to MongoDB filter format
 */

import { Document, ObjectId } from "mongodb";
import {
  FieldCondition,
  FilterGroup,
  Filter,
  isFilterGroup,
  isFieldCondition,
} from "../../../query/intermediate";
import {
  ComparisonOperator,
  FunctionCall,
  isFunctionCall,
} from "../../../types";
import { OPERATOR_MAP, toObjectId, toObjectIdArray } from "../types";

// ============================================================================
// FILTER CONVERTER
// ============================================================================

/**
 * MongoDB Filter Converter
 */
export class MongoDBFilterConverter {
  /**
   * Convert intermediate filter to MongoDB filter
   */
  static convert(filter: Filter): Document {
    if (Array.isArray(filter)) {
      // Array of conditions - combine with $and
      return this.convertConditionArray(filter);
    }

    if (isFilterGroup(filter)) {
      return this.convertFilterGroup(filter);
    }

    if (isFieldCondition(filter)) {
      return this.convertFieldCondition(filter);
    }

    return {};
  }

  /**
   * Convert array of field conditions
   */
  static convertConditionArray(conditions: FieldCondition[]): Document {
    if (conditions.length === 0) return {};

    if (conditions.length === 1) {
      return this.convertFieldCondition(conditions[0]);
    }

    return {
      $and: conditions.map((c) => this.convertFieldCondition(c)),
    };
  }

  /**
   * Convert security filters (always FieldCondition[])
   */
  static convertSecurityFilters(filters: FieldCondition[]): Document {
    return this.convertConditionArray(filters);
  }

  /**
   * Convert a filter group (logical operator)
   */
  static convertFilterGroup(group: FilterGroup): Document {
    const conditions: Document[] = [];

    // Add direct conditions
    if (group.conditions && group.conditions.length > 0) {
      for (const condition of group.conditions) {
        conditions.push(this.convertFieldCondition(condition));
      }
    }

    // Add nested groups
    if (group.nested && group.nested.length > 0) {
      for (const nestedGroup of group.nested) {
        conditions.push(this.convertFilterGroup(nestedGroup));
      }
    }

    if (conditions.length === 0) return {};

    switch (group.operator) {
      case "and":
        return conditions.length === 1 ? conditions[0] : { $and: conditions };

      case "or":
        return { $or: conditions };

      case "not":
        return conditions.length === 1
          ? { $not: conditions[0] }
          : { $nor: conditions };

      default:
        return { $and: conditions };
    }
  }

  /**
   * Convert a single field condition
   */
  static convertFieldCondition(condition: FieldCondition): Document {
    let { field, operator, value } = condition;

    // Resolve dynamic value
    const resolvedValue = this.resolveValue(value, field, operator);
    if (field === "id") {
      field = "_id";
    }
    // Convert operator
    const mongoFilter = this.convertOperator(field, operator, resolvedValue);

    return mongoFilter;
  }

  /**
   * Convert operator to MongoDB format
   */
  private static convertOperator(
    field: string,
    operator: ComparisonOperator,
    value: unknown,
  ): Document {
    switch (operator) {
      case "eq":
        return { [field]: value };

      case "neq":
        return { [field]: { $ne: value } };

      case "gt":
        return { [field]: { $gt: value } };

      case "gte":
        return { [field]: { $gte: value } };

      case "lt":
        return { [field]: { $lt: value } };

      case "lte":
        return { [field]: { $lte: value } };

      case "in":
        return { [field]: { $in: Array.isArray(value) ? value : [value] } };

      case "nin":
        return { [field]: { $nin: Array.isArray(value) ? value : [value] } };

      case "exists":
        return { [field]: { $exists: value === true || value === "true" } };

      case "null":
        return { [field]: null };

      case "notnull":
        return { [field]: { $ne: null } };

      case "regex":
        return { [field]: { $regex: value, $options: "i" } };

      case "like":
        return {
          [field]: { $regex: this.escapeRegex(String(value)), $options: "i" },
        };

      case "ilike":
        return {
          [field]: { $regex: this.escapeRegex(String(value)), $options: "i" },
        };

      case "contains":
        return {
          [field]: { $regex: this.escapeRegex(String(value)), $options: "i" },
        };

      case "startswith":
        return {
          [field]: {
            $regex: `^${this.escapeRegex(String(value))}`,
            $options: "i",
          },
        };

      case "endswith":
        return {
          [field]: {
            $regex: `${this.escapeRegex(String(value))}$`,
            $options: "i",
          },
        };

      case "not_contains":
        return {
          [field]: {
            $not: { $regex: this.escapeRegex(String(value)), $options: "i" },
          },
        };

      case "not_startswith":
        return {
          [field]: {
            $not: {
              $regex: `^${this.escapeRegex(String(value))}`,
              $options: "i",
            },
          },
        };

      case "not_endswith":
        return {
          [field]: {
            $not: {
              $regex: `${this.escapeRegex(String(value))}$`,
              $options: "i",
            },
          },
        };

      case "between":
        if (Array.isArray(value) && value.length >= 2) {
          return { [field]: { $gte: value[0], $lte: value[1] } };
        }
        return {};

      case "not_between":
        if (Array.isArray(value) && value.length >= 2) {
          return {
            $or: [
              { [field]: { $lt: value[0] } },
              { [field]: { $gt: value[1] } },
            ],
          };
        }
        return {};

      default:
        // Fallback to equality
        return { [field]: value };
    }
  }

  /**
   * Resolve dynamic value (function calls)
   */
  private static resolveValue(
    value: unknown,
    field: string,
    operator: ComparisonOperator,
  ): unknown {
    // Handle function calls
    if (isFunctionCall(value)) {
      return this.executeFunctionCall(value);
    }

    const isIdField = field === "_id" || field.endsWith("._id");

    // Handle arrays with possible function calls
    if (Array.isArray(value)) {
      return value.map((v) => {
        if (isFunctionCall(v)) return this.executeFunctionCall(v);
        // Auto-convert string IDs inside `in.[...]` / `nin.[...]` for _id fields.
        if (isIdField && typeof v === "string" && ObjectId.isValid(v)) {
          return new ObjectId(v);
        }
        return v;
      });
    }

    // Auto-convert _id fields to ObjectId (single-value operators).
    if (isIdField && typeof value === "string" && ObjectId.isValid(value)) {
      return new ObjectId(value);
    }

    return value;
  }

  /**
   * Execute a function call
   */
  private static executeFunctionCall(func: FunctionCall): unknown {
    switch (func.functionName) {
      case "toObjectId":
        return toObjectId(func.args[0] as string);

      case "arrayToObjectId":
        return toObjectIdArray(func.args[0] as string[]);

      case "now":
        return new Date();

      case "today":
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return today;
      case "nowSubDaysNotTime":
        const days = func.args[0] as number;
        const dateSub = new Date();
        dateSub.setDate(dateSub.getDate() - days);
        // set YYY-MM-DD not time
        const yyyy = dateSub.getFullYear();
        const mm = String(dateSub.getMonth() + 1).padStart(2, "0");
        const dd = String(dateSub.getDate()).padStart(2, "0");

        const result = `${yyyy}-${mm}-${dd}`;

        return result;

      case "currentUser":
        // This would be handled by context
        return func.args[0] || null;

      case "addDays":
        const date = new Date();
        date.setDate(date.getDate() + (func.args[0] as number));
        return date;

      case "subDays":
        const subDate = new Date();
        subDate.setDate(subDate.getDate() - (func.args[0] as number));
        return subDate;

      default:
        // Return as-is if unknown function
        return func;
    }
  }

  /**
   * Escape special regex characters
   */
  private static escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

/**
 * Convenience function to convert filter
 */
export function convertFilter(filter: Filter): Document {
  return MongoDBFilterConverter.convert(filter);
}

/**
 * Convenience function to convert security filters
 */
export function convertSecurityFilters(filters: FieldCondition[]): Document {
  return MongoDBFilterConverter.convertSecurityFilters(filters);
}
