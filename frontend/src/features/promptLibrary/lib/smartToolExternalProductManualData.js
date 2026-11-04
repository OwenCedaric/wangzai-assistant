function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const EXTERNAL_PRODUCT_MANUAL_INPUT_GROUP = 'external-product-manual-data';

export const EXTERNAL_PRODUCT_MANUAL_INPUT_SPECS = Object.freeze([
  Object.freeze({
    key: 'productCostRub',
    label: '商品成本（₽）',
    placeholder: '例如 1200',
    validator: 'non-negative-number',
  }),
  Object.freeze({
    key: 'commissionRate',
    label: '平台佣金率（%）',
    placeholder: '例如 15',
    validator: 'percentage',
  }),
  Object.freeze({
    key: 'fulfillmentFeeRub',
    label: '履约费用（₽/单）',
    placeholder: '例如 350',
    validator: 'non-negative-number',
  }),
  Object.freeze({
    key: 'taxRate',
    label: '税费率（%）',
    placeholder: '例如 6',
    validator: 'percentage',
  }),
  Object.freeze({
    key: 'returnCancelRate',
    label: '退货取消率（%）',
    placeholder: '例如 8.5',
    validator: 'percentage',
    fullWidth: true,
  }),
]);

const MANUAL_SPEC_BY_LABEL = new Map(
  EXTERNAL_PRODUCT_MANUAL_INPUT_SPECS.map((item) => [item.label, item])
);

export function getExternalProductManualInputSpec(label = '') {
  return MANUAL_SPEC_BY_LABEL.get(text(label)) || null;
}

export function isExternalProductManualInputLabel(label = '') {
  return Boolean(getExternalProductManualInputSpec(label));
}

export function normalizeExternalProductManualData(source = {}) {
  const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return Object.fromEntries(EXTERNAL_PRODUCT_MANUAL_INPUT_SPECS.map((item) => [
    item.key,
    finite(input[item.key] ?? input[item.label]),
  ]));
}

export function hasExternalProductManualData(source = {}) {
  return Object.values(normalizeExternalProductManualData(source)).some((value) => value !== null);
}

export function validateExternalProductManualInput(label = '', value = '') {
  const spec = getExternalProductManualInputSpec(label);
  const normalized = text(value);
  if (!spec || !normalized) return '';
  const parsed = finite(normalized);
  if (parsed === null) return '请填写有效数字。';
  if (parsed < 0) return '不能填写负数。';
  if (spec.validator === 'percentage' && parsed > 100) return '百分比应在 0 到 100 之间。';
  return '';
}

export function calculateExternalProductUnitProfit(price, source = {}) {
  const salePriceRub = finite(price);
  const manualData = normalizeExternalProductManualData(source);
  const requiredValues = [
    salePriceRub,
    manualData.productCostRub,
    manualData.commissionRate,
    manualData.fulfillmentFeeRub,
    manualData.taxRate,
  ];
  if (requiredValues.some((value) => value === null)) return null;
  const commissionAmountRub = salePriceRub * (manualData.commissionRate / 100);
  const taxAmountRub = salePriceRub * (manualData.taxRate / 100);
  const estimatedUnitProfitRub = salePriceRub
    - manualData.productCostRub
    - commissionAmountRub
    - manualData.fulfillmentFeeRub
    - taxAmountRub;
  return {
    salePriceRub,
    productCostRub: manualData.productCostRub,
    commissionRate: manualData.commissionRate,
    commissionAmountRub,
    fulfillmentFeeRub: manualData.fulfillmentFeeRub,
    taxRate: manualData.taxRate,
    taxAmountRub,
    estimatedUnitProfitRub,
    estimatedUnitProfitRate: salePriceRub > 0 ? (estimatedUnitProfitRub / salePriceRub) * 100 : null,
  };
}

