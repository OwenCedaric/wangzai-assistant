import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('profile asset routes deduplicate image content and return the blob only on explicit reads', async () => {
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
    const dataBase64 = Buffer.from('profile-asset-route-fixture').toString('base64');
    const response = await fetch(`${baseUrl}/api/profile-assets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mimeType: 'image/png', dataBase64 }),
    });
    const saved = await response.json();
    assert.equal(response.status, 200);
    assert.equal(saved.created, true);
    assert.equal(Object.hasOwn(saved.asset, 'dataBase64'), false);

    const duplicate = await (await fetch(`${baseUrl}/api/profile-assets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mimeType: 'image/png', dataBase64 }),
    })).json();
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.asset.id, saved.asset.id);

    const read = await (await fetch(`${baseUrl}/api/profile-assets/${encodeURIComponent(saved.asset.id)}`)).json();
    assert.equal(read.asset.dataBase64, dataBase64);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
