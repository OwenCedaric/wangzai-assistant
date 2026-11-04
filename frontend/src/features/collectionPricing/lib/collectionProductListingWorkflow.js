const MAX_LISTING_SKUS = 80;

import {
  buildListingAttributeList,
  isListingAttributeValueFilled,
  normalizeListingAttributeValues,
  splitListingAttributeDefinitions,
  validateListingAttributeValues,
} from './collectionProductAttributeSchema.js';
import {
  normalizeCollectionProductLogisticsDraft,
  normalizeCollectionProductPricingDraft,
} from './collectionProductPricingDraft.js';
import { isCollectionSkuPricingSnapshotCurrent } from './collectionSkuPricingIntegrity.js';
import {
  normalizeCollectionProductGeneratedImageSelections,
  normalizeCollectionProductImageHistory,
  withCollectionProductGeneratedImageSelection,
} from './collectionProductImageHistory.js';
import {
  applyCollectionProductGeneratedImagesToListingDraft,
  normalizeCollectionProductOriginalImageSelections,
} from './collectionProductGeneratedImageApplication.js';
import {
  getCollectionSkuShopInventory,
  normalizeCollectionSkuInventoryByShop,
} from './collectionProductShopInventory.js';

function text(value, maximum = 10_000) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, maximum);
}

function decimal(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(Number(number.toFixed(2))) : '';
}

function optionalDecimal(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  return decimal(value);
}

function normalizeSkuPricingSnapshot(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    inputKey: text(source.inputKey, 240),
    purchaseCostCny: optionalDecimal(source.purchaseCostCny),
    firstMileCostCny: optionalDecimal(source.firstMileCostCny),
    extraCostCny: optionalDecimal(source.extraCostCny),
    commissionPercent: optionalDecimal(source.commissionPercent),
    commissionCostCny: optionalDecimal(source.commissionCostCny),
    fixedCostCny: optionalDecimal(source.fixedCostCny),
    allInCostCny: optionalDecimal(source.allInCostCny),
    totalCostCny: optionalDecimal(source.totalCostCny),
    expectedProfitCny: optionalDecimal(source.expectedProfitCny),
    profitMarginPercent: optionalDecimal(source.profitMarginPercent),
    breakEvenPriceCny: optionalDecimal(source.breakEvenPriceCny),
    generatedAt: text(source.generatedAt, 80),
    quoteSource: text(source.quoteSource, 40),
    logisticsProviderId: text(source.logisticsProviderId, 80),
    logisticsRouteId: text(source.logisticsRouteId, 180),
    logisticsPricingVersion: text(source.logisticsPricingVersion, 120),
    pricingMode: source.pricingMode === 'ozon-activity-50' ? source.pricingMode : '',
    activityDiscountPercent: optionalDecimal(source.activityDiscountPercent),
    activityPriceCny: optionalDecimal(source.activityPriceCny),
    activityReferencePriceCny: optionalDecimal(source.activityReferencePriceCny),
    standardOldPriceCny: optionalDecimal(source.standardOldPriceCny),
  };
}

function positive(value) {
  return Number(value) > 0;
}

const NON_PRESCRIPTION_GLASSES_TYPE_IDS = new Set(['971081388']);
const NON_PRESCRIPTION_GLASSES_LABEL_PATTERN = /(?:平光眼镜|无度数眼镜|без\s+диоптрий)/iu;
const PRESCRIPTION_SKU_KEYWORD_PATTERN = /(?:近视|远视|老花|度数|屈光|矫正视力|prescription|diopt|диоптр|дптр)/iu;
const SIGNED_DECIMAL_DIOPTER_PATTERN = /[+\-\u2212\u2013]\s*(?:0[.,]\d+|[1-9]\d*[.,]\d+)/u;

function hasPrescriptionSkuEvidence(draft = {}) {
  return (Array.isArray(draft.skus) ? draft.skus : []).some((sku) => {
    if (sku?.enabled === false) return false;
    const evidence = [sku?.sourceSkuName, sku?.title]
      .map((item) => text(item, 1000))
      .filter(Boolean)
      .join(' ');
    return PRESCRIPTION_SKU_KEYWORD_PATTERN.test(evidence)
      || SIGNED_DECIMAL_DIOPTER_PATTERN.test(evidence);
  });
}

