import {
  translateAfterSalesLogisticsStatusToChinese,
  translateAfterSalesReasonToChinese,
} from '../../services/afterSalesReasonTranslate';
import { attachSplitRelationFields } from '../../services/orderSplitRelationRules';
import {
  getOzonAfterSalesReasonRawText,
  getOzonAfterSalesReasonText,
} from '../../services/ozonOrderExperience';
import { mergeRowsByKey as mergeOzonRowsByKeySafe } from '../../services/ozonOrderSafety';
import { safeWarn } from '../../services/safeLog';
import {
  OZON_ORDER_FALLBACK_PAGE_LIMIT,
  OZON_ORDER_PAGE_LIMIT,
  OZON_ORDER_PAGINATION_SAFETY_MAX_PAGES,
} from '../../shared/config/appConfigCore.jsx';
import { chunkValues } from '../../shared/lib/collectionUtils.js';
import { isOzonRetryableReadError, requestOzonReadOnly } from '../../shared/ozon/ozonRuntime.jsx';
import { hasAfterSalesOriginalOrderCheck } from '../order/afterSalesOriginalOrderRules.jsx';
import { isLowPriorityAfterSalesReason } from '../order/afterSalesReasonRules.jsx';
import {
  firstFilled,
  formatOzonOrderDate,
  formatOzonOrderDateTime,
  getOzonPayloadHasNext,
  getOzonPayloadOptionalTotal,
  getOzonReadableShops,
  getOzonShopClientId,
  getOzonShopLabel,
  normalizeOzonId,
  resolveOzonTimeRange,
} from '../order/orderShopScope.jsx';
import {
  AFTER_SALES_CLASSIFICATION_VERSION,
  getAfterSalesOriginalOrderSource,
  getAfterSalesTone,
  getOzonOrderBaseStatusLabel,
  getOzonOrderStatusLabel,
  getOzonOrderStatusTags,
  getSalesOrderTone,
  runIsolatedShopAsync,
  runLimitedAsync,
} from '../order/orderAsyncRules.jsx';
import {
  dedupeOzonAfterSalesProductsBySource,
  getAfterSalesStatusByRules,
  getOzonAfterSalesAmountCnyDisplay,
  getOzonAfterSalesProducts,
  getOzonOrderAmount,
  getOzonOrderCurrencyCode,
  getOzonOrderProducts,
  normalizeOzonAfterSalesProductCurrency,
  normalizeOzonAfterSalesProductQuantities,
} from '../order/orderDisplayFormat.jsx';
import {
  canUseCrossBorderOrderRead,
  enrichSalesRowsWithOzonProductImages,
  getOzonOrderCrossBorderInfo,
  mergeLocalCrossBorderOrderRecords,
  readSavedCrossBorderOrderSettings,
  requestCrossBorderOrderSearch,
  requestCrossBorderReadOnly,
} from '../order/crossBorderOrderApi.jsx';
import { getSalesOrderCrossBorderKeys } from '../order/orderCrossBorderKeys.jsx';
import {
  getCrossBorderOrderId,
  getCrossBorderPayloadObject,
  normalizeCrossBorderOrderInfo,
} from '../order/orderSourceLinkFields.jsx';
import { getOzonPayloadItems } from '../product/productOzonApi.jsx';
import { toFiniteNumber } from '../product/productAttributes.jsx';

export async function enrichSalesRowsWithCrossBorderStatus(rows = []) {
  const settings = readSavedCrossBorderOrderSettings();
  if (!canUseCrossBorderOrderRead(settings)) {
    return {
      rows,
      crossBorder: { enabled: false, error: '请先在设置里保存跨境巴士企业接口和账号授权。' },
    };
  }

  const clientIds = new Set(rows.map((row) => normalizeOzonId(row.shopClientId).trim()).filter(Boolean));

  return {
    rows,
    crossBorder: {
      enabled: true,
      deferred: true,
      shopCount: clientIds.size,
      total: null,
      matched: null,
    },
  };
}

export async function enrichSalesOrderWithCrossBorderDetail(order) {
  const settings = readSavedCrossBorderOrderSettings();
  if (!order) return order;
  const shopId = normalizeOzonId(order.shopId ?? order.shop_id).trim();
  const shopClientId = normalizeOzonId(order.shopClientId).trim();
  if (!shopClientId) return order;
  const shopScope = { shopId, shopClientId };

  try {
    let crossBorderOrder = null;
    const existingOrderId =
      order.crossBorderInfo?.orderId && order.crossBorderInfo.orderId !== '未返回' ? order.crossBorderInfo.orderId : '';
    if (existingOrderId) {
      const byExistingOrderId = await requestCrossBorderOrderSearch(
        settings,
        { order_id: existingOrderId },
        shopScope
      );
      crossBorderOrder = byExistingOrderId.items[0] ?? null;
    } else {
      for (const key of getSalesOrderCrossBorderKeys(order)) {
        const byOrderNumber = await requestCrossBorderOrderSearch(settings, { order_number: key }, shopScope);
        crossBorderOrder = byOrderNumber.items[0] ?? null;
        if (crossBorderOrder) break;
        const byPlatformOrder = await requestCrossBorderOrderSearch(settings, { platform_order: key }, shopScope);
        crossBorderOrder = byPlatformOrder.items[0] ?? null;
        if (crossBorderOrder) break;
      }
    }

    const crossBorderOrderId = getCrossBorderOrderId(crossBorderOrder);
    if (!crossBorderOrderId) return order;

    const [statusPayload, outPayload] = await Promise.all([
      requestCrossBorderReadOnly('/erpapi/orderlist/status', settings, { order_id: crossBorderOrderId }).catch(
        () => null
      ),
      requestCrossBorderReadOnly('/erpapi/order/get_order_out_info', settings, { order_id: crossBorderOrderId }).catch(
        () => null
      ),
    ]);
    mergeLocalCrossBorderOrderRecords(
      [
        {
          ...crossBorderOrder,
          statusPayload: statusPayload ? getCrossBorderPayloadObject(statusPayload) : undefined,
          outPayload: outPayload ? getCrossBorderPayloadObject(outPayload) : undefined,
        },
      ],
      shopScope
    ).catch(() => undefined);

    return {
      ...order,
      crossBorderInfo: {
        ...order.crossBorderInfo,
        ...normalizeCrossBorderOrderInfo(crossBorderOrder, statusPayload, outPayload),
      },
    };
  } catch {
    return order;
  }
}

