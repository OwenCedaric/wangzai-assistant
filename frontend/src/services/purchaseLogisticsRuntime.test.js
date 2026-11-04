import { describe, expect, it } from 'vitest';
import { normalizeOzonSalesRowToPurchaseOrder } from './purchaseOrderRuntime.js';
import {
  getGuooRealFbsFreightForPurchaseOrder,
  getLogisticsFreightForPurchaseOrder,
  getGuooRouteTextFromPurchaseOrder,
  hasConfirmedGuooRouteFromPurchaseOrder,
  getOrderCardLogisticsFeeValue,
  getPurchaseOrderMaterialPresentation,
} from './purchaseLogisticsRuntime.js';

describe('purchase logistics route normalization', () => {
  it('keeps the nested Ozon delivery route when normalizing an order', () => {
    const order = normalizeOzonSalesRowToPurchaseOrder({
      id: '0102329766-0325-1',
      amountValue: 37,
      rubToCnyRate: 0.09428269723940262,
      products: [
        {
          offerId: 'mz-26051410-231198',
          skuId: '4297775146',
          weight: 0.2,
          length: 20,
          width: 20,
          height: 20,
        },
      ],
      raw: {
        delivery_method: {
          name: '超级轻小件陆空联运 PUDO',
          tpl_provider: 'GUOO Standard Extra Small',
          warehouse: '一号',
        },
      },
    });

    expect(order.logistics).toBe('超级轻小件陆空联运 PUDO');
    expect(order.deliveryMethod).toBe('超级轻小件陆空联运 PUDO');
    expect(order.warehouse).toBe('一号');
    expect(getGuooRouteTextFromPurchaseOrder(order)).toContain('超级轻小件陆空联运 PUDO');
    expect(getOrderCardLogisticsFeeValue(order)).toBeGreaterThan(0);
  });

  it('can read the route directly from a nested source-order payload', () => {
    const routeText = getGuooRouteTextFromPurchaseOrder({
      sourceOrder: {
        raw: {
          delivery_method: {
            name: '超级轻小件陆空联运 PUDO',
            tpl_provider: 'GUOO Standard Extra Small',
          },
        },
      },
    });

    expect(routeText).toContain('超级轻小件陆空联运 PUDO');
    expect(routeText).toContain('GUOO Standard Extra Small');
  });

  it('uses the confirmed Ozon Economy Budget route for a split child and bills the minimum weight', () => {
    const order = {
      id: '0122157650-0182-1',
      amountValue: 47,
      rubToCnyRate: 0.09449027222647428,
      products: [{ weight: 0.3, length: 20, width: 40, height: 30 }],
      raw: {
        delivery_method: {
          name: 'fuxinghao PUDO',
          tpl_provider: 'GUOO Economy Budget',
        },
      },
    };

    const freight = getGuooRealFbsFreightForPurchaseOrder(order);

    expect(hasConfirmedGuooRouteFromPurchaseOrder(order)).toBe(true);
    expect(freight).toMatchObject({
      ok: true,
      routeId: 'guoo-economy-budget',
      routeConfirmed: true,
      actualWeight: 0.3,
      billedWeight: 0.5,
    });
    expect(freight.amount).toBeGreaterThan(0);
  });

  it('does not reject a split child by its child-only value when Ozon confirmed Standard Small', () => {
    const order = {
      id: '09362844-0405-2',
      amountValue: 75,
      rubToCnyRate: 0.09428269723940262,
      products: [{ weight: 0.12, length: 10, width: 10, height: 10 }],
      raw: {
        delivery_method: {
          name: '高客单轻小件陆空联运 PUDO',
          tpl_provider: 'GUOO Standard Small',
        },
      },
    };

    const freight = getGuooRealFbsFreightForPurchaseOrder(order);

    expect(freight).toMatchObject({
      ok: true,
      routeId: 'guoo-standard-small',
      routeConfirmed: true,
      actualWeight: 0.12,
      billedWeight: 0.12,
    });
  });

  it('falls back to the saved product material profile when the order has no bus volume', () => {
    const material = getPurchaseOrderMaterialPresentation({
      packageWeight: '未返回',
      packageSize: '未返回',
      products: [{
        materialProfile: { weight: 0.067, length: 13.6, width: 12.1, height: 2 },
      }],
    });

    expect(material).toMatchObject({
      weightText: '0.067 kg',
      lengthText: '13.6 cm',
      widthText: '12.1 cm',
      heightText: '2 cm',
      sizeText: '13.6 x 12.1 x 2 cm',
    });
  });

  it('keeps the bus readback ahead of the product material profile', () => {
    const material = getPurchaseOrderMaterialPresentation({
      products: [{
        materialProfile: { weight: 0.067, length: 13.6, width: 12.1, height: 2 },
      }],
    }, {
      volumeItems: [{
        grossWeight: 0.07,
        length: 11.8,
        width: 9.5,
        height: 3.1,
      }],
    });

    expect(material).toMatchObject({
      weightText: '0.07 kg',
      lengthText: '11.8 cm',
      widthText: '9.5 cm',
      heightText: '3.1 cm',
      sizeText: '11.8 x 9.5 x 3.1 cm',
    });
  });

  it('uses account-level provider selection before the shop and global selections', () => {
    const freight = getLogisticsFreightForPurchaseOrder({
      shopId: 'shop-1',
      shopClientId: 'client-1',
      amountValue: 10,
      rubToCnyRate: 0.1,
      products: [{ weight: 0.4, length: 20, width: 20, height: 20 }],
    }, {}, {
      settings: {
        globalSelection: { providerId: 'guoo', market: 'RU', serviceLevel: 'economy' },
        shopSelections: { 'shop-1': { providerId: 'cel', market: 'RU', serviceLevel: 'economy' } },
        accountSelections: { 'client-1': { providerId: 'ural', market: 'RU', serviceLevel: 'economy' } },
      },
    });

    expect(freight).toMatchObject({
      ok: true,
      providerId: 'ural',
      routeId: 'ural-ru-economy-extra-small',
    });
  });
});
