import { attachSplitRelationFields, getSplitOrderLockReason } from '../../services/orderSplitRelationRules';
import { firstFilled } from './orderIdentityRules.jsx';

export function getOzonOriginalOrderRaw(order = {}) {
  if (!order || typeof order !== 'object') return {};
  return order.raw?.result?.posting || order.raw?.result || order.raw || order.result?.posting || order.result || order;
}

function isUsefulAfterSalesReasonText(value) {
  const text = String(value ?? '').trim();
  return Boolean(text && text !== '未返回' && text !== '待确认' && text !== '读取失败' && text !== '[object Object]');
}

function preferOriginalCancellationReason(currentValue, cancellationReason) {
  return isUsefulAfterSalesReasonText(currentValue) ? currentValue : cancellationReason || currentValue;
}

export function mergeAfterSalesOriginalOrderEvidence(raw = {}, originalOrder = null) {
  if (!originalOrder || typeof originalOrder !== 'object') return raw;
  const originalRaw = getOzonOriginalOrderRaw(originalOrder);
  const cancellation = originalRaw.cancellation || originalOrder.raw?.cancellation || {};
  const cancellationReason = firstFilled(
    cancellation.cancel_reason,
    cancellation.cancelReason,
    cancellation.cancel_reason_name,
    cancellation.cancelReasonName,
    cancellation.cancel_reason_message,
    cancellation.cancelReasonMessage,
    cancellation.reason,
    cancellation.reason_name,
    originalOrder.cancel_reason,
    originalOrder.cancelReason,
    originalOrder.cancellation_reason,
    originalOrder.cancellationReason
  );
  const splitFields = attachSplitRelationFields({}, originalOrder);
  return {
    ...raw,
    ...splitFields,
    originalOrder,
    originalOrderSplitRole: splitFields.splitRole || '',
    originalOrderSplitLockReason: splitFields.splitLockReason || getSplitOrderLockReason(originalOrder),
    originalOrderStatus: firstFilled(
      originalRaw.status,
      originalRaw.substatus,
      originalOrder.raw?.status,
      originalOrder.status
    ),
    originalOrderSubstatus: firstFilled(originalRaw.substatus, originalOrder.raw?.substatus, originalOrder.substatus),
    originalOrderDeliveredAt: firstFilled(originalRaw.delivered_at, originalRaw.deliveredAt),
    originalOrderEvidenceChecked: true,
    originalOrderCancelledAfterShip: firstFilled(
      cancellation.cancelled_after_ship,
      cancellation.cancelledAfterShip,
      originalOrder.cancelled_after_ship,
      originalOrder.cancelledAfterShip
    ),
    reason: preferOriginalCancellationReason(raw.reason, cancellationReason),
    return_reason: preferOriginalCancellationReason(raw.return_reason, cancellationReason),
    refund_reason: preferOriginalCancellationReason(raw.refund_reason, cancellationReason),
    cancel_reason: preferOriginalCancellationReason(raw.cancel_reason, cancellationReason),
    cancellation_reason: preferOriginalCancellationReason(raw.cancellation_reason, cancellationReason),
    originalOrderCancellationReason: cancellationReason,
    originalOrderCancellation: cancellation,
  };
}