export function normalizeOzonSalesOrderRow(item = {}, { source = 'FBS', shop } = {}) {
  const fulfillment =
    source === 'FBO'
      ? 'FBO'
      : String(firstFilled(item.delivery_schema, item.fulfillment, item.substatus) || '')
            .toLowerCase()
            .includes('rfbs')
        ? 'rFBS'
        : 'FBS';
  const products = getOzonOrderProducts(item);
  const posting = normalizeOzonId(firstFilled(item.posting_number, item.postingNumber));
  const orderRef = normalizeOzonId(firstFilled(item.order_number, item.orderNumber, item.order_id, item.orderId));
  const rawStatusValue = firstFilled(item.status, item.posting_status, item.state);
  const statusTags = getOzonOrderStatusTags(rawStatusValue, item);
  const status = getOzonOrderStatusLabel(rawStatusValue, item);
  const deadlineRaw = firstFilled(item.cutoff_at, item.shipment_date, item.delivering_date, item.delivery_date_begin);
  const updatedRaw = firstFilled(
    item.updated_at,
    item.in_process_at,
    item.created_at,
    item.delivering_date,
    deadlineRaw
  );
  const paymentTimeRaw = firstFilled(item.paid_at, item.payment_date, item.in_process_at, item.created_at);
  const firstProduct = products[0] ?? {};
  const orderAmount = getOzonOrderAmount(item, products);
  const currencyCode =
    item.currency_code ||
    item.currency ||
    firstProduct.currencyCode ||
    item.financial_data?.currency_code ||
    item.financialData?.currency_code ||
    'RUB';
  const shopClientId = getOzonShopClientId(shop);

  const orderId = posting || '未返回';
  const recordId = posting || orderRef || '未返回';

  return attachSplitRelationFields(
    {
      id: orderId,
      recordKey: `${shopClientId || 'unknown'}:${recordId}`,
      posting: posting || '未返回',
      softwareOrderId: orderRef || '未返回',
      shopId: shop?.id || '',
      shopClientId,
      shopName: getOzonShopLabel(shop),
      shop: getOzonShopLabel(shop),
      channel: `Ozon ${fulfillment}`,
      buyer:
        firstFilled(
          item.customer?.name,
          item.buyer?.name,
          item.addressee?.name,
          item.analytics_data?.buyer_name,
          item.customer_name
        ) || '未返回',
      product: firstProduct.name || '未返回',
      sku: firstProduct.sku || '未返回',
      amount: orderAmount,
      amountValue: toFiniteNumber(orderAmount),
      currencyCode,
      items: products.reduce((sum, product) => sum + (toFiniteNumber(product.qty) ?? 0), 0) || products.length || 1,
      payment: firstFilled(item.payment_type_group_name, item.payment_status) || '未返回',
      paymentDate: paymentTimeRaw || '',
      paymentTime: formatOzonOrderDateTime(paymentTimeRaw, '未返回'),
      fulfillment,
      commissionMode: 'rFBS',
      commissionPercent: '未返回',
      commissionAmount: '未返回',
      logistics:
        firstFilled(
          item.delivery_method?.name,
          item.delivery_method_name,
          item.provider_name,
          item.analytics_data?.delivery_type,
          item.analytics_data?.warehouse_name
        ) || '未返回',
      status,
      statusTags,
      tone: getSalesOrderTone(status),
      deadline: deadlineRaw ? formatOzonOrderDate(deadlineRaw) : '未返回',
      created: formatOzonOrderDate(firstFilled(item.created_at, item.in_process_at), '未返回'),
      updated: formatOzonOrderDate(updatedRaw, '未返回'),
      address:
        firstFilled(item.analytics_data?.city, item.customer?.address?.city, item.delivery_address?.city) || '未返回',
      note: firstFilled(item.substatus, item.status) || 'Ozon 已返回订单状态',
      products: products.length ? products : [{ name: '未返回', sku: '未返回', qty: 1, price: '未返回' }],
      crossBorderInfo: getOzonOrderCrossBorderInfo(item),
      timeline: [
        `订单状态：${status}`,
        `履约方式：${fulfillment}`,
        `最后更新：${formatOzonOrderDate(updatedRaw, '未返回')}`,
      ],
      raw: item,
      realSource: source,
    },
    item
  );
}

export function getOzonOriginalOrderCancellationReasonText(item = {}) {
  const original = getAfterSalesOriginalOrderSource(item);
  const cancellation = item.originalOrderCancellation || original.cancellation || item.cancellation || {};
  return getOzonAfterSalesReasonText({
    originalOrderCancellationReason: item.originalOrderCancellationReason,
    originalOrderCancelReason: item.originalOrderCancelReason,
    cancel_reason: item.originalOrderCancelReason,
    cancellation_reason: item.originalOrderCancellationReason,
    originalOrderCancellation: cancellation,
  });
}

