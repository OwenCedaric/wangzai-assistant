import { describe, expect, it } from 'vitest';
import {
  buildPurchaseInfoOverrideIndex,
  clearVoidedPurchaseDisplayFields,
  findPurchaseInfoOverride,
  getPurchaseInfoCrossBorderInfo,
  getPurchaseInfoSupport,
  mergePurchaseInfoOverridesWithCrossBorderRecords,
  resolvePurchaseInfoOpenAction,
} from './purchaseInfoSupport';

describe('purchaseInfoSupport', () => {
  it('matches sales orders to SQLite purchase overrides and builds a direct order url', () => {
    const index = buildPurchaseInfoOverrideIndex([
      {
        shopId: 'shop-1',
        orderKey: 'posting-1',
        postingNumber: 'posting-1',
        purchasePlatform: '淘宝',
        purchaseOrderNumber: 'tb-20260704',
        sourceCostCny: 18.5,
        manualStatus: '已付款',
        materialSource: {
          title: '淘宝货源标题',
          imageUrl: 'https://img.example.test/source.jpg',
          productId: 'tb-item-1',
          qty: 2,
        },
      },
    ]);
    const order = {
      shopId: 'shop-1',
      id: 'posting-1',
      raw: { posting_number: 'posting-1' },
    };

    const override = findPurchaseInfoOverride(order, index);
    const support = getPurchaseInfoSupport(order, override);

    expect(support).toMatchObject({
      platform: '淘宝',
      orderNumber: 'tb-20260704',
      cost: '18.5',
      status: '已付款',
      sourceTitle: '淘宝货源标题',
      sourceImage: 'https://img.example.test/source.jpg',
      sourceProductId: 'tb-item-1',
      qty: '2',
      hasOrderUrl: true,
      hasPurchaseOrder: true,
      purchaseVoided: false,
    });
    expect(support.orderUrl).toContain('biz_order_id=tb-20260704');
    expect(resolvePurchaseInfoOpenAction(order, override)).toMatchObject({
      canOpen: true,
      url: support.orderUrl,
      message: '',
    });
  });

  it('uses purchase information already merged on the purchase order row', () => {
    const support = getPurchaseInfoSupport({
      id: 'posting-2',
      buyerPlatform: '天猫',
      purchaseOrderNo: 'tmall-20260704',
      purchasePrice: '21.8',
      purchaseOrderStatus: '已拍单',
    });

    expect(support.platform).toBe('天猫');
    expect(support.orderNumber).toBe('tmall-20260704');
    expect(support.cost).toBe('21.8');
    expect(support.orderUrl).toContain('bizOrderId=tmall-20260704');
    expect(support.hasPurchaseOrder).toBe(true);
  });

  it.each(['拼多多', '1688', '淘宝', '天猫'])('does not resurrect %s platform, amount or order number after refund', (platform) => {
    const order = {
      id: 'posting-refunded',
      buyerPlatform: platform,
      purchaseOrderNo: `${platform}-old-order`,
      purchasePrice: '52.71',
      sourceLink: 'https://detail.1688.com/offer/123456.html',
      materialSource: {
        platform,
        price: 52.71,
        link: 'https://detail.1688.com/offer/123456.html',
      },
    };
    const override = {
      purchasePlatform: platform,
      purchaseOrderNumber: `${platform}-old-order`,
      sourceCostCny: 52.71,
      raw: {
        purchaseRefundConfirmed: true,
        forcePurchaseStatus: '待拍单',
        voidedPurchaseOrderNo: `${platform}-old-order`,
        voidedPurchasePlatform: platform,
      },
    };
    const support = getPurchaseInfoSupport(order, override);

    expect(support).toMatchObject({
      platform: '待补录',
      orderNumber: '未返回',
      cost: '待确认',
      status: '待拍单',
      hasOrderUrl: false,
      hasSourceLink: true,
      hasPurchaseOrder: false,
      purchaseVoided: true,
    });

    const displayOrder = clearVoidedPurchaseDisplayFields(
      {
        buyerPlatform: platform,
        supplier: platform,
        purchaseOrderNo: `${platform}-old-order`,
        purchasePrice: '¥52.71',
        purchasePriceValue: 52.71,
        profitLedger: { results: { estimatedProfitCny: { status: 'ready', value: 20 } } },
      },
      {
        raw: {
          purchaseRefundConfirmed: true,
          forcePurchaseStatus: '待拍单',
          voidedPurchaseOrderNo: `${platform}-old-order`,
        },
      }
    );
    expect(displayOrder).toMatchObject({
      buyerPlatform: '待拍单',
      supplier: '待拍单',
      purchaseOrderNo: '',
      purchasePrice: '待确认',
      purchasePriceValue: null,
      forcePurchaseStatus: '待拍单',
      profitLedger: null,
    });

    expect(resolvePurchaseInfoOpenAction(order, override)).toMatchObject({
      canOpen: false,
      url: '',
      message: '该笔订单未采购。',
    });
  });

  it('reuses purchase override cross-border bus fields for sales order detail', () => {
    const order = {
      shopId: 'shop-1',
      id: '0123640791-0163-1',
      crossBorderInfo: {
        orderId: '未返回',
        packageWeight: '未返回',
        packageSize: '未返回',
        readStatus: '未返回',
      },
    };
    const override = {
      orderKey: '0123640791-0163-1',
      packageOrderId: '49774985',
      readStatus: '已读取材积',
      packageSize: '未返回',
      volumeItems: [
        {
          length: 11.8,
          width: 9.5,
          height: 3.1,
          grossWeight: 0.07,
          sizeText: '11.8 x 9.5 x 3.1 cm',
          weightText: '0.07 kg',
        },
      ],
    };

    expect(getPurchaseInfoCrossBorderInfo(order, override)).toMatchObject({
      orderId: '49774985',
      packageWeight: '0.07 kg',
      packageSize: '11.8 x 9.5 x 3.1 cm',
      readStatus: '已读取材积',
    });
  });

  it('fills sales detail dimensions from cached cross-border outInfo when override kept only weight', () => {
    const rows = mergePurchaseInfoOverridesWithCrossBorderRecords(
      [
        {
          orderKey: '4616153:33686462-0057-1',
          postingNumber: '4616153:33686462-0057-1',
          packageOrderId: '49482818',
          readStatus: '已读取材积',
          packageWeight: '0.152 kg',
          packageSize: '未返回',
        },
      ],
      [
        {
          recordKey: '49482818',
          orderId: '49482818',
          outPayload: {
            weight: '0.152',
            grossweight: '0.167',
            volume: [
              {
                length: '15.3',
                width: '13.2',
                height: '4.1',
                gross_weight: '0.167',
              },
            ],
          },
        },
      ]
    );

    expect(getPurchaseInfoCrossBorderInfo({}, rows[0])).toMatchObject({
      orderId: '49482818',
      packageWeight: '0.152 kg',
      packageSize: '15.3 x 13.2 x 4.1 cm',
      readStatus: '已读取材积',
    });
  });

  it('matches plugin domestic logistics by exact Ozon posting and purchase order', () => {
    const rows = mergePurchaseInfoOverridesWithCrossBorderRecords(
      [{
        shopId: 'ozon-shop-example-04',
        orderKey: '4097603:64720469-0563-1',
        postingNumber: '4097603:64720469-0563-1',
        purchaseOrderNumber: '3316981152254029783',
      }],
      [{
        shopId: 'ozon-shop-example-04',
        recordKey: '64720469-0563-1:79028134877723',
        platformOrder: '64720469-0563-1',
        purchaseOrderNumber: '3316981152254029783',
        carrierName: '中通快递(ZTO)',
        trackingNumber: '79028134877723',
        domesticLogisticsStatus: '已发货',
        readStatus: '已读取',
      }],
    );

    expect(rows[0].crossBorderRecord).toMatchObject({
      carrierName: '中通快递(ZTO)',
      trackingNumber: '79028134877723',
      domesticLogisticsStatus: '已发货',
    });
  });
});
