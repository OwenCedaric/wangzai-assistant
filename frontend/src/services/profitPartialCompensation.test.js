import { describe, expect, it } from 'vitest';
import { readPartialCompensationEvidence, prepareProfitCalculationOrder } from './profitPartialCompensation.js';
import { normalizeOzonProfitOrder, createProfitOrderFromLedgerRow, isProfitLedgerUsableForOrder, getProfitLedgerActualFees } from '../entities/profit/profitDisplayRules.jsx';
import { buildLocalProfitFinanceHydrationContext } from '../entities/profit/profitAfterSalesRules.jsx';
import { mergeProfitLedgerRows, migrateProfitLedgerRowToCurrentVersion, PROFIT_LEDGER_CALCULATION_VERSION } from './profitLedgerService.js';
import { protectProfitLedgerFinanceInputs } from './profitFinanceReadbackGuard.js';
import { rebuildProfitLedgerForFinalZeroActualSales } from '../entities/profit/profitLedgerMapping.jsx';
import { compactProfitLedgerSnapshotForPersistence } from './profitLedgerPersistenceCompaction.js';
import { getCanonicalPurchaseOrderOverrideKey, normalizeOzonSalesRowToPurchaseOrder } from './purchaseOrderRuntime.js';
const order = { id: '98765432-0001-1', posting: '98765432-0001-1', shopId: 'shop-1', shopClientId: '10001',
  recordKey: '10001:98765432-0001-1',
  status: '成功订单', afterSalesStatus: '签收后退款', hasAfterSalesRefund: true,
  currencyCode: 'CNY', amountValue: 100, sourcePurchaseCostCny: 10,
  actualCrossBorderBusFeeCny: 0, actualCrossBorderBusFeeSource: 'cross-border-charge-exact',
  products: [{ offerId: 'a', skuId: 'a', qty: 1, salesAmountValue: 100, commissionPercent: 5, currencyCode: 'CNY' }] };
const rate = { rubToCnyRate: 1, mode: 'daily', source: 'test', requestedDate: '2026-09-04' };
const operation = (id, type, amount, extra = {}) => ({ operation_id: id, posting_number: order.posting,
  operation_type: type, operation_date: '2026-09-04', currency_code: 'CNY', amount, ...extra });
const sale = operation('sale', 'OperationAgentDeliveredToCustomer', 95, { accruals_for_sale: 100, sale_commission: -5 });
const compensation = operation('compensation', 'OperationMarketplaceServicePartialCompensationToClient', -20);
function calculate(input = order, operations = [sale, compensation], cached = null) {
  const prepared = prepareProfitCalculationOrder(input, cached);
  const context = buildLocalProfitFinanceHydrationContext([prepared], operations);
  const bus = input.actualCrossBorderBusFeeCny ?? cached?.amounts?.actualCrossBorderBusFeeCny?.value ?? 0;
  const overrideKey = getCanonicalPurchaseOrderOverrideKey(normalizeOzonSalesRowToPurchaseOrder(prepared));
  expect(overrideKey).toBe(`${order.shopClientId}:${order.posting}`);
  const busContext = { purchaseLocalOverrides: { [overrideKey]: { shopId: order.shopId, orderKey: overrideKey,
    actualCrossBorderBusFeeCny: bus, actualCrossBorderBusFeeSource: 'cross-border-charge-exact' } } };
  const fresh = normalizeOzonProfitOrder(prepared, { ...context, ...busContext,
    exchangeRates: { actual: rate, estimated: rate }, actualExchangeRate: rate, estimatedExchangeRate: rate }).profitLedger;
  const protectedRow = protectProfitLedgerFinanceInputs(cached, fresh, { financeReadbackComplete: operations.length > 0 });
  const merged = cached ? mergeProfitLedgerRows([cached], [protectedRow], { keepUnseenCached: false })[0] : protectedRow;
  return rebuildProfitLedgerForFinalZeroActualSales(prepared, merged);
}

