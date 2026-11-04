import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('profile settings routes keep only allowlisted non-secret profile configuration', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saveResponse = await fetch(`${baseUrl}/api/profile-settings/fee-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { version: 1, plans: [{ id: 'default', name: '默认方案' }] } }),
    });
    const saved = await saveResponse.json();
    assert.equal(saveResponse.status, 200);
    assert.equal(saved.setting.namespace, 'fee-settings');
    assert.equal(saved.setting.value.plans[0].name, '默认方案');
    assert.equal(saved.crossBorderChargeRevaluation.ok, true);
    assert.equal(saved.crossBorderChargeRevaluation.collectionCount, 0);

    const readResponse = await fetch(`${baseUrl}/api/profile-settings/fee-settings`);
    assert.deepEqual((await readResponse.json()).setting.value, saved.setting.value);

    const promptResponse = await fetch(`${baseUrl}/api/profile-settings/prompt-library`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: {
          version: 1,
          categories: [{ value: 'custom', label: '自定义工具' }],
          items: [{ id: 'custom-tool', title: '自定义工具', promptConfig: { workflowSteps: ['只生成本地草稿'] } }],
        },
      }),
    });
    const promptSaved = await promptResponse.json();
    assert.equal(promptResponse.status, 200);
    assert.equal(promptSaved.setting.namespace, 'prompt-library');
    assert.equal(promptSaved.setting.value.items[0].promptConfig.workflowSteps[0], '只生成本地草稿');

    const shopPreferencesResponse = await fetch(`${baseUrl}/api/profile-settings/ozon-shop-preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: {
          version: 1,
          activeShopId: 'shop-demo',
          defaultWarehouseIds: { 'shop-demo': 'warehouse-1' },
          shops: [{ id: 'shop-demo', shopAlias: '演示店铺', connectionStatus: '本地已保存' }],
        },
      }),
    });
    const shopPreferencesSaved = await shopPreferencesResponse.json();
    assert.equal(shopPreferencesResponse.status, 200);
    assert.equal(shopPreferencesSaved.setting.namespace, 'ozon-shop-preferences');
    assert.equal(shopPreferencesSaved.setting.value.defaultWarehouseIds['shop-demo'], 'warehouse-1');

    const crossBorderPreferencesResponse = await fetch(`${baseUrl}/api/profile-settings/cross-border-preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: {
          version: 1,
          crossBorderAccountId: 'cross-border-main',
          cooperationWarehouse: 'warehouse-1',
          packageService: 'service-1',
          warehouseOptions: [{ value: 'warehouse-1', label: '合作仓' }],
        },
      }),
    });
    const crossBorderPreferencesSaved = await crossBorderPreferencesResponse.json();
    assert.equal(crossBorderPreferencesResponse.status, 200);
    assert.equal(crossBorderPreferencesSaved.setting.namespace, 'cross-border-preferences');
    assert.equal(crossBorderPreferencesSaved.setting.value.cooperationWarehouse, 'warehouse-1');

    const logisticsPricingResponse = await fetch(`${baseUrl}/api/profile-settings/logistics-pricing-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: {
          schemaVersion: 1,
          presetVersion: 'test-v1',
          globalSelection: { providerId: 'guoo', market: 'RU', serviceLevel: 'auto', routeId: '' },
          shopSelections: { 'shop-demo': { providerId: 'cel', market: 'RU', serviceLevel: 'standard', routeId: '' } },
          accountSelections: {},
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    });
    assert.equal(logisticsPricingResponse.status, 200);
    assert.equal((await logisticsPricingResponse.json()).setting.namespace, 'logistics-pricing-settings');

    const pluginContextValue = {
      version: 1,
      context: { shopId: 'shop-demo', orderKey: 'posting-1', offerId: 'offer-1', productIndex: 0 },
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const pluginContextResponse = await fetch(`${baseUrl}/api/profile-settings/purchase-plugin-context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: pluginContextValue }),
    });
    assert.equal(pluginContextResponse.status, 200);
    assert.deepEqual((await pluginContextResponse.json()).setting.value, pluginContextValue);
    const pluginContextReadResponse = await fetch(`${baseUrl}/api/profile-settings/purchase-plugin-context`);
    assert.equal(pluginContextReadResponse.status, 200);
    assert.deepEqual((await pluginContextReadResponse.json()).setting.value, pluginContextValue);

    const skuBindingValue = {
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
    const skuBindingResponse = await fetch(`${baseUrl}/api/profile-settings/auto-order-sku-bindings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: skuBindingValue }),
    });
    assert.equal(skuBindingResponse.status, 200);
    assert.deepEqual((await skuBindingResponse.json()).setting.value, skuBindingValue);
    const skuBindingReadResponse = await fetch(`${baseUrl}/api/profile-settings/auto-order-sku-bindings`);
    assert.deepEqual((await skuBindingReadResponse.json()).setting.value, skuBindingValue);

    const rejectedPluginContext = await fetch(`${baseUrl}/api/profile-settings/purchase-plugin-context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { ...pluginContextValue, context: { ...pluginContextValue.context, arbitrary: 'must-not-store' } } }),
    });
    assert.equal(rejectedPluginContext.status, 400);
    assert.match((await rejectedPluginContext.json()).error.message, /unknown field/);

    const rejected = await fetch(`${baseUrl}/api/profile-settings/fee-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { nested: { clientSecret: 'must-not-store' } } }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error.message, /secret field is forbidden/);

    const rejectedCredentialFlag = await fetch(`${baseUrl}/api/profile-settings/cross-border-preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: {
          crossBorderAccountId: 'cross-border-main',
          hasPassword: true,
        },
      }),
    });
    assert.equal(rejectedCredentialFlag.status, 400);
    assert.match((await rejectedCredentialFlag.json()).error.message, /secret field is forbidden/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
