import { canUseOzonShop } from '../../../../entities/order/orderShopScope.jsx';
import { isSplitParentBusinessLocked } from '../../../../services/orderSplitRelationRules';

export const PURCHASE_BATCH_CANCEL_ALLOWED_STATUSES = Object.freeze([
  '待拍单',
  '已拍单-待预报',
  '已拍单-待发货',
  '已拍单-未操作',
  '已拍单-售后单',
]);

export const PURCHASE_BATCH_CANCEL_ALLOWED_OZON_STATUSES = Object.freeze([
  'awaiting_registration',
  'acceptance_in_progress',
  'awaiting_approve',
  'awaiting_packaging',
  'awaiting_deliver',
  'awaiting_delivery',
]);

export const PURCHASE_BATCH_CANCEL_BLOCKED_OZON_STATUSES = Object.freeze([
  'driver_pickup',
  'delivering',
  'delivered',
  'sent_by_seller',
  'cancelled',
  'canceled',
  'not_accepted',
  'arbitration',
  'client_arbitration',
]);

const allowedStatusSet = new Set(PURCHASE_BATCH_CANCEL_ALLOWED_STATUSES);
const allowedOzonStatusSet = new Set(PURCHASE_BATCH_CANCEL_ALLOWED_OZON_STATUSES);
const blockedOzonStatusSet = new Set(PURCHASE_BATCH_CANCEL_BLOCKED_OZON_STATUSES);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeComparableText(value) {
  return normalizeText(value).replace(/\s+/gu, ' ').toLowerCase();
}

function uniqueTextValues(values = [], normalizer = normalizeText) {
  return [...new Set(values.map(normalizer).filter(Boolean))];
}

function getOrderStatusValues(order = {}) {
  const raw = order?.raw && typeof order.raw === 'object' ? order.raw : {};
  const rawPosting = raw?.posting && typeof raw.posting === 'object' ? raw.posting : {};
  return uniqueTextValues([
    order.status,
    order.purchaseStatus,
    order.purchase_status,
    order.forcePurchaseStatus,
    order.force_purchase_status,
    order.purchaseOrderStatus,
    order.purchase_order_status,
    order.ozonStatus,
    order.ozonRawStatus,
    order.rawStatus,
    order.raw_status,
    raw.status,
    raw.ozonStatus,
    raw.ozon_status,
    rawPosting.status,
  ]);
}

function isTerminalStatusText(value) {
  const status = normalizeComparableText(value);
  if (!status) return false;
  if (blockedOzonStatusSet.has(status)) return true;
  if (/(已经发货|已发货|发货完成|已送达|已签收|已完成|完结|关闭|成功订单)/u.test(status)) return true;
  return /(delivered|delivering|driver[_\s-]*pickup|sent[_\s-]*by[_\s-]*seller|cancell?ed|closed|completed|\u0434\u043e\u0441\u0442\u0430\u0432|\u043e\u0442\u043c\u0435\u043d|\u0437\u0430\u0432\u0435\u0440\u0448|\u0437\u0430\u043a\u0440\u044b\u0442)/iu.test(status);
}

function getOrderFulfillment(order = {}) {
  const raw = order?.raw && typeof order.raw === 'object' ? order.raw : {};
  return normalizeComparableText(
    order.fulfillment ||
      order.fulfillmentType ||
      order.fulfillment_type ||
      order.deliverySchema ||
      order.delivery_schema ||
      raw.fulfillment ||
      raw.delivery_schema
  ).toUpperCase();
}

export function getPurchaseBatchCancelEligibility(order = {}) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return {
      eligible: false,
      code: 'invalid_order',
      reason: '订单数据无效。',
      status: '',
    };
  }

  const statuses = getOrderStatusValues(order);
  const status = statuses[0] || '';
  if (getOrderFulfillment(order) === 'FBO') {
    return {
      eligible: false,
      code: 'fbo_order',
      reason: 'FBO 订单不能从拍单管理批量取消。',
      status,
    };
  }

  if (isSplitParentBusinessLocked(order)) {
    return {
      eligible: false,
      code: 'split_parent_locked',
      reason: '拆单母单尚未完成 Ozon 回读确认，只能保留查看。',
      status,
    };
  }

  const terminalStatus = statuses.find(isTerminalStatusText);
  if (terminalStatus) {
    return {
      eligible: false,
      code: 'terminal_status',
      reason: `订单已处于不可取消状态：${terminalStatus}。`,
      status: terminalStatus,
    };
  }

  const hasAllowedPurchaseStatus = statuses.some((item) => allowedStatusSet.has(normalizeText(item)));
  const hasAllowedOzonStatus = statuses.some((item) => allowedOzonStatusSet.has(normalizeComparableText(item)));
  if (hasAllowedPurchaseStatus || hasAllowedOzonStatus) {
    return {
      eligible: true,
      code: 'eligible',
      reason: '',
      status,
    };
  }

  return {
    eligible: false,
    code: 'status_not_cancellable',
    reason: status ? `当前状态不在可取消范围：${status}。` : '订单缺少可核验的取消状态。',
    status,
  };
}

