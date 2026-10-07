import { OptionsInput } from "../../../configs/core";
import { IntermediateQueryResult } from "../../../core_v2/compat";
import { getDeepValue } from "./helper";
import { AppError } from "../../../utils/app-error";
import {
  getPolicies,
  getSetting,
  executeSetting,
  executePolicy,
  executeValidation,
  excuteScope,
  getFormSettingBySlug,
} from "./excute";

export const mergeQueries = (
  queryData: Record<string, any>,
  conditions: Record<string, any>,
) => {
  const merged: Record<string, any> = { ...queryData };
  const andFilter = [];
  for (const key in conditions) {
    switch (key) {
      case "order":
        if (merged[key]) {
          merged[key] = `${merged[key]},${conditions[key]}`;
        } else {
          merged[key] = conditions[key];
        }
        break;
      case "select":
        // only relation select internal
        merged[key] = `${conditions[key]}`;

        break;
      default:
        andFilter.push(`${key}=${conditions[key]}`);
        break;
    }
  }
  if (andFilter.length > 0) {
    if (merged["and"]) {
      // merge existing with (values) splce out the last )
      merged["and"] = `${merged["and"].slice(0, -1)},${andFilter.join(",")})`;
      return merged;
    } else {
      merged["and"] = `(${andFilter.join(",")})`;
    }
  }
  return merged;
};

const createQueryPolicy = (
  resource: string,
  action: string,
  role: string[],
  slug?: string,
) => {
  const queryPolicies: Record<string, any> = {
    resource: {
      $in: [resource],
    },
    action: {
      $in: [action],
    },
  };
  if (role.length > 0) {
    queryPolicies["role"] = {
      $in: role,
    };
  }
  if (slug) {
    queryPolicies["slug"] = slug;
  }
  return queryPolicies;
};

const createQuerySetting = (
  resource: string,
  action: string,
  role: string[],
) => {
  const querySettings: Record<string, any> = {
    resource: resource,
    action: action,
  };
  if (role.length > 0) {
    querySettings["role"] = role[0];
  }
  return querySettings;
};

export const conditionsRegex = (
  key: string,
  context: any,
  conditions: string,
) => {
  const regex = new RegExp(`@${key}:([\\w:]+)`, "g");
  const result = conditions.replace(regex, (match, path) => {
    const value = getDeepValue(path, context);
    return value !== undefined ? JSON.stringify(value) : match;
  });
  return result;
};

export const builderQuery = async (
  queryData: Record<string, any>,
  action: any,
  resource: string,
  role: string[],
  body?: any,
  options?: OptionsInput,
) => {
  // super_admin (legacy) bypasses ALL policy checks — return entity + raw query directly.
  // The new system admin (role_system='admin') does NOT bypass: it relies on the policy having an entry for 'admin'
  // (auto-created by generateDefaultScaffold). Tenant admin role_name='admin' also matches that policy.
  if (role.includes('super_admin')) {
    const root_entity: string = action?.root_entity
      ? (Array.isArray(action.root_entity) ? action.root_entity[0] : action.root_entity)
      : resource;
    // Apply the policy condition (select=… joins) for super_admin so the JOIN happens automatically
    // per the definition in the JSON. Does not apply filter restrictions (super_admin bypasses them).
    let conditions = queryData;
    if (action?.["method"] !== "POST") {
      try {
        const policies = await getPolicies(createQueryPolicy(resource, action?.["slug"], ['admin'])).catch(() => []);
        const policy = policies?.[0];
        if (policy?.condition) {
          conditions = excuteScope(policy.condition, queryData, {} as any, options);
        }
      } catch {}
    }
    return { entity: root_entity, conditions, body, functionName: '' };
  }

  try {
    const setting = await getSetting(
      createQuerySetting(resource, action?.["slug"], role),
    );
    let shortcutSlug: string | undefined;
    if (setting) {
      const matchedSlug = await executeSetting(setting, options);
      if (matchedSlug) {
        shortcutSlug = matchedSlug;
      }
    }
    const policies = await getPolicies(
      createQueryPolicy(resource, action?.["slug"], role, shortcutSlug),
    );

    for (const policy of policies) {
      if (policy) {
        const context: Record<string, IntermediateQueryResult> | null =
          await executePolicy(policy, options);
        if (!context) continue;
        let newBody = body
        let root_entity: string = Array.isArray(policy.root_entity) ? policy.root_entity[0] : policy.root_entity;
        let code: string = Array.isArray(policy.code) ? policy.code[0] : policy.code || "";
        if (body && action?.["method"] && action["method"] != "GET" && action["method"] != "DELETE") {
          const condtion_body = policy.condtion_body || "";
          newBody = await executeValidation(
            condtion_body,
            root_entity,
            body,
            context,
            options
          );

          // Filter body fields based on form-setting if policy has one
          if (policy.form) {
            const formSetting = await getFormSettingBySlug(policy.form);
            if (formSetting?.fields?.length > 0) {
              

              // Filter: only allow fields in form-setting + system fields
              const filtered: Record<string, any> = {};
              

              // Apply defaults, enforce readonly values, and validate options_override
              for (const field of formSetting.fields) {
                if (field.readonly) {
                  if (field.default == undefined) {
                    if (field.required) {
                      delete queryData[field.name]; // remove readonly field if no default, to keep original value from DB (frontend disabled)
                      if (body[field.name]) {
                        queryData[field.name] = body[field.name]
                      }
                    }
                    
                  }else {
                    filtered[field.name] = field.default; // keep original value from DB (frontend disabled)
                  }
                  // readonly without default: keep client value (original from DB, frontend disabled)
                } else if (field.default !== undefined && filtered[field.name] === undefined) {
                  filtered[field.name] = field.default;
                }

                // Validate options_override for select fields
                if (field.options_override && filtered[field.name] !== undefined) {
                  const allowed: string[] = typeof field.options_override === 'string'
                    ? field.options_override.split(',').map((s: string) => s.trim()).filter(Boolean)
                    : field.options_override;
                  if (allowed.length > 0 && !allowed.includes(String(filtered[field.name]))) {
                    throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: `Field "${field.name}" value "${filtered[field.name]}" is not allowed. Allowed: ${allowed.join(', ')}` });
                  }
                }
              }

              newBody = filtered;
            }
          }
        }
        let query = queryData
        if (action?.["method"] != "POST") {
          let condition_scrop = policy.condition || "";

          // Auto-inject self scope: filter by created_by = current user
          if (policy.scope === 'self') {
            const selfCondition = 'created_by=eq.@options:user_id';
            condition_scrop = condition_scrop
              ? `${condition_scrop}&${selfCondition}`
              : selfCondition;
          }

          query = excuteScope(
            condition_scrop,
            queryData,
            context,
            options
          )
        }

        return {
          entity: root_entity,
          conditions: query,
          functionName: code,
          body: newBody,
          context,
          trigger: policy.trigger ?? null,
        }
        
      }
    }

    throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: "No policy matches role + resource (access denied)", expose: true });
  } catch (error) {
    console.error("Error fetching policy:", error, role, resource, action);
    throw error;
  }
};
