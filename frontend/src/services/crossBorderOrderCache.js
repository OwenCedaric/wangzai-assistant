import { mergeProtectedManualData } from './manualDataProtection.js';

const MAX_CROSS_BORDER_ORDER_RECORDS = 2000;

function normalizeText(value) {
  return String(value ?? '').trim();
}

function firstFilled(...values) {
  return values.map(normalizeText).find(Boolean) || '';
}

function normalizeOrderKey(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, '');
}

function normalizeCompactOrderKey(value) {
  return normalizeOrderKey(value).replace(/[-_]/g, '');
}

export function getCrossBorderOrderFamilyKey(value = '') {
  const normalized = normalizeOrderKey(value);
  const match = normalized.match(/^(\d{6,}-\d{3,})(?:-\d+)?$/);
  return match?.[1] || '';
}

export function areCrossBorderOrderCacheKeysEquivalent(value = '', key = '') {
  const normalizedValue = normalizeOrderKey(value);
  const normalizedKey = normalizeOrderKey(key);
  if (!normalizedValue || !normalizedKey) return false;
  if (normalizedValue === normalizedKey) return true;
  if (normalizeCompactOrderKey(normalizedValue) === normalizeCompactOrderKey(normalizedKey)) return true;
  const valueFamily = getCrossBorderOrderFamilyKey(normalizedValue);
  const keyFamily = getCrossBorderOrderFamilyKey(normalizedKey);
  return Boolean(valueFamily && keyFamily && valueFamily === keyFamily);
}

function cloneJsonSafe(value) {
  if (value === undefined || typeof value === 'function') return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function getIdentityValues(record = {}) {
  return [
    record.orderId,
    record.order_id,
    record.id,
    record.orderNumber,
    record.order_number,
    record.platformOrder,
    record.platform_order,
    record.fromOrder,
    record.from_order,
    record.purchaseOrderNumber,
    record.collectionNumber,
    record.collection_number,
    record.trackingNumber,
    record.tracking_number,
    record.logisticsOrder,
    record.logistics_order,
    record.sheetOrderNumber,
    record.sheet_order_sn,
  ]
    .flatMap((value) => {
      const text = normalizeText(value);
      if (!text) return [];
      const familyKey = getCrossBorderOrderFamilyKey(text);
      const compactKey = normalizeCompactOrderKey(text);
      return [text, familyKey, compactKey].filter(Boolean);
    })
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

export function getCrossBorderOrderRecordCacheKey(record = {}, context = {}) {
  const shopScope = firstFilled(
    record.shopId,
    context.shopId,
    record.shopClientId,
    record.clientId,
    context.shopClientId,
    'all'
  );
  const identity = firstFilled(...getIdentityValues(record));
  return identity ? `${shopScope}:${identity}` : '';
}

export function normalizeCrossBorderOrderCacheRecord(record = {}, context = {}) {
  const orderId = firstFilled(record.orderId, record.order_id, record.id);
  const orderNumber = firstFilled(record.orderNumber, record.order_number, record.platformOrder, record.platform_order);
  const purchaseOrderNumber = firstFilled(record.purchaseOrderNumber, record.fromOrder, record.from_order);
  const sheetOrderNumber = firstFilled(record.sheetOrderNumber, record.sheet_order_sn);
  const logisticsOrder = firstFilled(record.logisticsOrder, record.logistics_order);
  const trackingNumber = firstFilled(record.trackingNumber, record.tracking_number);
  const collectionNumber = firstFilled(record.collectionNumber, record.collection_number);
  const cachedAt = context.cachedAt || new Date().toISOString();

  return {
    ...(cloneJsonSafe(record) || {}),
    ...(context.shopId ? { shopId: normalizeText(context.shopId) } : {}),
    ...(context.shopClientId ? { shopClientId: normalizeText(context.shopClientId) } : {}),
    id: orderId,
    order_id: orderId,
    orderId,
    order_number: orderNumber,
    orderNumber,
    platform_order: orderNumber,
    platformOrder: orderNumber,
    from_order: purchaseOrderNumber,
    fromOrder: purchaseOrderNumber,
    purchaseOrderNumber,
    collection_number: collectionNumber,
    collectionNumber,
    logistics_order: logisticsOrder,
    logisticsOrder,
    tracking_number: trackingNumber,
    trackingNumber,
    sheet_order_sn: sheetOrderNumber,
    sheetOrderNumber,
    cachedAt,
    updatedAt: cachedAt,
    source: record.source || 'cross-border-bus',
  };
}

export function mergeCrossBorderOrderCacheRecord(current = {}, fresh = {}) {
  return mergeProtectedManualData(current, fresh);
}

export function mergeCrossBorderOrderRecordItems(existingItems = [], freshItems = [], context = {}) {
  const cachedAt = context.cachedAt || new Date().toISOString();
  const recordsByKey = new Map();
  const order = [];

  existingItems.forEach((item) => {
    const normalized = normalizeCrossBorderOrderCacheRecord(item, { cachedAt });
    const key = getCrossBorderOrderRecordCacheKey(normalized, context);
    if (!key || recordsByKey.has(key)) return;
    recordsByKey.set(key, normalized);
    order.push(key);
  });

  freshItems.forEach((item) => {
    const normalized = normalizeCrossBorderOrderCacheRecord(item, context);
    const key = getCrossBorderOrderRecordCacheKey(normalized, context);
    if (!key) return;
    if (!recordsByKey.has(key)) order.unshift(key);
    recordsByKey.set(key, mergeCrossBorderOrderCacheRecord(recordsByKey.get(key), normalized));
  });

  return order
    .filter((key, index, values) => values.indexOf(key) === index)
    .map((key) => recordsByKey.get(key))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(context.limit) || MAX_CROSS_BORDER_ORDER_RECORDS));
}