function validateCollectionCategoryCompatibility(draft = {}) {
  const categoryLabel = [draft.categoryName, draft.categoryPath].map((item) => text(item, 1200)).join(' ');
  const isNonPrescriptionType = NON_PRESCRIPTION_GLASSES_TYPE_IDS.has(text(draft.typeId, 80))
    || NON_PRESCRIPTION_GLASSES_LABEL_PATTERN.test(categoryLabel);
  if (!isNonPrescriptionType || !hasPrescriptionSkuEvidence(draft)) return [];
  return ['检测到 SKU 中包含度数规格，不能选择“平光眼镜/无度数眼镜”；请从完整类目库选择“视力眼镜”。'];
}

function normalizedAspectValueSignature(value = {}) {
  const dictionaryIds = [...new Set([
    ...(Array.isArray(value.dictionaryValueIds) ? value.dictionaryValueIds : []),
    value.dictionaryValueId,
  ].map((item) => text(item, 120)).filter(Boolean))].sort();
  const labels = [...new Set([
    ...(Array.isArray(value.values) ? value.values : []),
    value.value,
  ].map((item) => text(item, 1000).toLocaleLowerCase()).filter(Boolean))].sort();
  return JSON.stringify({ dictionaryIds, labels });
}

function duplicateSkuAspectGroups(skus = [], definitions = [], attributeValues = {}) {
  if (!isListingAttributeValueFilled(attributeValues['9048'])) return null;
  const { sku: aspectDefinitions } = splitListingAttributeDefinitions(definitions);
  if (!aspectDefinitions.length || skus.length < 2) return [];
  const bySignature = new Map();
  for (const sku of skus) {
    const signature = JSON.stringify(aspectDefinitions.map((definition) => [
      String(definition.id),
      normalizedAspectValueSignature(sku.attributeValues?.[String(definition.id)]),
    ]));
    const group = bySignature.get(signature) || [];
    group.push(sku);
    bySignature.set(signature, group);
  }
  return [...bySignature.values()].filter((group) => group.length > 1);
}

function findDuplicateSkuAspectGroup(skus = [], definitions = [], attributeValues = {}) {
  return duplicateSkuAspectGroups(skus, definitions, attributeValues)?.[0] || null;
}

const SKU_VARIANT_TEXT_ATTRIBUTE_ID = '10097';
const SOURCE_COLOR_TRANSLATIONS = Object.freeze([
  [/(?:浅蓝|淡蓝).*(?:白)|(?:白).*(?:浅蓝|淡蓝)/u, 'Светло-сине-белый'],
  [/(?:灰).*(?:白)|(?:白).*(?:灰)/u, 'Серо-белый'],
  [/(?:蓝).*(?:白)|(?:白).*(?:蓝)/u, 'Сине-белый'],
  [/(?:黑).*(?:白)|(?:白).*(?:黑)/u, 'Черно-белый'],
  [/(?:粉).*(?:白)|(?:白).*(?:粉)/u, 'Розово-белый'],
  [/(?:红).*(?:白)|(?:白).*(?:红)/u, 'Красно-белый'],
  [/(?:浅蓝|淡蓝)/u, 'Светло-синий'],
  [/(?:深蓝|藏蓝)/u, 'Темно-синий'],
  [/黑/u, 'Черный'],
  [/白/u, 'Белый'],
  [/红/u, 'Красный'],
  [/蓝/u, 'Синий'],
  [/绿/u, 'Зеленый'],
  [/黄/u, 'Желтый'],
  [/灰/u, 'Серый'],
  [/粉/u, 'Розовый'],
  [/紫/u, 'Фиолетовый'],
  [/(?:棕|咖啡)/u, 'Коричневый'],
  [/橙/u, 'Оранжевый'],
  [/金/u, 'Золотой'],
  [/银/u, 'Серебристый'],
  [/米/u, 'Бежевый'],
]);

