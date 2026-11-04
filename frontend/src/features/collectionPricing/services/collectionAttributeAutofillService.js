import { requestLocalApi } from '../../../api/localApiClient.js';
import { COLLECTION_ATTRIBUTE_AUTOFILL_RUNTIME_RULES } from '../constants/collectionAttributeAutofillRules.js';
import {
  COLLECTION_BEIXIONG_BUILTIN_MODEL,
  COLLECTION_BEIXIONG_RULES,
} from '../constants/collectionBeixiongAutofillRules.js';
import {
  collectionBeixiongDefinitionPhase,
} from '../lib/collectionBeixiongAutofillPlan.js';
import { completeCollectionBeixiongSuggestions } from '../lib/collectionBeixiongFallbacks.js';
import {
  isListingAttributeValueFilled,
  normalizeListingAttributeValue,
  splitListingAttributeDefinitions,
} from '../lib/collectionProductAttributeSchema.js';
import {
  buildCollectionAttributeAiSchema,
  flattenCollectionAttributeAiSchema,
} from '../lib/collectionAttributeAutofillSchema.js';
import { rankCollectionDictionaryOptionsForValues } from '../lib/collectionAttributeCandidateScorer.js';
import {
  OZON_NO_BRAND_LABEL,
  OZON_NO_BRAND_VALUE_ID,
} from '../lib/collectionProductManagedDefaults.js';

export const COLLECTION_ATTRIBUTE_AUTOFILL_MIN_CONFIDENCE = 0;

const MAX_EDITABLE_RULE_LENGTH = 7_500;
const MAX_SKUS_PER_BATCH = COLLECTION_BEIXIONG_RULES.skuBatchSize;
const MAX_OPTIONS_PER_PROMPT_FIELD = 12;
const MAX_MODEL_REQUEST_BYTES = 29_000;
const TARGET_MODEL_REQUEST_BYTES = 20_000;
// 单接口保留 6 路吞吐；自动模式发现多个独立 API 账号时，按账号轮转并最多扩到 12 路。
// 每个批次仍完整处理，不减少字段，也不会把 apiKey 暴露给渲染层。
const DEFAULT_MODEL_CONCURRENCY = 6;
const MAX_MODEL_POOL_CONCURRENCY = 12;
const MODEL_REQUEST_MAX_ATTEMPTS = COLLECTION_BEIXIONG_RULES.mainAttemptCount;
const MODEL_JSON_MAX_ATTEMPTS = COLLECTION_BEIXIONG_RULES.mainAttemptCount;
const MODEL_REPAIR_MAX_ATTEMPTS = COLLECTION_BEIXIONG_RULES.repairAttemptCount;
const MODEL_REQUESTS_PER_WINDOW = 30;
const MODEL_REQUEST_WINDOW_MS = 60_000;
const DICTIONARY_BULK_PREFETCH_THRESHOLD = 3;
const DEFAULT_DICTIONARY_CONCURRENCY = 8;
const NON_RETRYABLE_MODEL_BILLING_CODES = new Set([
  'PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE',
  'PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN',
]);
const COMPACT_MODEL_RESPONSE_RULE = [
  '响应只保留 outputContract 中列出的业务值，不复述判断过程。',
  '已确认属性禁止返回 evidence、lookupTerms 或解释文字；字典字段优先返回官方 dictionaryValueId/dictionaryValueIds。',
  '无法确认的字段只写 unresolved 的 scope、sourceSkuId、attributeId，禁止输出长原因。',
].join('\n');
const NUMERIC_TYPE_PATTERN = /(?:integer|decimal|number|numeric|float|double|int|long|short|数字|数值|整数|小数)/iu;

function clean(value, maximum = 2_000) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function cleanMultiline(value, maximum = 6_000) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, maximum);
}

function hasUsableRussianText(value) {
  const source = clean(value, 6_000);
  return /\p{Script=Cyrillic}/u.test(source) && !/[\u3400-\u9fff\uf900-\ufaff]/u.test(source);
}

function hasUsableRussianTags(value = []) {
  const rows = Array.isArray(value) ? value : [];
  return rows.length >= COLLECTION_BEIXIONG_RULES.tags.minimumAccepted
    && rows.every((item) => hasUsableRussianText(item));
}

function normalizeModelCandidate(value = {}) {
  const accountId = clean(value.accountId, 240);
  const model = clean(value.model, 240);
  if (!accountId || !model || value.ready === false) return null;
  return {
    id: clean(value.id, 240) || `${accountId}::${model}`,
    accountId,
    model,
    label: clean(value.label ?? value.displayName ?? model, 240),
    displayName: clean(value.displayName ?? value.label ?? model, 240),
    provider: clean(value.provider, 240),
    ready: true,
  };
}

export function resolveCollectionAttributeModelPool({ modelOptions = [], selectedModelId = 'auto' } = {}) {
  const options = Array.isArray(modelOptions) ? modelOptions : [];
  const selectedId = clean(selectedModelId, 240) || 'auto';
  if (selectedId !== 'auto') {
    const selected = normalizeModelCandidate(options.find((item) => clean(item?.id, 240) === selectedId));
    return [selected || COLLECTION_BEIXIONG_BUILTIN_MODEL];
  }

  const autoOption = options.find((item) => clean(item?.id, 240) === 'auto');
  const ordered = [
    autoOption,
    ...options.filter((item) => item !== autoOption && item?.isPrimary === true),
    ...options.filter((item) => item !== autoOption && item?.isPrimary !== true),
  ];
  const poolByAccountId = new Map();
  ordered.forEach((item) => {
    const candidate = normalizeModelCandidate(item);
    if (!candidate || candidate.accountId === COLLECTION_BEIXIONG_BUILTIN_MODEL.accountId) return;
    if (!poolByAccountId.has(candidate.accountId)) poolByAccountId.set(candidate.accountId, candidate);
  });
  return poolByAccountId.size
    ? [...poolByAccountId.values()]
    : [COLLECTION_BEIXIONG_BUILTIN_MODEL];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function scalarText(value, maximum = 2_000) {
  if (!value || typeof value !== 'object') return clean(value, maximum);
  return clean(firstDefined(
    value.label,
    value.value,
    value.valueText,
    value.value_text,
    value.text,
    value.name,
    value.title,
  ), maximum);
}

function scalarId(value, maximum = 80) {
  if (!value || typeof value !== 'object') return clean(value, maximum);
  return clean(firstDefined(
    value.id,
    value.valueId,
    value.value_id,
    value.dictionaryValueId,
    value.dictionary_value_id,
  ), maximum);
}

function normalizedTextArray(value, maximum = 2_000) {
  const rows = Array.isArray(value) ? value.flat(2) : value === undefined || value === null ? [] : [value];
  return [...new Set(rows.map((item) => scalarText(item, maximum)).filter(Boolean))];
}

function normalizedIdArray(value, maximum = 80) {
  const rows = Array.isArray(value) ? value.flat(2) : value === undefined || value === null ? [] : [value];
  return [...new Set(rows.map((item) => scalarId(item, maximum)).filter(Boolean))];
}

function normalizeRawSuggestion(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  const rawValue = firstDefined(source.value, source.valueText, source.value_text, source.label, source.text);
  const rawValues = firstDefined(source.values, source.valueList, source.value_list);
  const valueObjectId = rawValue && typeof rawValue === 'object' ? scalarId(rawValue) : '';
  const valueObjectText = rawValue && typeof rawValue === 'object' ? scalarText(rawValue, 60_000) : '';
  const valueRows = Array.isArray(rawValues) ? rawValues.flat(2) : [];
  return {
    attributeId: clean(firstDefined(source.attributeId, source.attribute_id, source.id), 80),
    value: valueObjectText || scalarText(rawValue, 60_000),
    values: normalizedTextArray(rawValues, 60_000),
    dictionaryValueId: scalarId(firstDefined(
      source.dictionaryValueId,
      source.dictionary_value_id,
      source.valueId,
      source.value_id,
      valueObjectId,
    ), 80),
    dictionaryValueIds: [...new Set([
      ...normalizedIdArray(firstDefined(
        source.dictionaryValueIds,
        source.dictionary_value_ids,
        source.valueIds,
        source.value_ids,
      )),
      ...valueRows.map((item) => (item && typeof item === 'object' ? scalarId(item) : '')).filter(Boolean),
    ])],
    lookupTerms: normalizedTextArray(firstDefined(source.lookupTerms, source.lookup_terms, source.searchTerms, source.search_terms), 300),
    evidence: clean(firstDefined(source.evidence, source.sourceEvidence, source.source_evidence), 500),
    confidence: firstDefined(source.confidence, source.score),
  };
}

function normalizeRawUnresolved(value = {}) {
  const sourceSkuId = clean(firstDefined(value?.sourceSkuId, value?.source_sku_id, value?.skuId, value?.sku_id), 120);
  return {
    scope: sourceSkuId ? 'sku' : clean(firstDefined(value?.scope, value?.level), 40),
    sourceSkuId,
    attributeId: clean(firstDefined(value?.attributeId, value?.attribute_id, value?.id), 80),
    lookupTerms: normalizedTextArray(firstDefined(value?.lookupTerms, value?.lookup_terms, value?.searchTerms, value?.search_terms), 300),
    reason: clean(firstDefined(value?.reason, value?.message, value?.evidence), 500),
    confidence: firstDefined(value?.confidence, value?.score),
  };
}

function normalizeRawModelPayload(value = {}) {
  const direct = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const source = direct.result && typeof direct.result === 'object' && !Array.isArray(direct.result)
    ? direct.result
    : direct.data && typeof direct.data === 'object' && !Array.isArray(direct.data)
      ? direct.data
      : direct;
  const globalRows = firstDefined(source.globalAttributes, source.global_attributes, source.global) || [];
  const skuRows = firstDefined(source.skuAttributes, source.sku_attributes, source.skus) || [];
  const skuTitleRows = firstDefined(source.skuTitles, source.sku_titles, source.titlesBySku, source.titles_by_sku) || skuRows;
  const unresolvedRows = firstDefined(source.unresolved, source.unresolvedAttributes, source.unresolved_attributes) || [];
  return {
    title: clean(firstDefined(source.title, source.productTitle, source.product_title), 5_000),
    description: cleanMultiline(firstDefined(source.description, source.productDescription, source.product_description), 6_000),
    tags: normalizedTextArray(firstDefined(source.tags, source.keywords, source.searchTags, source.search_tags), 80).slice(0, 28),
    skuTitles: (Array.isArray(skuTitleRows) ? skuTitleRows : []).flatMap((row) => {
      const sourceSkuId = clean(firstDefined(row?.sourceSkuId, row?.source_sku_id, row?.skuId, row?.sku_id), 120);
      const title = clean(firstDefined(row?.title, row?.productTitle, row?.product_title), 5_000);
      return sourceSkuId && title ? [{ sourceSkuId, title }] : [];
    }),
    globalAttributes: (Array.isArray(globalRows) ? globalRows : []).map(normalizeRawSuggestion),
    skuAttributes: (Array.isArray(skuRows) ? skuRows : []).map((row) => ({
      sourceSkuId: clean(firstDefined(row?.sourceSkuId, row?.source_sku_id, row?.skuId, row?.sku_id), 120),
      attributes: (Array.isArray(firstDefined(row?.attributes, row?.attributeValues, row?.attribute_values))
        ? firstDefined(row?.attributes, row?.attributeValues, row?.attribute_values)
        : []).map(normalizeRawSuggestion),
    })),
    unresolved: (Array.isArray(unresolvedRows) ? unresolvedRows : []).map(normalizeRawUnresolved),
  };
}

function numericConfidence(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function sourceAttributeRows(value = []) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const name = clean(item?.name ?? item?.title ?? item?.key, 180);
    const rawValue = item?.value ?? item?.valueText ?? item?.text ?? item?.nameValue;
    const normalizedValue = Array.isArray(rawValue)
      ? rawValue.map((entry) => clean(entry, 240)).filter(Boolean).join('、')
      : clean(rawValue, 500);
    return name && normalizedValue ? [{ name, value: normalizedValue }] : [];
  }).slice(0, 60);
}

