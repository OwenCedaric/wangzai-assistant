import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('shop settings list exposes Client ID and uses a fixed mask for the saved API Key', async () => {
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
    const apiKey = 'shop-visible-api-key-1234';
    const savedResponse = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'shop-visible', name: '可见店铺', clientId: 'seller-123', apiKey, status: 'active' }),
    });
    assert.equal(savedResponse.status, 201);

    const listResponse = await fetch(`${baseUrl}/api/shops`);
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(list.shops[0].clientId, 'seller-123');
    assert.equal(list.shops[0].apiKeyHint, '••••••••••');
    assert.equal(JSON.stringify(list).includes(apiKey), false);

    const forbiddenReveal = await fetch(`${baseUrl}/api/shops/shop-visible/credentials`);
    assert.equal(forbiddenReveal.status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