export function getOzonDirectAfterSalesReasonText(item = {}) {
  return getOzonAfterSalesReasonText({
    return_reason: item.return_reason,
    returnReason: item.returnReason,
    return_reason_name: item.return_reason_name,
    returnReasonName: item.returnReasonName,
    refund_reason: item.refund_reason,
    refundReason: item.refundReason,
    cancel_reason: item.cancel_reason,
    cancelReason: item.cancelReason,
    cancellation_reason: item.cancellation_reason,
    cancellationReason: item.cancellationReason,
    reason: item.reason,
    reason_name: item.reason_name,
    reasonName: item.reasonName,
    reason_message: item.reason_message,
    reasonMessage: item.reasonMessage,
    buyer_comment: item.buyer_comment,
    buyerComment: item.buyerComment,
    customer_comment: item.customer_comment,
    customerComment: item.customerComment,
    comment: item.comment,
    message: item.message,
    explanation: item.explanation,
  });
}

export function getOzonAfterSalesDisplayReason(item = {}, status = '') {
  const originalCancellationReason = getOzonOriginalOrderCancellationReasonText(item);
  const directReason = getOzonDirectAfterSalesReasonText(item);
  const deepReason = getOzonAfterSalesReasonText(item);
  const translateReason = (value) => translateAfterSalesReasonToChinese(value) || value || '';

  if (status === '发货前取消' && !isLowPriorityAfterSalesReason(originalCancellationReason)) {
    return translateReason(originalCancellationReason);
  }
  if (!isLowPriorityAfterSalesReason(directReason)) return translateReason(directReason);
  if (!isLowPriorityAfterSalesReason(originalCancellationReason)) return translateReason(originalCancellationReason);
  if (!isLowPriorityAfterSalesReason(deepReason)) return translateReason(deepReason);
  return translateReason(directReason || originalCancellationReason || deepReason);
}

function getOzonMoneyReturnedStatus(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return '';
  const explicit = firstFilled(state.money_return_state_name, state.moneyReturnStateName);
  if (explicit) return explicit;
  const rawText = firstFilled(state.state, state.state_name, state.stateName);
  if (!rawText) return '';
  if (/moneyreturned|деньги\s+возвращены|returned\s+money/iu.test(String(rawText))) return '已退款给买家';
  if (/moneyreturninginprocess|refundinginprocess|возврат\s+денег/iu.test(String(rawText))) return '退款处理中';
  return '';
}

