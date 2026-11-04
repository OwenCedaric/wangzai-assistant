import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createApp } from './createApp.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('customer push view marker routes persist and read back the exact account scope', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-a', 'Shop A', 'active')").run();
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const saveResponse = await fetch(`${baseUrl}/api/customer-service/push-view-markers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-a',
        accountScope: 'account-a',
        chatId: 'push-chat',
        lastMessageId: 'message-1',
      }),
    });
    assert.equal(saveResponse.status, 200);
    assert.equal((await saveResponse.json()).marker.lastMessageId, 'message-1');

    const readResponse = await fetch(`${baseUrl}/api/customer-service/push-view-markers/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: 'shop-a', accountScope: 'account-a' }),
    });
    const payload = await readResponse.json();
    assert.equal(readResponse.status, 200);
    assert.equal(payload.count, 1);
    assert.deepEqual(payload.rows[0], {
      shopId: 'shop-a',
      accountScope: 'account-a',
      chatId: 'push-chat',
      lastMessageId: 'message-1',
      lastMessageAt: '',
      viewedAt: payload.rows[0].viewedAt,
    });

    const otherAccountResponse = await fetch(`${baseUrl}/api/customer-service/push-view-markers/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: 'shop-a', accountScope: 'account-b' }),
    });
    assert.deepEqual((await otherAccountResponse.json()).rows, []);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
