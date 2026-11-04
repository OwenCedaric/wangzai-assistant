import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePurchaseCapture, resolvePurchasePlatformAdapter } from './purchaseCaptureRegistry.js';

for (const fixture of [
  ['https://detail.1688.com/offer/123.html', '1688'],
  ['https://item.taobao.com/item.htm?id=123', '淘宝'],
  ['https://detail.tmall.com/item.htm?id=123', '天猫'],
  ['https://mobile.yangkeduo.com/goods.html?goods_id=123', '拼多多'],
  ['https://www.ozon.ru/product/test-123456789/', 'Ozon买家'],
  ['https://item.jd.com/123.html', '京东'],
  ['https://www.wildberries.ru/catalog/123/detail.aspx', 'Wildberries'],
  ['https://www.amazon.com/dp/B000000000', 'Amazon'],
  ['https://www.temu.com/goods.html', 'Temu'],
  ['https://www.aliexpress.com/item/100000000.html', 'AliExpress'],
]) {
  test(`capture registry recognizes ${fixture[1]}`, () => {
    assert.equal(resolvePurchasePlatformAdapter({ pageUrl: fixture[0] }).label, fixture[1]);
  });
}

test('capture registry normalizes order, price, source and logistics evidence', () => {
  const capture = normalizePurchaseCapture({
    pageUrl: 'https://detail.1688.com/offer/123.html?spm=a#fragment',
    pageTitle: '订单详情',
    pageType: 'order-detail',
    productTitle: '测试商品',
    variant: '蓝色',
    quantity: '2',
    purchaseOrderNumber: 'ORDER-123',
    purchasePrice: '¥12.30',
    trackingNumber: 'TRACK-123',
    carrierName: '中通',
    fieldConfidence: { purchaseOrderNumber: 0.9, purchasePrice: 0.8 },
  });
  assert.equal(capture.platform, '1688');
  assert.equal(capture.purchasePrice, 12.3);
  assert.equal(capture.purchaseOrderNumber, 'ORDER-123');
  assert.equal(capture.trackingNumber, 'TRACK-123');
  assert.equal(capture.pageUrl.includes('#'), false);
});

test('capture registry keeps PDD paid-order status and separates order URL from product URL', () => {
  const capture = normalizePurchaseCapture({
    platform: '拼多多',
    pageUrl: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-1001',
    sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=98765',
    purchaseOrderUrl: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-1001',
    pageType: 'order-detail',
    purchaseOrderNumber: 'PDD-1001',
    purchaseOrderStatus: '待发货',
    paymentConfirmed: true,
    purchasePrice: '52.71',
  });

  assert.equal(capture.platform, '拼多多');
  assert.equal(capture.purchaseOrderNumber, 'PDD-1001');
  assert.equal(capture.purchaseOrderStatus, '待发货');
  assert.equal(capture.paymentConfirmed, true);
  assert.equal(capture.purchasePrice, 52.71);
  assert.match(capture.sourceUrl, /goods\.html/u);
  assert.match(capture.purchaseOrderUrl, /order\.html/u);
});

test('capture registry preserves separated product image groups and sku variants', () => {
  const capture = normalizePurchaseCapture({
    pageUrl: 'https://detail.1688.com/offer/123.html',
    productTitle: '测试商品',
    description: '商品描述',
    imageUrl: 'https://img.example/main.jpg',
    mainImages: ['https://img.example/main.jpg', 'https://img.example/second.jpg'],
    skuImages: [{ skuId: 'sku-red', skuName: '红色', imageUrl: 'https://img.example/red.jpg' }],
    detailImages: ['https://img.example/detail.jpg', 'https://img.example/main.jpg'],
    skus: [{ id: 'sku-red', name: '红色', price: '12.3', attributes: [{ name: '颜色', value: '红色' }], imageUrl: 'https://img.example/red.jpg' }],
  });
  assert.equal(capture.description, '商品描述');
  assert.deepEqual(capture.mainImages, ['https://img.example/main.jpg', 'https://img.example/second.jpg']);
  assert.deepEqual(capture.skuImages, [{ skuId: 'sku-red', skuName: '红色', imageUrl: 'https://img.example/red.jpg' }]);
  assert.deepEqual(capture.detailImages, ['https://img.example/detail.jpg']);
  assert.deepEqual(capture.images, [
    'https://img.example/main.jpg',
    'https://img.example/second.jpg',
    'https://img.example/red.jpg',
    'https://img.example/detail.jpg',
  ]);
  assert.equal(capture.skus[0].id, 'sku-red');
  assert.equal(capture.skus[0].price, 12.3);
  assert.deepEqual(capture.skus[0].attributes, [{ name: '颜色', value: '红色' }]);
});