function getOzonCancellationRefundEvidence(item = {}, source = '') {
  const state = item.state && typeof item.state === 'object' && !Array.isArray(item.state) ? item.state : {};
  const cancellation =
    item.cancellation && typeof item.cancellation === 'object' && !Array.isArray(item.cancellation)
      ? item.cancellation
      : item.originalOrderCancellation &&
          typeof item.originalOrderCancellation === 'object' &&
          !Array.isArray(item.originalOrderCancellation)
        ? item.originalOrderCancellation
        : {};
  const evidenceText = [
    item.status,
    item.state,
    item.return_status,
    item.returnStatus,
    item.originalOrderStatus,
    item.originalOrderSubstatus,
    state.state,
    state.state_name,
    state.stateName,
    state.group_state,
    item.reason,
    item.reason_name,
    item.return_reason,
    item.returnReason,
    item.cancellation_reason,
    item.cancellationReason,
    item.originalOrderCancellationReason,
    cancellation.cancel_reason,
    cancellation.cancelReason,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const isCancellationRefund =
    source === 'order-cancelled' ||
    item.source === 'order-cancelled' ||
    cancellation.cancelled_after_ship === true ||
    cancellation.canceled_after_ship === true ||
    /posting_canceled|cancelled|canceled|utilizing|utilization|утил|отказался\s+при\s+вручении|拒收|交付时拒收|取消/iu.test(
      evidenceText
    );
  if (!isCancellationRefund) return null;
  const time = firstFilled(
    cancellation.cancelled_at,
    cancellation.cancelledAt,
    cancellation.canceled_at,
    cancellation.canceledAt,
    cancellation.cancel_date,
    cancellation.cancelDate,
    cancellation.cancellation_date,
    cancellation.cancellationDate,
    cancellation.date,
    item.cancelled_at,
    item.cancelledAt,
    item.canceled_at,
    item.canceledAt,
    item.cancel_date,
    item.cancelDate,
    item.cancellation_date,
    item.cancellationDate,
    item.cancelled_date,
    item.cancelledDate,
    item.created_at,
    item.createdAt
  );
  return time ? { status: '已退款', time, source: 'Ozon取消日期' } : null;
}

export function normalizeOzonAfterSalesRow(item = {}, { source = 'returns', shop } = {}) {
  const sourceProducts = normalizeOzonAfterSalesProductQuantities(getOzonAfterSalesProducts(item), item);
  const products = dedupeOzonAfterSalesProductsBySource(sourceProducts.map(normalizeOzonAfterSalesProductCurrency));
  const posting = normalizeOzonId(
    firstFilled(item.posting_number, item.postingNumber, item.order_number, item.order_id)
  );
  const classification = getAfterSalesStatusByRules(item, source);
  const status = classification.status;
  const rawId = normalizeOzonId(item.id);
  const explicitAfterSalesId = normalizeOzonId(
    firstFilled(
      item.return_id,
      item.returnId,
      item.return_number,
      item.returnNumber,
      item.cancellation_id,
      item.cancellationId,
      item.request_id,
      item.requestId
    )
  );
  const id =
    source === 'order-cancelled'
      ? ''
      : explicitAfterSalesId || (rawId && rawId !== posting && !rawId.startsWith('return_') ? rawId : '');
  const recordKey = firstFilled(
    item.recordKey,
    item.returnKey,
    id && posting ? `return:${id}:posting:${posting}` : '',
    id ? `return:${id}` : '',
    posting ? `posting:${posting}` : ''
  );
  const entityId = id || recordKey || posting;
  const updatedRaw = firstFilled(item.updated_at, item.created_at, item.requested_at, item.return_date, item.date);
  const firstProduct = products[0] ?? {};
  const sourceCurrencyCode = getOzonOrderCurrencyCode(item, sourceProducts);
  const refundAmount = getOzonAfterSalesAmountCnyDisplay(item, products);
  const afterSalesReasonRaw = getOzonAfterSalesReasonRawText(item);
  const deterministicReason = translateAfterSalesReasonToChinese(afterSalesReasonRaw);
  const afterSalesReason =
    deterministicReason && !/[\u0400-\u04FF]/u.test(deterministicReason)
      ? deterministicReason
      : getOzonAfterSalesDisplayReason(item, status);
  const refundPayload =
    item.refund && typeof item.refund === 'object' && !Array.isArray(item.refund) ? item.refund : {};
  const statePayload = item.state && typeof item.state === 'object' && !Array.isArray(item.state) ? item.state : {};
  const refundEvidence =
    item.refundEvidence && typeof item.refundEvidence === 'object'
      ? item.refundEvidence
      : item.refund_evidence && typeof item.refund_evidence === 'object'
        ? item.refund_evidence
        : refundPayload.evidence && typeof refundPayload.evidence === 'object'
          ? refundPayload.evidence
          : null;
  const cancellationRefundEvidence = getOzonCancellationRefundEvidence(item, source);
  const refundStatus = firstFilled(
    item.refundStatus,
    item.refund_status,
    item.refundStatusText,
    item.refund_status_text,
    refundEvidence?.status,
    statePayload.money_return_state_name,
    statePayload.moneyReturnStateName,
    statePayload.money_return_state,
    statePayload.moneyReturnState,
    getOzonMoneyReturnedStatus(statePayload),
    cancellationRefundEvidence?.status,
    refundPayload.status,
    refundPayload.state,
    refundPayload.refund_status,
    refundPayload.refundStatus,
    refundPayload.money_return_state_name,
    refundPayload.moneyReturnStateName
  );
  const refundTime = firstFilled(
    item.refundTime,
    item.refund_time,
    item.refundAt,
    item.refund_at,
    item.refundedAt,
    item.refunded_at,
    refundEvidence?.time,
    refundEvidence?.refundTime,
    refundEvidence?.refund_time,
    refundEvidence?.refundedAt,
    refundEvidence?.refunded_at,
    cancellationRefundEvidence?.time,
    refundPayload.time,
    refundPayload.refund_time,
    refundPayload.refunded_at,
    refundPayload.refundedAt,
    refundPayload.created_at,
    refundPayload.processed_at,
    refundPayload.completed_at
  );
  const sourceLabel = source === 'conditional' ? '条件取消' : source === 'order-cancelled' ? '已取消订单' : '退货申请';
  const channelLabel = source === 'rfbs-return' ? 'Ozon rFBS' : source === 'order-cancelled' ? 'Ozon 取消订单' : 'Ozon';

  return attachSplitRelationFields(
    {
      id: entityId || '未返回',
      returnId: id,
      return_id: id,
      afterSalesId: id,
      recordKey,
      salesOrder: posting || '未返回',
      shop: getOzonShopLabel(shop),
      shopId: shop?.id || '',
      shopClientId: getOzonShopClientId(shop),
      clientId: getOzonShopClientId(shop),
      channel: channelLabel,
      buyer: firstFilled(item.customer_name, item.customer?.name, item.buyer?.name) || '未返回',
      product: firstProduct.name || '未返回',
      sku: firstProduct.sku || '未返回',
      amount: refundAmount,
      amountValue: toFiniteNumber(refundAmount),
      refundAmount,
      refundAmountValue: toFiniteNumber(refundAmount),
      currencyCode: 'CNY',
      sourceCurrencyCode,
      type: status,
      status,
      tone: getAfterSalesTone(status),
      logistics:
        translateAfterSalesLogisticsStatusToChinese(
          firstFilled(item.logistics_status, item.delivery_schema, item.status)
        ) || '未返回',
      reason: afterSalesReason || '未返回',
      reasonZh: firstFilled(item.reasonZh, item.reason_zh, item.return_reason_zh),
      reason_zh: firstFilled(item.reasonZh, item.reason_zh, item.return_reason_zh),
      reasonRaw: afterSalesReasonRaw,
      reason_raw: afterSalesReasonRaw,
      reasonTranslationStatus: firstFilled(
        item.reasonTranslationStatus,
        item.reason_translation_status,
        item.return_reason_translation_status
      ),
      reasonTranslationProvider: firstFilled(
        item.reasonTranslationProvider,
        item.reason_translation_provider,
        item.return_reason_translation_provider
      ),
      excludeFromAfterSales: Boolean(classification.excludeFromAfterSales),
      classificationVersion: AFTER_SALES_CLASSIFICATION_VERSION,
      classificationConfidence: classification.confidence ?? 0,
      classificationReason: classification.reason || '未命中更明确证据',
      financeRefundChecked: Boolean(item.financeRefundChecked || item.financeRefundEvidence?.checked),
      financeRefundConfirmed: Boolean(item.financeRefundConfirmed || item.financeRefundEvidence?.confirmed),
      financeRefundEvidence: item.financeRefundEvidence ?? null,
      refundStatus: refundStatus || '',
      refund_status: refundStatus || '',
      refundTime: refundTime || '',
      refund_time: refundTime || '',
      refundEvidence: refundEvidence ?? cancellationRefundEvidence,
      refusedEvidence: classification.deliveryEvidence?.refusedSnippet || classification.evidence.refusedSnippet || '',
      destroyedEvidence:
        classification.deliveryEvidence?.destroyedSnippet || classification.evidence.destroyedSnippet || '',
      blockedEvidence: classification.deliveryEvidence?.blockedSnippet || classification.evidence.blockedSnippet || '',
      deliveredEvidence: classification.deliveryEvidence?.deliveredSnippet || '',
      shippedEvidence: classification.deliveryEvidence?.shippedSnippet || '',
      originalOrderCancelledEvidence: classification.originalOrderEvidence?.cancelledSnippet || '',
      originalOrderDeliveredEvidence: classification.originalOrderEvidence?.deliveredSnippet || '',
      originalOrderEvidenceChecked: hasAfterSalesOriginalOrderCheck(item),
      deadline: formatOzonOrderDate(updatedRaw, '未返回'),
      updated: formatOzonOrderDate(updatedRaw, '未返回'),
      note: firstFilled(afterSalesReason, item.comment, item.message, item.status) || 'Ozon 已返回售后状态',
      products: products.length ? products : [{ name: '未返回', sku: '未返回', qty: 1, price: '未返回' }],
      timeline: [
        `售后状态：${status}`,
        `来源：${sourceLabel}`,
        `更新时间：${formatOzonOrderDate(updatedRaw, '未返回')}`,
      ],
      raw: item,
      source,
    },
    item
  );
}

export const OZON_ORDER_STATUS_RANK = {
  未知状态: 0,
  等待备货: 1,
  等待发货: 2,
  已经发货: 3,
  成功订单: 4,
  关闭订单: 4,
  售后订单: 4,
};

export function getOzonSalesOrderRowRawStatus(row = {}) {
  const raw = row.raw ?? {};
  return firstFilled(raw.status, raw.posting_status, raw.state, row.ozonRawStatus, row.rawStatus, row.status);
}

export function getOzonSalesOrderRowStatusRank(row = {}) {
  return OZON_ORDER_STATUS_RANK[getOzonOrderBaseStatusLabel(getOzonSalesOrderRowRawStatus(row))] ?? 0;
}

export function mergeOzonSalesOrderRows(previous, row) {
  if (!previous) return row;
  const statusSource = getOzonSalesOrderRowStatusRank(row) >= getOzonSalesOrderRowStatusRank(previous) ? row : previous;
  const merged = { ...previous, ...row };

  return {
    ...merged,
    status: statusSource.status ?? merged.status,
    statusTags: statusSource.statusTags ?? merged.statusTags,
    tone: statusSource.tone ?? merged.tone,
    raw: statusSource.raw ?? merged.raw,
    note: statusSource.note ?? merged.note,
    timeline: statusSource.timeline ?? merged.timeline,
    deadline: statusSource.deadline ?? merged.deadline,
    updated: statusSource.updated ?? merged.updated,
    realSource: statusSource.realSource ?? merged.realSource,
  };
}

export function getOzonOrderScopedRecordKey(row = {}) {
  const rowKey = firstFilled(row.recordKey, row.entityId);
  if (rowKey) return rowKey;
  const orderKey = firstFilled(row.id, row.posting, row.salesOrder, row.ozonOrderId, row.orderId);
  if (!orderKey) return '';
  const shopKey = firstFilled(
    row.shopClientId,
    row.clientId,
    row.shopId,
    row.shop,
    row.shopName,
    row.storeName,
    'unknown'
  );
  return `${shopKey}:${orderKey}`;
}

export function dedupeRowsById(rows) {
  return mergeOzonRowsByKeySafe(rows, getOzonOrderScopedRecordKey, mergeOzonSalesOrderRows);
}

export function mergeSalesOrderVisibleSupplement(order = {}, enhancedOrder = null) {
  if (!enhancedOrder) return order;
  return {
    ...order,
    products: enhancedOrder.products ?? order.products,
    commissionMode: enhancedOrder.commissionMode ?? order.commissionMode,
    commissionPercent: enhancedOrder.commissionPercent ?? order.commissionPercent,
    commissionAmount: enhancedOrder.commissionAmount ?? order.commissionAmount,
    commissionSource: enhancedOrder.commissionSource ?? order.commissionSource,
  };
}

export async function requestOzonPagedOffset(endpoint, shop, buildBody, options = {}) {
  const items = [];
  let total = null;
  const pageLimit = options.pageLimit || OZON_ORDER_PAGE_LIMIT;
  const requestedMaxPages = Math.floor(Number(options.maxPages) || 0);
  const maxPages = requestedMaxPages > 0 ? requestedMaxPages : OZON_ORDER_PAGINATION_SAFETY_MAX_PAGES;
  const requestedSyncMaxPages = Math.floor(Number(options.syncMaxPages) || 0);
  const syncMaxPages = requestedSyncMaxPages > 0 ? requestedSyncMaxPages : OZON_ORDER_PAGINATION_SAFETY_MAX_PAGES;
  const supportsSyncMetadata = [
    '/v3/posting/fbs/list',
    '/v3/posting/fbs/unfulfilled/list',
    '/v2/posting/fbo/list',
    '/v1/returns/list',
    '/v2/returns/rfbs/list',
    '/v2/returns/rfbs/get',
    '/v2/conditional-cancellation/list',
  ].includes(endpoint);

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageLimit;
    const body = buildBody({ offset, limit: pageLimit });
    if (body && typeof body === 'object') {
      if (options.autoSync === false && options.forceRefresh !== true) {
        body.autoSync = false;
      } else {
        body.autoSync = true;
        body.syncMaxPages = syncMaxPages;
      }
    }
    if (options.forceRefresh === true && body && typeof body === 'object') {
      if (page === 0) {
        body.forceRefresh = true;
      } else {
        body.autoSync = false;
      }
    }
    if (supportsSyncMetadata && body && typeof body === 'object') {
      if (options.recordNotifications === true) body.recordNotifications = true;
      if (options.schedulerProfile) body.schedulerProfile = options.schedulerProfile;
      if (options.profile) body.profile = options.profile;
      if (options.priority) body.priority = options.priority;
      if (options.syncSource) body.syncSource = options.syncSource;
      if (options.requestedBy) body.requestedBy = options.requestedBy;
    }
    const data = await requestOzonReadOnly(endpoint, shop, body, {
      signal: options.signal,
      timeoutMs: options.forceRefresh === true ? (options.forceRefreshTimeoutMs ?? 180_000) : options.timeoutMs,
      onSyncProgress: options.onSyncProgress,
      endpointLabel: options.endpointLabel,
      shopLabel: options.shopLabel,
      orderSyncTimeoutMs: options.orderSyncTimeoutMs,
      orderSyncPollIntervalMs: options.orderSyncPollIntervalMs,
    });
    const pageItems = getOzonPayloadItems(data);
    total = getOzonPayloadOptionalTotal(data) ?? total;
    const hasNext = getOzonPayloadHasNext(data);
    items.push(...pageItems);
    if (hasNext === false) break;
    if (pageItems.length < pageLimit) break;
    if (total !== null && items.length >= total) break;
  }

  return { items, total: total ?? items.length };
}

