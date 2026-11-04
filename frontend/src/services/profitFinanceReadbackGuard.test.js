import { describe, expect, it } from 'vitest';
import { protectProfitLedgerFinanceInputs, PROFIT_FINANCE_READBACK_FIELDS } from './profitFinanceReadbackGuard.js';
import { mergeProfitLedgerRows } from './profitLedgerService.js';
import { compactProfitLedgerSnapshotForPersistence } from './profitLedgerPersistenceCompaction.js';
import { shouldHydrateCachedProfitFinanceOrder } from './profitFinanceHydrationRules.js';

const amount = (value) => ({ value, status: 'ready', source: 'ozon-finance-detail' });
const ledger = (overrides = {}) => ({
  ledgerKey: 'future-shop:98765432-0001-1', shopId: 'future-shop',
  calculationVersion: 'profit-ledger-v16-per-order-finance-exchange-rate',
  actualFinanceStatus: 'confirmed', hasActualFinance: true, financeLookupChecked: true, financeOperationCount: 6,
  orderSnapshot: { posting: '98765432-0001-1', shopId: 'future-shop', status: '成功订单', hasFinanceRefund: true },
  amounts: { ...Object.fromEntries(PROFIT_FINANCE_READBACK_FIELDS.map(k => [k, amount(0)])),
    actualAcquiringFeeCny: amount(2), sourcePurchaseCostCny: amount(3), actualCrossBorderBusFeeCny: amount(1),
    salesAmountCny: amount(24), estimatedCommissionFeeCny: amount(1), estimatedAcquiringFeeCny: amount(1),
    estimatedDeliveryServiceFeeCny: amount(1), estimatedCrossBorderBusFeeCny: amount(1), logisticsFeeCny: amount(1) },
  exchangeRates: { actual: { rubToCnyRate: 0.09 } }, results: {}, ...overrides,
});

describe('finance readback input boundary (no formula changes)', () => {
  it('keeps refunds and fees when context is absent, but allows a new purchase cost to recalculate profit', () => {
    const cached = ledger();
    const fresh = ledger({ financeOperationCount: 0, actualFinanceStatus: 'pending',
      orderSnapshot: { ...cached.orderSnapshot, hasFinanceRefund: false },
      amounts: { ...cached.amounts, actualSalesAmountCny: amount(24), actualAcquiringFeeCny: amount(0), sourcePurchaseCostCny: amount(5) } });
    const protectedRow = protectProfitLedgerFinanceInputs(cached, fresh);
    const merged = mergeProfitLedgerRows([cached], [protectedRow])[0];
    expect(merged.orderSnapshot.hasFinanceRefund).toBe(true);
    expect(merged.amounts.actualSalesAmountCny.value).toBe(0);
    expect(merged.amounts.actualAcquiringFeeCny.value).toBe(2);
    expect(merged.amounts.sourcePurchaseCostCny.value).toBe(5);
    expect(merged.results.actualProfitCny.value).toBe(-8);
    expect(protectedRow.financeReadbackState).toBe('retained');
  });
  it('accepts a genuinely complete new finance read, including legal zero or refund reversal', () => {
    const cached = ledger();
    const fresh = ledger({ orderSnapshot: { ...cached.orderSnapshot, hasFinanceRefund: false },
      amounts: { ...cached.amounts, actualSalesAmountCny: amount(24), actualAcquiringFeeCny: amount(0) } });
    const result = protectProfitLedgerFinanceInputs(cached, fresh, { financeReadbackComplete: true });
    expect(result.amounts.actualAcquiringFeeCny.value).toBe(0);
    expect(result.orderSnapshot.hasFinanceRefund).toBe(false);
    expect(result.financeReadbackState).toBe('complete');
  });
  it('does not turn a partial or unchecked read into complete evidence', () => {
    const cached = ledger();
    for (const partial of [{ financeLookupChecked: false }, { financeOperationCount: 0 }]) {
      const result = protectProfitLedgerFinanceInputs(cached, ledger(partial), { financeReadbackComplete: true });
      expect(result.financeReadbackState).toBe('retained');
      expect(result.amounts).toMatchObject(cached.amounts);
    }
  });
  it('keeps old actual rate while permitting estimated inputs to update, without mutating either row', () => {
    const cached = ledger(), fresh = ledger({ exchangeRates: { actual: { rubToCnyRate: 0.11 }, estimated: { rubToCnyRate: 0.12 } } });
    const before = JSON.stringify([cached, fresh]);
    const result = protectProfitLedgerFinanceInputs(cached, fresh);
    expect(result.exchangeRates.actual.rubToCnyRate).toBe(0.09);
    expect(result.exchangeRates.estimated.rubToCnyRate).toBe(0.12);
    expect(JSON.stringify([cached, fresh])).toBe(before);
  });
  it('does not borrow evidence for a new order and retains read provenance through compact storage', () => {
    const fresh = ledger();
    expect(protectProfitLedgerFinanceInputs(null, fresh)).toBe(fresh);
    const protectedRow = protectProfitLedgerFinanceInputs(ledger(), fresh);
    const compact = compactProfitLedgerSnapshotForPersistence({ rows: [protectedRow] });
    expect(compact.rows[0].financeReadbackState).toBe('retained');
  });
  it('background-verifies even previously confirmed cached rows when the page requests revalidation', () => {
    expect(shouldHydrateCachedProfitFinanceOrder({ profitLedger: ledger() })).toBe(false);
    expect(shouldHydrateCachedProfitFinanceOrder({ profitLedger: ledger() }, { revalidateConfirmed: true })).toBe(true);
  });
});
