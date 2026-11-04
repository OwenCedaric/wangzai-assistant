import { describe, expect, it } from 'vitest';

import {
  hasPendingProfitCommissionOrLogistics,
  shouldHydrateCachedProfitFinanceOrder,
} from './profitFinanceHydrationRules.js';

function createLedger(overrides = {}) {
  return {
    financeLookupChecked: true,
    financeOperationCount: 4,
    actualFinanceStatus: 'confirmed',
    amounts: {
      actualCommissionFeeCny: { value: 4.32, status: 'ready' },
      actualLogisticsFeeCny: { value: 18.6, status: 'ready' },
    },
    ...overrides,
  };
}

describe('profit finance local hydration rules', () => {
  it('reopens a confirmed cached order when actual commission is still pending', () => {
    const ledger = createLedger({
      amounts: {
        actualCommissionFeeCny: { value: null, status: 'pending', source: 'ozon-finance-detail' },
        actualLogisticsFeeCny: { value: 20.8741, status: 'ready', source: 'ozon-finance-detail' },
      },
    });

    expect(hasPendingProfitCommissionOrLogistics(ledger)).toBe(true);
    expect(shouldHydrateCachedProfitFinanceOrder({ profitLedger: ledger })).toBe(true);
  });

  it('reopens a confirmed cached order when actual logistics is still pending', () => {
    const ledger = createLedger({
      amounts: {
        actualCommissionFeeCny: { value: 3.75, status: 'ready' },
        actualLogisticsFeeCny: { value: null, status: 'pending' },
      },
    });

    expect(shouldHydrateCachedProfitFinanceOrder({ profitLedger: ledger })).toBe(true);
  });

  it('does not reread a fully resolved confirmed cached order', () => {
    expect(shouldHydrateCachedProfitFinanceOrder({ profitLedger: createLedger() })).toBe(false);
  });

  it('accepts evidenced provisional zero values but rejects pending zero placeholders', () => {
    const provisional = createLedger({
      actualFinanceStatus: 'provisional',
      amounts: {
        actualCommissionFeeCny: { value: 0, status: 'provisional' },
        actualLogisticsFeeCny: { value: 0, status: 'provisional' },
      },
    });
    const pendingZero = createLedger({
      amounts: {
        actualCommissionFeeCny: { value: 0, status: 'pending' },
        actualLogisticsFeeCny: { value: 0, status: 'ready' },
      },
    });

    expect(shouldHydrateCachedProfitFinanceOrder({ profitLedger: provisional })).toBe(false);
    expect(shouldHydrateCachedProfitFinanceOrder({ profitLedger: pendingZero })).toBe(true);
  });
});
