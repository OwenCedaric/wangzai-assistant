import { firstFilled, firstUsableOzonId, getOzonShopLabel } from '../../../../entities/order/orderIdentityRules.jsx';
import { getOzonOrderBaseStatusLabel } from '../../../../entities/order/orderStatusRules.jsx';
import { formatOzonPrice } from '../../../../entities/product/productPriceRules.jsx';
import { firstFiniteNumber } from '../../../../entities/product/productAttributes.jsx';
import { compactObject } from '../../../../entities/product/productWriteHelpers.jsx';
import { attachSplitRelationFields } from '../../../../services/orderSplitRelationRules';
import { getPurchaseCrossBorderStrictOrderId } from '../../../../services/purchaseImageRuntime.js';
import {
  annotatePurchaseOrder,
  applyPurchaseManualFallbacks,
  derivePurchaseOrderStatus,
  getPurchaseOrderOzonBaseStatus,
  hasValidPurchaseOrderNumber,
} from '../../../../services/purchaseOrderRuntime.js';
export {
  annotatePurchaseOrder,
  applyPurchaseManualFallbacks,
  countPurchaseOrderModule,
  createPurchaseOrderLocalOverrideUpsert,
  deriveLegacyPurchaseOrderStatusByOzon,
  derivePurchaseOrderStatus,
  findPurchaseOrderLocalOverride,
  getManualPurchasePriceDisplay,
  getCanonicalPurchaseOrderOverrideKey,
  getPurchaseOrderActionState,
  getPurchaseOrderOzonBaseStatus,
  getPurchaseOrderStatusReason,
  hasConfirmedCrossBorderOrder,
  hasConfirmedPurchasePlacement,
  hasPurchaseOrderConflict,
  hasValidPurchaseOrderNumber,
  hydratePurchaseOrderLocalOverridesFromLocalFile,
  isConfirmedPurchasePlatformStatus,
  isFilledPurchaseOrderNoValue,
  isFilledPurchasePlatformValue,
  isFilledPurchasePriceValue,
  isFilledPurchaseTextValue,
  isPurchaseOrderModuleMatch,
  isPurchaseOrderPreparedWithoutCrossBorder,
  isPurchaseOrderRefundPending,
  isPurchaseOrderStageMatch,
  mapPurchaseOverrideRows,
  normalizeOzonSalesRowToPurchaseOrder,
  normalizePurchaseOrderLocalOverrides,
  purchaseOrderOverrideLocalApiHashes,
  PURCHASE_EMPTY_ORDER_NO_VALUES,
  PURCHASE_EMPTY_PLATFORM_VALUES,
  PURCHASE_EMPTY_PRICE_VALUES,
  readPurchaseOrderLocalOverrides,
  readPurchaseOrderOverridesFromLocalApi,
  removePurchaseSourceRecordsFromLocalOverride,
  sanitizePurchaseOrderLocalOverrideForMerge,
  savePurchaseOrderLocalOverrides,
  savePurchaseOrderOverridesToLocalApi,
  writePurchaseOrderLocalOverrides,
  writePurchaseOrderLocalOverrideUpsert,
} from '../../../../services/purchaseOrderRuntime.js';

export function createEmptyPurchaseOrder(activeShop = null) {
  return annotatePurchaseOrder({
    id: '',
    salesOrder: '暂无订单',
    shipmentNo: '',
    ozonOrderId: '未返回',
    shop: getOzonShopLabel(activeShop),
    supplier: '未返回',
    product: '暂无订单',
    productNo: '未返回',
    sku: '未返回',
    items: 0,
    amount: '未返回',
    purchaseOrderNo: '',
    purchasePrice: '待确认',
    ozonStatus: 'unknown',
    purchaseRecordStatus: 'none',
    channel: 'Ozon',
    buyerPlatform: '未返回',
    warehouse: '未返回',
    logistics: '未返回',
    packageOrderId: '',
    returnNo: '未返回',
    deliveryMethod: '未返回',
    packageWeight: '未返回',
    packageSize: '未返回',
    readStatus: '未返回',
    cargoStatus: '未返回',
    deadline: '未返回',
    updated: '未返回',
    paymentDate: '',
    paymentTime: '未返回',
    capturedAt: '',
    note: '暂无订单。',
    products: [],
    timeline: [],
  });
}

