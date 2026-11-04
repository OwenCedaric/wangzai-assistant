import { emptyPricingDraft } from '../constants/collectionPricingRules.js';

function text(value, maximum = 120) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, maximum);
}

function decimalText(value) {
  const source = text(value, 80).replace(',', '.').replace(/[^\d.-]/gu, '');
  if (!source) return '';
  const number = Number(source);
  return Number.isFinite(number) && number >= 0 ? String(Number(number.toFixed(3))) : '';
}

export function normalizeCollectionProductPricingDraft(value = {}, product = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourcePurchaseCost = String(product?.currency || '').toUpperCase() === 'CNY'
    ? product?.purchasePriceMin || product?.purchasePrice || ''
    : '';
  const sourceCommissionPercent = product?.categoryCommissionPercent
    ?? product?.categoryCommission
    ?? product?.commissionPercent
    ?? product?.raw?.categoryCommissionPercent
    ?? product?.raw?.commissionPercent
    ?? '';
  return Object.fromEntries(Object.keys(emptyPricingDraft).map((field) => [
    field,
    decimalText(field === 'purchaseCost'
      ? source[field] ?? sourcePurchaseCost
      : field === 'ozonFeePercent'
        ? source[field] || sourceCommissionPercent
        : source[field]),
  ]));
}

export function normalizeCollectionProductLogisticsDraft(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    providerId: text(source.providerId, 80).toLowerCase(),
    routeId: text(source.routeId, 180),
    market: text(source.market || 'RU', 8).toUpperCase(),
    serviceLevel: text(source.serviceLevel || 'auto', 40).toLowerCase(),
    routeText: text(source.routeText, 500),
  };
}

export function countCollectionPricingFields(value = {}) {
  const normalized = normalizeCollectionProductPricingDraft(value);
  return Object.values(normalized).filter((item) => item !== '').length;
}
