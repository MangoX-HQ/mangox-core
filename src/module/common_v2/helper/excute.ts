import {
  getCoreUnified,
  ICoreUnified,
  OptionsInput,
} from "../../../configs/core";
import { FilterGroup, IntermediateQueryResult, isFilterGroup } from "../../../core_v2/compat";
import { excuteDataWithCondition, getDeepValue } from "./helper";
import { getCache, setCache } from "./cache";
import { evaluateContextCondition } from "./condition";
import { conditionsRegex, mergeQueries } from "./builder";
import { schemaManager } from "../../../core_v2/schema/manager";
import { getTenantSlug } from "../../../core_v2/adapters/mongodb/tenant-context";

// Re-export from setting-mode (handles dev/prod switching)
export {
  getPolicies,
  getPolicyBySlug,
  getSetting,
  getFormSettingBySlug,
} from "../../_setting/setting-mode";


export type ContextDataResource = {
  entity: string;
  condtion?: string;
  alias: string;
};

type CaseItem = {
  value: string; // "operator.value" or "value" (eq implied)
  policy: string; // the policy's slug
};

const VALID_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "like",
  "ilike",
  "regex",
  "exists",
  "null",
  "notnull",
  "contains",
  "startswith",
  "endswith",
  "not_contains",
  "not_startswith",
  "not_endswith",
  "between",
  "not_between",
]);

const parseValue = (str: string): any => {
  if (str === "null") return null;
  if (str === "true") return true;
  if (str === "false") return false;
  if (/^\d+$/.test(str)) return parseInt(str);
  if (/^\d+\.\d+$/.test(str)) return parseFloat(str);
  return str;
};

const applyOperator = (
  operator: string,
  fieldValue: any,
  caseValue: any,
): boolean => {
  switch (operator) {
    case "eq":
      return String(fieldValue) === String(caseValue);
    case "neq":
      return String(fieldValue) !== String(caseValue);
    case "gt":
      return fieldValue > caseValue;
    case "gte":
      return fieldValue >= caseValue;
    case "lt":
      return fieldValue < caseValue;
    case "lte":
      return fieldValue <= caseValue;
    case "in":
      return Array.isArray(caseValue)
        ? caseValue.map(String).includes(String(fieldValue))
        : String(fieldValue) === String(caseValue);
    case "nin":
      return Array.isArray(caseValue)
        ? !caseValue.map(String).includes(String(fieldValue))
        : String(fieldValue) !== String(caseValue);
    case "exists":
      return fieldValue !== undefined && fieldValue !== null;
    case "null":
      return fieldValue === null || fieldValue === undefined;
    case "notnull":
      return fieldValue !== null && fieldValue !== undefined;
    case "contains":
      return String(fieldValue).includes(String(caseValue));
    case "not_contains":
      return !String(fieldValue).includes(String(caseValue));
    case "startswith":
      return String(fieldValue).startsWith(String(caseValue));
    case "not_startswith":
      return !String(fieldValue).startsWith(String(caseValue));
    case "endswith":
      return String(fieldValue).endsWith(String(caseValue));
    case "not_endswith":
      return !String(fieldValue).endsWith(String(caseValue));
    case "like":
    case "ilike": {
      const pattern = String(caseValue).replace(/%/g, ".*").replace(/_/g, ".");
      const flags = operator === "ilike" ? "i" : "";
      return new RegExp(`^${pattern}$`, flags).test(String(fieldValue));
    }
    case "regex":
      return new RegExp(String(caseValue)).test(String(fieldValue));
    case "between":
      if (Array.isArray(caseValue) && caseValue.length === 2)
        return fieldValue >= caseValue[0] && fieldValue <= caseValue[1];
      return false;
    case "not_between":
      if (Array.isArray(caseValue) && caseValue.length === 2)
        return fieldValue < caseValue[0] || fieldValue > caseValue[1];
      return false;
    default:
      return false;
  }
};

const matchCaseValue = (caseValueStr: string, switchValue: any): boolean => {
  const dotIndex = caseValueStr.indexOf(".");
  if (dotIndex > 0) {
    const potentialOp = caseValueStr.substring(0, dotIndex);
    if (VALID_OPERATORS.has(potentialOp)) {
      const rawValue = caseValueStr.substring(dotIndex + 1);
      const parsed = rawValue.startsWith("[")
        ? rawValue
            .slice(1, -1)
            .split(",")
            .map((v) => parseValue(v.trim()))
        : parseValue(rawValue);
      return applyOperator(potentialOp, switchValue, parsed);
    }
  }
  // fallback: eq
  return applyOperator("eq", switchValue, parseValue(caseValueStr));
};

/**
 * Execute setting: build context from context_data_resource,
 * resolve the switch expression, match Case[] → return the policy slug
 * Returns null if there is no setting, the switch is empty, or no case matches
 */
