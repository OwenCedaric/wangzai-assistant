import {
  deletePurchaseOrderOverride,
  getPurchaseOrderOverrides,
  importLegacyPurchaseOrderOverrides,
  savePurchaseOrderOverride,
} from '../api/localApiClient';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

const PURCHASE_CROSS_BORDER_OVERRIDE_FIELDS = [
  'crossBorderOrderFound',
  'crossBorderStatus',
  'crossBorderOrderCount',
  'packageOrderId',
  'crossBorderOrderId',
  'crossBorderOrderNumber',
  'packageOrderIds',
  'readStatus',
  'packageWeight',
  'packageSize',
  'volumeItems',
  'warehouse',
  'logistics',
  'deliveryMethod',
  'deliveryMethodId',
  'sheetOrderSn',
  'sheetUrl',
  'freightCostValue',
  'freightCost',
  'logisticsFreight',
  'guooFreight',
  'crossBorderUpdatedAt',
];

const PURCHASE_LOCAL_ACTION_OVERRIDE_FIELDS = new Set([
  'purchaseForecastFlow',
  'forcePurchaseStatus',
  'manualClassifiedAt',
  'manualClassifiedFrom',
  'manualClassifiedOzonStatus',
  'transferPendingAt',
  'transferPendingReason',
  'voidedPurchaseOrderNo',
  'purchaseException',
  'purchaseRecordStatus',
  'ozonAwaitingDeliveryPendingAt',
  'ozonAwaitingDeliveryRawStatus',
  'ozonAwaitingDeliveryReason',
]);

const PURCHASE_OVERRIDE_CLEARABLE_FIELDS = new Set([
  'purchasePlatform',
  'purchaseOrderNumber',
  'purchaseOrderUrl',
  'sourceCostCny',
  'manualStatus',
]);

function getCompactManualOverrideRaw(order = {}, patch = {}) {
  const output = {};
  [order, patch].forEach((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    Object.entries(source).forEach(([key, value]) => {
      if (!/^manual(?:Profit|Purchase|Buyer|Source)/i.test(key) && !PURCHASE_LOCAL_ACTION_OVERRIDE_FIELDS.has(key)) {
        return;
      }
      if (!hasPersistableValue(value)) return;
      output[key] = value;
    });
  });
  return output;
}

function getPurchaseOverrideClearFields(order = {}, patch = {}) {
  const fields = [patch.clearFields, order.clearFields]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(normalizeText)
    .filter((value) => PURCHASE_OVERRIDE_CLEARABLE_FIELDS.has(value));
  return [...new Set(fields)];
}

function hasPersistableValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
}

function getCrossBorderOverridePayloadFields(order = {}, patch = {}) {
  return PURCHASE_CROSS_BORDER_OVERRIDE_FIELDS.reduce((next, field) => {
    const value = hasPersistableValue(patch[field]) ? patch[field] : order[field];
    if (hasPersistableValue(value)) next[field] = value;
    return next;
  }, {});
}

export function getPurchaseOverrideKey(order = {}) {
  return normalizeText(
    order.orderKey ||
      order.recordKey ||
      order.postingNumber ||
      order.posting_number ||
      order.ozonOrderId ||
      order.orderId ||
      order.order_id
  );
}