const RUSSIAN_COLOR_PATTERN = /\b(?:светло[- ]син(?:ий|яя|ее)|темно[- ]син(?:ий|яя|ее)|серо[- ]бел(?:ый|ая|ое)|сине[- ]бел(?:ый|ая|ое)|черно[- ]бел(?:ый|ая|ое)|розово[- ]бел(?:ый|ая|ое)|красно[- ]бел(?:ый|ая|ое)|черн(?:ый|ая|ое)|бел(?:ый|ая|ое)|красн(?:ый|ая|ое)|син(?:ий|яя|ее)|голуб(?:ой|ая|ое)|зелен(?:ый|ая|ое)|желт(?:ый|ая|ое)|сер(?:ый|ая|ое)|розов(?:ый|ая|ое)|фиолетов(?:ый|ая|ое)|коричнев(?:ый|ая|ое)|оранжев(?:ый|ая|ое)|золот(?:ой|ая|ое)|серебрист(?:ый|ая|ое)|бежев(?:ый|ая|ое))\b/iu;

function sourceSkuForDraftSku(product = {}, draftSku = {}, index = 0) {
  const sourceSkus = Array.isArray(product.skus) ? product.skus : [];
  const sourceSkuId = text(draftSku.sourceSkuId, 200);
  return sourceSkus.find((item) => text(item?.id ?? item?.skuId ?? item?.name, 200) === sourceSkuId)
    || sourceSkus[index]
    || {};
}

function sourceSkuVariantText(product = {}, draftSku = {}, index = 0) {
  const sourceSku = sourceSkuForDraftSku(product, draftSku, index);
  const sourceAttributes = [
    ...(Array.isArray(sourceSku.attributes) ? sourceSku.attributes : []),
    ...(Array.isArray(sourceSku.sourceAttributes) ? sourceSku.sourceAttributes : []),
  ].flatMap((item) => [item?.value, item?.valueText, item?.text]);
  return [
    sourceSku.name,
    sourceSku.variant,
    sourceSku.color,
    sourceSku.colour,
    draftSku.sourceSkuName,
    ...sourceAttributes,
  ].map((item) => text(item, 500)).filter(Boolean).join(' ');
}

function inferredRussianSkuVariant(product = {}, draftSku = {}, index = 0) {
  const source = sourceSkuVariantText(product, draftSku, index);
  for (const [pattern, translated] of SOURCE_COLOR_TRANSLATIONS) {
    if (pattern.test(source)) return translated;
  }
  const russian = [source, draftSku.title]
    .map((item) => text(item, 1000).match(RUSSIAN_COLOR_PATTERN)?.[0] || '')
    .find(Boolean);
  return russian ? `${russian[0].toLocaleUpperCase()}${russian.slice(1).toLocaleLowerCase()}` : '';
}

/**
 * Repairs only machine-filled colour-name variants.  Manual values remain
 * untouched and unresolved groups continue to fail closed in step validation.
 * This is source/link agnostic: every collected product goes through the same
 * SKU-id/source-label mapping before a preview can be created.
 */
