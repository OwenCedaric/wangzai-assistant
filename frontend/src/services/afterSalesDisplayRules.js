import { isSplitParentBusinessLocked, shouldShowOrderInOzonDisplayList } from './orderSplitRelationRules';

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatusText(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return [value.state, value.status, value.name, value.title, value.state_name, value.stateName]
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return value == null ? '' : String(value).trim();
}

function joinStatusText(values = []) {
  return values.map(normalizeStatusText).filter(Boolean).join(' ').toLowerCase();
}

export function getAfterSalesPendingRemovalReason(order = {}) {
  if (!isPlainObject(order)) return 'invalid';

  const raw = isPlainObject(order.raw) ? order.raw : {};
  const refund = [order.refund, raw.refund, raw.refund_info, raw.refundInfo].find(isPlainObject) || {};
  const state = [order.state, raw.state].find(isPlainObject) || {};
  const originalOrder = [
    order.originalOrder,
    order.originalOrderDetail,
    raw.originalOrder,
    raw.originalOrderDetail,
  ].find(isPlainObject) || {};
  const financeEvidence = [order.financeRefundEvidence, raw.financeRefundEvidence].find(isPlainObject) || {};
  const refundEvidence = [order.refundEvidence, raw.refundEvidence, raw.refund_evidence].find(isPlainObject) || {};

  const refundStatusValues = [
    order.refundStatus,
    order.refund_status,
    order.refundStatusText,
    order.refund_status_text,
    raw.refundStatus,
    raw.refund_status,
    raw.refundStatusName,
    raw.refund_status_name,
    refund.status,
    refund.state,
    refund.refund_status,
    refund.refundStatus,
    refund.money_return_state,
    refund.moneyReturnState,
    refund.money_return_state_name,
    refund.moneyReturnStateName,
    state.money_return_state,
    state.moneyReturnState,
    state.money_return_state_name,
    state.moneyReturnStateName,
    state.state,
    state.state_name,
    state.stateName,
    refundEvidence.status,
  ];
  const refundStatusText = joinStatusText(refundStatusValues);
  const afterSalesLifecycleText = joinStatusText([
    order.afterSalesStatus,
    order.after_sales_status,
    order.requestStatus,
    order.request_status,
    order.returnStatus,
    order.return_status,
    raw.afterSalesStatus,
    raw.after_sales_status,
    raw.requestStatus,
    raw.request_status,
    raw.returnStatus,
    raw.return_status,
    raw.status,
    raw.state,
    state,
  ]);
  const partialRefund = /(partial|partially|частич|部分退款|部分补偿)/iu.test(refundStatusText);
  const originalOrderLifecycleText = joinStatusText([
    order.originalOrderStatus,
    order.original_order_status,
    order.originalStatus,
    order.originalOrderSubstatus,
    order.original_order_substatus,
    order.originalSubstatus,
    raw.originalOrderStatus,
    raw.original_order_status,
    raw.originalStatus,
    raw.originalOrderSubstatus,
    raw.original_order_substatus,
    raw.originalSubstatus,
    originalOrder.status,
    originalOrder.substatus,
    originalOrder.delivery_status,
    originalOrder.deliveryStatus,
    originalOrder.posting_status,
    originalOrder.postingStatus,
  ]);
  const originalOrderDelivered = /(^|\s|[_-])(delivered|posting[_-]?received|received)($|\s|[_-])|已签收|已送达|签收完成|доставлен|получен/iu.test(
    originalOrderLifecycleText
  );
  const partialCompensationCompleted = /(^|\s|[_-])partial[_-]?compensation[_-]?returned(?:[_-]?by[_-]?ozon)?($|\s|[_-])|部分补偿(?:已)?完成|已部分补偿|已向买家部分补偿|компенсировали\s+покупателю/iu.test(
    afterSalesLifecycleText
  );
  if (originalOrderDelivered && partialCompensationCompleted) return 'partial-compensation-completed';

  const explicitlyRefunded = refundStatusValues.some((value) => {
    const normalized = normalizeStatusText(value).trim().toLowerCase();
    if (!normalized) return false;
    return /^(?:moneyreturned|refunded|fully[_\s-]*refunded|full[_\s-]*refund(?:[_\s-]*(?:completed|complete|succeeded|success))?|refund[_\s-]*(?:completed|complete|succeeded|success)|已退款|已退款给买家|已全额退款|全额退款完成|退款完成|деньги\s+возвращены)$/iu.test(
      normalized
    );
  });
  const refundClosed = Boolean(
    order.refundClosed ||
      order.refund_closed ||
      refund.closed ||
      refund.is_closed ||
      refund.isClosed ||
      /(refund.{0,20}(closed|cancelled|canceled)|退款.{0,8}(关闭|取消)|已关闭退款|закрыт.{0,20}возврат|возврат.{0,20}закрыт)/iu.test(
        refundStatusText
      ) ||
      /^(closed|cancelled|canceled|закрыт)$/iu.test(refundStatusText) ||
      /^(closed|закрыт)$/iu.test(afterSalesLifecycleText)
  );
  if (refundClosed) return 'refund-closed';

  const fullRefundCompleted = Boolean(
    order.fullRefundCompleted ||
      order.full_refund_completed ||
      refund.full_refund_completed ||
      refund.fullRefundCompleted ||
      (!partialRefund &&
        (explicitlyRefunded ||
          order.financeRefundConfirmed ||
          raw.financeRefundConfirmed ||
          financeEvidence.confirmed ||
          refundEvidence.confirmed ||
          /(moneyreturned|fully.{0,8}refunded|full.{0,8}refund|refund.{0,8}(completed|complete|succeeded|success)|已全额退款|全额退款完成|退款完成|已退款给买家|деньги\s+возвращены)/iu.test(
            refundStatusText
          )))
  );
  if (fullRefundCompleted) return 'full-refund-completed';

  const explicitlyIncomplete = /(not[_\s-]*(completed|complete)|incomplete|pending|processing|未完成|待处理|处理中)/iu.test(
    afterSalesLifecycleText
  );
  const orderCompleted = Boolean(
    !explicitlyIncomplete &&
      (order.afterSalesCompleted ||
        order.after_sales_completed ||
        order.requestCompleted ||
        order.request_completed ||
        raw.afterSalesCompleted ||
        raw.after_sales_completed ||
        /(^|\s|[_-])(order[_-]?)?(completed|complete|finished|done)($|\s|[_-])|订单完成|售后完成|处理完成|已完成|заверш/iu.test(
          afterSalesLifecycleText
        ))
  );
  return orderCompleted ? 'order-completed' : '';
}

export function shouldShowAfterSalesOrderInPendingList(order = {}, options = {}) {
  return shouldShowAfterSalesOrderInList(order, options) && !getAfterSalesPendingRemovalReason(order);
}

export function shouldShowAfterSalesOrderInList(order = {}, options = {}) {
  if (!isPlainObject(order)) return false;
  if (order.excludeFromAfterSales === true) return false;
  return shouldShowOrderInOzonDisplayList(order, options);
}

export function getAfterSalesFulfillment(order = {}) {
  if (!isPlainObject(order)) return '';

  const sourceText = [
    order.fulfillment,
    order.deliverySchema,
    order.raw?.fulfillment,
    order.raw?.delivery_schema,
    order.raw?.deliverySchema,
    order.raw?.posting?.delivery_schema,
    order.source,
    order.channel,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  if (sourceText.includes('RFBS') || sourceText.includes('REALFBS')) return 'rFBS';
  if (sourceText.includes('FBO')) return 'FBO';
  if (sourceText.includes('FBS')) return 'FBS';
  return '';
}

export function canOperateAfterSalesOrder(order = {}) {
  if (!isPlainObject(order)) return false;
  return !isSplitParentBusinessLocked(order);
}
