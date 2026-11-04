export const PROTECTED_MANUAL_DATA_FIELDS = Object.freeze([
  'manualBuyerPlatform',
  'buyerPlatform',
  'purchasePlatform',
  'supplier',
  'manualPurchaseOrderNo',
  'purchaseOrderNo',
  'purchaseOrderNumber',
  'manualPurchasePrice',
  'manualPurchasePriceValue',
  'sourcePurchaseCostCny',
  'manualProfitSourcePurchaseCostCny',
  'manualProfitLogisticsFeeCny',
  'manualProfitCrossBorderBusFeeCny',
  'manualSourceRecord',
  'manualSourceRecords',
  'sourceLink',
  'sourceLinks',
  'productSourceLink',
  'productSourceLinks',
  'manualNote',
  'manualStatus',
  'manualCategory',
  'manualSource',
  'manualUpdatedAt',
  'busOrderId',
  'busOrderNo',
  'crossBorderOrderId',
  'crossBorderOrderNo',
  'order_id',
  'orderId',
]);

const PROTECTED_MANUAL_DATA_FIELD_SET = new Set(PROTECTED_MANUAL_DATA_FIELDS);

function normalizeText(value) {
  return String(value ?? '').trim();
}

export function hasProtectedManualValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return normalizeText(value) !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(hasProtectedManualValue);
  return true;
}

function cloneJsonSafe(value) {
  if (value === undefined || typeof value === 'function') return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function isProtectedManualDataField(field) {
  return PROTECTED_MANUAL_DATA_FIELD_SET.has(normalizeText(field));
}

export function mergeProtectedManualData(current = {}, fresh = {}, options = {}) {
  const next = { ...(cloneJsonSafe(current) || {}) };
  const protectedFields = new Set([
    ...PROTECTED_MANUAL_DATA_FIELDS,
    ...(Array.isArray(options.protectedFields) ? options.protectedFields : []),
  ]);

  Object.entries(fresh || {}).forEach(([field, value]) => {
    if (!hasProtectedManualValue(value)) return;
    if (protectedFields.has(field) && hasProtectedManualValue(next[field])) return;
    next[field] = cloneJsonSafe(value);
  });

  return next;
}
