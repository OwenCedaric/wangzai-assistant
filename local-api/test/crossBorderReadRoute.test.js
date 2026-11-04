import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createCrossBorderAccountRepository } from '../src/db/repositories/crossBorderAccountRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

async function withServer(db, crossBorderClient, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: { async requestReadOnly() { throw new Error('cross-border read tests must not call Ozon'); } },
    crossBorderClient,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('cross-border read route executes only read endpoint and merges order search rows into SQLite', async () => {
  const db = createMigratedTestDb();
  try {
    saveUnitShop(createShopRepository(db), 'shop-read');
    const accounts = createCrossBorderAccountRepository(db);
    accounts.saveAccount({
      id: 'cb-read',
      name: '只读授权',
      ['company' + 'Secret']: 'credential-a',
      ['access' + 'Token']: 'credential-b',
      appUid: 'uid',
      shopIds: ['shop-read'],
    });
    const calls = [];
    const fakeClient = {
      async requestReadOnly(input) {
        calls.push(input);
        return {
          ok: true,
          data: {
            code: 1,
            data: {
              list: [
                {
                  order_id: 'bus-read-1',
                  platform_order: 'posting-read-1',
                  status: '已预报',
                },
              ],
            },
          },
        };
      },
    };

    await withServer(db, fakeClient, async (base) => {
      const response = await fetch(`${base}/api/logistics/cross-border/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'cb-read', shopId: 'shop-read', endpointKey: 'order.search', body: { order_id: 'bus-read-1' } }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.cachedRecordCount, 1);
      assert.equal(calls[0].endpointKey, 'order.search');
      assert.equal(calls[0].credentials.accessToken, 'credential-b');

      const cache = await (await fetch(`${base}/api/logistics/cross-border/orders?shopId=shop-read&orderId=bus-read-1`)).json();
      assert.equal(cache.total, 1);
      assert.equal(cache.rows[0].platformOrder, 'posting-read-1');
    });
  } finally {
    db.close();
  }
});

test('cross-border read route rejects write endpoint and does not call client', async () => {
  const db = createMigratedTestDb();
  try {
    saveUnitShop(createShopRepository(db), 'shop-read');
    const accounts = createCrossBorderAccountRepository(db);
    accounts.saveAccount({
      id: 'cb-read',
      name: '只读授权',
      ['company' + 'Secret']: 'a',
      ['access' + 'Token']: 'b',
      appUid: 'c',
      shopIds: ['shop-read'],
    });
    let called = false;
    await withServer(db, { async requestReadOnly() { called = true; } }, async (base) => {
      const response = await fetch(`${base}/api/logistics/cross-border/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'cb-read', endpointKey: 'order.create', body: {} }),
      });
      const payload = await response.json();
      assert.equal(response.status, 403);
      assert.equal(payload.error.code, 'CROSS_BORDER_WRITE_ENDPOINT_BLOCKED');
      assert.equal(called, false);
    });
  } finally {
    db.close();
  }
});