test('capture registry preserves price ranges, supplier rules and normalized logistics fields', () => {
  const capture = normalizePurchaseCapture({
    pageUrl: 'https://detail.1688.com/offer/907805856885.html',
    productTitle: '采集规则商品', purchasePrice: '3.3', purchasePriceMin: '3.3', purchasePriceMax: '8.4',
    sourceCategoryId: '1033155', sourceCategoryName: '平光镜', sourceCategoryPath: '服饰配件、饰品 / 平光镜',
    weightG: '50', weightMinG: '50', weightMaxG: '50',
    shippingStatus: 'starting', shippingFeeMin: '3', shippingCurrency: 'CNY',
    shippingRuleText: '运费 ¥3 起，按收货地区结算',
    minimumOrderQuantity: '1', minimumOrderUnit: '副', mixedBatchStatus: 'unknown',
    deliveryLeadTimeHours: '48', deliveryText: '承诺48小时内发货',
  });

  assert.equal(capture.purchasePriceMin, 3.3);
  assert.equal(capture.purchasePriceMax, 8.4);
  assert.equal(capture.sourceCategoryId, '1033155');
  assert.equal(capture.sourceCategoryName, '平光镜');
  assert.equal(capture.weightG, 50);
  assert.equal(capture.shippingStatus, 'starting');
  assert.equal(capture.shippingFeeMin, 3);
  assert.equal(capture.minimumOrderQuantity, 1);
  assert.equal(capture.minimumOrderUnit, '副');
  assert.equal(capture.deliveryLeadTimeHours, 48);
});

test('capture registry keeps unknown pages and unknown platforms fail-closed', () => {
  const capture = normalizePurchaseCapture({
    pageUrl: 'https://example.invalid/unknown',
    pageTitle: '普通页面',
    pageText: '没有采购字段',
    platform: 'not-a-platform',
    pageType: 'not-a-page-type',
    purchasePrice: 'not-a-number',
    sourceUrl: 'https://example.invalid/unknown#private-fragment',
  });
  assert.equal(capture.platform, 'unknown');
  assert.equal(capture.pageType, 'unknown');
  assert.equal(capture.purchasePrice, null);
  assert.equal(capture.sourceUrl.includes('#'), false);
});

test('each adapter exposes the complete extraction contract for product, order and logistics pages', () => {
  const contexts = [
    ['1688', 'https://detail.1688.com/offer/1.html', '商品详情'],
    ['淘宝', 'https://item.taobao.com/item.htm?id=1', '我的订单'],
    ['天猫', 'https://detail.tmall.com/item.htm?id=1', '物流详情'],
    ['拼多多', 'https://mobile.yangkeduo.com/goods.html?goods_id=1', '订单详情'],
    ['Ozon买家', 'https://www.ozon.ru/product/test-123456789/', 'Заказ'],
  ];
  for (const [label, pageUrl, pageTitle] of contexts) {
    const adapter = resolvePurchasePlatformAdapter({ pageUrl });
    assert.equal(adapter.label, label);
    for (const method of ['detect', 'detectPageType', 'extractProduct', 'extractOrder', 'extractLogistics', 'normalize', 'getConfidence']) {
      assert.equal(typeof adapter[method], 'function');
    }
    const capture = normalizePurchaseCapture({
      pageUrl,
      pageTitle,
      productTitle: '测试商品',
      variant: '红色',
      quantity: '2',
      purchaseOrderNumber: 'PO-1',
      purchasePrice: '19.90',
      trackingNumber: 'TR-1',
      carrierName: '中通',
      logisticsStatus: '运输中',
    });
    assert.equal(capture.platform, label);
    assert.ok(capture.productTitle);
    assert.ok(capture.purchaseOrderNumber);
    assert.equal(capture.purchasePrice, 19.9);
    assert.ok(capture.trackingNumber);
  }
});

test('Ozon seller pages are not captured through the buyer adapter', () => {
  assert.equal(resolvePurchasePlatformAdapter({ pageUrl: 'https://seller.ozon.ru/app/products' }).label, 'unknown');
});

test('capture currency defaults never turn an unknown foreign price into CNY', () => {
  assert.equal(normalizePurchaseCapture({
    pageUrl: 'https://item.jd.com/12345.html', purchasePrice: 99,
  }).currency, 'CNY');
  assert.equal(normalizePurchaseCapture({
    pageUrl: 'https://www.wildberries.ru/catalog/12345/detail.aspx', purchasePrice: 999,
  }).currency, 'RUB');
  assert.equal(normalizePurchaseCapture({
    pageUrl: 'https://www.amazon.com/dp/B0ABC12345', purchasePrice: 89.99,
  }).currency, '');
});