export async function requestOzonPagedOffsetVariants(endpoint, shop, variants = [], options = {}) {
  let lastError = null;
  for (const variant of variants) {
    try {
      return await requestOzonPagedOffset(endpoint, shop, variant.buildBody, {
        pageLimit: variant.pageLimit,
        maxPages: variant.maxPages,
        syncMaxPages: variant.syncMaxPages ?? options.syncMaxPages,
        autoSync: variant.autoSync ?? options.autoSync,
        forceRefresh: options.forceRefresh === true || variant.forceRefresh === true,
        forceRefreshTimeoutMs: options.forceRefreshTimeoutMs,
        timeoutMs: options.timeoutMs,
        signal: variant.signal || options.signal,
        onSyncProgress: variant.onSyncProgress || options.onSyncProgress,
        endpointLabel: variant.endpointLabel || options.endpointLabel,
        shopLabel: options.shopLabel,
        orderSyncTimeoutMs: options.orderSyncTimeoutMs,
        orderSyncPollIntervalMs: options.orderSyncPollIntervalMs,
        recordNotifications: variant.recordNotifications ?? options.recordNotifications,
        schedulerProfile: variant.schedulerProfile || options.schedulerProfile,
        profile: variant.profile || options.profile,
        priority: variant.priority || options.priority,
        syncSource: variant.syncSource || options.syncSource,
        requestedBy: variant.requestedBy || options.requestedBy,
      });
    } catch (error) {
      lastError = error;
      if (isLocalApiOrderTransportFailure(error)) break;
      if (!isOzonRetryableReadError(error)) break;
    }
  }
  throw lastError ?? new Error(`${endpoint} 请求失败`);
}

