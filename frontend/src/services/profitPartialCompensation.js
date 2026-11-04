import { convertFeeAmountToCny } from './feeCalculationService.js';
import { getFinanceOperationAmount, getProfitFinanceEvidenceSummary } from './profitFinanceBreakdown.js';

const text = value => String(value ?? '').trim();

export function isPartialCompensationSale(value = {}) {
  const snapshot = value.orderSnapshot ?? {};
  if (!(value.partialCompensationOnly === true || snapshot.partialCompensationOnly === true)) return false;
  if (value.hasFinanceRefund === true || snapshot.hasFinanceRefund === true) return false;
  if (value.fullRefundCompleted === true || snapshot.fullRefundCompleted === true) return false;
  const lifecycle = [value.status, value.rawStatus, value.rawSubstatus, value.raw?.status,
    snapshot.status, snapshot.rawStatus, snapshot.rawSubstatus].map(text).join(' ').toLowerCase();
  return !/cancel|canceled|cancelled|关闭|取消|拒收|refus|not_accepted|money[_-]?returned|\brefunded\b|已全额退款|已退款/.test(lifecycle);
}

export function readPartialCompensationEvidence(operations = [], { rubToCnyRate } = {}) {
  const summary = getProfitFinanceEvidenceSummary(operations);
  const seen = new Set(); let count = 0, net = 0, unresolved = false;
  for (const operation of operations) {
    const type = text(operation.operation_type ?? operation.operationType ?? operation.raw?.operation_type).toLowerCase();
    if (type !== 'operationmarketplaceservicepartialcompensationtoclient') continue;
    const id = text(operation.operation_id ?? operation.operationId ?? operation.raw?.operation_id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    count++;
    const amount = getFinanceOperationAmount(operation);
    const currency = operation.currency_code || operation.currencyCode || operation.raw?.currency_code || 'RUB';
    const converted = amount == null ? null : convertFeeAmountToCny(amount, currency, { rubToCnyRate });
    if (converted == null || !Number.isFinite(converted)) unresolved = true;
    else net += converted;
  }
  return { operationCount: count, operationIds: [...seen], amountCny: unresolved ? null : Math.max(0, -net),
    partialOnly: count > 0 && summary.hasDeliveredSaleOperation && !summary.hasRefundDeductionOperation };
}

// Merge missing business context before calculating, not after calculating
// fees with one state and then zeroing revenue with a different cached state.
export function prepareProfitCalculationOrder(order = {}, cached = null) {
  const snapshot = cached?.orderSnapshot;
  if (!snapshot || (order.shopId && cached.shopId && order.shopId !== cached.shopId)) return order;
  if (order.shopClientId && cached.shopClientId && order.shopClientId !== cached.shopClientId) return order;
  const posting = text(order.posting || order.raw?.posting_number);
  const cachedPosting = text(snapshot.posting || snapshot.id);
  if (posting && cachedPosting && posting !== cachedPosting) return order;
  const changedAfterSalesState = text(order.afterSalesStatus) && text(order.afterSalesStatus) !== text(snapshot.afterSalesStatus);
  return { ...order, profitLedger: cached,
    afterSalesStatus: text(order.afterSalesStatus) || snapshot.afterSalesStatus || '',
    hasAfterSalesRefund: order.hasAfterSalesRefund === true || (!changedAfterSalesState && snapshot.hasAfterSalesRefund === true),
    hasFinanceRefund: order.hasFinanceRefund === true || snapshot.hasFinanceRefund === true,
    partialCompensationOnly: order.partialCompensationOnly === true || snapshot.partialCompensationOnly === true,
  };
}
