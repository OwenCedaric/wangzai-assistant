import { isListingAttributeValueFilled } from './collectionProductAttributeSchema.js';
import { collectionAttributeSemantics } from './collectionAttributeSemanticResolver.js';

export const OZON_NO_BRAND_VALUE_ID = '126745801';
export const OZON_NO_BRAND_LABEL = 'Нет бренда';
export const OZON_CHINA_VALUE_ID = '90296';
export const OZON_CHINA_LABEL = 'Китай';

const AUTO_DIMENSION_SOURCE = 'source-field';
const DIMENSION_NAME_PATTERN = /(尺寸|宽|高|长|ширин|высот|длин|размер)/iu;
const PRODUCT_PART_NAME_PATTERN = /(镜片|镜架|镜框|鼻梁|鼻托|镜腿|总|整体|линз|оправ|заушник|мост|переносиц|общая)/iu;

function text(value, maximum = 2_000) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function definitionId(definition = {}) {
  return text(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
}

function optionLabel(option = {}) {
  return text(option?.label ?? option?.value ?? option?.valueText ?? option?.value_text, 500);
}

function noBrandOption(options = []) {
  return (Array.isArray(options) ? options : []).find((option) => (
    text(option.id ?? option.valueId ?? option.value_id, 80) === OZON_NO_BRAND_VALUE_ID
  )) || (Array.isArray(options) ? options : []).find((option) => (
    /^(нет\s*бренда|无品牌|没有品牌|no\s*brand)$/iu.test(optionLabel(option))
  )) || null;
}

function sameValue(left = {}, right = {}) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

function isBrandDefinition(definition = {}) {
  return definitionId(definition) === '85' || /^(бренд|品牌|brand)$/iu.test(text(definition.name, 200));
}

function isCountryDefinition(definition = {}) {
  return /(原产国|制造国|страна|country)/iu.test(text(definition.name, 300));
}

function isProductTypeDefinition(definition = {}) {
  return Boolean(definition?.isDictionary)
    && collectionAttributeSemantics(definition).includes('productType');
}

function selectedCategoryTypeOption(draft = {}, options = []) {
  const selectedTypeId = text(draft.typeId, 80);
  if (!selectedTypeId) return null;
  return (Array.isArray(options) ? options : []).find((option) => (
    text(option?.id ?? option?.valueId ?? option?.value_id, 80) === selectedTypeId
  )) || null;
}

function chinaOption(options = []) {
  return (Array.isArray(options) ? options : []).find((option) => (
    /^(китай|中国|china)$/iu.test(optionLabel(option))
  )) || null;
}

function shouldRemovePackageDimension(definition = {}, current = {}) {
  const name = text(definition.name, 300);
  return current?.source === AUTO_DIMENSION_SOURCE
    && DIMENSION_NAME_PATTERN.test(name)
    && PRODUCT_PART_NAME_PATTERN.test(name);
}

function managedTextValue(value) {
  return {
    value: text(value),
    dictionaryValueId: '',
    values: [],
    dictionaryValueIds: [],
    source: 'managed-default',
  };
}

export function applyCollectionProductManagedDefaults({
  product = {},
  draft = {},
  definitions = [],
  optionsByAttributeId = {},
  currentValues = draft.attributeValues,
  fillProductName = false,
} = {}) {
  const values = { ...(currentValues && typeof currentValues === 'object' ? currentValues : {}) };
  let appliedCount = 0;
  let removedCount = 0;
  const setValue = (id, nextValue, { overwrite = false } = {}) => {
    if (!id || (!overwrite && isListingAttributeValueFilled(values[id]))) return;
    if (sameValue(values[id], nextValue)) return;
    values[id] = nextValue;
    appliedCount += 1;
  };

  (Array.isArray(definitions) ? definitions : []).forEach((definition) => {
    const id = definitionId(definition);
    if (!id) return;
    const current = values[id];
    if (shouldRemovePackageDimension(definition, current)) {
      delete values[id];
      removedCount += 1;
    }
    if (isBrandDefinition(definition)) {
      const official = noBrandOption(optionsByAttributeId[id] || []);
      setValue(id, {
        value: optionLabel(official) || OZON_NO_BRAND_LABEL,
        dictionaryValueId: text(official?.id ?? official?.valueId ?? official?.value_id, 80) || OZON_NO_BRAND_VALUE_ID,
        values: [],
        dictionaryValueIds: [],
        source: 'managed-default',
      }, { overwrite: true });
      return;
    }
    if (isCountryDefinition(definition)) {
      const official = chinaOption(optionsByAttributeId[id] || []);
      if (definition.isDictionary) {
        const value = optionLabel(official) || OZON_CHINA_LABEL;
        const dictionaryValueId = text(
          official?.id ?? official?.valueId ?? official?.value_id,
          80,
        ) || OZON_CHINA_VALUE_ID;
        setValue(id, {
          value,
          dictionaryValueId: definition.isCollection ? '' : dictionaryValueId,
          values: definition.isCollection ? [value] : [],
          dictionaryValueIds: definition.isCollection ? [dictionaryValueId] : [],
          source: 'managed-default',
        }, { overwrite: true });
      } else {
        setValue(id, managedTextValue(OZON_CHINA_LABEL), { overwrite: true });
      }
      return;
    }
    if (isProductTypeDefinition(definition)) {
      if (current?.source === 'manual') return;
      const official = selectedCategoryTypeOption(draft, optionsByAttributeId[id] || []);
      if (official) {
        setValue(id, {
          value: optionLabel(official),
          dictionaryValueId: text(official?.id ?? official?.valueId ?? official?.value_id, 80),
          values: [],
          dictionaryValueIds: [],
          source: 'category-selection',
        }, { overwrite: true });
      }
      return;
    }
    if (id === '11650' || id === '23249') {
      if (Number(product.minimumOrderQuantity) === 1) setValue(id, managedTextValue('1'));
      return;
    }
    if (id === '9070') {
      setValue(id, managedTextValue('false'));
      return;
    }
    if (id === '4180' && fillProductName) {
      const title = text(draft.title, 5_000);
      const canReplaceAutoSource = ['source-attribute', 'source-field', 'managed-default'].includes(values[id]?.source);
      if (title && (!isListingAttributeValueFilled(values[id]) || canReplaceAutoSource)) {
        setValue(id, managedTextValue(title), { overwrite: canReplaceAutoSource });
      }
    }
  });

  return { values, appliedCount, removedCount };
}
