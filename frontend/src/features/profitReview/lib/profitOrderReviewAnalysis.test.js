import { describe, expect, it } from 'vitest';
import { analyzeProfitOrderReview } from './profitOrderReviewAnalysis.js';

function ledger({ order = 'ORDER-1', profit = -10, sku = '998877', actual = true } = {}) {
  return {
    ledgerKey: order,
    shopId: 'shop-a',
    orderSnapshot: {
      posting: order,
      shopId: 'shop-a',
      product: '遥控汽车',
      sku,
      paymentDate: '2026-07-30',
      products: [{ sku, name: '遥控汽车' }],
    },
    amounts: {
      salesAmountCny: { status: 'ready', value: 100 },
      actualSalesAmountCny: { status: actual ? 'ready' : 'pending', value: actual ? 100 : null },
      sourcePurchaseCostCny: { status: 'ready', value: 55 },
      actualCommissionFeeCny: { status: 'ready', value: 20 },
      actualPenaltyFeeCny: { status: 'ready', value: 0 },
      actualAcquiringFeeCny: { status: 'ready', value: 5 },
      actualDeliveryServiceFeeCny: { status: 'ready', value: 15 },
      actualLogisticsFeeCny: { status: 'ready', value: 10 },
      actualCrossBorderBusFeeCny: { status: 'ready', value: 5 },
      estimatedCommissionFeeCny: { status: 'ready', value: 18 },
      estimatedAcquiringFeeCny: { status: 'ready', value: 4 },
      estimatedDeliveryServiceFeeCny: { status: 'ready', value: 12 },
      estimatedCrossBorderBusFeeCny: { status: 'ready', value: 5 },
      logisticsFeeCny: { status: 'ready', value: 8 },
    },
    results: {
      actualProfitCny: { status: actual ? 'ready' : 'pending', value: actual ? profit : null, formula: '实际公式' },
      estimatedProfitCny: { status: 'ready', value: profit + 5, formula: '预估公式' },
    },
  };
}

describe('profitOrderReviewAnalysis', () => {
  it('keeps ledger values deterministic and combines same-SKU and market evidence', () => {
    const analysis = analyzeProfitOrderReview({
      ledgerRow: ledger(),
      relatedLedgerRows: [ledger(), ledger({ order: 'ORDER-2', profit: 20 })],
      marketDraft: {
        result: {
          summary: '真实市场数据已返回',
          externalAnalysis: {
            records: [{
              sku: '998877', title: '遥控汽车', sales: 120, revenue: 240000, averageDailyUnits: 4,
              rating: 4.7, returnCancelRate: 3, trends: [
                { date: '2026-07-01', sales: 2 }, { date: '2026-07-08', sales: 4 },
              ],
            }],
          },
        },
      },
    });

    expect(analysis.profit.mode).toBe('actual');
    expect(analysis.profit.profit).toBe(-10);
    expect(analysis.profit.biggestDrag.label).toBe('采购成本');
    expect(analysis.ownProduct.orderCount).toBe(2);
    expect(analysis.ownProduct.totalProfit).toBe(10);
    expect(analysis.market.metrics.sales30d).toBe(120);
    expect(analysis.decision.label).toContain('先修复成本');
  });

  it('uses estimated profit when actual finance is not ready', () => {
    const analysis = analyzeProfitOrderReview({ ledgerRow: ledger({ actual: false, profit: 10 }) });
    expect(analysis.profit.mode).toBe('estimated');
    expect(analysis.profit.profit).toBe(15);
    expect(analysis.profit.formula).toBe('预估公式');
  });
});

