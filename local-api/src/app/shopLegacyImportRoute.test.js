import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function legacyPayload() {
  const shops = [
    { id: 'legacy-shop-a', name: 'Legacy A', alias: 'A', clientId: 'client-a', apiKey: 'legacy-api-key-a', status: 'active' },
    { id: 'legacy-shop-b', name: 'Legacy B', alias: 'B', clientId: 'client-b', apiKey: 'legacy-api-key-b', status: 'inactive' },
  ];
  return {
    shops,
    preferences: {
      version: 1,
      shops: shops.map(({ apiKey, clientId, ...shop }) => ({ ...shop, connectionStatus: '未测试' })),
      activeShopId: 'legacy-shop-b',
      defaultWarehouseIds: { 'legacy-shop-a': 'warehouse-a', 'legacy-shop-b': 'warehouse-b' },
      updatedAt: '2026-07-13T00:00:00.000Z',
    },
  };
}

test('shop legacy bulk route atomically imports accounts and preferences without continuous sync or secret echo', async () => {
  const db = createMigratedTestDb();
  const bootstrapped = [];
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: true }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
      continuousSyncService: {
        start() {},
        bootstrapShop(shopId) {
          bootstrapped.push(shopId);
        },
      },
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const payload = legacyPayload();
    const response = await fetch(`${baseUrl}/api/shops/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const imported = await response.json();

    assert.equal(response.status, 200);
    assert.equal(imported.ok, true);
    assert.equal(imported.importedCount, 2);
    assert.equal(imported.scopeCount, 2);
    assert.equal(typeof imported.digest, 'string');
    assert.equal(JSON.stringify(imported).includes('legacy-api-key-'), false);
    assert.deepEqual(bootstrapped, []);

    const firstPageResponse = await fetch(`${baseUrl}/api/shops?cursorMode=legacy-migration&limit=1`);
    const firstPage = await firstPageResponse.json();
    assert.equal(firstPageResponse.status, 200);
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.rows.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.equal(typeof firstPage.nextCursor, 'string');
    assert.equal(Array.isArray(firstPage.shops), false);
    assert.equal(JSON.stringify(firstPage).includes('legacy-api-key-'), false);

    const secondPage = await (
      await fetch(`${baseUrl}/api/shops?cursorMode=legacy-migration&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`)
    ).json();
    assert.equal(secondPage.total, 2);
    assert.equal(secondPage.rows.length, 1);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.nextCursor, '');

    const normalList = await (await fetch(`${baseUrl}/api/shops`)).json();
    assert.equal(normalList.count, 2);
    assert.equal(Array.isArray(normalList.shops), true);
    assert.equal(normalList.shops.find((shop) => shop.id === 'legacy-shop-a').hasApiKey, true);

    const preferences = await (
      await fetch(`${baseUrl}/api/profile-settings/ozon-shop-preferences`)
    ).json();
    assert.equal(preferences.setting.value.activeShopId, 'legacy-shop-b');
    assert.deepEqual(preferences.setting.value.defaultWarehouseIds, {
      'legacy-shop-a': 'warehouse-a',
      'legacy-shop-b': 'warehouse-b',
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('shop legacy bulk route validates all records before writing either account or preferences', async () => {
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
    const payload = legacyPayload();
    payload.shops[1] = { ...payload.shops[1], id: 'legacy-shop-a' };
    const response = await fetch(`${baseUrl}/api/shops/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 400);
    const list = await (await fetch(`${baseUrl}/api/shops`)).json();
    assert.equal(list.count, 0);
    const preferences = await (
      await fetch(`${baseUrl}/api/profile-settings/ozon-shop-preferences`)
    ).json();
    assert.equal(preferences.setting, null);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
