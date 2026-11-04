const SIGNED_QUOTE_SOURCES = new Set(['server-signed', 'offline-signed']);
const INPUT_KEY_PREFIX = 'collection-sku-pricing-v1';

function scaledInteger(value, scale, { allowEmpty = false, defaultValue = null } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return allowEmpty ? defaultValue : null;
  }
  const number = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) return null;
  const scaled = Math.round(number * scale);
  return Number.isSafeInteger(scaled) ? scaled : null;
}

function resolvedFirstMileCost(sku = {}, pricingDraft = {}) {
  return sku.firstMileCostCny ?? sku.freightCostCny ?? pricingDraft.firstMileCost;
}

export function isCollectionSignedPricingSnapshot(snapshot = {}) {
  return SIGNED_QUOTE_SOURCES.has(String(snapshot?.quoteSource || '').trim());
}

export function buildCollectionSkuPricingInputKey(sku = {}, pricingDraft = {}) {
  const purchaseCostMinor = scaledInteger(sku.sourcePriceCny, 100);
  const firstMileCostMinor = scaledInteger(resolvedFirstMileCost(sku, pricingDraft), 100);
  const extraCostMinor = scaledInteger(pricingDraft.extraCost, 100, { allowEmpty: true, defaultValue: 0 });
  const commissionBasisPoints = scaledInteger(pricingDraft.ozonFeePercent, 100);
  const expectedProfitMinor = scaledInteger(pricingDraft.expectedProfitCny, 100, { allowEmpty: true });
  const targetMarginBasisPoints = scaledInteger(pricingDraft.targetMarginPercent, 100, { allowEmpty: true });
  const values = [
    purchaseCostMinor,
    firstMileCostMinor,
    extraCostMinor,
    commissionBasisPoints,
  ];
  if (values.some((value) => value === null)) return '';
  if (Number.isSafeInteger(expectedProfitMinor) && expectedProfitMinor > 0) {
    return [INPUT_KEY_PREFIX, ...values, expectedProfitMinor].join(':');
  }
  if (Number.isSafeInteger(targetMarginBasisPoints) && targetMarginBasisPoints > 0) {
    return [INPUT_KEY_PREFIX, ...values, `margin-${targetMarginBasisPoints}`].join(':');
  }
  return '';
}

export function isCollectionSkuPricingSnapshotCurrent(sku = {}, pricingDraft = {}) {
  const snapshot = sku?.pricingSnapshot || {};
  if (!isCollectionSignedPricingSnapshot(snapshot)) return true;
  const expectedKey = buildCollectionSkuPricingInputKey(sku, pricingDraft);
  return Boolean(expectedKey && snapshot.inputKey === expectedKey);
}

export function clearCollectionSignedSkuPricing(sku = {}) {
  if (!isCollectionSignedPricingSnapshot(sku?.pricingSnapshot)) return sku;
  return {
    ...sku,
    price: '',
    oldPrice: '',
    minPrice: '',
    priceCny: '',
    oldPriceCny: '',
    minPriceCny: '',
    pricingSnapshot: {},
  };
}

export function clearStaleCollectionSignedSkuPricing(skus = [], pricingDraft = {}) {
  let changed = false;
  const rows = (Array.isArray(skus) ? skus : []).map((sku) => {
    if (isCollectionSkuPricingSnapshotCurrent(sku, pricingDraft)) return sku;
    changed = true;
    return clearCollectionSignedSkuPricing(sku);
  });
  return { changed, skus: rows };
}

export function clearAllCollectionSignedSkuPricing(skus = []) {
  let changed = false;
  const rows = (Array.isArray(skus) ? skus : []).map((sku) => {
    if (!isCollectionSignedPricingSnapshot(sku?.pricingSnapshot)) return sku;
    changed = true;
    return clearCollectionSignedSkuPricing(sku);
  });
  return { changed, skus: rows };
}

export const collectionSkuPricingInputKeyContract = Object.freeze({
  prefix: INPUT_KEY_PREFIX,
  version: 1,
});
