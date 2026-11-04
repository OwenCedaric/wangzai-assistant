import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countPurchasePluginPurchaseAccountReferences,
  countPurchasePluginShopOwnerReferences,
  getPurchasePluginCaptures,
  getPurchasePluginContext,
  purgePurchasePluginPurchaseAccountOwner,
  purgePurchasePluginShopOwner,
  resetPurchasePluginStoreForTest,
  savePurchasePluginCapture,
  setPurchasePluginContext,
} from './plugin-store.mjs';

test.beforeEach(() => resetPurchasePluginStoreForTest());

function context(shopId, suffix, shopIncarnation = `inc-${suffix}`, credentialRevision = 1, purchaseAccountId = '') {
  return {
    shopId,
    purchaseAccountId,
    shopIncarnation,
    credentialRevision,
    orderKey: `order-${suffix}`,
    productKey: `product-${suffix}`,
  };
}

test('purchase bridge purges only purchase account A while preserving B and C captures', () => {
  for (const accountId of ['purchase-a', 'purchase-b', 'purchase-c']) {
    const suffix = accountId.at(-1);
    const captureContext = context(`shop-${suffix}`, suffix, `inc-${suffix}`, 1, accountId);
    setPurchasePluginContext(captureContext);
    savePurchasePluginCapture({
      context: captureContext,
      link: `https://mobile.yangkeduo.com/goods.html?goods_id=200${suffix.charCodeAt(0)}`,
    });
  }
  setPurchasePluginContext(context('shop-b', 'b-current', 'inc-b', 1, 'purchase-b'));

  assert.equal(countPurchasePluginPurchaseAccountReferences('purchase-a'), 1);
  assert.ok(countPurchasePluginPurchaseAccountReferences('purchase-b') > 0);
  assert.equal(countPurchasePluginPurchaseAccountReferences('purchase-c'), 1);
  assert.deepEqual(purgePurchasePluginPurchaseAccountOwner('purchase-a'), {
    ownerId: 'purchase-a',
    verified: true,
    remaining: 0,
  });
  assert.equal(getPurchasePluginContext().purchaseAccountId, 'purchase-b');
  assert.deepEqual(
    getPurchasePluginCaptures().map((capture) => capture.context.purchaseAccountId).sort(),
    ['purchase-b', 'purchase-c'],
  );
  assert.throws(
    () => setPurchasePluginContext(context('shop-a', 'late-a', 'inc-a', 1, 'purchase-a')),
    /永久删除/u,
  );
  assert.doesNotThrow(
    () => setPurchasePluginContext(context('shop-c', 'still-c', 'inc-c', 1, 'purchase-c')),
  );
});

test('purchase bridge purges and fences one exact Ozon shop while preserving another', () => {
  setPurchasePluginContext(context('shop-a', 'a'));
  savePurchasePluginCapture({
    context: context('shop-a', 'a'),
    link: 'https://mobile.yangkeduo.com/goods.html?goods_id=1001',
  });
  setPurchasePluginContext(context('shop-b', 'b'));
  savePurchasePluginCapture({
    context: context('shop-b', 'b'),
    link: 'https://mobile.yangkeduo.com/goods.html?goods_id=1002',
  });

  assert.ok(countPurchasePluginShopOwnerReferences('shop-a') > 0);
  const result = purgePurchasePluginShopOwner({
    ownerId: 'shop-a',
    shopIncarnation: 'inc-a',
    credentialRevision: 1,
  });
  assert.deepEqual(result, {
    ownerId: 'shop-a',
    shopIncarnation: 'inc-a',
    credentialRevision: 1,
    verified: true,
    remaining: 0,
  });
  assert.equal(getPurchasePluginContext().shopId, 'shop-b');
  assert.deepEqual(getPurchasePluginCaptures().map((capture) => capture.context.shopId), ['shop-b']);
  assert.throws(() => setPurchasePluginContext(context('shop-a', 'late', 'inc-a', 1)), /永久删除/u);
  assert.doesNotThrow(() => setPurchasePluginContext(context('shop-a', 'rebound', 'inc-rebound', 1)));
  assert.equal(getPurchasePluginContext().shopIncarnation, 'inc-rebound');
});

test('purchase bridge saves Ozon buyer product links without treating seller pages as sources', () => {
  setPurchasePluginContext(context('shop-ozon-buyer', 'buyer'));
  const capture = savePurchasePluginCapture({
    context: context('shop-ozon-buyer', 'buyer'),
    link: 'https://www.ozon.ru/product/test-product-123456789/?token=drop#reviews',
  });
  assert.equal(capture.platform, 'Ozon买家');
  assert.equal(capture.productId, '123456789');
  assert.equal(capture.shortLink, 'https://www.ozon.ru/product/test-product-123456789/');
  assert.throws(() => savePurchasePluginCapture({
    context: context('shop-ozon-buyer', 'buyer'),
    link: 'https://seller.ozon.ru/app/products',
  }), /Ozon 买家/u);
});