export function buildOzonPostingListReadVariants({ since, to, dir = 'DESC', filter, withFields, maxPages }) {
  const fullWithFields = withFields ?? { analytics_data: true, barcodes: true, financial_data: true, translit: true };
  const lightWithFields = { analytics_data: true, financial_data: true, translit: true };
  const basicWithFields = { translit: true };
  const safeFilter = filter ?? { since, to };

  return [
    {
      pageLimit: OZON_ORDER_PAGE_LIMIT,
      maxPages,
      buildBody: ({ offset, limit }) => ({ dir, filter: safeFilter, limit, offset, with: fullWithFields }),
    },
    {
      pageLimit: OZON_ORDER_FALLBACK_PAGE_LIMIT,
      maxPages,
      buildBody: ({ offset, limit }) => ({ dir, filter: safeFilter, limit, offset, with: fullWithFields }),
    },
    {
      pageLimit: OZON_ORDER_FALLBACK_PAGE_LIMIT,
      maxPages,
      buildBody: ({ offset, limit }) => ({ dir, filter: safeFilter, limit, offset, with: lightWithFields }),
    },
    {
      pageLimit: OZON_ORDER_FALLBACK_PAGE_LIMIT,
      maxPages,
      buildBody: ({ offset, limit }) => ({ dir, filter: safeFilter, limit, offset, with: basicWithFields }),
    },
  ];
}

export async function readOzonOrderEndpoint(label, reader) {
  try {
    return { ok: true, label, value: await reader() };
  } catch (error) {
    safeWarn(`${label} 读取失败`, error);
    return { ok: false, label, error };
  }
}

