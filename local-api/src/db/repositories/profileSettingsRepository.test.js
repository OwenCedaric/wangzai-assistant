import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileSettingsRepository } from './profileSettingsRepository.js';
import { createMigratedTestDb } from '../../../test/testDb.js';

test('profile settings repository allows only named non-secret JSON configuration', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfileSettingsRepository(db);
    const saved = repository.saveSetting({
      namespace: 'fee-settings',
      value: { version: 1, activeId: 'plan-a', plans: [{ id: 'plan-a', name: '默认方案' }] },
    });
    assert.equal(saved.created, true);
    assert.deepEqual(repository.getSetting('fee-settings')?.value, {
      version: 1, activeId: 'plan-a', plans: [{ id: 'plan-a', name: '默认方案' }],
    });
    assert.throws(
      () => repository.saveSetting({ namespace: 'fee-settings', value: { apiKey: 'must-not-store' } }),
      /secret field is forbidden/,
    );
    assert.throws(
      () => repository.saveSetting({ namespace: 'unknown-settings', value: {} }),
      /namespace is not allowed/,
    );
  } finally {
    db.close();
  }
});

test('purchase-plugin-context accepts only its fixed non-secret envelope', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfileSettingsRepository(db);
    const value = {
      version: 1,
      context: {
        shopName: '夹具店铺', shopId: 'shop-1', shopClientId: 'client-1',
        orderId: 'order-1', orderKey: 'posting-1', productKey: 'product-1', legacyProductKey: 'legacy-1',
        offerId: 'offer-1', sku: 'sku-1', productName: '夹具商品', ozonOrderId: 'ozon-1',
        salesAmount: '12.50', productImageUrl: 'https://img.test/product.jpg',
        lockedAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', productIndex: 2,
      },
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const saved = repository.saveSetting({ namespace: 'purchase-plugin-context', value });

    assert.deepEqual(saved.setting.value, value);
    assert.throws(
      () => repository.saveSetting({ namespace: 'purchase-plugin-context', value: { ...value, debugPayload: 'nope' } }),
      /unknown field/,
    );
    assert.throws(
      () => repository.saveSetting({ namespace: 'purchase-plugin-context', value: { ...value, context: { ...value.context, apiKey: 'nope' } } }),
      /secret field is forbidden/,
    );
    assert.throws(
      () => repository.saveSetting({ namespace: 'purchase-plugin-context', value: { ...value, context: { ...value.context, productIndex: -1 } } }),
      /productIndex/,
    );
  } finally {
    db.close();
  }
});

test('auto-order SKU bindings persist only human-readable link and SKU-name pairs', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createProfileSettingsRepository(db);
    const value = {
      version: 1,
      bindings: [{
        ozonUrl: 'https://www.ozon.ru/product/demo-100/',
        ozonTitle: 'Ozon商品',
        sourceUrl: 'https://detail.1688.com/offer/200.html',
        sourceTitle: '货源商品',
        sourcePlatform: '1688',
        pairs: [{ ozonSkuName: '颜色：黑色', sourceSkuName: '颜色：雅黑' }],
        updatedAt: '2026-08-25T00:00:00.000Z',
      }],
    };
    const saved = repository.saveSetting({ namespace: 'auto-order-sku-bindings', value });
    assert.deepEqual(saved.setting.value, value);
    assert.equal(JSON.stringify(saved.setting.value).includes('skuId'), false);
  } finally {
    db.close();
  }
});