function isUsableCrossBorderText(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return !/^(?:未返回|待确认|null|undefined|nan|-|—)$/i.test(text);
}

function firstUsableCrossBorderText(...values) {
  return values.find(isUsableCrossBorderText);
}

function normalizeCrossBorderPersistVolumeItems(...sources) {
  const items = sources.flatMap((source) => (Array.isArray(source) ? source : []));
  return items
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) =>
      compactObject({
        length: item.length,
        width: item.width,
        height: item.height,
        grossWeight: item.grossWeight,
        sizeText: firstUsableCrossBorderText(item.sizeText, item.packageSize, item.size),
        weightText: firstUsableCrossBorderText(item.weightText, item.packageWeight, item.weight),
      })
    )
    .filter((item) => Object.keys(item).length > 0);
}

function getCrossBorderVolumeSizeText(item = {}) {
  const directText = firstUsableCrossBorderText(item.sizeText, item.packageSize, item.size);
  if (directText) return directText;
  const dimensions = [item.length, item.width, item.height]
    .map((value) => firstFiniteNumber(value))
    .filter((value) => value !== null && value > 0);
  return dimensions.length === 3 ? `${dimensions[0]} x ${dimensions[1]} x ${dimensions[2]} cm` : '';
}

function getCrossBorderVolumeWeightText(item = {}) {
  const directText = firstUsableCrossBorderText(item.weightText, item.packageWeight, item.weight);
  if (directText) return directText;
  const weight = firstFiniteNumber(item.grossWeight, item.weight);
  return weight !== null && weight > 0 ? `${weight} kg` : '';
}

export function buildPurchaseCrossBorderPersistFields(detail = {}, fallback = {}) {
  const orderItem = detail.orderItem && typeof detail.orderItem === 'object' ? detail.orderItem : {};
  const orderId = firstUsableOzonId(
    detail.orderId,
    detail.packageOrderId,
    detail.crossBorderOrderId,
    getPurchaseCrossBorderStrictOrderId(orderItem),
    fallback.orderId,
    fallback.packageOrderId,
    fallback.crossBorderOrderId
  );
  const orderNumber = firstUsableOzonId(
    detail.orderNumber,
    detail.crossBorderOrderNumber,
    orderItem.order_number,
    orderItem.orderNumber,
    orderItem.platform_order,
    orderItem.platformOrder,
    fallback.orderNumber,
    fallback.crossBorderOrderNumber
  );
  const orderIds = Array.isArray(detail.orderIds)
    ? detail.orderIds.map((value) => firstUsableOzonId(value)).filter(Boolean)
    : orderId
      ? [orderId]
      : [];
  const found = Boolean(
    detail.crossBorderOrderFound || fallback.crossBorderOrderFound || orderId || orderNumber || detail.orderItem
  );
  const volumeItems = normalizeCrossBorderPersistVolumeItems(detail.volumeItems, fallback.volumeItems);
  const primaryVolumeItem = volumeItems[0] ?? {};
  const volumeSizeText = getCrossBorderVolumeSizeText(primaryVolumeItem);
  const volumeWeightText = getCrossBorderVolumeWeightText(primaryVolumeItem);

  return compactObject({
    crossBorderOrderFound: found || undefined,
    packageOrderId: orderId,
    crossBorderOrderId: orderId,
    crossBorderOrderNumber: orderNumber,
    packageOrderIds: orderIds,
    crossBorderStatus: firstFilled(
      detail.crossBorderStatus,
      detail.status,
      detail.readStatus,
      fallback.crossBorderStatus
    ),
    readStatus: firstFilled(detail.message, detail.readStatus, fallback.readStatus),
    packageWeight: firstUsableCrossBorderText(detail.packageWeight, volumeWeightText, fallback.packageWeight),
    packageSize: firstUsableCrossBorderText(detail.packageSize, volumeSizeText, fallback.packageSize),
    volumeItems,
    warehouse: firstFilled(detail.warehouse, fallback.warehouse),
    logistics: firstFilled(detail.logistics, fallback.logistics),
    deliveryMethod: firstFilled(detail.deliveryMethod, fallback.deliveryMethod),
    deliveryMethodId: firstFilled(detail.deliveryMethodId, fallback.deliveryMethodId),
    sheetOrderSn: firstUsableOzonId(detail.sheetOrderSn, fallback.sheetOrderSn),
    sheetUrl: firstUsableOzonId(detail.sheetUrl, fallback.sheetUrl),
    freightCostValue: detail.freightCostValue ?? fallback.freightCostValue,
    freightCost: firstFilled(detail.freightCost, fallback.freightCost),
    logisticsFreight: detail.logisticsFreight ?? fallback.logisticsFreight,
    guooFreight: detail.guooFreight ?? fallback.guooFreight,
    crossBorderUpdatedAt: new Date().toISOString(),
  });
}