export function isPurchaseBatchCancelOrderEligible(order = {}) {
  return getPurchaseBatchCancelEligibility(order).eligible;
}

export function partitionPurchaseBatchCancelOrders(orders = []) {
  const eligibleOrders = [];
  const excludedOrders = [];
  (Array.isArray(orders) ? orders : []).forEach((order) => {
    const eligibility = getPurchaseBatchCancelEligibility(order);
    if (eligibility.eligible) eligibleOrders.push(order);
    else excludedOrders.push({ order, ...eligibility });
  });
  return {
    eligibleOrders,
    excludedOrders,
    eligibleCount: eligibleOrders.length,
    excludedCount: excludedOrders.length,
  };
}

export function getCancellablePurchaseOrders(orders = []) {
  return partitionPurchaseBatchCancelOrders(orders).eligibleOrders;
}

export function getPurchaseBatchCancelKey(order = {}) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return '';
  const orderKey = normalizeText(
    order.recordKey || order.id || order.salesOrder || order.shipmentNo || order.ozonOrderId || order.posting
  );
  if (!orderKey) return '';
  const shopKey = normalizeText(
    order.shopId || order.shop_id || order.shopClientId || order.shop_client_id || order.clientId || order.client_id
  );
  return `${shopKey || 'unknown-shop'}::${orderKey}`;
}

function normalizeShop(shop = {}) {
  const idValues = uniqueTextValues([shop.id, shop.shopId, shop.shop_id], normalizeComparableText);
  const clientIdValues = uniqueTextValues(
    [shop.clientId, shop.client_id, shop.shopClientId, shop.shop_client_id],
    normalizeComparableText
  );
  const labels = uniqueTextValues(
    [shop.shopAlias, shop.sellerName, shop.shop, shop.shopName, shop.storeName, shop.name],
    normalizeComparableText
  );
  return {
    shop,
    idValues,
    clientIdValues,
    labels,
    available: canUseOzonShop(shop),
    key: `${idValues.join('|') || 'no-shop-id'}::${clientIdValues.join('|') || 'no-client-id'}`,
  };
}

function dedupeNormalizedShops(shops = []) {
  const byKey = new Map();
  (Array.isArray(shops) ? shops : []).forEach((shop) => {
    if (!shop || typeof shop !== 'object' || Array.isArray(shop)) return;
    const normalized = normalizeShop(shop);
    const existing = byKey.get(normalized.key);
    if (!existing || (!existing.available && normalized.available)) byKey.set(normalized.key, normalized);
  });
  return [...byKey.values()];
}

function getOrderShopIdentity(order = {}) {
  const shopClientIds = uniqueTextValues([order.shopClientId, order.shop_client_id], normalizeComparableText);
  const clientIds = uniqueTextValues([order.clientId, order.client_id], normalizeComparableText);
  const shopIds = uniqueTextValues([order.shopId, order.shop_id], normalizeComparableText);
  const labels = uniqueTextValues(
    [order.shop, order.shopName, order.shop_name, order.storeName, order.store_name],
    normalizeComparableText
  );
  return {
    shopIds,
    clientIds: uniqueTextValues([...shopClientIds, ...clientIds], normalizeComparableText),
    hasClientIdConflict: shopClientIds.length > 1 || clientIds.length > 1 || new Set([...shopClientIds, ...clientIds]).size > 1,
    hasShopIdConflict: shopIds.length > 1,
    labels,
    hasLabelConflict: labels.length > 1,
  };
}

function failedShopResolution(code, reason, extra = {}) {
  return {
    ok: false,
    shop: null,
    shopKey: '',
    matchedBy: '',
    code,
    reason,
    ...extra,
  };
}

function successfulShopResolution(normalized, matchedBy) {
  return {
    ok: true,
    shop: normalized.shop,
    shopKey: normalized.key,
    matchedBy,
    code: 'resolved',
    reason: '',
  };
}

function resolveSingleShopCandidate(candidates, matchedBy) {
  if (candidates.length > 1) {
    return failedShopResolution('shop_ambiguous', '订单店铺身份同时匹配多个店铺，已停止提交。');
  }
  if (!candidates.length) return null;
  const candidate = candidates[0];
  if (!candidate.available) {
    return failedShopResolution('shop_unavailable', '订单匹配的店铺未配置可用 Ozon 接口，已停止提交。');
  }
  return successfulShopResolution(candidate, matchedBy);
}

