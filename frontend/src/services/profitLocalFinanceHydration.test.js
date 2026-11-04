import { describe, expect, it } from 'vitest';

import {
  buildLocalProfitFinanceExchangeRateIndex,
  buildLocalProfitFinanceHydrationContext,
} from '../entities/profit/profitAfterSalesRules.jsx';
import { normalizeOzonProfitOrder } from '../entities/profit/profitDisplayRules.jsx';
import { isProfitOrderFinanceLookupChecked } from '../entities/profit/profitDisplayRules.jsx';
import { getProfitOrderFinanceOperations } from '../entities/profit/profitLedgerMapping.jsx';

function createOrder(posting, overrides = {}) {
  return {
    id: posting,
    posting,
    salesOrder: posting.replace(/-\d+$/u, ''),
    shopId: 'ozon-shop-example-01',
    shopClientId: '4616153',
    status: 'cancelled',
    ...overrides,
  };
}

function createOperation(operationId, postingNumber, amount) {
  return {
    operation_id: operationId,
    posting_number: postingNumber,
    operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
    operation_date: '2026-05-10 00:00:00',
    amount,
  };
}

describe('cached profit row local finance hydration', () => {
  it('rebuilds every matched completed order with the stored finance-date rate instead of leaving deductions pending', () => {
    const row = createOrder('63213599-0205-2', {
      salesOrder: '63213599-0205',
      status: '成功订单',
      fulfillment: 'FBO',
      amount: 136.89,
      amountValue: 136.89,
      paymentDate: '2026-08-22T18:21:10.542555Z',
      currencyCode: 'CNY',
      products: [{
        offerId: 'mz-26042516-168634',
        skuId: '4080564432',
        price: 136.89,
        commissionPercent: 15,
        currencyCode: 'CNY',
      }],
    });
    const operations = [
      {
        operation_id: '60927143813',
        posting_number: row.id,
        operation_type: 'OperationAgentDeliveredToCustomer',
        operation_date: '2026-08-25 00:00:00',
        amount: 1361.19,
        sale_commission: -254.55,
        services: [
          { name: 'MarketplaceServiceItemDirectFlowLogistic', price: -74 },
          { name: 'MarketplaceServiceItemRedistributionLastMileCourier', price: -7.26 },
        ],
      },
      {
        operation_id: '60930508613',
        posting_number: row.id,
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-08-25 00:00:00',
        amount: -37.38,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: -37.38 }],
      },
    ];
    const hydration = buildLocalProfitFinanceHydrationContext([row], operations);
    const rate = {
      requestedDate: '2026-08-25',
      date: '2026-08-25',
      rubToCnyRate: 0.08074087829927414,
      source: 'cbr-official',
    };
    const rateIndex = buildLocalProfitFinanceExchangeRateIndex(
      [row],
      hydration,
      { todayKey: '2026-08-30', realtime: null, dailyRates: new Map([['2026-08-25', rate]]) }
    );
    const exchangeRates = rateIndex.get('ozon-shop-example-01:63213599-0205-2');
    const normalized = normalizeOzonProfitOrder(row, {
      financeIndex: hydration.financeIndex,
      financeLookupCheckedIndex: hydration.financeLookupCheckedIndex,
      financeParentFallbackIndex: hydration.financeParentFallbackIndex,
      actualExchangeRate: exchangeRates.actual,
      exchangeRates,
      allowZeroPurchaseCost: true,
    });

    expect(normalized.profitLedger.actualFinanceStatus).toBe('confirmed');
    expect(normalized.profitLedger.amounts.actualCommissionFeeCny.value).toBeCloseTo(20.55, 2);
    expect(normalized.profitLedger.amounts.actualAcquiringFeeCny.value).toBeCloseTo(3.02, 2);
    expect(normalized.profitLedger.amounts.actualDeliveryServiceFeeCny.value).toBeCloseTo(6.56, 2);
  });

  it('maps a uniquely-owned parent flow back to its child and marks only evidenced rows checked', () => {
    const row = createOrder('38652143-0161-1');
    const operations = [
      createOperation('51006268496', '38652143-0161', -3.31),
      createOperation('52711792199', '38652143-0161', 3.31),
    ];

    const context = buildLocalProfitFinanceHydrationContext([row], operations);
    const matched = getProfitOrderFinanceOperations(row, context.financeIndex, {
      financeParentFallbackIndex: context.financeParentFallbackIndex,
    });

    expect(matched).toHaveLength(2);
    expect(matched.reduce((sum, operation) => sum + operation.amount, 0)).toBeCloseTo(0, 8);
    expect(context.matchedRowCount).toBe(1);
    expect(context.matchedOrderKeys.has('ozon-shop-example-01:38652143-0161-1')).toBe(true);
    expect(isProfitOrderFinanceLookupChecked(row, context.financeLookupCheckedIndex)).toBe(true);
  });

  it('does not assign one parent flow to multiple sibling child postings', () => {
    const rows = [createOrder('09362844-0405-2'), createOrder('09362844-0405-3')];
    const operations = [createOperation('parent-flow', '09362844-0405', 0)];

    const context = buildLocalProfitFinanceHydrationContext(rows, operations);

    expect(context.matchedRowCount).toBe(0);
    rows.forEach((row) => {
      expect(
        getProfitOrderFinanceOperations(row, context.financeIndex, {
          financeParentFallbackIndex: context.financeParentFallbackIndex,
        })
      ).toHaveLength(0);
      expect(isProfitOrderFinanceLookupChecked(row, context.financeLookupCheckedIndex)).toBe(false);
    });
  });
});