export function isLocalApiOrderTransportFailure(error = {}) {
  const code = String(error?.code || error?.payload?.error?.code || '').trim();
  const status = Number(error?.status) || 0;
  const text = [
    error?.message,
    error?.payload?.errorMessage,
    error?.payload?.error?.message,
    error?.cause?.message,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');

  if (code === 'LOCAL_API_TRANSPORT_FAILED' || code === 'LOCAL_API_TIMEOUT') return true;
  if (status !== 0) return false;
  return /(?:无法连接本地\s*API|local-api 请求超时|ECONNREFUSED|ECONNRESET|EPIPE|socket\s*hang\s*up|fetch\s*failed|network\s*error|connection\s*(?:refused|reset))/iu.test(
    text
  );
}

export async function runOzonOrderEndpointReadersSequentially(readers = []) {
  const results = [];
  for (const read of readers) {
    const result = await read();
    results.push(result);
    if (!result?.ok && isLocalApiOrderTransportFailure(result?.error)) break;
  }
  return results;
}

function getOrderSnapshotTransportFailure(result = {}) {
  if (result?.status === 'rejected') {
    return isLocalApiOrderTransportFailure(result.reason) ? result.reason : null;
  }
  const snapshot = result?.value;
  if (!snapshot?.ok) return isLocalApiOrderTransportFailure(snapshot?.error) ? snapshot.error : null;
  const endpointFailure = snapshot?.value?.errors?.find((item) =>
    isLocalApiOrderTransportFailure(item?.error)
  );
  return endpointFailure?.error || null;
}

function createOrderSyncProgressForwarder(options = {}, shop, endpointLabel) {
  if (typeof options.onSyncProgress !== 'function') return undefined;
  const shopLabel = getOzonShopLabel(shop);
  return (event = {}) => {
    options.onSyncProgress({
      ...event,
      endpointLabel: event.endpointLabel || endpointLabel,
      shopId: event.shopId || shop?.id || '',
      shopLabel: event.shopLabel || shopLabel,
    });
  };
}

export async function requestOzonSalesOrdersSnapshot(shop, options = {}) {
  const { since, to } = resolveOzonTimeRange(options.dateRange || options.timeScope || options);
  const withFields = { analytics_data: true, barcodes: true, financial_data: true, translit: true };
  const maxPages = options.maxPages;
  const createEndpointOptions = (endpointLabel) => ({
    signal: options.signal,
    forceRefresh: options.forceRefresh === true,
    forceRefreshTimeoutMs: options.forceRefreshTimeoutMs,
    onSyncProgress: createOrderSyncProgressForwarder(options, shop, endpointLabel),
    endpointLabel,
    shopLabel: getOzonShopLabel(shop),
    orderSyncTimeoutMs: options.orderSyncTimeoutMs,
    orderSyncPollIntervalMs: options.orderSyncPollIntervalMs,
    schedulerProfile: options.schedulerProfile || (options.forceRefresh === true ? 'foreground' : undefined),
    profile: options.profile || (options.forceRefresh === true ? 'foreground' : undefined),
    priority: options.priority || (options.forceRefresh === true ? 'P1' : undefined),
    syncSource: options.syncSource || (options.forceRefresh === true ? 'manual-order-refresh' : undefined),
    requestedBy: options.requestedBy || (options.forceRefresh === true ? 'frontend-orders-manual-refresh' : undefined),
  });
  const endpointResults = await runOzonOrderEndpointReadersSequentially([
    () => readOzonOrderEndpoint('FBS/rFBS 订单列表', () =>
      requestOzonPagedOffsetVariants(
        '/v3/posting/fbs/list',
        shop,
        buildOzonPostingListReadVariants({ since, to, dir: 'DESC', withFields, maxPages }),
        createEndpointOptions('FBS/rFBS 订单列表')
      )
    ),
    () => readOzonOrderEndpoint('待处理 FBS 订单', () =>
      requestOzonPagedOffsetVariants(
        '/v3/posting/fbs/unfulfilled/list',
        shop,
        buildOzonPostingListReadVariants({
          since,
          to,
          dir: 'ASC',
          filter: { cutoff_from: since, cutoff_to: to },
          withFields,
          maxPages,
        }),
        createEndpointOptions('待处理 FBS 订单')
      )
    ),
    () => readOzonOrderEndpoint('FBO 订单列表', () =>
      requestOzonPagedOffsetVariants(
        '/v2/posting/fbo/list',
        shop,
        [
          {
            pageLimit: OZON_ORDER_PAGE_LIMIT,
            maxPages,
            buildBody: ({ offset, limit }) => ({
              dir: 'DESC',
              filter: { since, to },
              limit,
              offset,
              translit: true,
              with: { analytics_data: true, financial_data: true },
            }),
          },
          {
            pageLimit: OZON_ORDER_FALLBACK_PAGE_LIMIT,
            maxPages,
            buildBody: ({ offset, limit }) => ({
              dir: 'DESC',
              filter: { since, to },
              limit,
              offset,
              translit: true,
            }),
          },
        ],
        createEndpointOptions('FBO 订单列表')
      )
    ),
  ]);
  const [fbsList, unfulfilledList, fboList] = endpointResults;

  const rows = dedupeRowsById([
    ...(fbsList?.ok ? fbsList.value.items.map((item) => normalizeOzonSalesOrderRow(item, { source: 'FBS', shop })) : []),
    ...(unfulfilledList?.ok
      ? unfulfilledList.value.items.map((item) => normalizeOzonSalesOrderRow(item, { source: 'FBS', shop }))
      : []),
    ...(fboList?.ok ? fboList.value.items.map((item) => normalizeOzonSalesOrderRow(item, { source: 'FBO', shop })) : []),
  ]);
  const shouldEnrichCrossBorder = options.enrichCrossBorder !== false;
  const crossBorderResult = shouldEnrichCrossBorder
    ? await enrichSalesRowsWithCrossBorderStatus(rows)
    : { rows, crossBorder: { enabled: false, total: 0, matched: 0 } };

  return {
    rows: crossBorderResult.rows,
    errors: endpointResults.filter((result) => result && !result.ok),
    crossBorder: crossBorderResult.crossBorder,
    fetchedAt: new Date().toISOString(),
  };
}

export async function enrichPurchaseRowsWithOzonImagesForShops(shops = [], rows = [], options = {}) {
  const readableShops = getOzonReadableShops(shops);
  if (!rows.length || !readableShops.length) return { rows: [], errors: [] };

  const results = await runIsolatedShopAsync(readableShops, (shop) => {
    const shopClientId = getOzonShopClientId(shop);
    const shopRows = rows.filter((row) => row.shopId === shop.id || row.shopClientId === shopClientId);
    return readOzonOrderEndpoint(`${getOzonShopLabel(shop)} 拍单商品图片`, () =>
      enrichSalesRowsWithOzonProductImages(shop, shopRows, options)
    );
  });

  return {
    rows: results.flatMap((result) =>
      result.status === 'fulfilled' && result.value?.ok ? (result.value.value ?? []) : []
    ),
    errors: results
      .map((result, index) => {
        if (result.status === 'rejected') {
          return { ok: false, label: getOzonShopLabel(readableShops[index]), error: result.reason };
        }
        return result.value && !result.value.ok ? result.value : null;
      })
      .filter(Boolean),
  };
}

export async function requestOzonSalesOrdersSnapshotForShops(shops = [], options = {}) {
  const readableShops = getOzonReadableShops(shops);
  if (!readableShops.length) {
    throw new Error('请先在设置里配置 Ozon 店铺 Client ID 和 API Key。');
  }

  const forceRefreshShopIds = Array.isArray(options.forceOrderRefreshShopIds)
    ? new Set(options.forceOrderRefreshShopIds.map((value) => String(value || '').trim()).filter(Boolean))
    : null;
  const snapshots = await runIsolatedShopAsync(
    readableShops,
    (shop) => {
      const shouldForceThisShop =
        options.forceRefresh === true &&
        (!forceRefreshShopIds || forceRefreshShopIds.has(String(shop?.id || '').trim()));
      return readOzonOrderEndpoint(getOzonShopLabel(shop), () =>
        requestOzonSalesOrdersSnapshot(shop, {
          ...options,
          forceRefresh: shouldForceThisShop,
          autoSync: forceRefreshShopIds ? shouldForceThisShop : options.autoSync,
        })
      );
    },
    {
      concurrency: options.shopConcurrency,
      getStopReason: getOrderSnapshotTransportFailure,
    }
  );
  const settledSnapshots = snapshots.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : { ok: false, label: getOzonShopLabel(readableShops[index]), error: result.reason }
  );
  const rows = settledSnapshots.flatMap((snapshot) => (snapshot.ok ? (snapshot.value.rows ?? []) : []));
  const errors = settledSnapshots.flatMap((snapshot) => {
    if (!snapshot.ok) return [snapshot];
    return snapshot.value.errors ?? [];
  });
  const transportFailure = errors
    .map((item) => item?.error || item)
    .find(isLocalApiOrderTransportFailure);
  const successfulShopCount = settledSnapshots.filter(
    (snapshot) =>
      snapshot.ok &&
      !(snapshot.value?.errors || []).some((item) => isLocalApiOrderTransportFailure(item?.error))
  ).length;
  if (transportFailure && successfulShopCount === 0) throw transportFailure;

  return {
    rows,
    errors,
    crossBorder: {
      enabled: settledSnapshots.some((snapshot) => snapshot.ok && snapshot.value.crossBorder?.enabled),
      total: settledSnapshots.reduce(
        (sum, snapshot) => sum + (snapshot.ok ? Number(snapshot.value.crossBorder?.total) || 0 : 0),
        0
      ),
      matched: settledSnapshots.reduce(
        (sum, snapshot) => sum + (snapshot.ok ? Number(snapshot.value.crossBorder?.matched) || 0 : 0),
        0
      ),
    },
    shops: readableShops.map((shop) => ({
      id: shop.id,
      clientId: getOzonShopClientId(shop),
      label: getOzonShopLabel(shop),
    })),
    fetchedAt: new Date().toISOString(),
  };
}

