import { getOzonCurrency, getOzonPriceValue } from '../../../entities/product/productAttributes.jsx';
import { getOzonDimensionValue } from '../../../entities/product/productWriteHelpers.jsx';

function toPositiveNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = toPositiveNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function toDraftValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

export function completeWarehouseFreightCurrencyDraft(draft = {}, rubToCnyRate) {
  const rate = toPositiveNumber(rubToCnyRate);
  if (rate === null) return draft;
  const rub = toPositiveNumber(draft.productValueRub);
  const cny = toPositiveNumber(draft.productValueCny);
  if (rub === null && cny !== null) {
    return { ...draft, productValueRub: Number((cny / rate).toFixed(2)).toString() };
  }
  if (cny === null && rub !== null) {
    return { ...draft, productValueCny: Number((rub * rate).toFixed(2)).toString() };
  }
  return draft;
}

export function buildWarehouseFreightRouteText(method = {}) {
  const raw = method?.raw && typeof method.raw === 'object' ? method.raw : {};
  return [
    method?.name,
    method?.type,
    raw.name,
    raw.delivery_method_name,
    raw.deliveryMethodName,
    raw.method_name,
    raw.provider_name,
    raw.providerName,
    raw.provider,
    raw.tpl_provider_name,
    raw.tplProviderName,
    raw.delivery_type,
    raw.deliveryType,
    raw.shipping_type,
    raw.delivery_schema,
  ]
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' ');
}

export function normalizeWarehouseFreightProductProfile(product = {}, liveData = {}) {
  const sourceProduct = product && typeof product === 'object' ? product : {};
  const raw = sourceProduct.raw && typeof sourceProduct.raw === 'object' ? sourceProduct.raw : {};
  const detail = liveData.detail || raw.detail || {};
  const attributes = liveData.attributes || raw.attributes || {};
  const priceInfo = liveData.priceInfo || raw.priceInfo || {};
  const sourceWeightUnit =
    detail?.weight_unit ||
    detail?.weightUnit ||
    attributes?.weight_unit ||
    attributes?.weightUnit ||
    detail?.dimensions?.weight_unit ||
    attributes?.dimensions?.weight_unit ||
    'g';
  const sourceDimensionUnit =
    detail?.dimension_unit ||
    detail?.dimensionUnit ||
    attributes?.dimension_unit ||
    attributes?.dimensionUnit ||
    detail?.dimensions?.dimension_unit ||
    attributes?.dimensions?.dimension_unit ||
    'mm';
  const priceValue = firstPositiveNumber(
    sourceProduct.productValueRub,
    sourceProduct.productValueCny,
    sourceProduct.priceValue,
    getOzonPriceValue(detail, priceInfo)
  );
  const currencyCode = String(
    sourceProduct.currencyCode || getOzonCurrency(detail, priceInfo) || ''
  ).toUpperCase();
  const weightKg = firstPositiveNumber(
    sourceProduct.weightKg,
    sourceProduct.weight,
    getOzonDimensionValue(detail, attributes, ['weight', '重量', 'вес'], 'weight', sourceWeightUnit)
  );
  const lengthCm = firstPositiveNumber(
    sourceProduct.lengthCm,
    sourceProduct.depthCm,
    sourceProduct.length,
    getOzonDimensionValue(
      detail,
      attributes,
      ['depth', 'length', '长', 'длина'],
      'dimension',
      sourceDimensionUnit
    )
  );
  const widthCm = firstPositiveNumber(
    sourceProduct.widthCm,
    sourceProduct.width,
    getOzonDimensionValue(detail, attributes, ['width', '宽', 'ширина'], 'dimension', sourceDimensionUnit)
  );
  const heightCm = firstPositiveNumber(
    sourceProduct.heightCm,
    sourceProduct.height,
    getOzonDimensionValue(detail, attributes, ['height', '高', 'высота'], 'dimension', sourceDimensionUnit)
  );
  const productValueRub = firstPositiveNumber(
    sourceProduct.productValueRub,
    currencyCode === 'RUB' ? priceValue : null
  );
  const productValueCny = firstPositiveNumber(
    sourceProduct.productValueCny,
    currencyCode === 'CNY' || currencyCode === 'RMB' ? priceValue : null
  );

  return {
    weightKg,
    lengthCm,
    widthCm,
    heightCm,
    productValueRub,
    productValueCny,
    currencyCode,
    source: liveData.source || (liveData.detail || liveData.attributes || liveData.priceInfo ? 'ozon-live' : 'local-cache'),
    complete: Boolean(weightKg && lengthCm && widthCm && heightCm),
  };
}

export function toWarehouseFreightDraft(profile = {}) {
  return {
    weightKg: toDraftValue(profile.weightKg),
    lengthCm: toDraftValue(profile.lengthCm),
    widthCm: toDraftValue(profile.widthCm),
    heightCm: toDraftValue(profile.heightCm),
    productValueRub: toDraftValue(profile.productValueRub),
    productValueCny: toDraftValue(profile.productValueCny),
  };
}
