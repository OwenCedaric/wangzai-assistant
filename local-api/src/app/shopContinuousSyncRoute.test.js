import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('saving an active shop with newly ready credentials queues an immediate local background bootstrap', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const bootstrapCalls = [];
    let startCalls = 0;
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: true }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
      continuousSyncService: {
        start() { startCalls += 1; return { ok: true }; },
        bootstrapShop(shopId) { bootstrapCalls.push(shopId); return { ok: true, accepted: 10 }; },
        getStatus() { return { ok: true }; },
      },
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '同步店铺',
        status: 'active',
        clientId: 'client-id',
        apiKey: 'api-key',
      }),
    });
    const createdPayload = await created.json();
    assert.equal(created.status, 201);
    assert.equal(startCalls, 1);
    assert.deepEqual(bootstrapCalls, [createdPayload.shop.id]);
    assert.equal(JSON.stringify(createdPayload).includes('api-key'), false);

    const renamed = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: createdPayload.shop.id, name: '同步店铺（改名）', status: 'active' }),
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual(bootstrapCalls, [createdPayload.shop.id]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('desktop startup can defer continuous sync until the HTTP server is healthy', async () => {
  const db = createMigratedTestDb();
  let server;
  let stopCalls = 0;
  try {
    let startCalls = 0;
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: true }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
      deferContinuousSync: true,
      continuousSyncStartDelayMs: 500,
      continuousSyncService: {
        start() { startCalls += 1; return { ok: true }; },
        stop() { stopCalls += 1; return { ok: true }; },
        bootstrapShop() { return { ok: true, accepted: 0, results: [] }; },
        getStatus() { return { ok: true }; },
      },
    });

    assert.equal(startCalls, 0);
    await listen(server);
    assert.equal(startCalls, 0);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(startCalls, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
  assert.equal(stopCalls, 1);
});
