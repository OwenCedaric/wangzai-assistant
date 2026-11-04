import { isVerifiedEmptyFinanceReceipt } from './profitEmptyFinanceEvidence.js';
// These are inputs supplied by Ozon finance, not calculation rules. A missing
// read context must never be treated as an authoritative empty transaction list.
export const PROFIT_FINANCE_READBACK_FIELDS = Object.freeze([
  'actualSalesAmountCny', 'actualCommissionFeeCny', 'actualPenaltyFeeCny',
  'actualAcquiringFeeCny', 'actualDeliveryServiceFeeCny', 'actualLogisticsFeeCny',
  'actualOzonFeeCny', 'platformNetCny', 'refundOrderDeductionFeeCny',
  'buyerCompensationCny',
]);

export function protectProfitLedgerFinanceInputs(cached, fresh, { financeReadbackComplete = false, verifiedEmptyReceipt } = {}) {
  if (!fresh) return fresh;
  const oldBus = cached?.amounts?.actualCrossBorderBusFeeCny;
  const newBus = fresh.amounts?.actualCrossBorderBusFeeCny;
  // A settings estimate is not new cash-ledger evidence. Never re-add a fixed
  // 1.2 fee over a confirmed no-charge result while inputs are still loading.
  if (oldBus?.status === 'ready' && newBus?.source === 'cross-border-bus-settings'
    && (!financeReadbackComplete || ['cross-border-no-forecast', 'cross-border-final-no-exact-charge'].includes(oldBus.source))) {
    fresh = { ...fresh, amounts: { ...fresh.amounts, actualCrossBorderBusFeeCny: oldBus } };
  }
  if (financeReadbackComplete && fresh.financeLookupChecked === true && fresh.financeOperationCount > 0) {
    return { ...fresh, financeReadbackState: 'complete', financeEmptyReceipt: null };
  }
  if (financeReadbackComplete && fresh.financeLookupChecked === true && fresh.financeOperationCount === 0
    && fresh.actualFinanceStatus === 'confirmed' && isVerifiedEmptyFinanceReceipt(verifiedEmptyReceipt, fresh)) {
    return { ...fresh, financeReadbackState: 'empty-confirmed', financeEmptyReceipt: verifiedEmptyReceipt };
  }
  if (!cached?.amounts) return fresh;
  const amounts = { ...fresh.amounts };
  for (const field of PROFIT_FINANCE_READBACK_FIELDS) {
    if (cached.amounts[field] !== undefined) amounts[field] = cached.amounts[field];
    else delete amounts[field];
  }
  return {
    ...fresh,
    amounts,
    // Keep the provenance together with the retained inputs. Local purchase,
    // product, estimated fee and cross-border inputs may still update normally.
    actualFinanceStatus: cached.actualFinanceStatus,
    hasActualFinance: cached.hasActualFinance,
    financeLookupChecked: cached.financeLookupChecked,
    financeOperationCount: cached.financeOperationCount,
    profitFinanceVersion: cached.profitFinanceVersion,
    financeReadbackState: 'retained',
    financeEmptyReceipt: cached.financeEmptyReceipt ?? null,
    actualExchangeRate: cached.actualExchangeRate ?? cached.exchangeRates?.actual,
    exchangeRates: { ...fresh.exchangeRates, actual: cached.exchangeRates?.actual ?? cached.actualExchangeRate },
    orderSnapshot: { ...fresh.orderSnapshot, hasFinanceRefund: cached.orderSnapshot?.hasFinanceRefund === true,
      partialCompensationOnly: cached.orderSnapshot?.partialCompensationOnly === true },
  };
}