export function resolvePurchaseBatchCancelShop(order = {}, shops = []) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return failedShopResolution('invalid_order', '订单数据无效，无法解析店铺。');
  }

  const normalizedShops = dedupeNormalizedShops(shops);
  const identity = getOrderShopIdentity(order);
  if (identity.hasClientIdConflict || identity.hasShopIdConflict) {
    return failedShopResolution('order_shop_identity_conflict', '订单内部包含相互冲突的店铺编号，已停止提交。');
  }

  const hasStrongIdentity = identity.shopIds.length > 0 || identity.clientIds.length > 0;
  if (hasStrongIdentity) {
    const idMatches = identity.shopIds.length
      ? normalizedShops.filter((candidate) => identity.shopIds.every((id) => candidate.idValues.includes(id)))
      : normalizedShops;
    const clientMatches = identity.clientIds.length
      ? normalizedShops.filter((candidate) => identity.clientIds.every((id) => candidate.clientIdValues.includes(id)))
      : normalizedShops;
    const candidates = idMatches.filter((candidate) => clientMatches.includes(candidate));
    const resolution = resolveSingleShopCandidate(candidates, 'strong-identity');
    if (resolution) return resolution;

    const hasSeparateMatches = idMatches.length > 0 || clientMatches.length > 0;
    return failedShopResolution(
      hasSeparateMatches && identity.shopIds.length && identity.clientIds.length
        ? 'order_shop_identity_conflict'
        : 'shop_not_found',
      hasSeparateMatches && identity.shopIds.length && identity.clientIds.length
        ? '订单的 shopId 和 clientId 分别指向不同店铺，已停止提交。'
        : '未找到与订单强店铺身份完全一致的配置，不会回退到当前店铺。'
    );
  }

  if (identity.hasLabelConflict) {
    return failedShopResolution('order_shop_label_conflict', '订单内部包含相互冲突的店铺名称，已停止提交。');
  }

  if (identity.labels.length === 1) {
    const label = identity.labels[0];
    const labelMatches = normalizedShops.filter(
      (candidate) => candidate.available && candidate.labels.includes(label)
    );
    const resolution = resolveSingleShopCandidate(labelMatches, 'unique-label');
    if (resolution) return resolution;
    return failedShopResolution('shop_label_not_found', '未找到名称与订单完全一致的唯一可用店铺。');
  }

  const availableShops = normalizedShops.filter((candidate) => candidate.available);
  if (availableShops.length === 1) return successfulShopResolution(availableShops[0], 'only-available-shop');
  if (!availableShops.length) {
    return failedShopResolution('shop_unavailable', '没有可用的 Ozon 店铺配置，已停止提交。');
  }
  return failedShopResolution('shop_ambiguous', '订单没有强店铺身份，且当前存在多个可用店铺，已停止提交。');
}

export const resolveStrictPurchaseOrderShop = resolvePurchaseBatchCancelShop;

export function preparePurchaseBatchCancelOrders(orders = [], shops = []) {
  const readyOrders = [];
  const excludedOrders = [];
  (Array.isArray(orders) ? orders : []).forEach((order) => {
    const eligibility = getPurchaseBatchCancelEligibility(order);
    if (!eligibility.eligible) {
      excludedOrders.push({ order, ...eligibility });
      return;
    }
    const shopResolution = resolvePurchaseBatchCancelShop(order, shops);
    if (!shopResolution.ok) {
      excludedOrders.push({ order, eligible: false, ...shopResolution });
      return;
    }
    readyOrders.push({ order, shop: shopResolution.shop, shopKey: shopResolution.shopKey, shopResolution });
  });
  return {
    readyOrders,
    excludedOrders,
    readyCount: readyOrders.length,
    excludedCount: excludedOrders.length,
    shopCount: new Set(readyOrders.map((item) => item.shopKey)).size,
  };
}

function getReasonId(reason = {}) {
  return normalizeText(reason.id ?? reason.reason_id ?? reason.reasonId ?? reason.cancel_reason_id ?? reason.cancelReasonId);
}

function normalizeReasonLists(reasonLists) {
  if (reasonLists instanceof Map) return [...reasonLists.values()];
  if (Array.isArray(reasonLists)) return reasonLists;
  if (reasonLists && typeof reasonLists === 'object') return Object.values(reasonLists);
  return [];
}

export function intersectPurchaseBatchCancelReasons(reasonLists = []) {
  const lists = normalizeReasonLists(reasonLists).map((list) => (Array.isArray(list) ? list : []));
  if (!lists.length || lists.some((list) => list.length === 0)) return [];

  const remainingIds = lists.slice(1).map((list) => new Set(list.map(getReasonId).filter(Boolean)));
  const seen = new Set();
  return lists[0].reduce((result, reason) => {
    const id = getReasonId(reason);
    if (!id || seen.has(id) || remainingIds.some((ids) => !ids.has(id))) return result;
    seen.add(id);
    result.push({
      ...reason,
      id,
      rawLabel: Object.prototype.hasOwnProperty.call(reason, 'rawLabel') ? reason.rawLabel : '',
    });
    return result;
  }, []);
}

export const intersectPurchaseCancelReasons = intersectPurchaseBatchCancelReasons;