export function toPurchaseOverridePayload(order = {}, patch = {}) {
  const orderKey = getPurchaseOverrideKey(patch) || getPurchaseOverrideKey(order);
  if (!orderKey) {
    throw new Error('保存拍单补录需要 orderKey/postingNumber。');
  }
  const crossBorderFields = getCrossBorderOverridePayloadFields(order, patch);
  return {
    ...crossBorderFields,
    clearFields: getPurchaseOverrideClearFields(order, patch),
    shopId: normalizeText(patch.shopId || order.shopId || order.shop_id),
    orderKey,
    postingNumber: normalizeText(
      patch.postingNumber || patch.posting_number || order.postingNumber || order.posting_number
    ),
    ozonOrderId: normalizeText(
      patch.ozonOrderId || patch.ozon_order_id || order.ozonOrderId || order.orderId || order.order_id
    ),
    offerId: normalizeText(patch.offerId || patch.offer_id || order.offerId || order.offer_id),
    sku: normalizeText(patch.sku || order.sku),
    purchasePlatform: normalizeText(
      patch.purchasePlatform ||
        patch.purchase_platform ||
        patch.platform ||
        patch.manualBuyerPlatform ||
        patch.buyerPlatform ||
        patch.supplier ||
        order.purchasePlatform ||
        order.purchase_platform ||
        order.manualBuyerPlatform ||
        order.buyerPlatform ||
        order.supplier
    ),
    purchaseOrderNumber: normalizeText(
      patch.purchaseOrderNumber ||
        patch.purchase_order_number ||
        patch.purchaseOrderNo ||
        patch.purchase_order_no ||
        patch.orderNo ||
        patch.order_no ||
        patch.manualPurchaseOrderNo ||
        order.purchaseOrderNumber ||
        order.purchase_order_number ||
        order.purchaseOrderNo ||
        order.purchase_order_no ||
        order.orderNo ||
        order.order_no ||
        order.manualPurchaseOrderNo
    ),
    purchaseOrderUrl: normalizeText(
      patch.purchaseOrderUrl ||
        patch.purchase_order_url ||
        patch.orderUrl ||
        patch.order_url ||
        patch.purchaseOrderLink ||
        patch.purchase_order_link ||
        patch.url ||
        patch.link ||
        order.purchaseOrderUrl ||
        order.purchase_order_url ||
        order.orderUrl ||
        order.order_url ||
        order.purchaseOrderLink ||
        order.purchase_order_link
    ),
    sourceCostCny:
      patch.sourceCostCny ??
      patch.source_cost_cny ??
      patch.purchaseCostCny ??
      patch.purchase_cost_cny ??
      patch.cost ??
      patch.manualPurchasePriceValue ??
      patch.manualPurchasePrice ??
      order.sourceCostCny ??
      order.source_cost_cny ??
      order.purchaseCostCny ??
      order.purchase_cost_cny ??
      order.purchasePriceValue ??
      order.purchasePrice ??
      order.manualPurchasePriceValue ??
      order.manualPurchasePrice,
    manualStatus: normalizeText(
      patch.manualStatus ||
        patch.manual_status ||
        patch.purchaseOrderStatus ||
        patch.purchase_order_status ||
        patch.manualPurchaseOrderStatus ||
        patch.status ||
        order.manualStatus ||
        order.manual_status ||
        order.purchaseOrderStatus ||
        order.purchase_order_status ||
        order.manualPurchaseOrderStatus
    ),
    updatedAt: normalizeText(patch.updatedAt ?? patch.updated_at ?? order.updatedAt ?? order.updated_at),
    materialSource: patch.materialSource ?? patch.material_source,
    note: normalizeText(patch.note || patch.remark || patch.memo),
    // `order` / `patch` 曾各自复制整份 Ozon 订单，既会把一个 override 推到 HTTP 64KiB
    // 上限，也让 JSON 与 SQLite 重复保存。规范字段和跨境字段已有明确列；仅保留额外 manual 字段。
    raw: { ...crossBorderFields, ...getCompactManualOverrideRaw(order, patch) },
  };
}

export async function readPurchaseOverrides(query = {}, options = {}) {
  return getPurchaseOrderOverrides(query, options);
}

export async function savePurchaseOverride(order = {}, patch = {}, options = {}) {
  return savePurchaseOrderOverride(toPurchaseOverridePayload(order, patch), options);
}

export function importLegacyPurchaseOverrides(overrides = [], options = {}) {
  return importLegacyPurchaseOrderOverrides(overrides, options);
}

export async function removePurchaseOverride(order = {}, options = {}) {
  const orderKey = getPurchaseOverrideKey(order);
  return deletePurchaseOrderOverride({ shopId: order.shopId || order.shop_id, orderKey }, options);
}
