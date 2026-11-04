import { describe, expect, it } from 'vitest';
import { buildPurchaseBrowserTarget } from '../services/purchaseBrowserTargetBridge.js';
import { buildPurchasePluginSourceContextValue } from './usePurchaseSourceLinkState.jsx';

describe('purchase workbench order target fallback', () => {
  it('builds the exact target from the order when the selected product row is temporarily absent', () => {
    const context = buildPurchasePluginSourceContextValue({
      product: null,
      selectedOrderSourceShop: { id: 'ozon-shop-example-04' },
      selectedOrder: {
        id: '0215352801-0034-2',
        salesOrder: '0215352801-0034-2',
        ozonOrderId: '0215352801-0034',
        shop: 'Ozon 3店',
        productNo: 'mz-26032810-471686',
        sku: 'mz-26032810-471686',
        product: 'Сетка для бритвы',
        items: 1,
        amount: '¥49.36',
      },
    });

    expect(context).toEqual(expect.objectContaining({
      shopId: 'ozon-shop-example-04',
      orderKey: '0215352801-0034-2',
      offerId: 'mz-26032810-471686',
      sku: 'mz-26032810-471686',
      productName: 'Сетка для бритвы',
    }));
    expect(buildPurchaseBrowserTarget(context)).toEqual(expect.objectContaining({
      shopId: 'ozon-shop-example-04',
      orderKey: '0215352801-0034-2',
      sku: 'mz-26032810-471686',
    }));
  });
});
