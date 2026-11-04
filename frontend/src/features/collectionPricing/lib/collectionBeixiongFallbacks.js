import { COLLECTION_BEIXIONG_RULES } from '../constants/collectionBeixiongAutofillRules.js';
import {
  isListingAttributeValueFilled,
  normalizeListingAttributeValue,
  splitListingAttributeDefinitions,
} from './collectionProductAttributeSchema.js';
import {
  collectionBeixiongDefinitionKind,
  collectionBeixiongDefinitionPhase,
  isCollectionBeixiongSharedDefinition,
} from './collectionBeixiongAutofillPlan.js';

const CYRILLIC_PATTERN = /[А-Яа-яЁё]/u;
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/u;

function clean(value, maximum = 2_000) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function definitionId(definition = {}) {
  return clean(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
}

function definitionLabel(definition = {}) {
  return clean([
    definition.name,
    definition.title,
    definition.description,
    definition.groupName,
    definition.group_name,
  ].filter(Boolean).join(' '), 1_000);
}

function definitionName(definition = {}) {
  return clean([definition.name, definition.title].filter(Boolean).join(' '), 500);
}

function listingPackageDefaults(product = {}, draft = {}) {
  return {
    weightG: clean(draft.weightG ?? product.weightG, 60),
    packageLengthCm: clean(draft.packageLengthCm ?? product.packageLengthCm, 60),
    packageWidthCm: clean(draft.packageWidthCm ?? product.packageWidthCm, 60),
    packageHeightCm: clean(draft.packageHeightCm ?? product.packageHeightCm, 60),
  };
}

function sourceDocumentUrls(product = {}) {
  const rows = [
    ...(Array.isArray(product.documents) ? product.documents : []),
    ...(Array.isArray(product.pdfUrls) ? product.pdfUrls : []),
    product.pdfUrl,
    product.documentUrl,
  ];
  return [...new Set(rows.map((item) => clean(item?.url ?? item, 3_000)).filter((item) => /^https:\/\//iu.test(item)))];
}

function buildNorthBearRichContent(draft = {}) {
  const description = normalizeCollectionBeixiongDescription(draft.description);
  if (!description) return '';
  const textItems = description.split(/(?<=[.!?])\s+/u).filter(Boolean).map((content) => ({ type: 'text', content }));
  const content = [{
    widgetName: 'raTextBlock',
    theme: 'primary',
    padding: 'type2',
    gapSize: 'm',
    text: { size: 'size3', align: 'left', color: 'color1', items: textItems },
  }];
  // Rich Content is deliberately text-only. Supplier media is neither an
  // Ozon-hosted video nor an explicitly selected listing image, and allowing
  // it here bypasses the editor's image selection contract.
  return JSON.stringify({ content, version: 0.3 });
}

function truncate(value, maximum) {
  const source = clean(value, maximum + 100);
  if (source.length <= maximum) return source;
  return source.slice(0, maximum).replace(/[,;:\s-]+$/u, '').trim();
}

export function normalizeCollectionBeixiongTitle(value) {
  const rules = COLLECTION_BEIXIONG_RULES.title;
  const title = clean(value, 1_000);
  if (!title || CJK_PATTERN.test(title) || !CYRILLIC_PATTERN.test(title)) return '';
  return truncate(title, rules.maximum);
}

export function normalizeCollectionBeixiongDescription(value) {
  const source = clean(value, 6_000);
  const sourceSentences = source
    .split(/(?<=[.!?])\s+/u)
    .map((item) => clean(item, 1_000))
    .filter((item) => item && CYRILLIC_PATTERN.test(item) && !CJK_PATTERN.test(item));
  return sourceSentences
    .slice(0, COLLECTION_BEIXIONG_RULES.description.maximumSentences)
    .join(' ');
}

export function normalizeCollectionBeixiongTags(value = []) {
  const rows = Array.isArray(value) ? value.flat(2) : clean(value, 4_000).split(/[,，;；\n]/u);
  const unique = [];
  rows.forEach((item) => {
    const tag = clean(item, COLLECTION_BEIXIONG_RULES.tags.maximumLength);
    if (!tag || CJK_PATTERN.test(tag) || !CYRILLIC_PATTERN.test(tag)) return;
    if (!unique.some((current) => current.toLocaleLowerCase() === tag.toLocaleLowerCase())) unique.push(tag);
  });
  return unique.slice(0, COLLECTION_BEIXIONG_RULES.tags.targetCount);
}

function sourceAttributeValue(definition = {}, product = {}, sku = null) {
  const wanted = definitionLabel(definition).toLocaleLowerCase();
  const rows = [
    ...(Array.isArray(sku?.sourceAttributes) ? sku.sourceAttributes : []),
    ...(Array.isArray(sku?.attributes) ? sku.attributes : []),
    ...(Array.isArray(product.attributes) ? product.attributes : []),
  ];
  const exact = rows.find((item) => {
    const name = clean(item?.name ?? item?.title ?? item?.key, 300).toLocaleLowerCase();
    return name && (wanted.includes(name) || name.includes(wanted));
  });
  const value = clean(exact?.value ?? exact?.valueText ?? exact?.text, 1_000);
  return value && !CJK_PATTERN.test(value) ? value : '';
}

function fallbackAttributeValue(definition = {}, { product = {}, draft = {}, sku = null } = {}) {
  if (definition.isDictionary) return null;
  const sourceValue = sourceAttributeValue(definition, product, sku);
  const label = definitionLabel(definition);
  const name = definitionName(definition);
  const kind = collectionBeixiongDefinitionKind(definition);
  let value = sourceValue;
  const documents = sourceDocumentUrls(product);
  if (/документ\s*pdf|pdf\s*(?:документ|document)|PDF文档/iu.test(name)) {
    if (!documents.length) return null;
    value = documents[0];
  } else if (/название\s*файла\s*pdf|pdf\s*(?:name|名称)/iu.test(name)) {
    const documentName = (Array.isArray(product.documents) ? product.documents : [])
      .map((item) => clean(item?.name ?? item?.title ?? item?.fileName, 500))
      .find(Boolean);
    if (!documents.length || !documentName) return null;
    value = documentName;
  } else if (/rich[-\s]*контент|rich[-\s]*content/iu.test(name)) {
    value = buildNorthBearRichContent(draft);
  } else if (/видеообложк.*ссыл|video.*cover.*(?:url|link)/iu.test(name)) {
    return null;
  } else if (/видео.*назван|video.*(?:name|title)/iu.test(name)) {
    return null;
  } else if (/видео.*(?:ссыл|url|link)/iu.test(name)) {
    return null;
  } else if (/товар.*на\s*видео|products?.*video/iu.test(name)) {
    return null;
  } else if (kind === 'number') {
    const namedDraftValue = /вес|weight|重量/iu.test(label)
      ? draft.weightG
      : /длин|length|长度|长/iu.test(label)
        ? draft.packageLengthCm
        : /шир|width|宽/iu.test(label)
          ? draft.packageWidthCm
          : /выс|height|高度|高/iu.test(label)
            ? draft.packageHeightCm
            : '';
    const match = clean(namedDraftValue || sourceValue, 200).replace(',', '.').match(/-?\d+(?:\.\d+)?/u);
    value = match ? String(Number(match[0])) : '';
  } else if (collectionBeixiongDefinitionPhase(definition) === 'tags') {
    return null;
  } else if (collectionBeixiongDefinitionPhase(definition) === 'description') {
    return null;
  }
  if (!value || CJK_PATTERN.test(value)) return null;
  return { value, values: [], dictionaryValueId: '', dictionaryValueIds: [], source: 'ai' };
}

function suggestionRow(attributeId, value, evidence = '来源资料中的真实字段回退') {
  return { attributeId, value, confidence: 0.55, evidence };
}

function valueKey(value = {}) {
  const row = normalizeListingAttributeValue(value);
  return JSON.stringify([row.value, row.values, row.dictionaryValueId, row.dictionaryValueIds]);
}

export function completeCollectionBeixiongSuggestions(suggestions = {}, {
  product = {}, draft = {}, definitions = [], optionsByAttributeId = {}, sharedSkuTitle = false,
} = {}) {
  const globalMap = new Map((suggestions.globalAttributes || []).map((item) => [String(item.attributeId), item]));
  const skuMap = new Map((suggestions.skuAttributes || []).map((item) => [String(item.sourceSkuId), new Map(
    (item.attributes || []).map((attribute) => [String(attribute.attributeId), attribute]),
  )]));
  const { global: globalDefinitions, sku: skuDefinitions } = splitListingAttributeDefinitions(definitions);
  const unresolved = new Map();
  let fallbackCount = 0;
  globalDefinitions.forEach((definition) => {
    const id = definitionId(definition);
    const suggested = globalMap.get(id);
    if (suggested && !definition.isDictionary && CJK_PATTERN.test(normalizeListingAttributeValue(suggested.value).value)) {
      globalMap.delete(id);
    }
    if (!id || isListingAttributeValueFilled(draft.attributeValues?.[id]) || globalMap.has(id)) return;
    const value = fallbackAttributeValue(definition, { product, draft, optionsByAttributeId });
    if (value) {
      globalMap.set(id, suggestionRow(id, value));
      fallbackCount += 1;
    } else {
      unresolved.set(`global::${id}`, {
        scope: 'global', sourceSkuId: '', attributeId: id,
        reason: definition.isDictionary
          ? '没有与来源事实匹配的 Ozon 官方选项，需人工确认'
          : '来源资料没有该字段的可靠事实，需人工确认',
      });
    }
  });
  const draftSkus = Array.isArray(draft.skus) ? draft.skus : [];
  skuDefinitions.forEach((definition) => {
    const id = definitionId(definition);
    const firstSuggested = draftSkus
      .map((sku) => skuMap.get(String(sku.sourceSkuId))?.get(id)?.value)
      .find((value) => isListingAttributeValueFilled(value)
        && (definition.isDictionary || !CJK_PATTERN.test(normalizeListingAttributeValue(value).value)));
    const shared = isCollectionBeixiongSharedDefinition(definition);
    draftSkus.forEach((sku, index) => {
      const sourceSkuId = String(sku.sourceSkuId || '');
      if (!sourceSkuId || isListingAttributeValueFilled(sku.attributeValues?.[id])) return;
      const attributes = skuMap.get(sourceSkuId) || new Map();
      const suggested = attributes.get(id);
      if (suggested && !definition.isDictionary && CJK_PATTERN.test(normalizeListingAttributeValue(suggested.value).value)) {
        attributes.delete(id);
      }
      if (attributes.has(id)) return;
      const sourceSku = (Array.isArray(product.skus) ? product.skus : []).find((item) => String(item?.id ?? item?.name ?? '') === sourceSkuId)
        || product.skus?.[index]
        || {};
      const value = shared && firstSuggested
        ? firstSuggested
        : fallbackAttributeValue(definition, { product, draft, sku: sourceSku, optionsByAttributeId });
      if (value) {
        attributes.set(id, suggestionRow(id, value, shared && firstSuggested
          ? '明确 shared 字段：首个有效 SKU 值传播'
          : 'SKU 来源资料中的真实字段回退'));
        skuMap.set(sourceSkuId, attributes);
        fallbackCount += 1;
      } else {
        unresolved.set(`sku:${sourceSkuId}:${id}`, {
          scope: 'sku', sourceSkuId, attributeId: id,
          reason: definition.isDictionary
            ? '没有与该 SKU 来源事实匹配的 Ozon 官方选项，需人工确认'
            : '该 SKU 来源资料没有该字段的可靠事实，需人工确认',
        });
      }
    });
  });
  (suggestions.unresolved || []).forEach((item) => {
    const sourceSkuId = String(item.sourceSkuId || '');
    const id = String(item.attributeId || '');
    const resolved = sourceSkuId ? skuMap.get(sourceSkuId)?.has(id) : globalMap.has(id);
    const key = `${sourceSkuId ? 'sku' : 'global'}:${sourceSkuId}:${id}`;
    if (!resolved && id && !unresolved.has(key)) unresolved.set(key, item);
  });
  const skuTitleMap = new Map((suggestions.skuTitles || []).map((item) => [String(item.sourceSkuId), clean(item.title, 1_000)]));
  const sharedTitle = sharedSkuTitle
    ? normalizeCollectionBeixiongTitle(suggestions.title) || normalizeCollectionBeixiongTitle(draft.title)
    : '';
  const skuTitles = draftSkus.map((sku) => {
    const title = normalizeCollectionBeixiongTitle(skuTitleMap.get(String(sku.sourceSkuId)))
      || (normalizeCollectionBeixiongTitle(sku.title) ? '' : sharedTitle);
    return title ? {
      sourceSkuId: String(sku.sourceSkuId || ''),
      title,
    } : null;
  }).filter(Boolean);
  const tags = normalizeCollectionBeixiongTags(suggestions.tags);
  return {
    ...suggestions,
    title: normalizeCollectionBeixiongTitle(suggestions.title),
    description: normalizeCollectionBeixiongDescription(suggestions.description),
    tags,
    skuTitles,
    packageDefaults: listingPackageDefaults(product, draft),
    globalAttributes: [...globalMap.values()],
    skuAttributes: [...skuMap.entries()].map(([sourceSkuId, attributes]) => ({
      sourceSkuId,
      attributes: [...attributes.values()],
    })).filter((item) => item.attributes.length),
    unresolved: [...unresolved.values()],
    fallbackCount,
    fillFingerprint: [
      [...globalMap.values()].map((item) => `${item.attributeId}:${valueKey(item.value)}`).join('|'),
      [...skuMap.entries()].map(([skuId, rows]) => `${skuId}:${[...rows.values()].map((item) => `${item.attributeId}:${valueKey(item.value)}`).join('|')}`).join('||'),
    ].join('###'),
  };
}