export function repairCollectionProductSkuVariantValues(draft = {}, product = {}, definitions = []) {
  const { sku: skuDefinitions } = splitListingAttributeDefinitions(definitions);
  if (!skuDefinitions.some((definition) => String(definition.id) === SKU_VARIANT_TEXT_ATTRIBUTE_ID)) return draft;
  const enabled = (Array.isArray(draft.skus) ? draft.skus : []).filter((item) => item.enabled !== false);
  const duplicateGroups = duplicateSkuAspectGroups(enabled, definitions, draft.attributeValues) || [];
  const missingVariant = enabled.some((item) => !isListingAttributeValueFilled(
    item.attributeValues?.[SKU_VARIANT_TEXT_ATTRIBUTE_ID],
  ));
  if (!duplicateGroups.length && !missingVariant) return draft;

  const repairTargets = new Set([
    ...duplicateGroups.flat(),
    ...enabled.filter((item) => !isListingAttributeValueFilled(item.attributeValues?.[SKU_VARIANT_TEXT_ATTRIBUTE_ID])),
  ]);
  const candidateBySku = new Map();
  (Array.isArray(draft.skus) ? draft.skus : []).forEach((sku, index) => {
    if (!repairTargets.has(sku)) return;
    const current = normalizeListingAttributeValues({
      [SKU_VARIANT_TEXT_ATTRIBUTE_ID]: sku.attributeValues?.[SKU_VARIANT_TEXT_ATTRIBUTE_ID],
    })[SKU_VARIANT_TEXT_ATTRIBUTE_ID];
    if (current?.source === 'manual') return;
    const candidate = inferredRussianSkuVariant(product, sku, index);
    if (candidate) candidateBySku.set(sku, candidate);
  });
  if (candidateBySku.size !== repairTargets.size) return draft;
  const candidates = [...candidateBySku.values()].map((item) => item.toLocaleLowerCase());
  if (new Set(candidates).size !== candidates.length) return draft;

  const attributeValues = { ...(draft.attributeValues || {}) };
  delete attributeValues['10096'];
  delete attributeValues[SKU_VARIANT_TEXT_ATTRIBUTE_ID];
  return {
    ...draft,
    attributeValues,
    skus: (Array.isArray(draft.skus) ? draft.skus : []).map((sku) => {
      const candidate = candidateBySku.get(sku);
      if (!candidate) return sku;
      return {
        ...sku,
        attributeValues: {
          ...(sku.attributeValues || {}),
          [SKU_VARIANT_TEXT_ATTRIBUTE_ID]: {
            value: candidate,
            values: [],
            dictionaryValueId: '',
            dictionaryValueIds: [],
            source: 'source-sku-field',
            status: 'mapped',
            confidence: 0.98,
            evidence: [{
              source: 'source-sku-field',
              path: 'sku.name',
              value: sourceSkuVariantText(product, sku),
            }],
          },
        },
      };
    }),
  };
}

function safeOfferPart(value) {
  return text(value, 100).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
}

function createLegacyOfferId(product = {}, sku = {}, index = 0, savedSku = {}) {
  const productPart = safeOfferPart(product.sourceProductId || product.id || 'item');
  const skuPart = safeOfferPart(sku.id || savedSku.sourceSkuId || sku.name || savedSku.sourceSkuName || index + 1);
  const suffix = String(index + 1).padStart(2, '0');
  return `SPB-${productPart}-${skuPart}-${suffix}`.slice(0, 30).replace(/-+$/u, '');
}

function stableNumericOfferToken(value) {
  const source = text(value, 2000) || 'wangzai';
  let left = 2166136261;
  let right = 2246822519;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619) >>> 0;
    right = Math.imul(right ^ (code + index + 1), 3266489917) >>> 0;
  }
  return `${String(left).padStart(10, '0')}${String(right).padStart(10, '0')}`;
}

function sourceSkuNumericId(sku = {}, savedSku = {}) {
  const sourceId = text(sku.id || sku.skuId || savedSku.sourceSkuId, 260);
  if (/^\d+$/u.test(sourceId)) return sourceId;
  if (/^(?:sku|variant|default)(?:[-_ ]?\d+)?$/iu.test(sourceId)) return '';
  return (sourceId.match(/\d+/gu) || []).sort((left, right) => right.length - left.length)[0] || '';
}

function createOfferId(product = {}, sku = {}, index = 0, savedSku = {}) {
  const sourceSkuId = text(sku.id || sku.skuId || savedSku.sourceSkuId, 260);
  const sourceSkuName = text(sku.name || savedSku.sourceSkuName, 500);
  const numericSkuId = sourceSkuNumericId(sku, savedSku);
  const numericToken = numericSkuId || stableNumericOfferToken([
    product.sourceProductId || product.id || 'item',
    sourceSkuId || sourceSkuName || 'sku',
    index + 1,
  ].join('|'));
  return `WZ-${numericToken.slice(-27)}`;
}

