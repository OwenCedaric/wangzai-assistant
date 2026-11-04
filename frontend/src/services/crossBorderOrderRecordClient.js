import {
  deleteCrossBorderOrderRecord,
  getCrossBorderOrderRecords,
  saveCrossBorderOrderRecord,
} from '../api/localApiClient.js';
import { getCrossBorderOrderRecordCacheKey, normalizeCrossBorderOrderCacheRecord } from './crossBorderOrderCache.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function requireInternalShopId(record = {}, context = {}) {
  const shopId = normalizeText(context.shopId ?? context.shop_id ?? record.shopId ?? record.shop_id);
  if (shopId && shopId !== 'all') return shopId;
  const error = new Error('跨境巴士订单记录必须使用内部 shopId，不能用 Client ID 代替。');
  error.code = 'CROSS_BORDER_INTERNAL_SHOP_ID_REQUIRED';
  throw error;
}

export function getCrossBorderRecordKey(record = {}, context = {}) {
  const normalized = normalizeCrossBorderOrderCacheRecord(record, context);
  const key = getCrossBorderOrderRecordCacheKey(normalized, context);
  return key ? key.split(':').slice(1).join(':') : normalizeText(normalized.orderId || normalized.orderNumber);
}

export function toCrossBorderRecordPayload(record = {}, context = {}) {
  const normalized = normalizeCrossBorderOrderCacheRecord(record, context);
  return {
    ...normalized,
    shopId: requireInternalShopId(record, context),
    recordKey: getCrossBorderRecordKey(normalized, context),
    orderId: normalized.orderId,
    order_id: normalized.orderId,
    platformOrder: normalized.platformOrder || normalized.orderNumber,
    platform_order: normalized.platformOrder || normalized.orderNumber,
    purchaseOrderNumber: normalized.purchaseOrderNumber || normalized.fromOrder,
    from_order: normalized.purchaseOrderNumber || normalized.fromOrder,
    trackingNumber: normalized.trackingNumber,
    tracking_number: normalized.trackingNumber,
    logisticsOrder: normalized.logisticsOrder,
    logistics_order: normalized.logisticsOrder,
    sheetOrderNumber: normalized.sheetOrderNumber,
    sheet_order_sn: normalized.sheetOrderNumber,
  };
}

export function readCrossBorderRecords(query = {}, options = {}) {
  return getCrossBorderOrderRecords(query, options);
}

export function saveCrossBorderRecord(record = {}, context = {}, options = {}) {
  return saveCrossBorderOrderRecord(toCrossBorderRecordPayload(record, context), options);
}

export function saveCrossBorderRecords(records = [], context = {}, options = {}) {
  return saveCrossBorderOrderRecord(
    {
      shopId: requireInternalShopId({}, context),
      records: records.map((record) => toCrossBorderRecordPayload(record, context)),
    },
    options
  );
}

export function removeCrossBorderRecord(record = {}, context = {}, options = {}) {
  return deleteCrossBorderOrderRecord(
    {
      shopId: requireInternalShopId(record, context),
      recordKey: getCrossBorderRecordKey(record, context),
      orderId: normalizeText(record.orderId ?? record.order_id ?? record.id),
      platformOrder: normalizeText(
        record.platformOrder ?? record.platform_order ?? record.orderNumber ?? record.order_number
      ),
    },
    options
  );
}