function sourceSkuFor(product = {}, draftSku = {}, index = 0) {
  const sourceSkus = Array.isArray(product.skus) ? product.skus : [];
  return sourceSkus.find((item) => String(item?.id ?? item?.name ?? '') === String(draftSku?.sourceSkuId ?? ''))
    || sourceSkus[index]
    || {};
}

function compactCurrentValue(value = {}) {
  const row = normalizeListingAttributeValue(value);
  return clean(
    row.values.length ? row.values.join('、') : row.value,
    300,
  ) || clean(
    row.dictionaryValueIds.length ? row.dictionaryValueIds.join(',') : row.dictionaryValueId,
    160,
  );
}

function joinRuntimeRules(tool = {}) {
  const config = tool.promptConfig || {};
  const rows = [
    cleanMultiline(config.systemPrompt, MAX_EDITABLE_RULE_LENGTH),
    Array.isArray(config.workflowSteps) && config.workflowSteps.length
      ? `运行步骤：\n${config.workflowSteps.map((item, index) => `${index + 1}. ${clean(item, 500)}`).join('\n')}`
      : '',
    Array.isArray(config.outputRules) && config.outputRules.length
      ? `输出规则：\n${config.outputRules.map((item) => `- ${clean(item, 500)}`).join('\n')}`
      : '',
    Array.isArray(config.safetyRules) && config.safetyRules.length
      ? `核对规则：\n${config.safetyRules.map((item) => `- ${clean(item, 500)}`).join('\n')}`
      : '',
  ].filter(Boolean);
  return cleanMultiline(rows.join('\n\n'), MAX_EDITABLE_RULE_LENGTH);
}

function chunks(value = [], size = 1) {
  const rows = Array.isArray(value) ? value : [];
  const batchSize = Math.max(1, Number(size) || 1);
  const result = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    result.push(rows.slice(index, index + batchSize));
  }
  return result;
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}

function isBrandDefinition(definition = {}) {
  const id = clean(definition?.id ?? definition?.attributeId ?? definition?.attribute_id, 80);
  const name = clean(definition?.name ?? definition?.title, 240);
  return id === '85' || /^(?:бренд|品牌|brand)$/iu.test(name);
}

function productFacts(product = {}) {
  return {
    sourceProductId: clean(product.sourceProductId ?? product.id, 120),
    title: clean(product.title ?? product.name, 800),
    description: cleanMultiline(product.description, 2_500),
    sourceCategory: clean(product.sourceCategoryPath ?? product.categoryPath ?? product.categoryName, 500),
    sourceAttributes: sourceAttributeRows(product.attributes),
    weightG: clean(product.weightG, 80),
    packageLengthCm: clean(product.packageLengthCm, 80),
    packageWidthCm: clean(product.packageWidthCm, 80),
    packageHeightCm: clean(product.packageHeightCm, 80),
  };
}

function skuFacts(product = {}, draftSkus = [], definitions = []) {
  return (Array.isArray(draftSkus) ? draftSkus : []).map((draftSku, index) => {
    const sourceSku = sourceSkuFor(product, draftSku, index);
    return {
      sourceSkuId: clean(draftSku.sourceSkuId, 120),
      sourceSkuName: clean(draftSku.sourceSkuName, 220),
      sourceTitle: clean(sourceSku.title ?? sourceSku.name, 220),
      imageUrl: clean(draftSku.imageUrl ?? sourceSku.imageUrl ?? sourceSku.image ?? sourceSku.picUrl, 3_000),
      sourceAttributes: sourceAttributeRows(sourceSku.attributes).slice(0, 30),
      currentValues: (Array.isArray(definitions) ? definitions : []).flatMap((definition) => {
        const attributeId = clean(definition?.id ?? definition?.attributeId ?? definition?.attribute_id, 80);
        const value = compactCurrentValue(draftSku.attributeValues?.[attributeId]);
        return attributeId && value ? [{ attributeId, value }] : [];
      }),
    };
  });
}

