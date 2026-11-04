import { describe, expect, it } from 'vitest';
import React from 'react';

globalThis.React = React;

const { getPurchaseOrderListProfit } = await import('../features/orders/purchase/lib/purchaseImageRules.jsx');
const { getPurchaseOrderProfitSummaryItems } = await import(
  '../features/orders/purchase/lib/purchaseImageRules.jsx'
);
const { createPurchaseProfitLedgerSnapshotKeys } = await import(
  '../features/orders/purchase/services/purchaseProfitLedgerService.js'
);

function createLedger({ cost = 13.8, profit = -2.3919, status = 'ready', reason = '', missing = [] } = {}) {
  return {
    ledgerKey: '4616153:06477778-0475-1',
    orderKey: '4616153:06477778-0475-1',
    orderSnapshot: { sourcePurchaseCostCny: cost },
    amounts: {
      sourcePurchaseCostCny: { value: cost, status: 'ready', source: 'purchase-override' },
    },
    results: {
      estimatedProfitCny: { value: profit, status, reason, missing },
    },
  };
}

describe('purchase order profit display', () => {
  it('shows the estimated profit from the shared profit ledger when purchase cost already exists', () => {
    expect(
      getPurchaseOrderListProfit({
        purchasePriceValue: 13.8,
        profitLedger: createLedger(),
      })
    ).toEqual({ value: '-￥2.39', hint: '已核算', tone: 'loss' });
  });

  it('keeps zero profit as a valid calculated result', () => {
    expect(
      getPurchaseOrderListProfit({
        purchasePriceValue: 6.96,
        profitLedger: createLedger({ cost: 6.96, profit: 0 }),
      })
    ).toEqual({ value: '￥0.00', hint: '已核算', tone: '' });
  });

  it('reports the actual missing field instead of always claiming purchase cost is missing', () => {
    expect(
      getPurchaseOrderListProfit({
        purchasePriceValue: 13.8,
        profitLedger: createLedger({
          profit: null,
          status: 'pending',
          reason: '缺物流费用',
          missing: ['缺物流费用'],
        }),
      })
    ).toEqual({ value: '待确认', hint: '物流待补', tone: '' });
  });

  it('only shows purchase cost pending when neither the order nor the ledger has a cost', () => {
    expect(getPurchaseOrderListProfit({})).toEqual({ value: '待确认', hint: '成本待补', tone: '' });
  });

  it('does not display a stale ledger value after the purchase cost changes', () => {
    expect(
      getPurchaseOrderListProfit({
        purchasePriceValue: 20,
        profitLedger: createLedger({ cost: 13.8, profit: -2.3919 }),
      })
    ).toEqual({ value: '待确认', hint: '利润待更新', tone: '' });
  });

  it('uses one profit-ledger breakdown for both the list and the detail card', () => {
    const profitLedger = createLedger({ cost: 2.9, profit: 2.711906294851156 });
    profitLedger.amounts = {
      ...profitLedger.amounts,
      salesAmountCny: { value: 16, status: 'ready' },
      estimatedOzonFeeCny: { value: 3.6042937051488444, status: 'ready' },
      estimatedCrossBorderBusFeeCny: { value: 1.225, status: 'ready' },
      logisticsFeeCny: { value: 5.5588, status: 'ready' },
    };
    const order = { purchasePriceValue: 2.9, profitLedger };

    expect(getPurchaseOrderListProfit(order)).toEqual({ value: '+￥2.71', hint: '已核算', tone: 'profit' });
    expect(getPurchaseOrderProfitSummaryItems(order)).toEqual([
      { label: '销售额', value: '¥16.00' },
      { label: '货源', value: '¥2.90' },
      { label: '平台费', value: '¥4.83' },
      { label: '物流', value: '¥5.56' },
      { label: '利润', value: '+￥2.71', tone: 'profit' },
    ]);
  });
});

describe('purchase profit ledger snapshot keys', () => {
  it('uses the same scoped key as the profit page', () => {
    const scope = {
      page: 'profit-calculation',
      startDateKey: '2026-04-11',
      endDateKey: '2026-07-10',
      filterScope: 'all',
      version: 'time-v1',
      cachePart: 'profit-calculation:range:2026-04-11_2026-07-10:filter:all:v:time-v1',
      apiRange: {
        since: '2026-04-11T00:00:00.000Z',
        to: '2026-07-10T23:59:59.999Z',
      },
    };

    const keys = createPurchaseProfitLedgerSnapshotKeys(
      [{ id: 'ozon-shop-1', clientId: '4616153', shopAlias: 'Ozon 1店' }],
      scope,
      0
    );

    expect(keys[0]).toBe(
      'ozon-profit-ledger-v1:ozon-shop:client:4616153:profit-calculation:range:2026-04-11_2026-07-10:filter:all:v:time-v1'
    );
  });
});