export function createManualPurchaseDraftFromOrder(order = {}) {
  return {
    manualBuyerPlatform: String(order.manualBuyerPlatform || '').trim(),
    manualPurchaseOrderNo: String(order.manualPurchaseOrderNo || '').trim(),
    manualPurchasePrice: String(firstFilled(order.manualPurchasePrice, order.manualPurchasePriceValue) || '').trim(),
  };
}

export function hasPurchaseOverrideValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
}

export function buildPurchaseTransferPendingOverride(order = {}) {
  return {
    clearFields: [
      'purchasePlatform',
      'purchaseOrderNumber',
      'purchaseOrderUrl',
      'sourceCostCny',
      'manualStatus',
    ],
    purchaseOrderNo: '',
    purchaseRecordStatus: 'none',
    buyerPlatform: '待拍单',
    supplier: '待拍单',
    forcePurchaseStatus: '待拍单',
    purchaseException: '',
    voidedPurchaseOrderNo: hasValidPurchaseOrderNumber(order) ? order.purchaseOrderNo : '',
    transferPendingAt: new Date().toISOString(),
    transferPendingReason: hasValidPurchaseOrderNumber(order)
      ? '用户确认采购平台已退款/关闭后转待拍单'
      : '无有效采购记录，转待拍单',
  };
}

export function applyPurchaseTransferPendingOverride(existing = {}, order = {}) {
  const next = { ...existing, ...buildPurchaseTransferPendingOverride(order) };
  [
    'purchasePlatform',
    'purchase_platform',
    'platform',
    'manualBuyerPlatform',
    'buyerPlatform',
    'supplier',
    'purchaseOrderNumber',
    'purchase_order_number',
    'purchaseOrderNo',
    'purchase_order_no',
    'orderNo',
    'order_no',
    'manualPurchaseOrderNo',
    'purchaseOrderUrl',
    'purchase_order_url',
    'orderUrl',
    'order_url',
    'purchaseOrderLink',
    'purchase_order_link',
    'manualPurchaseOrderUrl',
    'sourceCostCny',
    'source_cost_cny',
    'purchaseCostCny',
    'purchase_cost_cny',
    'cost',
    'manualPurchasePrice',
    'manualPurchasePriceValue',
    'purchasePrice',
    'purchasePriceValue',
    'manualStatus',
    'manual_status',
    'purchaseOrderStatus',
    'purchase_order_status',
    'manualPurchaseOrderStatus',
  ].forEach((field) => delete next[field]);
  return next;
}

export function buildPurchaseManualClassifyOverride(order = {}, targetStatus = '') {
  return {
    forcePurchaseStatus: targetStatus,
    manualClassifiedAt: new Date().toISOString(),
    manualClassifiedFrom: order.status || derivePurchaseOrderStatus(order),
    manualClassifiedOzonStatus: getPurchaseOrderOzonBaseStatus(order),
  };
}