function referenceImages(product = {}) {
  const candidates = [
    ...(Array.isArray(product.mainImages) ? product.mainImages : []),
    ...(Array.isArray(product.skuImages) ? product.skuImages.map((item) => item?.imageUrl ?? item?.url) : []),
    ...(Array.isArray(product.detailImages) ? product.detailImages : []),
    ...(Array.isArray(product.images) ? product.images : []),
  ];
  return [...new Set(candidates.map((item) => clean(item, 3_000)).filter((item) => /^https:\/\//iu.test(item)))]
    .slice(0, 10)
    .map((url, sourceIndex) => ({ url, sourceIndex }));
}

function promptCandidateFacts(product = {}, job = {}, visualReport = '') {
  return [...new Set([
    cleanMultiline(visualReport, 4_000),
    ...(Array.isArray(job?.skus) ? job.skus.flatMap((sku) => [
      sku?.sourceSkuName,
      sku?.sourceTitle,
      ...(Array.isArray(sku?.sourceAttributes) ? sku.sourceAttributes.flatMap((item) => [item?.name, item?.value]) : []),
      ...(Array.isArray(sku?.currentValues) ? sku.currentValues.map((item) => item?.value) : []),
    ]) : []),
    product?.title,
    ...(Array.isArray(product?.sourceAttributes) ? product.sourceAttributes.flatMap((item) => [item?.name, item?.value]) : []),
    product?.description,
  ].map((item) => clean(item, 800)).filter(Boolean))].slice(0, 24);
}

function relevantPromptOptions(field = {}, facts = [], optionLimit = MAX_OPTIONS_PER_PROMPT_FIELD) {
  const options = Array.isArray(field.options) ? field.options : [];
  if (options.length <= optionLimit) return options;
  const selected = new Map();
  const boundedFacts = facts.slice(0, 12);
  const compositeFact = clean(facts.join(' | '), 4_000);
  rankCollectionDictionaryOptionsForValues(
    [...boundedFacts, compositeFact].filter(Boolean),
    field,
    options,
  ).forEach((item) => {
    if (selected.size < optionLimit) selected.set(clean(item?.option?.id, 80), item.option);
  });
  return [...selected.values()].slice(0, optionLimit);
}

function compactPromptSchema(schema = {}, {
  optionLimit = MAX_OPTIONS_PER_PROMPT_FIELD,
  product = {},
  job = {},
  visualReport = '',
  compactDescriptions = false,
} = {}) {
  const result = { categoryTitle: clean(schema.categoryTitle, 800) };
  const facts = promptCandidateFacts(product, job, visualReport);
  [
    'required_dropdown',
    'required_text',
    'required_numeric',
    'optional_dropdown',
    'optional_text',
    'optional_numeric',
  ].forEach((key) => {
    result[key] = (Array.isArray(schema[key]) ? schema[key] : []).map((field) => ({
      ...field,
      description: compactDescriptions ? clean(field.description, 240) : field.description,
      options: relevantPromptOptions(field, facts, optionLimit),
    }));
  });
  return result;
}

function createVisionRequest({ product = {}, draft = {}, definitions = [], tool = {}, modelSelection } = {}) {
  const images = referenceImages(product);
  if (!images.length) return null;
  const { global, sku } = splitListingAttributeDefinitions(definitions);
  const fieldNames = [...global, ...sku].map((definition) => ({
    attributeId: clean(definition.id, 80),
    name: clean(definition.name ?? definition.title, 240),
    skuScoped: sku.includes(definition),
  })).filter((item) => item.attributeId).slice(0, 120);
  return {
    path: '/api/image-prompt-plans/generate',
    body: {
      accountId: clean(modelSelection.accountId, 240),
      model: clean(modelSelection.model, 240),
      templateId: 'attribute-visual-evidence.v1',
      templateInput: {
        product: productFacts(product),
        ozonCategory: {
          descriptionCategoryId: clean(draft.descriptionCategoryId, 80),
          typeId: clean(draft.typeId, 80),
          path: clean(draft.categoryPath ?? draft.categoryName, 800),
        },
        fields: fieldNames,
        skus: skuFacts(product, draft.skus, sku).map(({ sourceSkuId, sourceSkuName, sourceTitle, imageUrl, sourceAttributes }) => ({
          sourceSkuId, sourceSkuName, sourceTitle, imageUrl, sourceAttributes,
        })),
        runtimeRuleSummary: cleanMultiline(joinRuntimeRules(tool), 2_500),
        outputContract: {
          globalFacts: [{ attributeId: '', value: '', evidence: '' }],
          skuFacts: [{ sourceSkuId: '', facts: [{ attributeId: '', value: '', evidence: '' }] }],
          notes: [],
        },
      },
      referenceImages: images,
    },
  };
}

function resolveSkuBatchSize(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return MAX_SKUS_PER_BATCH;
  return Math.min(MAX_SKUS_PER_BATCH, Math.max(1, Math.trunc(requested)));
}

const ATTRIBUTE_SCHEMA_BUCKETS = Object.freeze([
  'required_dropdown',
  'required_text',
  'required_numeric',
  'optional_dropdown',
  'optional_text',
  'optional_numeric',
]);

function splitAttributeSchema(schema = {}, requestedBatchSize = 0) {
  const batchSize = Math.max(0, Math.trunc(Number(requestedBatchSize) || 0));
  if (!batchSize) return [schema];
  const rows = ATTRIBUTE_SCHEMA_BUCKETS.flatMap((bucket) => (
    Array.isArray(schema?.[bucket])
      ? schema[bucket].map((field) => ({ bucket, field }))
      : []
  ));
  return chunks(rows, batchSize).map((batch) => {
    const next = Object.fromEntries(ATTRIBUTE_SCHEMA_BUCKETS.map((bucket) => [bucket, []]));
    next.categoryTitle = schema.categoryTitle;
    batch.forEach(({ bucket, field }) => next[bucket].push(field));
    return next;
  });
}

function createBatchJobs(
  { product = {}, draft = {}, definitions = [], optionsByAttributeId = {} } = {},
  {
    skuBatchSize = MAX_SKUS_PER_BATCH,
    splitGlobalJobs = false,
    globalAttributeBatchSize = 0,
    sharedSkuTitle = false,
  } = {},
) {
  const resolvedSkuBatchSize = resolveSkuBatchSize(skuBatchSize);
  const { global, sku } = splitListingAttributeDefinitions(definitions);
  const jobs = [];
  const pendingGlobalDefinitions = global.filter((definition) => {
    const attributeId = clean(definition?.id ?? definition?.attributeId ?? definition?.attribute_id, 80);
    return attributeId && !isListingAttributeValueFilled(draft.attributeValues?.[attributeId]);
  });
  const includeTitle = !hasUsableRussianText(draft.title);
  const includeDescription = !hasUsableRussianText(draft.description);
  const includeTags = !hasUsableRussianTags(draft.tags);
  const globalSchema = buildCollectionAttributeAiSchema({
    categoryTitle: draft.categoryPath ?? draft.categoryName,
    definitions: pendingGlobalDefinitions,
    optionsByAttributeId,
    currentValues: draft.attributeValues,
  });
  const hasGlobalContent = includeTitle || includeDescription || includeTags;
  const hasGlobalAttributes = Boolean(flattenCollectionAttributeAiSchema(globalSchema).length);
  const appendGlobalJob = ({ id, includeContent, schema }) => {
    jobs.push({
      id,
      phase: 'single-wave',
      phaseOrder: 1,
      mode: 'global',
      includeText: includeContent,
      includeTitle: includeContent && includeTitle,
      includeDescription: includeContent && includeDescription,
      includeTags: includeContent && includeTags,
      includeSkuTitles: false,
      schema,
      skus: [],
    });
  };
  if (splitGlobalJobs) {
    if (hasGlobalContent) {
      appendGlobalJob({ id: 'single-wave-global-content-1', includeContent: true, schema: {} });
    }
    if (hasGlobalAttributes) {
      splitAttributeSchema(globalSchema, globalAttributeBatchSize).forEach((schema, index) => {
        appendGlobalJob({
          id: `single-wave-global-attributes-${globalAttributeBatchSize || 'all'}-${index + 1}`,
          includeContent: false,
          schema,
        });
      });
    }
  } else if (hasGlobalContent || hasGlobalAttributes) {
    appendGlobalJob({ id: 'single-wave-global-1', includeContent: hasGlobalContent, schema: globalSchema });
  }
  if (!Array.isArray(draft.skus) || !draft.skus.length) return jobs;
  chunks(draft.skus, resolvedSkuBatchSize).forEach((draftSkuBatch, skuBatchIndex) => {
    const pendingDefinitions = sku.filter((definition) => {
      const attributeId = clean(definition?.id ?? definition?.attributeId ?? definition?.attribute_id, 80);
      return attributeId && draftSkuBatch.some((draftSku) => (
        !isListingAttributeValueFilled(draftSku?.attributeValues?.[attributeId])
      ));
    });
    const includeSkuTitles = !sharedSkuTitle
      && draftSkuBatch.some((draftSku) => !hasUsableRussianText(draftSku?.title));
    const pendingSkus = draftSkuBatch.filter((draftSku) => (
      (includeSkuTitles && !hasUsableRussianText(draftSku?.title))
      || pendingDefinitions.some((definition) => {
        const attributeId = clean(definition?.id ?? definition?.attributeId ?? definition?.attribute_id, 80);
        return !isListingAttributeValueFilled(draftSku?.attributeValues?.[attributeId]);
      })
    ));
    if (!pendingSkus.length) return;
    const schema = buildCollectionAttributeAiSchema({
      categoryTitle: draft.categoryPath ?? draft.categoryName,
      definitions: pendingDefinitions,
      optionsByAttributeId,
    });
    if (!includeSkuTitles && !flattenCollectionAttributeAiSchema(schema).length) return;
    jobs.push({
      id: `single-wave-${resolvedSkuBatchSize}-sku-${skuBatchIndex + 1}`,
      phase: 'single-wave',
      phaseOrder: 1,
      mode: 'sku',
      includeText: includeSkuTitles,
      includeTitle: false,
      includeDescription: false,
      includeTags: false,
      includeSkuTitles,
      schema,
      skus: skuFacts(product, pendingSkus, pendingDefinitions),
    });
  });
  return jobs;
}

function createBatchRequest({ product = {}, draft = {}, job, tool = {}, modelSelection, visualReport = '' } = {}) {
  const runtimeRules = joinRuntimeRules(tool);
  const payload = {
    pipeline: COLLECTION_BEIXIONG_RULES.version,
    phase: job.phase,
    mode: job.mode,
    includeTitleAndDescription: Boolean(job.includeTitle || job.includeDescription),
    includeTitle: Boolean(job.includeTitle),
    includeDescription: Boolean(job.includeDescription),
    includeTags: Boolean(job.includeTags),
    includeSkuTitles: Boolean(job.includeSkuTitles),
    product: productFacts(product),
    ozonCategory: {
      descriptionCategoryId: clean(draft.descriptionCategoryId, 80),
      typeId: clean(draft.typeId, 80),
      path: clean(draft.categoryPath ?? draft.categoryName, 800),
    },
    currentDraft: job.includeText ? {
      title: clean(draft.title, 1_000),
      description: cleanMultiline(draft.description, 2_000),
    } : undefined,
    schema: compactPromptSchema(job.schema, {
      product: productFacts(product),
      job,
      visualReport,
    }),
    skus: job.skus,
    visualReport: cleanMultiline(visualReport, 8_000),
  };
  const outputContract = {
    ...(job.includeTitle ? { title: '' } : {}),
    ...(job.includeDescription ? { description: '' } : {}),
    ...(job.includeTags ? { tags: [] } : {}),
    ...(job.includeSkuTitles ? { skuTitles: [{ sourceSkuId: '', title: '' }] } : {}),
    ...(job.mode === 'global' && flattenCollectionAttributeAiSchema(job.schema).length
      ? { globalAttributes: [{ attributeId: '', value: '', values: [], dictionaryValueId: '', dictionaryValueIds: [], confidence: 0.9 }] }
      : {}),
    ...(job.mode === 'sku' && flattenCollectionAttributeAiSchema(job.schema).length
      ? { skuAttributes: [{ sourceSkuId: '', attributes: [{ attributeId: '', value: '', values: [], dictionaryValueId: '', dictionaryValueIds: [], confidence: 0.9 }] }] }
      : {}),
    unresolved: [{ scope: 'global-or-sku', sourceSkuId: '', attributeId: '' }],
  };
  const requestBody = {
    accountId: clean(modelSelection.accountId, 240),
    model: clean(modelSelection.model, 240),
    reasoningEffort: 'low',
    templateId: 'attribute-autofill.v1',
    templateInput: { ...payload, outputContract },
    customRules: [runtimeRules, COMPACT_MODEL_RESPONSE_RULE].filter(Boolean).join('\n'),
    temperature: COLLECTION_BEIXIONG_RULES.temperature,
  };
  if (utf8ByteLength(requestBody) > TARGET_MODEL_REQUEST_BYTES) {
    payload.schema = compactPromptSchema(job.schema, {
      optionLimit: 6,
      product: payload.product,
      job,
      visualReport: payload.visualReport,
      compactDescriptions: true,
    });
    payload.product.description = cleanMultiline(payload.product.description, 900);
    payload.product.sourceAttributes = payload.product.sourceAttributes.slice(0, 20).map((item) => ({
      name: clean(item.name, 120),
      value: clean(item.value, 220),
    }));
    payload.skus = payload.skus.map((item) => ({
      ...item,
      imageUrl: undefined,
      sourceAttributes: item.sourceAttributes.slice(0, 6).map((attribute) => ({
        name: clean(attribute.name, 120),
        value: clean(attribute.value, 180),
      })),
    }));
    payload.visualReport = cleanMultiline(payload.visualReport, 2_500);
    requestBody.customRules = cleanMultiline(runtimeRules, 2_500);
    requestBody.templateInput = { ...payload, outputContract };
  }
  if (utf8ByteLength(requestBody) > TARGET_MODEL_REQUEST_BYTES) {
    payload.schema = compactPromptSchema(job.schema, {
      optionLimit: 3,
      product: payload.product,
      job,
      visualReport: payload.visualReport,
      compactDescriptions: true,
    });
    payload.product.description = cleanMultiline(payload.product.description, 400);
    payload.product.sourceAttributes = payload.product.sourceAttributes.slice(0, 10);
    payload.skus = payload.skus.map((item) => ({
      ...item,
      sourceSkuName: clean(item.sourceSkuName, 120),
      sourceTitle: clean(item.sourceTitle, 120),
      sourceAttributes: item.sourceAttributes.slice(0, 3),
    }));
    payload.visualReport = cleanMultiline(payload.visualReport, 1_000);
    requestBody.customRules = cleanMultiline(runtimeRules, 1_200);
    requestBody.templateInput = { ...payload, outputContract };
  }
  const requestBytes = utf8ByteLength(requestBody);
  if (requestBytes >= MAX_MODEL_REQUEST_BYTES) {
    const error = new Error('当前属性批次资料仍然过多，已停止该批次并保留其他成功结果。');
    error.code = 'COLLECTION_ATTRIBUTE_MODEL_PAYLOAD_TOO_LARGE';
    error.requestBytes = requestBytes;
    throw error;
  }
  return requestBody;
}

function modelPayloadTooLargeError(requestBytes) {
  const error = new Error('当前属性批次资料仍然过多，已停止该批次并保留其他成功结果。');
  error.code = 'COLLECTION_ATTRIBUTE_MODEL_PAYLOAD_TOO_LARGE';
  error.requestBytes = requestBytes;
  return error;
}

function assertModelRequestBodyLimit(requestBody) {
  const requestBytes = utf8ByteLength(requestBody);
  if (requestBytes >= MAX_MODEL_REQUEST_BYTES) throw modelPayloadTooLargeError(requestBytes);
  return requestBody;
}

function withBoundedUserInstruction(request, preferredInstruction, compactInstruction) {
  const candidates = [preferredInstruction, compactInstruction, '返回当前批次完整 JSON；补齐 schema 中的缺失字段。']
    .map((value) => cleanMultiline(value, 20_000))
    .filter((value, index, rows) => value && rows.indexOf(value) === index);
  let lastBytes = utf8ByteLength(request);
  for (const userInstruction of candidates) {
    const requestBody = { ...request, userInstruction };
    lastBytes = utf8ByteLength(requestBody);
    if (lastBytes < MAX_MODEL_REQUEST_BYTES) return requestBody;
  }
  throw modelPayloadTooLargeError(lastBytes);
}

function extractJson(value) {
  const source = String(value ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error('模型没有返回可识别的属性结果，请重新分析。');
  }
}

function normalizedMatchText(value) {
  return clean(value, 600).toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

function matchingDictionaryRows(rows = [], term = '', isCollection = false) {
  const normalizedTerm = normalizedMatchText(term);
  if (!normalizedTerm) return [];
  const exactRows = rows.filter((item) => normalizedMatchText(item?.label ?? item?.value) === normalizedTerm);
  if (exactRows.length) return isCollection ? exactRows : exactRows.slice(0, 1);
  const closeRows = rows.filter((item) => {
    const candidate = normalizedMatchText(item?.label ?? item?.value);
    return candidate && (candidate.includes(normalizedTerm) || normalizedTerm.includes(candidate));
  });
  return isCollection ? closeRows : closeRows.length === 1 ? closeRows : [];
}

function rawAttributeSuggestions(parsed = {}) {
  const rows = [];
  (Array.isArray(parsed?.globalAttributes) ? parsed.globalAttributes : []).forEach((suggestion) => {
    rows.push({ scope: 'global', sourceSkuId: '', suggestion });
  });
  (Array.isArray(parsed?.skuAttributes) ? parsed.skuAttributes : []).forEach((skuRow) => {
    const sourceSkuId = clean(skuRow?.sourceSkuId, 120);
    (Array.isArray(skuRow?.attributes) ? skuRow.attributes : []).forEach((suggestion) => {
      rows.push({ scope: 'sku', sourceSkuId, suggestion });
    });
  });
  return rows;
}

function rawUnresolvedSuggestions(parsed = {}) {
  return (Array.isArray(parsed?.unresolved) ? parsed.unresolved : []).map((item) => {
    const sourceSkuId = clean(item?.sourceSkuId, 120);
    return {
      scope: sourceSkuId || clean(item?.scope, 40) === 'sku' ? 'sku' : 'global',
      sourceSkuId,
      suggestion: {
        attributeId: clean(item?.attributeId, 80),
        lookupTerms: Array.isArray(item?.lookupTerms) ? item.lookupTerms : [],
        evidence: clean(item?.reason, 500),
        confidence: numericConfidence(item?.confidence, 0.8),
      },
      unresolved: item,
    };
  });
}

function suggestionHasCandidateValue(suggestion = {}) {
  return Boolean([
    ...(Array.isArray(suggestion?.dictionaryValueIds) ? suggestion.dictionaryValueIds : []),
    ...(Array.isArray(suggestion?.values) ? suggestion.values : []),
    suggestion?.dictionaryValueId,
    suggestion?.value,
  ].some((item) => clean(item, 2_000)));
}

function batchTargetKey(scope, sourceSkuId, attributeId) {
  return `${scope}:${clean(sourceSkuId, 120)}:${clean(attributeId, 80)}`;
}

function batchTargets(job = {}, { requiredOnly = false } = {}) {
  const schemaFields = requiredOnly
    ? [
        ...(Array.isArray(job.schema?.required_dropdown) ? job.schema.required_dropdown : []),
        ...(Array.isArray(job.schema?.required_text) ? job.schema.required_text : []),
        ...(Array.isArray(job.schema?.required_numeric) ? job.schema.required_numeric : []),
      ]
    : flattenCollectionAttributeAiSchema(job.schema);
  const fields = schemaFields.map((field) => ({
    attributeId: clean(field.attributeId, 80),
  })).filter((field) => field.attributeId);
  if (job.mode === 'sku') {
    return (Array.isArray(job.skus) ? job.skus : []).flatMap((sku) => fields.map((field) => ({
      ...field,
      scope: 'sku',
      sourceSkuId: clean(sku.sourceSkuId, 120),
    }))).filter((target) => target.sourceSkuId);
  }
  return fields.map((field) => ({ ...field, scope: 'global', sourceSkuId: '' }));
}

function auditBatchResult(job = {}, parsed = {}) {
  const resolved = new Set(rawAttributeSuggestions(parsed).flatMap(({ scope, sourceSkuId, suggestion }) => {
    const attributeId = clean(suggestion?.attributeId ?? suggestion?.id, 80);
    return attributeId && suggestionHasCandidateValue(suggestion)
      ? [batchTargetKey(scope, sourceSkuId, attributeId)]
      : [];
  }));
  if (job.mode === 'sku') {
    (Array.isArray(job.skus) ? job.skus : []).forEach((sku) => {
      (Array.isArray(sku.currentValues) ? sku.currentValues : []).forEach((item) => {
        const attributeId = clean(item?.attributeId, 80);
        if (attributeId && clean(item?.value, 2_000)) {
          resolved.add(batchTargetKey('sku', sku.sourceSkuId, attributeId));
        }
      });
    });
  }
  const unresolved = new Set((Array.isArray(parsed?.unresolved) ? parsed.unresolved : []).flatMap((item) => {
    const attributeId = clean(item?.attributeId ?? item?.id, 80);
    if (!attributeId) return [];
    const sourceSkuId = clean(item?.sourceSkuId, 120);
    const scope = sourceSkuId || clean(item?.scope, 40) === 'sku' ? 'sku' : 'global';
    return [batchTargetKey(scope, sourceSkuId, attributeId)];
  }));
  const targets = batchTargets(job);
  const requiredTargets = batchTargets(job, { requiredOnly: true });
  const missing = requiredTargets.filter((target) => {
    const key = batchTargetKey(target.scope, target.sourceSkuId, target.attributeId);
    return !resolved.has(key) && !unresolved.has(key);
  });
  return { targets, missing };
}

function addMissingTargetsToUnresolved(parsed = {}, missingTargets = []) {
  if (!missingTargets.length) return parsed;
  return {
    ...parsed,
    unresolved: [
      ...(Array.isArray(parsed.unresolved) ? parsed.unresolved : []),
      ...missingTargets.map((target) => ({
        scope: target.scope,
        sourceSkuId: target.sourceSkuId,
        attributeId: target.attributeId,
        reason: '模型本轮未返回该字段，进入智能局部修正与同类值回退',
      })),
    ],
  };
}

function suggestionLookupTerms(suggestion = {}) {
  return [...new Set([
    ...(Array.isArray(suggestion.lookupTerms) ? suggestion.lookupTerms : []),
    ...(Array.isArray(suggestion.values) ? suggestion.values : []),
    suggestion.value,
  ].map((item) => clean(item, 300)).filter(Boolean))].slice(0, 4);
}

function definitionMapOf(definitions = []) {
  return new Map((Array.isArray(definitions) ? definitions : []).flatMap((definition) => {
    const id = clean(definition?.id ?? definition?.attributeId ?? definition?.attribute_id, 80);
    return id ? [[id, definition]] : [];
  }));
}

async function runWithConcurrency(items = [], concurrency = 1, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, runWorker),
  );
  const failure = workers.find((item) => item.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

function normalizeDictionaryRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).flatMap((item) => {
    const id = clean(item?.id ?? item?.valueId ?? item?.value_id, 80);
    const label = clean(item?.label ?? item?.value ?? item?.valueText ?? item?.value_text, 500);
    return id && label ? [{ ...item, id, label, value: label }] : [];
  });
}

function mergeDictionaryRows(target = {}, attributeId, rows = []) {
  const merged = new Map((target[attributeId] || []).map((item) => [clean(item?.id, 80), item]));
  normalizeDictionaryRows(rows).forEach((item) => merged.set(item.id, item));
  target[attributeId] = [...merged.values()];
}

export async function preloadCollectionAttributeAutofillDictionaryOptions({
  definitions = [],
  optionsByAttributeId = {},
  searchAttributeOptions,
  signal,
  concurrency,
} = {}) {
  const nextOptions = Object.fromEntries(Object.entries(optionsByAttributeId || {}).map(([id, rows]) => [
    id,
    Array.isArray(rows) ? [...rows] : [],
  ]));
  (Array.isArray(definitions) ? definitions : []).forEach((definition) => {
    if (!definition?.isDictionary || !isBrandDefinition(definition)) return;
    const attributeId = clean(definition?.id ?? definition?.attributeId ?? definition?.attribute_id, 80);
    if (!attributeId) return;
    mergeDictionaryRows(nextOptions, attributeId, [{
      id: OZON_NO_BRAND_VALUE_ID,
      label: OZON_NO_BRAND_LABEL,
    }]);
  });
  if (typeof searchAttributeOptions !== 'function') {
    return { optionsByAttributeId: nextOptions, requestCount: 0 };
  }
  const attributeIds = [...new Set((Array.isArray(definitions) ? definitions : []).flatMap((definition) => {
    const attributeId = clean(definition?.id ?? definition?.attributeId ?? definition?.attribute_id, 80);
    return definition?.isDictionary
      && !isBrandDefinition(definition)
      && attributeId
      && !(nextOptions[attributeId] || []).length
      ? [attributeId]
      : [];
  }))];
  let requestCount = 0;
  await runWithConcurrency(
    attributeIds,
    Math.max(1, Math.min(Number(concurrency) || DEFAULT_DICTIONARY_CONCURRENCY, Math.max(1, attributeIds.length))),
    async (attributeId) => {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      try {
        requestCount += 1;
        const cachedRows = await searchAttributeOptions(attributeId, '', {
          signal,
          bulk: true,
          preferCache: true,
          cacheOnly: true,
        });
        let rows = cachedRows;
        if (!rows.length) {
          requestCount += 1;
          rows = await searchAttributeOptions(attributeId, '', {
            signal,
            bulk: true,
            refresh: true,
          });
        }
        mergeDictionaryRows(nextOptions, attributeId, rows);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    },
  );
  return { optionsByAttributeId: nextOptions, requestCount };
}

function isRetryableModelCapacityError(error) {
  const code = clean(
    error?.code
      || error?.payload?.error?.code
      || error?.payload?.code,
    160,
  );
  if (NON_RETRYABLE_MODEL_BILLING_CODES.has(code)) return false;
  const status = Number(error?.status || error?.payload?.status || 0);
  const message = clean(error?.message || error?.payload?.message || error?.payload?.error?.message, 500);
  return status === 408
    || status === 425
    || status === 429
    || status >= 500
    || /concurrency limit|too many requests|rate limit|请求过多|并发.*(?:超限|限制)|限流/iu.test(message);
}

function waitForModelRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('请求已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('请求已取消', 'AbortError'));
    }, { once: true });
  });
}