function normalizeOfferId(item = {}, product = {}, sourceSku = {}, index = 0) {
  const savedOfferId = text(item.offerId, 30);
  const legacyOfferId = createLegacyOfferId(product, sourceSku, index, item);
  if (!savedOfferId || savedOfferId === legacyOfferId) {
    return createOfferId(product, sourceSku, index, item);
  }
  return savedOfferId;
}

function ensureUniqueGeneratedOfferIds(skus = [], product = {}) {
  const seen = new Set();
  return skus.map((sku, index) => {
    const offerId = text(sku.offerId, 30);
    if (!seen.has(offerId)) {
      seen.add(offerId);
      return sku;
    }
    if (!/^WZ-\d+$/u.test(offerId)) return sku;
    let attempt = 0;
    let candidate = offerId;
    while (seen.has(candidate)) {
      attempt += 1;
      const suffix = stableNumericOfferToken([
        product.sourceProductId || product.id || 'item',
        sku.sourceSkuId || sku.sourceSkuName || 'sku',
        index + 1,
        attempt,
      ].join('|')).slice(-6);
      candidate = `WZ-${offerId.slice(3, 24)}${suffix}`.slice(0, 30);
    }
    seen.add(candidate);
    return { ...sku, offerId: candidate };
  });
}

function normalizeListingSku(item = {}, product = {}, sourceSku = {}, index = 0, legacyShopId = '') {
  const fallbackPrice = item.price ?? '';
  const price = decimal(fallbackPrice);
  const oldPrice = decimal(item.oldPrice);
  const minPrice = decimal(item.minPrice);
  const sourcePriceCny = String(product.currency || '').toUpperCase() === 'CNY'
    ? optionalDecimal(item.sourcePriceCny ?? sourceSku.price)
    : optionalDecimal(item.sourcePriceCny);
  const inventoryByShopId = normalizeCollectionSkuInventoryByShop(item.inventoryByShopId, {
    shopId: legacyShopId,
    stock: item.stock,
    warehouseId: item.warehouseId,
  });
  return {
    sourceSkuId: text(item.sourceSkuId || sourceSku.id || sourceSku.name || index + 1, 200),
    sourceSkuName: text(item.sourceSkuName || sourceSku.name || sourceSku.id || `规格 ${index + 1}`, 500),
    offerId: normalizeOfferId(item, product, sourceSku, index),
    title: text(item.title || product.title, 5000),
    price,
    oldPrice,
    minPrice,
    sourcePriceCny,
    priceCny: optionalDecimal(item.priceCny),
    oldPriceCny: optionalDecimal(item.oldPriceCny),
    minPriceCny: optionalDecimal(item.minPriceCny),
    pricingSnapshot: normalizeSkuPricingSnapshot(item.pricingSnapshot),
    stock: '',
    warehouseId: '',
    inventoryByShopId,
    imageUrl: text(item.imageUrl || sourceSku.imageUrl, 2400),
    attributeValues: normalizeListingAttributeValues(item.attributeValues),
    enabled: item.enabled !== false,
  };
}

