import { describe, expect, it } from 'vitest';
import { buildProfitOzonProductWorkbenchContext } from './profitOzonProductWorkbenchContext.js';

describe('profit Ozon product workbench context', () => {
  it('builds the profit-specific sidebar contract from the current profit row', () => {
    const context = buildProfitOzonProductWorkbenchContext({
      order: {
        id: 'PROFIT-ORDER-1',
        ozonOrderId: 'OZON-1',
        product: '利润商品',
        shop: 'Ozon 1店',
        salesAmount: '¥100.00',
        estimatedProfit: '¥20.00',
        actualProfit: '¥18.00',
        currencyCode: 'CNY',
        status: '成功订单',
        products: [{ name: '利润商品', skuId: '123456', offerId: 'OFFER-1' }],
      },
      product: { name: '利润商品', skuId: '123456', offerId: 'OFFER-1' },
      profitLocalInputs: { purchaseLocalOverrides: {}, productSourceLinks: {} },
      readableShops: [],
    });

    expect(context).toMatchObject({
      sidebarKind: 'profit',
      title: '利润核算操作台',
      profit: {
        realStatus: '成功订单',
        actualProfit: '¥18.00',
      },
    });
    expect(context.profit.estimateItems.map((item) => item.label)).toEqual(['销售收入', '总预估扣费', '预估利润']);
    expect(context.profit.actualFeeItems.length).toBeGreaterThan(0);
  });
});