function createModelRequestRateLimiter({
  maximum = MODEL_REQUESTS_PER_WINDOW,
  windowMs = MODEL_REQUEST_WINDOW_MS,
  now = Date.now,
  wait = waitForModelRetry,
} = {}) {
  let starts = [];
  const safeMaximum = Math.max(1, Math.trunc(Number(maximum) || MODEL_REQUESTS_PER_WINDOW));
  const safeWindowMs = Math.max(1, Math.trunc(Number(windowMs) || MODEL_REQUEST_WINDOW_MS));
  return {
    async acquire(_accountId, signal) {
      for (;;) {
        if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
        const currentTime = Number(now());
        starts = starts.filter((item) => currentTime - item < safeWindowMs);
        if (starts.length < safeMaximum) {
          starts.push(currentTime);
          return;
        }
        await wait(Math.max(1, safeWindowMs - (currentTime - starts[0]) + 5), signal);
      }
    },
    maximum: safeMaximum,
    windowMs: safeWindowMs,
  };
}

async function requestModelBatchWithRetry(
  requester,
  path,
  requestOptions,
  workerIndex = 0,
  rateLimiter = null,
  accountId = '',
) {
  let lastError = null;
  for (let attempt = 1; attempt <= MODEL_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rateLimiter?.acquire(accountId, requestOptions.signal);
      return await requester(path, requestOptions);
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError' || !isRetryableModelCapacityError(error) || attempt >= MODEL_REQUEST_MAX_ATTEMPTS) {
        throw error;
      }
      const delayMs = (attempt * 1_500) + ((workerIndex % DEFAULT_MODEL_CONCURRENCY) * 250);
      await waitForModelRetry(delayMs, requestOptions.signal);
    }
  }
  throw lastError;
}

