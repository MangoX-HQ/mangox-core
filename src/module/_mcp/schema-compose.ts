import { schemaManager } from '../../core_v2/schema/manager';
import { getFormSettingBySlug } from '../_setting/setting-mode';

export interface EffectiveSchema {
  type: 'object';
  properties: Record<string, any>;
  required: string[];
  additionalProperties: boolean;
}

const EMPTY: EffectiveSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: true,
};

export async function composeEffectiveSchema(entityName: string, formSetting?: any): Promise<EffectiveSchema> {
  const entity = await schemaManager.getEntity(entityName);
  const base = entity?.json_schema;
  if (!base || typeof base !== 'object') return { ...EMPTY };

  const baseProps: Record<string, any> = base.properties || {};
  const baseRequired: string[] = Array.isArray(base.required) ? base.required : [];

  if (!formSetting?.fields?.length) {
    return {
      type: 'object',
      properties: { ...baseProps },
      required: [...baseRequired],
      additionalProperties: false,
    };
  }

  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const field of formSetting.fields) {
    const name = field?.name;
    if (!name) continue;
    const baseField = baseProps[name];
    if (!baseField) continue;

    const prop: any = { ...baseField };

    if (field.readonly) prop.readOnly = true;
    if (field.default !== undefined) prop.default = field.default;

    if (field.options_override) {
      const allowed = typeof field.options_override === 'string'
        ? field.options_override.split(',').map((s: string) => s.trim()).filter(Boolean)
        : Array.isArray(field.options_override)
          ? field.options_override.map(String)
          : [];
      if (allowed.length > 0) prop.enum = allowed;
    }

    properties[name] = prop;

    const isRequired = baseRequired.includes(name) || field.required === true;
    if (isRequired && !field.readonly) required.push(name);
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

export async function composeEffectiveSchemaForPolicy(entityName: string, formSlug?: string): Promise<EffectiveSchema> {
  const formSetting = formSlug ? await getFormSettingBySlug(formSlug) : null;
  return await composeEffectiveSchema(entityName, formSetting);
}