export function normalizeCollectionProductListingDraft(value = {}, product = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const sourceSkus = Array.isArray(product.skus) ? product.skus : [];
  const savedSkus = Array.isArray(source.skus) ? source.skus : [];
  const savedBySourceId = new Map(savedSkus.map((item) => [text(item.sourceSkuId), item]));
  const normalizedSkus = sourceSkus.length
    ? sourceSkus.map((sku, index) => normalizeListingSku(savedBySourceId.get(text(sku.id)) || {}, product, sku, index, source.shopId))
    : savedSkus.map((item, index) => normalizeListingSku(item, product, {}, index, source.shopId));
  const skus = ensureUniqueGeneratedOfferIds(normalizedSkus, product);
  const attributes = Array.isArray(source.attributes)
    ? source.attributes.filter((item) => item && typeof item === 'object').map((item) => ({ ...item }))
    : [];
  const attributeValues = normalizeListingAttributeValues(source.attributeValues);
  const originalImageSelections = normalizeCollectionProductOriginalImageSelections(source.originalImageSelections);
  const imageGenerationHistory = normalizeCollectionProductImageHistory(source.imageGenerationHistory);
  const hasExplicitGeneratedImageSelections = Object.prototype.hasOwnProperty.call(source, 'generatedImageSelections');
  let generatedImageSelections = normalizeCollectionProductGeneratedImageSelections(source.generatedImageSelections);
  if (!hasExplicitGeneratedImageSelections) {
    imageGenerationHistory.forEach((entry) => {
      if (!generatedImageSelections[entry.group]) {
        generatedImageSelections = withCollectionProductGeneratedImageSelection(generatedImageSelections, entry);
      }
    });
  }
  const normalizedDraft = {
    shopId: text(source.shopId, 180),
    uploadShopIds: [...new Set((Array.isArray(source.uploadShopIds) ? source.uploadShopIds : [])
      .map((item) => text(item, 180))
      .filter(Boolean))],
    descriptionCategoryId: text(source.descriptionCategoryId, 80),
    typeId: text(source.typeId, 80),
    categorySelectionSource: ['auto', 'manual'].includes(source.categorySelectionSource)
      ? source.categorySelectionSource
      : '',
    categoryName: text(source.categoryName, 500),
    categoryPath: text(source.categoryPath, 1200),
    categoryCommissionPercent: optionalDecimal(source.categoryCommissionPercent),
    categoryCommissionSource: ['manual', 'ozon-product-commission-snapshot'].includes(source.categoryCommissionSource)
      ? source.categoryCommissionSource
      : '',
    categoryCommissionEvidenceCount: Math.max(0, Math.trunc(Number(source.categoryCommissionEvidenceCount) || 0)),
    attributeAutofillVersion: text(source.attributeAutofillVersion, 160),
    title: text(source.title || product.title, 5000),
    description: text(source.description || product.description, 6000),
    tags: [...new Set((Array.isArray(source.tags) ? source.tags : [])
      .map((item) => text(item, 28))
      .filter(Boolean))].slice(0, 28),
    attributes,
    attributeValues,
    images: [],
    currencyCode: 'CNY',
    vat: text(source.vat || '0', 20),
    weightG: text(source.weightG || product.weightG, 60),
    packageLengthCm: text(source.packageLengthCm || product.packageLengthCm, 60),
    packageWidthCm: text(source.packageWidthCm || product.packageWidthCm, 60),
    packageHeightCm: text(source.packageHeightCm || product.packageHeightCm, 60),
    pricingDraft: normalizeCollectionProductPricingDraft(source.pricingDraft, product),
    logisticsDraft: normalizeCollectionProductLogisticsDraft(source.logisticsDraft),
    imageGenerationHistory,
    generatedImageSelections,
    originalImageSelections,
    skus,
    activityPriceUpload: source.activityPriceUpload === true,
    updatedAt: text(source.updatedAt, 80),
  };
  return applyCollectionProductGeneratedImagesToListingDraft(
    normalizedDraft,
    generatedImageSelections,
    product,
  );
}

export function normalizeCollectionProductListingDrafts(value = {}, product = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([shopId, draft]) => {
    const normalizedShopId = text(shopId || draft?.shopId, 180);
    if (!normalizedShopId || !draft || typeof draft !== 'object' || Array.isArray(draft)) return [];
    return [[normalizedShopId, {
      ...normalizeCollectionProductListingDraft(draft, product),
      shopId: normalizedShopId,
    }]];
  }));
}

