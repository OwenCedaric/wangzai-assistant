import {
  normalizeListingAttributeValue,
  splitListingAttributeDefinitions,
} from './collectionProductAttributeSchema.js';

const NUMERIC_TYPE_PATTERN = /(?:integer|decimal|number|numeric|float|double|int|long|short|数字|数值|整数|小数)/iu;
const TEXTAREA_TYPE_PATTERN = /(?:multiline|textarea|rich|description|多行|描述)/iu;
const UPLOAD_ONLY_ATTRIBUTE_IDS = new Set([
  '8789',
  '8790',
  '11254',
  '21837',
  '21841',
  '21845',
  '22273',
]);

function clean(value, maximum = 2_000) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function currentValueText(value = {}) {
  const row = normalizeListingAttributeValue(value);
  return clean(
    row.values.length ? row.values.join('、') : row.value,
    500,
  ) || clean(
    row.dictionaryValueIds.length ? row.dictionaryValueIds.join(',') : row.dictionaryValueId,
    240,
  );
}

function valueKindOf(definition = {}) {
  if (definition.isDictionary) return 'dropdown';
  const type = clean(
    definition.valueType
      ?? definition.value_type
      ?? definition.attributeType
      ?? definition.attribute_type
      ?? definition.type,
    120,
  );
  if (NUMERIC_TYPE_PATTERN.test(type)) return 'numeric';
  return TEXTAREA_TYPE_PATTERN.test(type) ? 'textarea' : 'text';
}

function optionRows(definition = {}, optionsByAttributeId = {}) {
  const attributeId = clean(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
  return (Array.isArray(optionsByAttributeId?.[attributeId]) ? optionsByAttributeId[attributeId] : [])
    .flatMap((item) => {
      const id = clean(item?.id ?? item?.valueId ?? item?.value_id, 80);
      const value = clean(item?.label ?? item?.value ?? item?.valueText ?? item?.value_text, 300);
      return id && value ? [{ id, value, info: clean(item?.info ?? item?.description, 300) }] : [];
    });
}

function fieldRow(definition = {}, optionsByAttributeId = {}, currentValues = {}) {
  const attributeId = clean(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
  const kind = valueKindOf(definition);
  return {
    attributeId,
    label: clean(definition.name ?? definition.title ?? `属性 ${attributeId}`, 240),
    description: clean(definition.description, 800),
    group: clean(definition.groupName ?? definition.group_name, 160),
    required: Boolean(definition.is_required ?? definition.isRequired ?? definition.required),
    valueKind: kind,
    isCollection: Boolean(definition.isCollection ?? definition.is_collection),
    maxValues: Math.max(0, Number(definition.maxValueCount ?? definition.max_value_count ?? 0) || 0),
    unit: clean(definition.unit ?? definition.measurementUnit ?? definition.measurement_unit, 80),
    currentValue: currentValueText(currentValues?.[attributeId]),
    options: kind === 'dropdown' ? optionRows(definition, optionsByAttributeId) : [],
  };
}

/**
 * Compiles the live Ozon schema into the six buckets used by the verified
 * schema-driven fill workflow.  The model never receives an invented field:
 * every row keeps the real Ozon attribute id and official option ids.
 */
export function buildCollectionAttributeAiSchema({
  categoryTitle = '',
  definitions = [],
  optionsByAttributeId = {},
  currentValues = {},
} = {}) {
  const schema = {
    categoryTitle: clean(categoryTitle, 800),
    required_dropdown: [],
    required_text: [],
    required_numeric: [],
    optional_dropdown: [],
    optional_text: [],
    optional_numeric: [],
  };
  (Array.isArray(definitions) ? definitions : []).forEach((definition) => {
    const row = fieldRow(definition, optionsByAttributeId, currentValues);
    if (!row.attributeId || row.currentValue || UPLOAD_ONLY_ATTRIBUTE_IDS.has(row.attributeId)) return;
    const kind = row.valueKind === 'dropdown'
      ? 'dropdown'
      : (row.valueKind === 'numeric' ? 'numeric' : 'text');
    schema[`${row.required ? 'required' : 'optional'}_${kind}`].push(row);
  });
  return schema;
}

export function buildCollectionAttributeAiSchemas(input = {}) {
  const { global, sku } = splitListingAttributeDefinitions(input.definitions || []);
  return {
    global: buildCollectionAttributeAiSchema({ ...input, definitions: global }),
    sku: buildCollectionAttributeAiSchema({ ...input, definitions: sku, currentValues: {} }),
  };
}

export function flattenCollectionAttributeAiSchema(schema = {}) {
  return [
    'required_dropdown',
    'required_text',
    'required_numeric',
    'optional_dropdown',
    'optional_text',
    'optional_numeric',
  ].flatMap((key) => Array.isArray(schema?.[key]) ? schema[key] : []);
}

export function countCollectionAttributeAiSchemaFields(schema = {}) {
  return flattenCollectionAttributeAiSchema(schema).length;
}