export { chunkValues };

export function getProfitOrderProductIds(products = []) {
  return [
    ...new Set(
      products
        .map((product) =>
          normalizeOzonId(firstFilled(product?.raw?.product_id, product?.raw?.productId, product?.productId)).trim()
        )
        .filter((value) => value && value !== '未返回' && Number.isFinite(Number(value)))
    ),
  ].map((value) => Number(value));
}

export function getProfitOrderOfferIds(products = []) {
  return [
    ...new Set(
      products
        .map((product) =>
          normalizeOzonId(firstFilled(product?.offerId, product?.raw?.offer_id, product?.raw?.offerId)).trim()
        )
        .filter((value) => value && value !== '未返回')
    ),
  ];
}

export async function requestOzonOrderPriceInfos(shop, orders = [], options = {}) {
  const products = orders.flatMap((order) => (Array.isArray(order.products) ? order.products : []));
  const productIds = getProfitOrderProductIds(products);
  const offerIds = getProfitOrderOfferIds(products);
  const results = [];

  for (const chunk of chunkValues(productIds, 100)) {
    if (!chunk.length) continue;
    const data = await requestOzonReadOnly(
      '/v5/product/info/prices',
      shop,
      {
        filter: { product_id: chunk },
        limit: 1000,
      },
      { signal: options.signal }
    );
    results.push(...getOzonPayloadItems(data));
  }

  for (const chunk of chunkValues(offerIds, 100)) {
    if (!chunk.length) continue;
    const data = await requestOzonReadOnly(
      '/v5/product/info/prices',
      shop,
      {
        filter: { offer_id: chunk },
        limit: 1000,
      },
      { signal: options.signal }
    );
    results.push(...getOzonPayloadItems(data));
  }

  return dedupeRowsById(
    results.map((item) => ({
      ...item,
      id: normalizeOzonId(firstFilled(item.product_id, item.id, item.offer_id, item.offerId, item.sku)),
    }))
  );
}

export function addProfitPriceMapKey(map, key, priceInfo) {
  const text = normalizeOzonId(key).trim();
  if (!text || text === '未返回') return;
  map.set(text, priceInfo);
}

export function buildProfitPriceInfoMap(priceInfos = []) {
  const map = new Map();
  priceInfos.forEach((priceInfo) => {
    addProfitPriceMapKey(map, priceInfo.product_id, priceInfo);
    addProfitPriceMapKey(map, priceInfo.id, priceInfo);
    addProfitPriceMapKey(map, priceInfo.offer_id, priceInfo);
    addProfitPriceMapKey(map, priceInfo.offerId, priceInfo);
    addProfitPriceMapKey(map, priceInfo.sku, priceInfo);
  });
  return map;
}
