import { describe, expect, it } from 'vitest';
import { buildPurchaseLinkWorkbenchPresentation } from './purchaseLinkWorkbenchPresentation.js';

describe('domestic purchase link workbench presentation', () => {
  it('keeps the current order data beside a Pinduoduo source page', () => {
    const presentation = buildPurchaseLinkWorkbenchPresentation({
      url: 'https://mobile.yangkeduo.com/goods.html?goods_id=123',
      order: {
        id: 'ORDER-PDD-1',
        shop: 'Ozon 1店',
        amount: '¥16.00',
        status: '成功订单',
      },
      product: { name: '测试商品', sku: 'SKU-1', qty: 1 },
      sourceEntry: {
        platform: 'PDD',
        link: 'https://mobile.yangkeduo.com/goods.html?goods_id=123',
        price: '¥2.90',
      },
      purchaseInfo: { platform: 'PDD', orderNumber: 'PDD-ORDER-1', cost: '¥2.90' },
      crossBorderInfo: {
        orderId: '49774985',
        packageWeight: '0.07 kg',
        packageSize: '11.8 x 9.5 x 3.1 cm',
        readStatus: '已读取材积',
      },
    });

    expect(presentation).toMatchObject({
      title: '订单采购操作台',
      browserLabel: '拼多多采购页面',
      order: {
        orderNo: 'ORDER-PDD-1',
        purchasePlatform: 'PDD',
        purchaseOrderNo: 'PDD-ORDER-1',
      },
      source: {
        platform: 'PDD',
        amount: '¥2.90',
        url: 'https://mobile.yangkeduo.com/goods.html?goods_id=123',
      },
      logistics: {
        orderId: '49774985',
        weight: '0.07 kg',
        size: '11.8 x 9.5 x 3.1 cm',
        readStatus: '已读取材积',
      },
    });
  });

  it('labels Seller pages as Seller instead of the public Ozon buyer site', () => {
    expect(buildPurchaseLinkWorkbenchPresentation({
      url: 'https://seller.ozon.ru/app/returns/details/rfbs/88964914',
      sidebarKind: 'after-sales',
      afterSales: { afterSalesId: '88964914' },
      title: '售后订单操作台',
    })).toMatchObject({
      sidebarKind: 'after-sales',
      title: '售后订单操作台',
      browserLabel: 'Ozon Seller 页面',
      notice: 'Ozon Seller 页面已固定在当前售后操作台内，关闭卡片时浏览器会同步隐藏。',
    });
  });
});
