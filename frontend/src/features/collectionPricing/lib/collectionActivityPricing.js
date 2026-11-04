export const COLLECTION_ACTIVITY_DISCOUNT_PERCENT = 50;

function moneyText(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return String(Number(number.toFixed(2)));
}

function effectiveSalePrice(sku = {}) {
  return String(sku.priceCny ?? '').trim() ? sku.priceCny : sku.price ?? '';
}

function standardOldPrice(sku = {}, salePrice = 0) {
  const saved = Number(sku.pricingSnapshot?.standardOldPriceCny);
  if (Number.isFinite(saved) && saved > salePrice) return moneyText(saved);
  const current = Number(String(sku.oldPriceCny ?? '').trim() ? sku.oldPriceCny : sku.oldPrice);
  if (Number.isFinite(current) && current > salePrice) return moneyText(current);
  return moneyText(salePrice * 1.3);
}

function activitySnapshot(snapshot = {}, salePrice, referencePrice, standardPrice) {
  return {
    ...snapshot,
    pricingMode: 'ozon-activity-50',
    activityDiscountPercent: COLLECTION_ACTIVITY_DISCOUNT_PERCENT,
    activityPriceCny: moneyText(salePrice),
    activityReferencePriceCny: moneyText(referencePrice),
    standardOldPriceCny: moneyText(standardPrice),
  };
}

function standardSnapshot(snapshot = {}) {
  const {
    pricingMode: _pricingMode,
    activityDiscountPercent: _activityDiscountPercent,
    activityPriceCny: _activityPriceCny,
    activityReferencePriceCny: _activityReferencePriceCny,
    standardOldPriceCny: _standardOldPriceCny,
    ...rest
  } = snapshot;
  return rest;
}

export function applyCollectionActivityPricingMode(skus = [], enabled = false) {
  return (Array.isArray(skus) ? skus : []).map((sku) => {
    if (sku?.enabled === false) return sku;
    const salePrice = Number(effectiveSalePrice(sku));
    if (!Number.isFinite(salePrice) || salePrice <= 0) return sku;
    const savedStandardOldPrice = standardOldPrice(sku, salePrice);
    if (enabled) {
      const referencePrice = salePrice * 2;
      return {
        ...sku,
        oldPriceCny: moneyText(referencePrice),
        oldPrice: '',
        pricingSnapshot: activitySnapshot(
          sku.pricingSnapshot,
          salePrice,
          referencePrice,
          savedStandardOldPrice,
        ),
      };
    }
    return {
      ...sku,
      oldPriceCny: savedStandardOldPrice,
      oldPrice: '',
      pricingSnapshot: standardSnapshot(sku.pricingSnapshot),
    };
  });
}

export function applyCollectionActivityPricingToGeneratedRow(row = {}, enabled = false) {
  const salePrice = Number(row.priceCny);
  if (!Number.isFinite(salePrice) || salePrice <= 0 || !enabled) return row;
  const referencePrice = salePrice * 2;
  return {
    ...row,
    oldPriceCny: Number(referencePrice.toFixed(2)),
    pricingSnapshot: activitySnapshot(
      row.pricingSnapshot,
      salePrice,
      referencePrice,
      row.oldPriceCny,
    ),
  };
}

export function buildCollectionActivitySalePriceChanges(value = '', enabled = false) {
  const changes = { priceCny: value, price: '', pricingSnapshot: {} };
  if (!enabled) return changes;
  const salePrice = Number(value);
  if (!Number.isFinite(salePrice) || salePrice <= 0) {
    return { ...changes, oldPriceCny: '', oldPrice: '' };
  }
  const referencePrice = salePrice * 2;
  return {
    ...changes,
    oldPriceCny: moneyText(referencePrice),
    oldPrice: '',
    pricingSnapshot: activitySnapshot({}, salePrice, referencePrice, salePrice * 1.3),
  };
}
