import { describe, expect, it } from 'vitest';
import {
  buildAfterSalesOzonProductWorkbenchContext,
  getAfterSalesWorkbenchDisplayId,
} from './afterSalesOzonProductWorkbenchContext.js';

describe('after-sales Ozon product workbench context', () => {
  it('builds the after-sales-specific sidebar contract and keeps the real after-sales id', () => {
    const order = {
      id: 'RETURN-1',
      returnId: 'AFTER-1',
      salesOrder: 'ORDER-1',
      type: '退货申请',
      status: '已退款',
      shop: 'Ozon 1店',
      refundAmount: '¥16.00',
      reason: '买家拒收',
      responsibilityParty: '买家',
      products: [{ name: '售后商品', skuId: '654321' }],
    };
    const context = buildAfterSalesOzonProductWorkbenchContext({
      order,
      product: order.products[0],
      purchaseOverrideIndex: new Map([[
        'ORDER-1',
        { purchasePlatform: 'PDD', purchaseOrderNumber: 'PDD-ORDER-1' },
      ]]),
    });

    expect(getAfterSalesWorkbenchDisplayId(order)).toBe('AFTER-1');
    expect(context).toMatchObject({
      sidebarKind: 'after-sales',
      title: '售后订单操作台',
      afterSales: {
        originalOrderNo: 'ORDER-1',
        afterSalesId: 'AFTER-1',
        type: '退货申请',
        status: '已退款',
        refundAmount: '¥16.00',
        reason: '买家拒收',
        purchasePlatform: 'PDD',
        purchaseOrderNo: 'PDD-ORDER-1',
      },
    });
  });
});
