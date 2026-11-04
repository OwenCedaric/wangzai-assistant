import { describe, expect, it } from 'vitest';
import { buildPurchaseOrderWorkbenchPresentation } from './purchaseOrderWorkbenchPresentation.js';

describe('purchase order workbench presentation', () => {
  it('builds a fixed order panel for the synthetic browser test order', () => {
    const presentation = buildPurchaseOrderWorkbenchPresentation({
      order: {
        id: 'WORKBENCH-TEST-20260723-1',
        salesOrder: 'WORKBENCH-TEST-20260723-1',
        productNo: 'WB-DEMO-001',
        ozonOrderId: 'TEST-OZON-001',
        shop: '测试店铺',
        status: '待拍单',
        amount: '¥99.00',
        buyerPlatform: 'PDD',
        purchaseOrderNo: '待补录',
        ozonStatus: '测试订单',
        paymentTime: '2026/07/23 10:30:00',
        packageWeight: '0.35 kg',
        packageSize: '20 x 12 x 8 cm',
        deliveryMethod: '测试物流路线',
        readStatus: '测试数据已就绪',
        items: 1,
      },
      product: { name: '订单操作台测试商品', sku: 'WB-SKU-001', qty: 1 },
      sourceEntry: {
        platform: 'PDD',
        link: 'https://mobile.yangkeduo.com/',
        price: '¥18.80',
      },
      sourceLink: 'https://mobile.yangkeduo.com/',
    });

    expect(presentation).toMatchObject({
      version: 1,
      kind: 'purchase-order',
      displayMode: 'embedded',
      title: '订单操作台',
      order: {
        orderNo: 'WORKBENCH-TEST-20260723-1',
        goodsNo: 'WB-DEMO-001',
        shop: '测试店铺',
        status: '待拍单',
      },
      product: { title: '订单操作台测试商品', sku: 'WB-SKU-001', quantity: 'x1' },
      source: { platform: 'PDD', amount: '¥18.80', url: 'https://mobile.yangkeduo.com/' },
      logistics: { weight: '0.35 kg', size: '20 x 12 x 8 cm' },
    });
    expect(presentation.profitItems.map((item) => item.label)).toEqual(['销售额', '货源', '平台费', '物流', '利润']);
  });

  it.each(['拼多多', '1688', '淘宝', '天猫'])(
    'does not resurrect a refunded %s purchase from the retained source link',
    (platform) => {
      const presentation = buildPurchaseOrderWorkbenchPresentation({
        order: {
          id: 'order-refunded-1',
          status: '待拍单',
          purchasePlatform: '',
          purchaseOrderNumber: '',
          sourceCostCny: null,
          raw: {
            forcePurchaseStatus: '待拍单',
            voidedPurchaseOrderNo: 'VOIDED-ORDER-1',
            voidedPurchasePlatform: platform,
            voidedPurchaseCostCny: 52.71,
            purchaseRefundConfirmed: true,
          },
        },
        product: { sku: 'sku-refunded-1', price: 52.71 },
        sourceEntry: {
          platform,
          link: 'https://example.test/retained-source-link',
          price: '¥52.71',
        },
        profitItems: [
          { label: '销售额', value: '¥109.00' },
          { label: '货源', value: '¥52.71' },
          { label: '利润', value: '¥20.00', tone: 'profit' },
        ],
      });

      expect(presentation.order.purchasePlatform).toBe('待补录');
      expect(presentation.order.purchaseOrderNo).toBe('待补录');
      expect(presentation.source.platform).toBe('待补录');
      expect(presentation.source.amount).toBe('待确认');
      expect(presentation.source.url).toBe('https://example.test/retained-source-link');
      expect(presentation.profitItems).toEqual([
        { label: '销售额', value: '¥109.00', tone: '' },
        { label: '货源', value: '待确认', tone: '' },
        { label: '利润', value: '待确认', tone: '' },
      ]);
    },
  );

  it('keeps the workbench renderable while the selected product is temporarily empty', () => {
    const presentation = buildPurchaseOrderWorkbenchPresentation({
      order: { id: 'order-loading-product', status: '待拍单' },
      product: null,
      sourceEntry: null,
      purchaseInfo: null,
      crossBorderInfo: null,
    });

    expect(presentation.order.orderNo).toBe('order-loading-product');
    expect(presentation.product.title).toBe('未返回');
  });
});
