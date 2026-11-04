import { requestLocalApi } from '../../../api/localApiClient.js';
import { buildProductAttributeEditRows, getAttributeList } from '../../../entities/product/productAttributes.jsx';
import { readProductEditorContext } from '../../../services/productModuleClient.js';
import {
  formatAttributeRulesForPrompt,
  formatGlobalSkillRulesForAttributePrompt,
} from '../lib/smartToolSkillConfiguration.js';

export const DEFAULT_PRODUCT_DESCRIPTION_MODEL = 'gpt-5.5';
export const PRODUCT_DESCRIPTION_ATTRIBUTE_ID = 4191;

const SMART_TOOL_HIDDEN_ATTRIBUTE_IDS = new Set([
  // Ozon product identity / publication structure. Existing products should
  // keep these values in the normal product editor instead of asking AI to
  // regenerate them.
  '85',
  '8229',
  '8962',
  '9024',
  '9048',
  '11650',
  '22390',
  '23249',
  '23536',
  // Rich-content and media helper fields are not text-optimization targets.
  '8789',
  '8790',
  '11254',
  '21837',
  '21841',
  '21845',
  '22273',
]);

const SMART_TOOL_HIDDEN_ATTRIBUTE_LABEL = /(?:Ozon\s*类目|商品类型\s*[（(]?Ozon\s*类目|描述类目|商家货号|Offer\s*ID|合并同款|合并同一卡片|合并为相似商品|原厂包装数量|销售单位内的商品数量|单件商品数量|商品标识码|富内容|Rich\s*Content|PDF|视频|video)/iu;

function text(value) {
  return String(value ?? '').trim();
}

function attributeId(attribute = {}) {
  return text(attribute.id || attribute.attribute_id || attribute.attributeId);
}

function attributeValue(attribute = {}) {
  const values = Array.isArray(attribute.values) ? attribute.values : [];
  if (values.length) {
    return values
      .map((item) => text(item?.value || item?.dictionary_value || item?.name || item))
      .filter(Boolean)
      .join('、');
  }
  return text(attribute.value || attribute.dictionary_value || attribute.name);
}

function productAttributes(product = {}) {
  const source = product || {};
  const candidates = [
    source.attributes,
    source.raw?.attributes,
    source.raw?.detail?.attributes,
    source.raw?.entity?.attributes,
  ];
  return candidates.find((value) => Array.isArray(value) && value.length)
    || candidates.find((value) => Array.isArray(value))
    || [];
}

export function filterSmartToolOptimizableAttributeRows(attributeRows = []) {
  return (Array.isArray(attributeRows) ? attributeRows : []).filter((item) => {
    const id = text(item?.attributeId || item?.id);
    const label = text(item?.label || item?.definition?.name || item?.definition?.attribute_name);
    if (SMART_TOOL_HIDDEN_ATTRIBUTE_IDS.has(id)) return false;
    if (SMART_TOOL_HIDDEN_ATTRIBUTE_LABEL.test(label)) return false;
    // Dictionary fields are fixed Ozon choices for the selected category.
    // Keep them in the product editor; this optimization panel only handles
    // fields for which the text model can safely propose copy.
    if (item?.isDictionary) return false;
    return true;
  });
}

export function readSmartToolProductDescription(product = {}) {
  const attribute = productAttributes(product).find((item) => attributeId(item) === String(PRODUCT_DESCRIPTION_ATTRIBUTE_ID));
  return attributeValue(attribute);
}

export async function readSmartToolProductDescriptionContext(product = {}, options = {}) {
  const source = product || {};
  const context = await readProductEditorContext({
    shopId: text(source.shopId || source.shop_id || source.raw?.shopId || source.raw?.shop_id),
    productId: text(source.productId || source.product_id),
    offerId: text(source.offerId || source.offer_id),
    descriptionCategoryId: text(source.descriptionCategoryId || source.description_category_id),
    typeId: text(source.typeId || source.type_id),
  }, options);
  const attributes = Array.isArray(context?.attributes) ? context.attributes : productAttributes(source);
  const attributeDefinitions = Array.isArray(context?.attributeDefinitions) ? context.attributeDefinitions : [];
  const attributeProduct = {
    ...source,
    attributes: getAttributeList({ attributes }),
    raw: { ...source.raw, attributes: { attributes } },
  };
  return {
    attributes,
    attributeDefinitions,
    attributeRows: filterSmartToolOptimizableAttributeRows(
      buildProductAttributeEditRows(attributeProduct, attributeDefinitions)
    ),
    source: context?.source || 'sqlite',
  };
}

export function listConfiguredTextModels(modelOptions = []) {
  const ready = (Array.isArray(modelOptions) ? modelOptions : []).filter(
    (item) => item?.ready && text(item.model)
  );
  const explicit = ready.filter((item) => item.id !== 'auto');
  return explicit.length ? explicit : ready;
}

export function resolveConfiguredTextModel(modelOptions = [], selectedModelId = '') {
  const options = listConfiguredTextModels(modelOptions);
  return options.find((item) => item.id === selectedModelId)
    || options.find((item) => text(item.model).toLowerCase() === DEFAULT_PRODUCT_DESCRIPTION_MODEL)
    || options[0]
    || null;
}

function summarizeAttributes(product = {}) {
  return productAttributes(product)
    .filter((item) => attributeId(item) !== String(PRODUCT_DESCRIPTION_ATTRIBUTE_ID))
    .slice(0, 30)
    .map((item) => {
      const value = attributeValue(item);
      return value ? `${attributeId(item) || '字段'}：${value}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeAttributeRows(attributeRows = []) {
  return (Array.isArray(attributeRows) ? attributeRows : [])
    .filter((item) => item?.filled && text(item.value))
    .slice(0, 100)
    .map((item) => `${text(item.label) || `Ozon 字段 ${text(item.attributeId || item.id)}`}：${text(item.value)}`)
    .join('\n');
}

function createAttributeGenerationSchema(attributeRows = [], selectedFieldIds = []) {
  const selected = new Set((Array.isArray(selectedFieldIds) ? selectedFieldIds : []).map(text).filter(Boolean));
  return (Array.isArray(attributeRows) ? attributeRows : [])
    .filter((item) => !selected.size || selected.has(text(item.attributeId || item.id)))
    .slice(0, 100)
    .map((item) => ({
      id: text(item.attributeId || item.id),
      label: text(item.label),
      currentValue: text(item.value),
      filled: Boolean(item.filled),
      required: Boolean(item.required),
      type: text(item.definition?.type || item.definition?.attribute_type),
    }));
}

function cleanJsonText(value) {
  return text(value)
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
}

export function parseProductFieldSuggestions(value, attributeRows = []) {
  const raw = cleanJsonText(value);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const descriptionRow = (Array.isArray(attributeRows) ? attributeRows : []).find(
      (item) => text(item.attributeId || item.id) === String(PRODUCT_DESCRIPTION_ATTRIBUTE_ID)
    );
    return descriptionRow && raw
      ? [{ id: text(descriptionRow.attributeId || descriptionRow.id), value: raw }]
      : [];
  }
  const rows = Array.isArray(parsed?.fields)
    ? parsed.fields
    : Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed?.fields || parsed || {}).map(([id, fieldValue]) => ({ id, value: fieldValue }));
  const validIds = new Set((Array.isArray(attributeRows) ? attributeRows : []).map((item) => text(item.attributeId || item.id)));
  const seen = new Set();
  return rows
    .map((item) => ({
      id: text(item?.id || item?.attributeId || item?.attribute_id),
      value: text(item?.value ?? item?.generatedValue ?? item?.text),
    }))
    .filter((item) => item.id && validIds.has(item.id) && !seen.has(item.id) && seen.add(item.id))
    .slice(0, 100);
}

export function createProductDescriptionGenerationRequest({ product = {}, sku = {}, skuFacts = '', modelSelection, editorContext, selectedFieldIds = [], attributeRules = {}, globalSkillPrompt = '' } = {}) {
  if (!modelSelection?.ready || !text(modelSelection.model)) {
    throw new Error('没有读取到已配置的文本模型，请先到接口配置中添加。');
  }
  const title = text(product.title || product.name);
  const currentDescription = readSmartToolProductDescription(product);
  const attributeFacts = summarizeAttributeRows(editorContext?.attributeRows) || summarizeAttributes(product);
  const fieldSchema = createAttributeGenerationSchema(editorContext?.attributeRows, selectedFieldIds);
  const configuredAttributeRules = formatAttributeRulesForPrompt(attributeRules);
  const sharedGlobalRules = formatGlobalSkillRulesForAttributePrompt(globalSkillPrompt);
  return {
    accountId: text(modelSelection.accountId),
    model: text(modelSelection.model),
    templateId: 'product-description.v1',
    templateInput: {
      productTitle: title,
      offerId: text(product.offerId),
      sku: text(sku.sku || sku.id),
      skuFacts: text(skuFacts || sku.facts),
      currentDescription,
      attributeFacts,
      allowedFields: fieldSchema,
      outputContract: { fields: [{ id: 'Ozon field ID', value: 'generated Russian value' }] },
    },
    customRules: [sharedGlobalRules, configuredAttributeRules].filter(Boolean).join('\n\n'),
  };
}

export async function runSmartToolProductDescriptionGeneration(input = {}, options = {}) {
  const request = createProductDescriptionGenerationRequest(input);
  const response = await requestLocalApi('/api/product-descriptions/generate', {
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs || 150000,
    signal: options.signal,
  });
  const selected = new Set((Array.isArray(input.selectedFieldIds) ? input.selectedFieldIds : []).map(text).filter(Boolean));
  const responseRows = (Array.isArray(input.editorContext?.attributeRows) ? input.editorContext.attributeRows : [])
    .filter((item) => !selected.size || selected.has(text(item.attributeId || item.id)));
  return {
    ...response,
    fields: parseProductFieldSuggestions(response?.description, responseRows),
    rawText: text(response?.description),
  };
}