export const executeSetting = async (
  setting: any,
  options?: Record<string, any>,
): Promise<string | null> => {
  if (!setting) return null;

  // 1. Build context from context_data_resource
  const contextDataResource: ContextDataResource[] =
    setting.context_data_resource || [];
  const context: Record<string, any> = {};

  for (const item of contextDataResource) {
    let condtion = (item.condtion || "").replace(
      /@options:([\w:]+)/g,
      (_match: string, path: string) => {
        const value = getDeepValue(path, options);
        return value !== undefined ? JSON.stringify(value) : _match;
      },
    );
    const query = Object.fromEntries(new URLSearchParams(condtion));
    const cacheKey = `${item.entity}:${condtion}`;
    const cached = getCache(cacheKey);
    const result =
      cached ??
      (await getCoreUnified().getCore().findAll(query, item.entity, ["admin"]));
    if (!cached) setCache(cacheKey, result);
    context[item.alias] = result;
  }

  // 2. If there is no switch → no shortcut
  const switchExpr: string = (setting.switch || "").trim();
  if (!switchExpr) return null;

  // 3. Resolve the switch value from context (path uses ":" separator)
  const switchValue = getDeepValue(switchExpr, context);

  // 4. Match Case[]
  const cases: CaseItem[] = setting.Case || [];
  for (const c of cases) {
    if (matchCaseValue(c.value, switchValue)) {
      return c.policy; // the slug of the policy to use
    }
  }

  return null;
};

export const executePolicy = async (
  policy: any,
  options?: OptionsInput,
): Promise<Record<string, IntermediateQueryResult> | null> => {
  const contextDataResources: ContextDataResource[] = Array.isArray(policy.data)
    ? policy.data
    : [];

  const contextResults = await Promise.all(
    contextDataResources.map(async (item) => {
      let condtion = (item.condtion || "").replace(
        /@options:([\w:]+)/g,
        (_match: string, path: string) => {
          const value = getDeepValue(path, options);
          return value !== undefined ? JSON.stringify(value) : _match;
        },
      );
      const query = Object.fromEntries(new URLSearchParams(condtion));
      const cacheKey = `${item.entity}:${condtion}`;
      const cached = getCache(cacheKey);
      const result =
        cached ??
        (await getCoreUnified()
          .getCore()
          .findAll(query, item.entity, ["admin"]));
      if (!cached) setCache(cacheKey, result);
      return { key: item.alias || item.entity, value: result };
    }),
  );

  const context: Record<string, IntermediateQueryResult> = Object.fromEntries(
    contextResults.map(({ key, value }) => [key, value]),
  );

  // Execute code_context to enrich context before condition evaluation
  const codeContextFn: string = Array.isArray(policy.code_context) ? policy.code_context[0] : policy.code_context || "";
  if (codeContextFn) {
    const enriched = await executeCode(codeContextFn, context, options);
    if (enriched && typeof enriched === 'object') {
      Object.assign(context, enriched);
    }
  }

  if (!evaluateContextCondition(policy.condition_context, context)) {
    return null;
  }

  return context;
};

export const executeValidation = async (
  conditions: string,
  root_entity: string,
  body: any,
  context: Record<string, IntermediateQueryResult>,
  options?: OptionsInput,
) => {
  let conditions_build: string = conditionsRegex("context", context, conditions);
  // 2. Replacement for @options
  conditions_build = conditionsRegex("options", options, conditions_build);
  const queryCondition = Object.fromEntries(new URLSearchParams(conditions_build));
  const queryConverter = await getCoreUnified().getCore().getQueryConverter();
  const intermediateQuery = await queryConverter.convert(
    queryCondition,
    root_entity,
    {
      tenant_id: options?.tenant_id,
      user_id: options?.user_id || "anonymous",
      roles: options?.roles || [],
    },
  );
  let results: boolean = true;
  if (
    intermediateQuery.userFilter &&
    isFilterGroup(intermediateQuery.userFilter)
  ) {
    results = excuteDataWithCondition(
      intermediateQuery.userFilter as FilterGroup,
      body,
    );
  }
  if (!results) {
    throw new Error("Data validation failed");
  }
  return body
};

export const excuteScope = (
  condition: string,
  queryData: Record<string, any>,
  context: Record<string, IntermediateQueryResult>,
  options?: OptionsInput
) => {
   let conditions: string = condition || "";
    conditions = conditionsRegex("context", context, conditions);
    conditions = conditionsRegex("options", options, conditions);
    const queryCondition = Object.fromEntries(
      new URLSearchParams(conditions),
    );

    return mergeQueries(queryData, queryCondition)
}

/**
 * Execute a code record by function name.
 * The code string is wrapped in: async function <name>(data, options) { <code> }
 * Returns the return value of the function, or the original data if no return / error.
 */
export const executeCode = async (
  functionName: string,
  data: any,
  options?: OptionsInput,
): Promise<any> => {
  if (!functionName) return data;

  const tenantSlug = getTenantSlug();
  const cache = await schemaManager.getTenantCache(tenantSlug);
  const codeRecord = cache['code']?.[functionName];
  if (!codeRecord?.code) {
    console.warn(`[executeCode] Code record not found for function: ${functionName}`);
    return data;
  }

  // helpers are passed via options.helpers (e.g. tenant_auth login Path B).
  // When present, they're exposed as a 3rd arg to the user function.
  const helpers = (options as any)?.helpers;
  const throwOnError = (options as any)?.throwOnError === true;

  try {
    // Wrap in async so code can use await
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('data', 'options', 'helpers', codeRecord.code);
    const result = await fn(data, options, helpers);
    return result !== undefined ? result : data;
  } catch (err) {
    console.error(`[executeCode] Error executing function "${functionName}":`, err);
    if (throwOnError) throw err;
    return data;
  }
};