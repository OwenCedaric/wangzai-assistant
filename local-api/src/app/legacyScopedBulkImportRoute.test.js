import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createTestServer(db) {
  return createApp({
    db,
    config: { security: {}, sync: {}, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
  });
}

test('scoped legacy bulk routes are exact POST imports and only expose import statistics', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shops = createShopRepository(db);
    saveUnitShop(shops, 'shop-bulk-route');
    server = createTestServer(db);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const cases = [
      {
        path: '/api/products/source-links/legacy-import',
        body: {
          records: [
            { shopId: 'shop-bulk-route', productKey: 'offer-route-a', links: [{ link: 'https://source.test/a' }] },
            { shopId: 'shop-bulk-route', productKey: 'offer-route-b', links: [{ link: 'https://source.test/b' }] },
          ],
        },
      },
      {
        path: '/api/purchase/source-links/legacy-import',
        body: {
          records: [
            { shopId: 'shop-bulk-route', orderKey: 'purchase-route-a', links: [{ link: 'https://source.test/c' }] },
            { shopId: 'shop-bulk-route', orderKey: 'purchase-route-b', links: [{ link: 'https://source.test/d' }] },
          ],
        },
      },
      {
        path: '/api/sales/source-links/legacy-import',
        body: {
          records: [
            { shopId: 'shop-bulk-route', orderKey: 'sales-route-a', links: [{ link: 'https://source.test/e' }] },
            { shopId: 'shop-bulk-route', orderKey: 'sales-route-b', links: [{ link: 'https://source.test/f' }] },
          ],
        },
      },
      {
        path: '/api/purchase/orders/overrides/legacy-import',
        body: {
          overrides: [
            { shopId: 'shop-bulk-route', orderKey: 'override-route-a', updatedAt: '2026-07-13T01:00:00.000Z' },
            { shopId: 'shop-bulk-route', orderKey: 'override-route-b', updatedAt: '2026-07-13T01:00:01.000Z' },
          ],
        },
      },
    ];
    for (const item of cases) {
      const response = await fetch(`${baseUrl}${item.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, item.path);
      assert.deepEqual(
        { ok: payload.ok, importedCount: payload.importedCount, scopeCount: payload.scopeCount },
        { ok: true, importedCount: 2, scopeCount: 1 },
      );
      assert.equal(Object.keys(payload).some((key) => /records|rows|links|overrides/i.test(key)), false);
    }

    const wrongMethod = await fetch(`${baseUrl}/api/purchase/source-links/legacy-import`, { method: 'PUT' });
    assert.equal(wrongMethod.status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('only the exact typed legacy import route accepts a body above normal source-link limits', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shops = createShopRepository(db);
    saveUnitShop(shops, 'shop-bulk-size');
    server = createTestServer(db);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const largeTitle = 'x'.repeat(2 * 1024 * 1024 + 128);
    const body = {
      records: [
        { shopId: 'shop-bulk-size', productKey: 'offer-size-a', links: [{ link: 'https://source.test/a', title: largeTitle }] },
        { shopId: 'shop-bulk-size', productKey: 'offer-size-b', links: [{ link: 'https://source.test/b' }] },
      ],
    };
    const accepted = await fetch(`${baseUrl}/api/products/source-links/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).importedCount, 2);

    const rejected = await fetch(`${baseUrl}/api/products/source-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body.records[0]),
    });
    assert.equal(rejected.status, 413);
    const rejectedPayload = await rejected.json();
    assert.equal(rejectedPayload.ok, false);
    assert.equal(rejectedPayload.error.code, 'REQUEST_BODY_TOO_LARGE');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('product source-link GET keeps its normal array DTO and only emits cursor fields for legacy migration mode', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shops = createShopRepository(db);
    saveUnitShop(shops, 'shop-source-get-contract');
    server = createTestServer(db);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const imported = await fetch(`${baseUrl}/api/products/source-links/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [{
          shopId: 'shop-source-get-contract',
          productKey: 'offer-contract',
          links: [{ link: 'https://source.test/contract' }],
        }],
      }),
    });
    assert.equal(imported.status, 200);

    const normalResponse = await fetch(`${baseUrl}/api/products/source-links?shopId=shop-source-get-contract`);
    const normalPayload = await normalResponse.json();
    assert.equal(normalResponse.status, 200);
    assert.equal(Array.isArray(normalPayload), true);
    assert.equal(normalPayload.length, 1);

    const cursorResponse = await fetch(
      `${baseUrl}/api/products/source-links?shopId=shop-source-get-contract&cursorMode=legacy-migration&limit=1`,
    );
    const cursorPayload = await cursorResponse.json();
    assert.equal(cursorResponse.status, 200);
    assert.deepEqual(
      {
        rows: Array.isArray(cursorPayload.rows),
        total: cursorPayload.total,
        hasMore: cursorPayload.hasMore,
        nextCursor: cursorPayload.nextCursor,
      },
      { rows: true, total: 1, hasMore: false, nextCursor: '' },
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