async function requestAndParseModelBatch(
  requester,
  request,
  requestOptions,
  workerIndex = 0,
  rateLimiter = null,
) {
  const responses = [];
  let lastError = null;
  for (let attempt = 1; attempt <= MODEL_JSON_MAX_ATTEMPTS; attempt += 1) {
    const body = attempt === 1
      ? assertModelRequestBodyLimit(request)
      : withBoundedUserInstruction(
          request,
          '上一次输出不是完整、可解析的 JSON。本次只修正 JSON 结构，并完整返回当前批次全部字段。',
          '修正 JSON 结构并完整返回当前批次。',
        );
    const response = await requestModelBatchWithRetry(requester, '/api/product-descriptions/generate', {
      ...requestOptions,
      body,
    }, workerIndex, rateLimiter, request.accountId);
    responses.push(response);
    try {
      return { parsed: normalizeRawModelPayload(extractJson(response?.description)), responses };
    } catch (error) {
      lastError = error;
      if (attempt >= MODEL_JSON_MAX_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

async function hydrateDictionaryOptions({
  parsedResults = [],
  definitions = [],
  optionsByAttributeId = {},
  searchAttributeOptions,
  signal,
  onProgress,
  concurrency,
} = {}) {
  const nextOptions = Object.fromEntries(Object.entries(optionsByAttributeId || {}).map(([id, rows]) => [
    id,
    Array.isArray(rows) ? [...rows] : [],
  ]));
  if (typeof searchAttributeOptions !== 'function') {
    return { optionsByAttributeId: nextOptions, searchResults: new Map(), searchCount: 0 };
  }
  const definitionsById = definitionMapOf(definitions);
  const taskMap = new Map();
  parsedResults.forEach((parsed) => {
    [...rawAttributeSuggestions(parsed), ...rawUnresolvedSuggestions(parsed)].forEach(({ suggestion }) => {
      if (numericConfidence(suggestion?.confidence, 1) < COLLECTION_ATTRIBUTE_AUTOFILL_MIN_CONFIDENCE) return;
      const attributeId = clean(suggestion?.attributeId ?? suggestion?.id, 80);
      const definition = definitionsById.get(attributeId);
      if (!definition?.isDictionary) return;
      suggestionLookupTerms(suggestion).forEach((query) => {
        const normalizedQuery = normalizedMatchText(query);
        const hasExactOption = (nextOptions[attributeId] || []).some((option) => (
          normalizedMatchText(option?.label ?? option?.value) === normalizedQuery
        ));
        if (hasExactOption) return;
        const key = `${attributeId}:${normalizedQuery}`;
        const existing = taskMap.get(key);
        if (existing) {
          existing.aliases.add(query);
          return;
        }
        taskMap.set(key, { key, attributeId, query, aliases: new Set([query]) });
      });
    });
  });
  const tasks = [...taskMap.values()];
  const searchResults = new Map();
  const mergeRows = (attributeId, rows) => {
    mergeDictionaryRows(nextOptions, attributeId, rows);
  };
  const assignSearchRows = (task, rows) => {
    task.aliases.forEach((alias) => {
      searchResults.set(`${task.attributeId}:${alias.toLocaleLowerCase()}`, rows);
    });
  };
  const groupedTasks = new Map();
  tasks.forEach((task) => {
    const rows = groupedTasks.get(task.attributeId) || [];
    rows.push(task);
    groupedTasks.set(task.attributeId, rows);
  });
  const bulkGroups = [...groupedTasks.entries()]
    .filter(([attributeId, rows]) => (
      rows.length >= DICTIONARY_BULK_PREFETCH_THRESHOLD
      || !(nextOptions[attributeId] || []).length
    ))
    .map(([attributeId, rows]) => ({ attributeId, tasks: rows }));
  const bulkAttributeIds = new Set(bulkGroups.map((item) => item.attributeId));
  const specificTasks = tasks.filter((task) => !bulkAttributeIds.has(task.attributeId));
  let completedRequests = 0;
  let searchCount = 0;
  let progressTotal = bulkGroups.length + specificTasks.length;
  const reportProgress = () => onProgress?.({
    phase: 'dictionary',
    current: completedRequests,
    total: Math.max(completedRequests, progressTotal),
  });
  const dictionaryConcurrency = Math.max(1, Math.min(
    Number(concurrency) || DEFAULT_DICTIONARY_CONCURRENCY,
    Math.max(1, tasks.length),
  ));
  await runWithConcurrency(bulkGroups, Math.min(4, dictionaryConcurrency), async (group) => {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    let rows = [];
    try {
      searchCount += 1;
      rows = normalizeDictionaryRows(await searchAttributeOptions(group.attributeId, '', {
        signal,
        bulk: true,
        preferCache: true,
        // Cached dictionaries are normally ready because they are preloaded while
        // image analysis runs.  A genuinely empty dictionary gets one real Ozon
        // refresh here, shared by every candidate for the same attribute.
        cacheOnly: Boolean((nextOptions[group.attributeId] || []).length),
      }));
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
    }
    mergeRows(group.attributeId, rows);
    const definition = definitionsById.get(group.attributeId) || {};
    group.tasks.forEach((task) => {
      const matched = matchingDictionaryRows(rows, task.query, definition.isCollection);
      if (matched.length) assignSearchRows(task, rows);
      else specificTasks.push(task);
    });
    completedRequests += 1;
    reportProgress();
  });
  progressTotal = completedRequests + specificTasks.length;
  reportProgress();
  await runWithConcurrency(specificTasks, dictionaryConcurrency, async (task) => {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    let rows = [];
    try {
      searchCount += 1;
      rows = normalizeDictionaryRows(await searchAttributeOptions(task.attributeId, task.query, {
        signal,
        preferCache: true,
        cacheOnly: true,
      }));
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
    }
    assignSearchRows(task, rows);
    mergeRows(task.attributeId, rows);
    completedRequests += 1;
    reportProgress();
  });
  return { optionsByAttributeId: nextOptions, searchResults, searchCount };
}

function reconcileDictionarySuggestions(parsedResults = [], definitions = [], optionsByAttributeId = {}, searchResults = new Map()) {
  const definitionsById = definitionMapOf(definitions);
  const selectOptions = (attributeId, terms, isCollection) => {
    const optionRows = Array.isArray(optionsByAttributeId?.[attributeId]) ? optionsByAttributeId[attributeId] : [];
    const selected = new Map();
    for (const term of terms) {
      const returned = searchResults.get(`${attributeId}:${term.toLocaleLowerCase()}`) || [];
      const matchedRows = matchingDictionaryRows(optionRows, term, isCollection).length
        ? matchingDictionaryRows(optionRows, term, isCollection)
        : matchingDictionaryRows(returned, term, isCollection);
      matchedRows.forEach((match) => {
        const id = clean(match.id, 80);
        if (id) selected.set(id, match);
      });
      if (!isCollection && selected.size) break;
    }
    return [...selected.values()];
  };
  const applySelected = (suggestion, definition, selectedRows) => {
    if (!selectedRows.length) return false;
    if (definition.isCollection) {
      suggestion.dictionaryValueIds = [...new Set([
        ...(Array.isArray(suggestion.dictionaryValueIds) ? suggestion.dictionaryValueIds : []),
        ...selectedRows.map((item) => clean(item.id, 80)),
      ].filter(Boolean))];
      suggestion.values = [...new Set([
        ...(Array.isArray(suggestion.values) ? suggestion.values : []),
        ...selectedRows.map((item) => clean(item.label ?? item.value, 500)),
      ].filter(Boolean))];
    } else {
      suggestion.dictionaryValueId = clean(selectedRows[0].id, 80);
      suggestion.value = clean(selectedRows[0].label ?? selectedRows[0].value, 500);
    }
    return true;
  };
  parsedResults.forEach((parsed) => {
    rawAttributeSuggestions(parsed).forEach(({ suggestion }) => {
      const attributeId = clean(suggestion?.attributeId ?? suggestion?.id, 80);
      const definition = definitionsById.get(attributeId);
      if (!definition?.isDictionary) return;
      const terms = suggestionLookupTerms(suggestion);
      if (!terms.length || (!definition.isCollection && suggestionValue(suggestion, definition, optionsByAttributeId))) return;
      applySelected(suggestion, definition, selectOptions(attributeId, terms, definition.isCollection));
    });
    const promoted = new Set();
    rawUnresolvedSuggestions(parsed).forEach(({ scope, sourceSkuId, suggestion, unresolved }, index) => {
      const attributeId = clean(suggestion.attributeId, 80);
      const definition = definitionsById.get(attributeId);
      const terms = suggestionLookupTerms(suggestion);
      if (!definition?.isDictionary || !terms.length) return;
      const selectedRows = selectOptions(attributeId, terms, definition.isCollection);
      if (!applySelected(suggestion, definition, selectedRows)) return;
      if (scope === 'sku') {
        let skuRow = parsed.skuAttributes.find((item) => clean(item?.sourceSkuId, 120) === sourceSkuId);
        if (!skuRow) {
          skuRow = { sourceSkuId, attributes: [] };
          parsed.skuAttributes.push(skuRow);
        }
        skuRow.attributes.push(suggestion);
      } else {
        parsed.globalAttributes.push(suggestion);
      }
      promoted.add(unresolved);
      promoted.add(index);
    });
    if (promoted.size) parsed.unresolved = parsed.unresolved.filter((item, index) => !promoted.has(item) && !promoted.has(index));
  });
}

function allowedOptionMap(definition = {}, optionsByAttributeId = {}) {
  const id = clean(definition.id, 80);
  const rows = Array.isArray(optionsByAttributeId[id]) ? optionsByAttributeId[id] : [];
  return new Map(rows.flatMap((option) => {
    const optionId = clean(option?.id, 80);
    const label = clean(option?.label ?? option?.value, 500);
    return optionId && label ? [[optionId, { id: optionId, label }]] : [];
  }));
}

function suggestionValue(suggestion = {}, definition = {}, optionsByAttributeId = {}) {
  if (numericConfidence(suggestion.confidence, 1) < COLLECTION_ATTRIBUTE_AUTOFILL_MIN_CONFIDENCE) return null;
  const maxValueCount = Math.max(0, Number(definition.maxValueCount ?? definition.max_value_count ?? 0) || 0);
  if (definition.isDictionary) {
    const optionMap = allowedOptionMap(definition, optionsByAttributeId);
    const byLabel = new Map([...optionMap.values()].map((item) => [clean(item.label, 500).toLocaleLowerCase(), item]));
    const requestedIds = [
      ...(Array.isArray(suggestion.dictionaryValueIds) ? suggestion.dictionaryValueIds : []),
      suggestion.dictionaryValueId,
    ].map((item) => clean(item, 80)).filter(Boolean);
    const requestedLabels = [
      ...(Array.isArray(suggestion.values) ? suggestion.values : []),
      suggestion.value,
    ].map((item) => clean(item, 500)).filter(Boolean);
    const selected = [];
    requestedIds.forEach((id) => { if (optionMap.has(id)) selected.push(optionMap.get(id)); });
    requestedLabels.forEach((label) => {
      const option = byLabel.get(label.toLocaleLowerCase());
      if (option) selected.push(option);
    });
    const unique = [...new Map(selected.map((item) => [item.id, item])).values()];
    const collectionLimit = Math.min(
      COLLECTION_BEIXIONG_RULES.multiSelectMaximum,
      maxValueCount || COLLECTION_BEIXIONG_RULES.multiSelectMaximum,
    );
    const limited = unique.slice(0, definition.isCollection ? collectionLimit : 1);
    if (!limited.length) return null;
    return definition.isCollection
      ? {
          value: limited.map((item) => item.label).join(', '),
          values: limited.map((item) => item.label),
          dictionaryValueId: '',
          dictionaryValueIds: limited.map((item) => item.id),
          source: 'ai',
        }
      : {
          value: limited[0].label,
          values: [],
          dictionaryValueId: limited[0].id,
          dictionaryValueIds: [],
          source: 'ai',
        };
  }
  const textMaximum = collectionBeixiongDefinitionPhase(definition) === 'description' ? 60_000 : 2_000;
  const requestedValues = [
    ...(Array.isArray(suggestion.values) ? suggestion.values : []),
    suggestion.value,
  ].map((item) => clean(item, textMaximum)).filter(Boolean);
  const type = clean(
    definition.valueType
      ?? definition.value_type
      ?? definition.attributeType
      ?? definition.attribute_type
      ?? definition.type,
    120,
  );
  const normalizedValues = NUMERIC_TYPE_PATTERN.test(type)
    ? requestedValues.flatMap((item) => {
        const normalized = item.replace(',', '.').replace(/\s+/gu, '');
        const number = Number(normalized);
        return Number.isFinite(number) ? [String(number)] : [];
      })
    : requestedValues;
  const unique = [...new Set(normalizedValues)];
  const limited = maxValueCount ? unique.slice(0, maxValueCount) : unique;
  if (!limited.length) return null;
  return definition.isCollection
    ? { value: limited.join(', '), values: limited, dictionaryValueId: '', dictionaryValueIds: [], source: 'ai' }
    : { value: limited[0], values: [], dictionaryValueId: '', dictionaryValueIds: [], source: 'ai' };
}

function sanitizeAttributeRows(rows = [], definitionMap, optionsByAttributeId) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).flatMap((suggestion) => {
    const attributeId = clean(suggestion?.attributeId ?? suggestion?.id, 80);
    const definition = definitionMap.get(attributeId);
    if (!attributeId || !definition || seen.has(attributeId)) return [];
    const value = suggestionValue(suggestion, definition, optionsByAttributeId);
    if (!value) return [];
    seen.add(attributeId);
    return [{
      attributeId,
      value,
      confidence: numericConfidence(suggestion.confidence, 1),
      evidence: clean(suggestion.evidence, 500),
    }];
  });
}

export function parseCollectionAttributeAutofillResult(value, {
  definitions = [], optionsByAttributeId = {}, draft = {},
} = {}) {
  const parsed = normalizeRawModelPayload(typeof value === 'string' ? extractJson(value) : value);
  const { global, sku } = splitListingAttributeDefinitions(definitions);
  const globalMap = new Map(global.map((item) => [clean(item.id, 80), item]));
  const skuMap = new Map(sku.map((item) => [clean(item.id, 80), item]));
  const validSkuIds = new Set((Array.isArray(draft.skus) ? draft.skus : []).map((item) => clean(item.sourceSkuId, 120)));
  return {
    title: clean(parsed?.title, 5_000),
    description: cleanMultiline(parsed?.description, 6_000),
    tags: normalizedTextArray(parsed?.tags, 80).slice(0, COLLECTION_BEIXIONG_RULES.tags.targetCount),
    skuTitles: (Array.isArray(parsed?.skuTitles) ? parsed.skuTitles : []).flatMap((item) => {
      const sourceSkuId = clean(item?.sourceSkuId, 120);
      const title = clean(item?.title, 5_000);
      return sourceSkuId && title && validSkuIds.has(sourceSkuId) ? [{ sourceSkuId, title }] : [];
    }),
    globalAttributes: sanitizeAttributeRows(parsed?.globalAttributes, globalMap, optionsByAttributeId),
    skuAttributes: (Array.isArray(parsed?.skuAttributes) ? parsed.skuAttributes : []).flatMap((item) => {
      const sourceSkuId = clean(item?.sourceSkuId, 120);
      if (!sourceSkuId || !validSkuIds.has(sourceSkuId)) return [];
      const attributes = sanitizeAttributeRows(item?.attributes, skuMap, optionsByAttributeId);
      return attributes.length ? [{ sourceSkuId, attributes }] : [];
    }),
    unresolved: (Array.isArray(parsed?.unresolved) ? parsed.unresolved : []).slice(0, 100).map((item) => ({
      scope: clean(item?.scope, 40),
      sourceSkuId: clean(item?.sourceSkuId, 120),
      attributeId: clean(item?.attributeId, 80),
      lookupTerms: normalizedTextArray(item?.lookupTerms, 300),
      reason: clean(item?.reason, 500),
    })).filter((item) => item.attributeId || item.reason),
  };
}

function mergeParsedSuggestions(parts = []) {
  const globalMap = new Map();
  const skuMap = new Map();
  const skuTitleMap = new Map();
  let title = '';
  let description = '';
  let tags = [];
  const unresolvedMap = new Map();
  (Array.isArray(parts) ? parts : []).forEach((part) => {
    if (!title && part?.title) title = part.title;
    if (!description && part?.description) description = part.description;
    if (!tags.length && Array.isArray(part?.tags)) tags = part.tags;
    (part?.skuTitles || []).forEach((item) => {
      if (item?.sourceSkuId && item?.title && !skuTitleMap.has(item.sourceSkuId)) {
        skuTitleMap.set(item.sourceSkuId, item.title);
      }
    });
    (part?.globalAttributes || []).forEach((item) => {
      const previous = globalMap.get(item.attributeId);
      if (!previous || item.confidence > previous.confidence) globalMap.set(item.attributeId, item);
    });
    (part?.skuAttributes || []).forEach((skuRow) => {
      const attributes = skuMap.get(skuRow.sourceSkuId) || new Map();
      (skuRow.attributes || []).forEach((item) => {
        const previous = attributes.get(item.attributeId);
        if (!previous || item.confidence > previous.confidence) attributes.set(item.attributeId, item);
      });
      skuMap.set(skuRow.sourceSkuId, attributes);
    });
    (part?.unresolved || []).forEach((item) => {
      const key = `${item.scope}:${item.sourceSkuId}:${item.attributeId}:${item.reason}`;
      unresolvedMap.set(key, item);
    });
  });
  const resolvedGlobalIds = new Set(globalMap.keys());
  const resolvedSkuKeys = new Set();
  skuMap.forEach((attributes, sourceSkuId) => {
    attributes.forEach((_value, attributeId) => resolvedSkuKeys.add(`${sourceSkuId}:${attributeId}`));
  });
  const unresolved = [...unresolvedMap.values()].filter((item) => {
    if (item.scope === 'sku') return !resolvedSkuKeys.has(`${item.sourceSkuId}:${item.attributeId}`);
    return !resolvedGlobalIds.has(item.attributeId);
  });
  return {
    title,
    description,
    tags,
    skuTitles: [...skuTitleMap.entries()].map(([sourceSkuId, skuTitle]) => ({ sourceSkuId, title: skuTitle })),
    globalAttributes: [...globalMap.values()],
    skuAttributes: [...skuMap.entries()].map(([sourceSkuId, attributes]) => ({
      sourceSkuId,
      attributes: [...attributes.values()],
    })).filter((item) => item.attributes.length),
    unresolved,
  };
}

function ensureSanitizedSuggestionCoverage(suggestions = {}, jobs = []) {
  const resolved = new Set();
  (suggestions.globalAttributes || []).forEach((item) => {
    resolved.add(batchTargetKey('global', '', item.attributeId));
  });
  (suggestions.skuAttributes || []).forEach((skuRow) => {
    (skuRow.attributes || []).forEach((item) => {
      resolved.add(batchTargetKey('sku', skuRow.sourceSkuId, item.attributeId));
    });
  });
  (Array.isArray(jobs) ? jobs : []).forEach((job) => {
    if (job.mode !== 'sku') return;
    (job.skus || []).forEach((sku) => {
      (sku.currentValues || []).forEach((item) => {
        if (clean(item?.value, 2_000)) {
          resolved.add(batchTargetKey('sku', sku.sourceSkuId, item.attributeId));
        }
      });
    });
  });
  const unresolved = new Map((suggestions.unresolved || []).map((item) => [
    batchTargetKey(item.sourceSkuId || item.scope === 'sku' ? 'sku' : 'global', item.sourceSkuId, item.attributeId),
    item,
  ]));
  (Array.isArray(jobs) ? jobs : []).flatMap(batchTargets).forEach((target) => {
    const key = batchTargetKey(target.scope, target.sourceSkuId, target.attributeId);
    if (resolved.has(key) || unresolved.has(key)) return;
    unresolved.set(key, {
      scope: target.scope,
      sourceSkuId: target.sourceSkuId,
      attributeId: target.attributeId,
      reason: '模型返回值未通过当前 Ozon 字段或标准选项校验，进入智能回退',
    });
  });
  return { ...suggestions, unresolved: [...unresolved.values()] };
}

function aggregateUsage(responses = []) {
  const usageRows = (Array.isArray(responses) ? responses : []).map((item) => item?.usage).filter(Boolean);
  if (!usageRows.length) return null;
  const result = {};
  usageRows.forEach((usage) => {
    Object.entries(usage).forEach(([key, value]) => {
      const number = Number(value);
      if (Number.isFinite(number)) result[key] = (Number(result[key]) || 0) + number;
    });
  });
  return result;
}

export function applyCollectionAttributeAutofillResult(draft = {}, suggestions = {}, expectedDraft = draft) {
  let appliedAttributeCount = 0;
  let appliedTextCount = 0;
  const attributeValues = { ...(draft.attributeValues || {}) };
  (suggestions.globalAttributes || []).forEach((item) => {
    if (isListingAttributeValueFilled(attributeValues[item.attributeId])) return;
    attributeValues[item.attributeId] = item.value;
    appliedAttributeCount += 1;
  });
  const skuSuggestionMap = new Map((suggestions.skuAttributes || []).map((item) => [item.sourceSkuId, item.attributes]));
  const skuTitleMap = new Map((suggestions.skuTitles || []).map((item) => [item.sourceSkuId, item.title]));
  const expectedSkuMap = new Map((Array.isArray(expectedDraft.skus) ? expectedDraft.skus : []).map((item) => [clean(item.sourceSkuId, 120), item]));
  const skus = (Array.isArray(draft.skus) ? draft.skus : []).map((sku) => {
    const nextValues = { ...(sku.attributeValues || {}) };
    const sourceSkuId = clean(sku.sourceSkuId, 120);
    (skuSuggestionMap.get(sourceSkuId) || []).forEach((item) => {
      if (isListingAttributeValueFilled(nextValues[item.attributeId])) return;
      nextValues[item.attributeId] = item.value;
      appliedAttributeCount += 1;
    });
    const suggestedTitle = clean(skuTitleMap.get(sourceSkuId), 5_000);
    const expectedSku = expectedSkuMap.get(sourceSkuId);
    const canReplaceTitle = suggestedTitle && String(sku.title || '') === String(expectedSku?.title || '');
    if (canReplaceTitle) appliedTextCount += 1;
    return { ...sku, title: canReplaceTitle ? suggestedTitle : sku.title, attributeValues: nextValues };
  });
  let title = draft.title;
  let description = draft.description;
  let tags = Array.isArray(draft.tags) ? draft.tags : [];
  if (suggestions.title && String(draft.title || '') === String(expectedDraft.title || '')) {
    title = suggestions.title;
    appliedTextCount += 1;
  }
  if (suggestions.description && String(draft.description || '') === String(expectedDraft.description || '')) {
    description = suggestions.description;
    appliedTextCount += 1;
  }
  if (Array.isArray(suggestions.tags)
    && suggestions.tags.length
    && JSON.stringify(tags) === JSON.stringify(Array.isArray(expectedDraft.tags) ? expectedDraft.tags : [])) {
    tags = suggestions.tags;
    appliedTextCount += 1;
  }
  const packageDefaults = suggestions.packageDefaults || {};
  const weightG = clean(draft.weightG, 60) || clean(packageDefaults.weightG, 60);
  const packageLengthCm = clean(draft.packageLengthCm, 60) || clean(packageDefaults.packageLengthCm, 60);
  const packageWidthCm = clean(draft.packageWidthCm, 60) || clean(packageDefaults.packageWidthCm, 60);
  const packageHeightCm = clean(draft.packageHeightCm, 60) || clean(packageDefaults.packageHeightCm, 60);
  appliedAttributeCount += [
    [draft.weightG, weightG],
    [draft.packageLengthCm, packageLengthCm],
    [draft.packageWidthCm, packageWidthCm],
    [draft.packageHeightCm, packageHeightCm],
  ].filter(([current, next]) => !clean(current, 60) && clean(next, 60)).length;
  return {
    draft: {
      ...draft,
      title,
      description,
      tags,
      weightG,
      packageLengthCm,
      packageWidthCm,
      packageHeightCm,
      attributeValues,
      skus,
    },
    appliedAttributeCount,
    appliedTextCount,
    appliedCount: appliedAttributeCount + appliedTextCount,
  };
}

export async function runCollectionAttributeAutofill(input = {}, options = {}) {
  const tool = input.tool || COLLECTION_ATTRIBUTE_AUTOFILL_RUNTIME_RULES;
  const modelPool = resolveCollectionAttributeModelPool({
    modelOptions: input.modelOptions,
    selectedModelId: input.selectedModelId,
  });
  const visionModelSelection = COLLECTION_BEIXIONG_BUILTIN_MODEL;
  if (!input.draft?.descriptionCategoryId || !input.draft?.typeId || !input.definitions?.length) {
    throw new Error('请先确认 Ozon 类目并读取类目字段。');
  }
  const requester = options.request || requestLocalApi;
  const progress = options.onProgress || input.onProgress;
  const splitGlobalJobs = options.splitGlobalJobs === true;
  const globalAttributeBatchSize = Math.max(0, Math.trunc(Number(options.globalAttributeBatchSize) || 0));
  const sharedSkuTitle = options.sharedSkuTitle === true;
  // First determine whether any text or attribute cell still needs model work.
  // This schema-free preflight prevents a completed draft from touching either
  // the model or the dictionary cache. Pending dictionary fields are still jobs,
  // and therefore continue through the normal official-option preload below.
  const skuBatchSize = resolveSkuBatchSize(options.skuBatchSize);
  const preflightJobs = createBatchJobs(input, {
    skuBatchSize,
    splitGlobalJobs,
    globalAttributeBatchSize,
    sharedSkuTitle,
  });
  let preloadedDictionary = {
    optionsByAttributeId: { ...(input.optionsByAttributeId || {}) },
    requestCount: 0,
  };
  let visualReport = '';
  let visionWarning = '';
  const visionRequest = options.enableVision === false || !preflightJobs.length
    ? null
    : createVisionRequest({ ...input, tool, modelSelection: visionModelSelection });
  const dictionaryPreloadPromise = !preflightJobs.length
    ? null
    : preloadCollectionAttributeAutofillDictionaryOptions({
        definitions: input.definitions,
        optionsByAttributeId: input.optionsByAttributeId,
        searchAttributeOptions: options.searchAttributeOptions || input.searchAttributeOptions,
        signal: options.signal,
        concurrency: options.dictionaryConcurrency,
      });
  if (visionRequest) {
    progress?.({ phase: 'vision', current: 0, total: 1 });
    try {
      const response = await requester(visionRequest.path, {
        method: 'POST',
        body: visionRequest.body,
        timeoutMs: options.visionTimeoutMs || 180_000,
        signal: options.signal,
      });
      visualReport = cleanMultiline(response?.planText, 20_000);
      progress?.({ phase: 'vision', current: 1, total: 1 });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      visionWarning = error instanceof Error ? error.message : '图片事实读取失败';
    }
  }
  if (dictionaryPreloadPromise) preloadedDictionary = await dictionaryPreloadPromise;
  const preparedInput = {
    ...input,
    optionsByAttributeId: preloadedDictionary.optionsByAttributeId,
  };
  const jobs = preflightJobs.length
    ? createBatchJobs(preparedInput, {
        skuBatchSize,
        splitGlobalJobs,
        globalAttributeBatchSize,
        sharedSkuTitle,
      })
    : preflightJobs;
  const requestedModelConcurrency = Number(options.modelConcurrency);
  const automaticModelConcurrency = modelPool.length > 1
    ? Math.min(MAX_MODEL_POOL_CONCURRENCY, Math.max(DEFAULT_MODEL_CONCURRENCY, modelPool.length))
    : DEFAULT_MODEL_CONCURRENCY;
  const modelConcurrency = Number.isFinite(requestedModelConcurrency) && requestedModelConcurrency > 0
    ? Math.min(Math.trunc(requestedModelConcurrency), jobs.length || 1)
    : Math.min(automaticModelConcurrency, Math.max(1, jobs.length));
  const modelRateLimiter = createModelRequestRateLimiter({
    maximum: options.modelRequestsPerWindow,
    windowMs: options.modelRequestWindowMs,
    now: options.modelRateLimitNow,
    wait: options.modelRateLimitWait,
  });
  const checkpointKey = clean(input.checkpointKey, 500);
  const savedCheckpoint = input.checkpoint?.key === checkpointKey && input.checkpoint?.completedByJobId
    ? input.checkpoint
    : null;
  const savedCompleted = savedCheckpoint?.completedByJobId || {};
  const reusedResults = jobs.flatMap((job) => {
    const parsed = savedCompleted[job.id];
    if (!parsed) return [];
    return [{
      job,
      responses: [],
      parsed: normalizeRawModelPayload(parsed),
      reviewedCount: batchTargets(job).length,
      reused: true,
    }];
  });
  const pendingJobs = jobs.filter((job) => !savedCompleted[job.id]);
  const pendingJobIndexById = new Map(pendingJobs.map((job, index) => [job.id, index]));
  let completedModelBatches = reusedResults.length;
  progress?.({ phase: 'model', current: completedModelBatches, total: jobs.length, concurrency: modelConcurrency });
  const runJob = async (job, workerIndex) => {
    const modelSelection = modelPool[(pendingJobIndexById.get(job.id) || 0) % modelPool.length];
    const parsedParts = [];
    const responses = [];
    let audit = { targets: batchTargets(job), missing: batchTargets(job) };
    try {
      const baseRequest = createBatchRequest({ ...preparedInput, job, tool, modelSelection, visualReport });
      for (let repairAttempt = 0; repairAttempt <= MODEL_REPAIR_MAX_ATTEMPTS; repairAttempt += 1) {
        const request = repairAttempt === 0
          ? baseRequest
          : withBoundedUserInstruction(
              baseRequest,
              [
                `这是局部修正第 ${repairAttempt}/${MODEL_REPAIR_MAX_ATTEMPTS} 次。上次仍有 ${audit.missing.length} 个字段没有有效值。`,
                `只补齐这些目标：${JSON.stringify(audit.missing)}。下拉仍只能使用输入中的官方 options。`,
              ].join('\n'),
              `局部修正：补齐当前 schema 中仍缺失的 ${audit.missing.length} 个目标；下拉仅使用官方 options，并返回完整 JSON。`,
            );
        const requested = await requestAndParseModelBatch(requester, request, {
          method: 'POST',
          timeoutMs: options.timeoutMs || 180_000,
          signal: options.signal,
        }, workerIndex, modelRateLimiter);
        responses.push(...requested.responses);
        parsedParts.push(requested.parsed);
        const merged = normalizeRawModelPayload(mergeParsedSuggestions(parsedParts));
        audit = auditBatchResult(job, merged);
        if (!audit.missing.length) {
          return {
            job,
            responses,
            parsed: merged,
            reviewedCount: audit.targets.length,
            repairAttemptCount: repairAttempt,
            modelSelection,
          };
        }
      }
      const parsed = addMissingTargetsToUnresolved(
        normalizeRawModelPayload(mergeParsedSuggestions(parsedParts)),
        audit.missing,
      );
      return {
        job,
        responses,
        parsed,
        reviewedCount: audit.targets.length,
        repairAttemptCount: MODEL_REPAIR_MAX_ATTEMPTS,
        modelSelection,
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const parsed = parsedParts.length
        ? addMissingTargetsToUnresolved(
            normalizeRawModelPayload(mergeParsedSuggestions(parsedParts)),
            audit.missing,
          )
        : null;
      return {
        job,
        responses,
        parsed,
        reviewedCount: audit.targets.length,
        repairAttemptCount: 0,
        modelSelection,
        error,
      };
    } finally {
      completedModelBatches += 1;
      progress?.({
        phase: 'model',
        stage: job.phase,
        current: completedModelBatches,
        total: jobs.length,
        jobId: job.id,
        modelAccountId: modelSelection.accountId,
      });
    }
  };
  progress?.({
    phase: 'model',
    stage: 'single-wave',
    stageLabel: '单轮并行填写文案与属性',
    current: completedModelBatches,
    total: jobs.length,
    concurrency: Math.min(modelConcurrency, pendingJobs.length || 1),
  });
  const pendingResults = await runWithConcurrency(
    pendingJobs,
    Math.min(modelConcurrency, pendingJobs.length || 1),
    runJob,
  );
  const jobResults = [...reusedResults, ...pendingResults];
  const usableResults = jobResults.filter((item) => item.parsed);
  const completedResults = jobResults.filter((item) => item.parsed && !item.error);
  const failedResults = jobResults.filter((item) => !item.parsed || item.error);
  const nextCheckpoint = failedResults.length ? {
    key: checkpointKey,
    completedByJobId: Object.fromEntries(completedResults.map((item) => [item.job.id, item.parsed])),
    failedJobIds: failedResults.map((item) => item.job.id),
  } : null;
  if (!usableResults.length && failedResults.length) {
    const error = failedResults[0].error instanceof Error
      ? failedResults[0].error
      : new Error('模型属性批次全部失败，请重新分析。');
    error.checkpoint = nextCheckpoint;
    throw error;
  }
  const rawResults = usableResults.map((item) => item.parsed);
  const dictionary = await hydrateDictionaryOptions({
    parsedResults: rawResults,
    definitions: input.definitions,
    optionsByAttributeId: preloadedDictionary.optionsByAttributeId,
    searchAttributeOptions: options.searchAttributeOptions || input.searchAttributeOptions,
    signal: options.signal,
    onProgress: progress,
    concurrency: options.dictionaryConcurrency,
  });
  reconcileDictionarySuggestions(
    rawResults,
    input.definitions,
    dictionary.optionsByAttributeId,
    dictionary.searchResults,
  );
  const parsedParts = rawResults.map((parsed) => parseCollectionAttributeAutofillResult(parsed, {
    ...input,
    optionsByAttributeId: dictionary.optionsByAttributeId,
  }));
  const sanitizedSuggestions = ensureSanitizedSuggestionCoverage(mergeParsedSuggestions(parsedParts), jobs);
  const suggestions = completeCollectionBeixiongSuggestions(sanitizedSuggestions, {
    product: input.product,
    draft: input.draft,
    definitions: input.definitions,
    optionsByAttributeId: dictionary.optionsByAttributeId,
    sharedSkuTitle,
  });
  const responseRows = usableResults.flatMap((item) => item.responses || []);
  const { global: globalDefinitions, sku: skuDefinitions } = splitListingAttributeDefinitions(input.definitions);
  progress?.({ phase: 'complete', current: jobs.length, total: jobs.length });
  return {
    suggestions,
    optionsByAttributeId: dictionary.optionsByAttributeId,
    rawText: cleanMultiline(responseRows.map((item) => item?.description).filter(Boolean).join('\n'), 60_000),
    usage: aggregateUsage(responseRows),
    model: clean(responseRows.find((item) => item?.model)?.model || modelPool[0].model, 240),
    modelLabel: modelPool.length > 1
      ? `${modelPool.length} 路模型接口并行`
      : clean(modelPool[0].displayName || modelPool[0].label || modelPool[0].model, 240),
    checkpoint: nextCheckpoint,
    pipeline: {
      strategy: COLLECTION_BEIXIONG_RULES.version,
      phaseCount: jobs.length ? 1 : 0,
      skuBatchSize,
      splitGlobalJobs,
      globalAttributeBatchSize,
      sharedSkuTitle,
      modelRoundCount: Math.max(1, ...usableResults.map((item) => item.responses?.length || 0)),
      repairAttemptCount: usableResults.reduce((total, item) => total + Number(item.repairAttemptCount || 0), 0),
      fallbackCount: suggestions.fallbackCount,
      modelBatchCount: jobs.length,
      modelConcurrency,
      modelPoolSize: modelPool.length,
      modelAccountCount: new Set(modelPool.map((item) => item.accountId)).size,
      parallelPhaseExecution: true,
      strictPhaseOrder: false,
      reviewedAttributeCellCount: completedResults.reduce((total, item) => total + item.reviewedCount, 0),
      completedModelBatchCount: completedResults.length,
      failedModelBatchCount: failedResults.length,
      reusedModelBatchCount: reusedResults.length,
      modelRequestCount: responseRows.length,
      modelRequestsPerWindow: modelRateLimiter.maximum,
      modelRequestWindowMs: modelRateLimiter.windowMs,
      modelWarning: failedResults.length
        ? `${failedResults.length} 个模型批次暂未完成，已保留成功结果，下次可从失败批次继续。`
        : '',
      schemaFieldCount: input.definitions.length,
      schemaCellCount: globalDefinitions.length + (skuDefinitions.length * (input.draft.skus?.length || 0)),
      dictionarySearchCount: dictionary.searchCount,
      dictionaryPreloadCount: preloadedDictionary.requestCount,
      visualAnalysisUsed: Boolean(visualReport),
      visionWarning,
    },
  };
}