export function createCollectionProductListingDraft(product = {}, { shops = [], activeShopId = '' } = {}) {
  const sourceProduct = product && typeof product === 'object' ? product : {};
  const availableShopIds = new Set(shops.map((shop) => text(shop?.id || shop?.shopId, 180)).filter(Boolean));
  const requestedActiveShopId = text(activeShopId, 180);
  const firstAvailableShopId = [...availableShopIds][0] || '';
  // A deleted/legacy global selection must never become the hidden catalog or
  // private-image scope of a product draft. Use it only when it still exists
  // in the current user's live shop list.
  const preferredShopId = requestedActiveShopId && availableShopIds.has(requestedActiveShopId)
    ? requestedActiveShopId
    : firstAvailableShopId;
  const savedByShop = normalizeCollectionProductListingDrafts(sourceProduct.ozonListingDrafts, sourceProduct);
  const legacy = normalizeCollectionProductListingDraft(sourceProduct.ozonListingDraft, sourceProduct);
  const hasCanonicalDraft = sourceProduct.ozonListingDraft
    && typeof sourceProduct.ozonListingDraft === 'object'
    && !Array.isArray(sourceProduct.ozonListingDraft)
    && Object.keys(sourceProduct.ozonListingDraft).length > 0;
  const newestSavedDraft = Object.values(savedByShop).sort((left, right) => {
    const timeDifference = (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
    return timeDifference || String(left.shopId).localeCompare(String(right.shopId));
  })[0];
  const saved = (hasCanonicalDraft ? legacy : newestSavedDraft)
    || normalizeCollectionProductListingDraft({}, sourceProduct);
  const savedShopId = text(saved.shopId, 180);
  const initialShopId = savedShopId && (!availableShopIds.size || availableShopIds.has(savedShopId))
    ? savedShopId
    : preferredShopId;
  const savedUploadShopIds = [...new Set((saved.uploadShopIds || [])
    .map((item) => text(item, 180))
    .filter((shopId) => shopId && (!availableShopIds.size || availableShopIds.has(shopId))))];
  const uploadShopIds = savedUploadShopIds.length
    ? savedUploadShopIds
    : (initialShopId ? [initialShopId] : []);
  return {
    ...saved,
    shopId: initialShopId,
    uploadShopIds,
  };
}

export function requireManualCollectionProductCategorySelection(draft = {}) {
  if (
    draft.categorySelectionSource === 'manual'
    && positive(draft.descriptionCategoryId)
    && positive(draft.typeId)
  ) return draft;
  return {
    ...draft,
    descriptionCategoryId: '',
    typeId: '',
    categorySelectionSource: '',
    categoryName: '',
    categoryPath: '',
    categoryCommissionPercent: '',
    categoryCommissionSource: '',
    categoryCommissionEvidenceCount: 0,
    pricingDraft: { ...(draft.pricingDraft || {}), ozonFeePercent: '' },
    attributeValues: {},
    skus: (Array.isArray(draft.skus) ? draft.skus : []).map((item) => ({ ...item, attributeValues: {} })),
    attributes: [],
  };
}

export function buildListingAttributes(attributeValues = {}, definitions = []) {
  return buildListingAttributeList(attributeValues, definitions);
}

export function validateCollectionProductListingStep(stepId, draft = {}, definitions = []) {
  const errors = [];
  if (stepId === 'category') {
    if (
      draft.categorySelectionSource !== 'manual'
      || !positive(draft.descriptionCategoryId)
      || !positive(draft.typeId)
    ) errors.push('请先通过完整类目库选择并确认 Ozon 类目。');
    else errors.push(...validateCollectionCategoryCompatibility(draft));
  }
  if (stepId === 'details') {
    if (text(draft.title).length < 4) errors.push('请填写完整的 Ozon 商品标题。');
    const { global } = splitListingAttributeDefinitions(definitions);
    errors.push(...validateListingAttributeValues(draft.attributeValues, global).errors);
  }
  if (stepId === 'images' && !(draft.images || []).length) errors.push('至少选择 1 张商品图片。');
  if (stepId === 'skus') {
    const enabled = (draft.skus || []).filter((item) => item.enabled !== false);
    const salePrice = (item) => item.priceCny || item.price;
    const oldPrice = (item) => item.oldPriceCny || item.oldPrice;
    if (!enabled.length) errors.push('至少启用 1 个 SKU。');
    if (enabled.length > MAX_LISTING_SKUS) errors.push(`单次最多上架 ${MAX_LISTING_SKUS} 个 SKU。`);
    if (new Set(enabled.map((item) => text(item.offerId))).size !== enabled.length) errors.push('SKU 货号不能重复。');
    if (enabled.some((item) => !text(item.offerId) || text(item.offerId).length > 30)) errors.push('每个 SKU 都要有不超过 30 个字符的货号。');
    if (enabled.some((item) => !positive(salePrice(item)))) errors.push('每个启用的 SKU 都要填写大于 0 的人民币销售价。');
    if (enabled.some((item) => !positive(oldPrice(item)) || Number(oldPrice(item)) <= Number(salePrice(item)))) errors.push('每个启用的 SKU 划线价都必须大于销售价。');
    if (enabled.some((item) => !isCollectionSkuPricingSnapshotCurrent(item, draft.pricingDraft))) {
      errors.push('核价条件已经变化，请重新生成 SKU 售价后再继续。');
    }
    if (!positive(draft.weightG) || !positive(draft.packageLengthCm) || !positive(draft.packageWidthCm) || !positive(draft.packageHeightCm)) {
      errors.push('重量和包裹长宽高必须完整且大于 0。');
    }
    const uploadShopIds = [...new Set((Array.isArray(draft.uploadShopIds) ? draft.uploadShopIds : [draft.shopId])
      .map((item) => text(item, 180)).filter(Boolean))];
    if (!uploadShopIds.length) errors.push('请至少选择一个上传店铺。');
    uploadShopIds.forEach((shopId) => {
      const invalidInventory = enabled.find((item) => {
        const inventory = getCollectionSkuShopInventory(item, shopId);
        return inventory.stock && !positive(inventory.warehouseId);
      });
      if (invalidInventory) errors.push(`店铺 ${shopId} 已填写库存，但没有选择对应仓库。`);
    });
    const { sku: skuDefinitions } = splitListingAttributeDefinitions(definitions);
    if (skuDefinitions.length) {
      const invalidSku = enabled.find((item) => !validateListingAttributeValues(
        item.attributeValues,
        skuDefinitions,
        { label: `SKU“${text(item.sourceSkuName || item.offerId, 120)}”的规格属性` },
      ).ok);
      if (invalidSku) {
        errors.push(...validateListingAttributeValues(
          invalidSku.attributeValues,
          skuDefinitions,
          { label: `SKU“${text(invalidSku.sourceSkuName || invalidSku.offerId, 120)}”的规格属性` },
        ).errors);
      }
      const duplicateAspectGroup = findDuplicateSkuAspectGroup(enabled, definitions, draft.attributeValues);
      if (duplicateAspectGroup) {
        const labels = duplicateAspectGroup.slice(0, 3)
          .map((item) => text(item.sourceSkuName || item.offerId, 80))
          .filter(Boolean)
          .join('、');
        errors.push(`SKU 变体属性组合重复${labels ? `（${labels}${duplicateAspectGroup.length > 3 ? '等' : ''}）` : ''}，请为每个 SKU 填写唯一的规格属性后再预览。`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function toCollectionListingCommandDraft(draft = {}, definitions = []) {
  const {
    imageGenerationHistory: _imageGenerationHistory,
    generatedImageSelections: _generatedImageSelections,
    originalImageSelections: _originalImageSelections,
    uploadShopIds: _uploadShopIds,
    ...commandDraft
  } = draft;
  const { global, sku } = splitListingAttributeDefinitions(definitions);
  const globalAttributes = buildListingAttributes(draft.attributeValues, global);
  return {
    ...commandDraft,
    skuAttributeIds: sku.map((definition) => String(definition.id)).filter(Boolean),
    attributes: globalAttributes,
    attributesJson: JSON.stringify(globalAttributes),
    imagesText: (draft.images || []).join('\n'),
    skus: (draft.skus || []).filter((item) => item.enabled !== false).map((item) => ({
      ...item,
      attributes: buildListingAttributes(item.attributeValues, sku),
    })),
  };
}

export function withListingDraftTimestamp(draft = {}) {
  return { ...draft, updatedAt: new Date().toISOString() };
}

export const COLLECTION_PRODUCT_LISTING_MAX_SKUS = MAX_LISTING_SKUS;
