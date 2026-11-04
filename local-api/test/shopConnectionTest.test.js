import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

async function withServer({ db, ozonScheduler }, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonScheduler,
    ozonClient: { async requestReadOnly() { throw new Error('shop connection route tests use fake scheduler'); } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('shop connection test runs roles and seller/info through scheduler', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_connection_ok');
    const calls = [];
    const ozonScheduler = {
      async executeReadOnly(input) {
        calls.push(input);
        if (input.endpointKey === 'shop.roles') {
          return { ok: true, status: 'success', jobId: 'job-roles', data: { result: { roles: ['product_view'] } } };
        }
        return { ok: true, status: 'success', jobId: 'job-seller', data: { result: { name: 'Unit Seller' } } };
      },
    };

    await withServer({ db, ozonScheduler }, async (base) => {
      const response = await fetch(`${base}/api/shops/${encodeURIComponent(shopId)}/test`, { method: 'POST' });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.connected, true);
      assert.deepEqual(payload.roles.result.roles, ['product_view']);
      assert.equal(payload.sellerInfo.result.name, 'Unit Seller');
      assert.deepEqual(calls.map((item) => item.endpointKey), ['shop.roles', 'shop.sellerInfo']);
      assert.equal(calls[0].shopId, shopId);
      assert.equal(calls[0].forceRefresh, true);
    });
  } finally {
    db.close();
  }
});

test('shop connection test requires stored encrypted credentials', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    shopRepository.saveShop({ id: 'shop_without_key', name: 'No key shop', clientId: 'client-only' });
    const ozonScheduler = {
      async executeReadOnly() {
        throw new Error('scheduler must not run without credentials');
      },
    };

    await withServer({ db, ozonScheduler }, async (base) => {
      const response = await fetch(`${base}/api/shops/shop_without_key/test`, { method: 'POST' });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'SHOP_CREDENTIALS_REQUIRED');
      assert.equal(payload.connected, false);
    });
  } finally {
    db.close();
  }
});

test('shop connection test explains Ozon code 5 authentication failures without hiding them behind 502', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_connection_invalid_key');
    const ozonScheduler = {
      async executeReadOnly() {
        return {
          ok: false,
          status: 'failed',
          jobId: 'job-invalid-key',
          errors: [{
            code: 'OZON_HTTP_ERROR',
            status: 404,
            message: 'Ozon read request failed with HTTP 404. Invalid Api-Key, please check the key and try again; Ozon code 5',
            response: { code: 5, message: 'Invalid Api-Key, please check the key and try again' },
          }],
        };
      },
    };

    await withServer({ db, ozonScheduler }, async (base) => {
      const response = await fetch(`${base}/api/shops/${encodeURIComponent(shopId)}/test`, { method: 'POST' });
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.connected, false);
      assert.equal(payload.error.code, 'OZON_AUTHENTICATION_FAILED');
      assert.equal(payload.error.endpointKey, 'shop.roles');
      assert.equal(payload.error.status, 404);
      assert.equal(payload.error.ozonCode, '5');
      assert.match(payload.error.message, /API Key 无效/u);
      assert.doesNotMatch(JSON.stringify(payload), /opaque-key/u);
    });
  } finally {
    db.close();
  }
});

test('shop connection test explains a scheduler authentication pause instead of returning a generic failure', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_connection_auth_paused');
    const ozonScheduler = {
      async executeReadOnly() {
        return {
          ok: false,
          status: 'blocked',
          reason: 'shop_paused_auth',
          error: {
            code: 'OZON_AUTH_PAUSED',
            message: 'Ozon synchronization is paused until this shop credential revision changes.',
          },
        };
      },
    };

    await withServer({ db, ozonScheduler }, async (base) => {
      const response = await fetch(`${base}/api/shops/${encodeURIComponent(shopId)}/test`, { method: 'POST' });
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.error.code, 'OZON_AUTHENTICATION_FAILED');
      assert.equal(payload.error.endpointKey, 'shop.roles');
      assert.match(payload.error.message, /API Key 无效/u);
      assert.doesNotMatch(payload.error.message, /Ozon 店铺连接测试失败/u);
    });
  } finally {
    db.close();
  }
});