describe('user-approved partial compensation net income', () => {
  it('keeps 80 of a 100 sale after 20 compensation, then deducts the existing costs and fees', () => {
    const row = calculate();
    expect(row.amounts.buyerCompensationCny.value).toBe(20);
    expect(row.amounts.actualSalesAmountCny.value).toBe(80);
    expect(row.amounts.actualOzonFeeCny.value).toBe(5);
    expect(row.results.actualProfitCny.value).toBe(65);
    expect(row.orderSnapshot.partialCompensationOnly).toBe(true);
    expect(getProfitLedgerActualFees(row).some(row => row.label === '买家补偿（已扣）')).toBe(true);
  });
  it('does not deduct compensation again after merge, compact storage, migration and page reopening', () => {
    let row = calculate();
    for (let index = 0; index < 3; index++) {
      row = compactProfitLedgerSnapshotForPersistence({ rows: [row] }).rows[0];
      row = migrateProfitLedgerRowToCurrentVersion(row);
      const reopened = createProfitOrderFromLedgerRow(row);
      expect(isProfitLedgerUsableForOrder(reopened, row)).toBe(true);
      row = calculate(reopened, [sale, compensation], row);
      expect(row.results.actualProfitCny.value).toBe(65);
      expect(row.amounts.actualSalesAmountCny.value).toBe(80);
    }
  });
  it('does not clear a real bus charge just because a partial compensation has an after-sales label', () => {
    const row = calculate({ ...order, actualCrossBorderBusFeeCny: 1.13 });
    expect(row.amounts.actualCrossBorderBusFeeCny.value).toBe(1.13);
    expect(row.results.actualProfitCny.value).toBeCloseTo(63.87);
  });
  it('retains verified compensation on a cache miss while allowing cost changes', () => {
    const cached = calculate();
    const row = calculate({ ...createProfitOrderFromLedgerRow(cached), sourcePurchaseCostCny: 15 }, [], cached);
    expect(row.amounts.buyerCompensationCny.value).toBe(20);
    expect(row.results.actualProfitCny.value).toBe(60);
  });
  it('deduplicates operation IDs and respects a real reversal instead of charging twice', () => {
    expect(readPartialCompensationEvidence([sale, compensation, { ...compensation }]).amountCny).toBe(20);
    const reversal = operation('reversal', compensation.operation_type, 20);
    expect(calculate(order, [sale, compensation, reversal]).results.actualProfitCny.value).toBe(85);
  });
  it('does not keep partial-sale income after a full financial refund or order cancellation', () => {
    const refund = operation('refund', 'ClientReturnAgentOperation', -100, { accruals_for_sale: -100, sale_commission: 5 });
    const full = calculate(order, [sale, compensation, refund]);
    expect(full.orderSnapshot.partialCompensationOnly).toBe(false);
    expect(full.amounts.actualSalesAmountCny.value).toBe(0);
    const cancelled = calculate({ ...order, status: 'cancelled' });
    expect(cancelled.orderSnapshot.partialCompensationOnly).toBe(false);
    expect(cancelled.amounts.actualSalesAmountCny.value).toBe(0);
  });
  it('does not invent zero compensation when the amount or conversion is unavailable', () => {
    expect(readPartialCompensationEvidence([sale, { ...compensation, currency_code: 'RUB' }]).amountCny).toBeNull();
    expect(readPartialCompensationEvidence([sale, { ...compensation, amount: null }]).amountCny).toBeNull();
  });
  it('prepares the same cached business context before calculation and never borrows another order', () => {
    const cached = calculate();
    const raw = { ...order }; delete raw.afterSalesStatus; delete raw.hasAfterSalesRefund;
    expect(prepareProfitCalculationOrder(raw, cached).afterSalesStatus).toBe('签收后退款');
    const other = { ...raw, posting: '98765432-0002-1' };
    expect(prepareProfitCalculationOrder(other, cached)).toBe(other);
    expect(prepareProfitCalculationOrder({ ...raw, shopId: 'other' }, cached).profitLedger).toBeUndefined();
  });
  it('migrates the previous v16 without clearing or recomputing confirmed financial values', () => {
    const old = { ...calculate(), calculationVersion: 'profit-ledger-v16-per-order-finance-exchange-rate' };
    const migrated = migrateProfitLedgerRowToCurrentVersion(old);
    expect(migrated.calculationVersion).toBe(PROFIT_LEDGER_CALCULATION_VERSION);
    expect(migrated.amounts).toEqual(old.amounts);
    expect(migrated.results).toEqual(old.results);
  });
});
