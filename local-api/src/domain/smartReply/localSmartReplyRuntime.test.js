import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createLocalSmartReplyRuntime } from './localSmartReplyRuntime.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('full-source local-api persists and serves the local smart-reply mode with existing shop credentials', async () => {
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'smart-reply-full-source-test-secret';
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE profile_settings (
      namespace TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ozon_notification_events (
      id TEXT PRIMARY KEY,
      shop_id TEXT,
      domain TEXT NOT NULL,
      event_type TEXT NOT NULL,
      posting_number TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);
  const shop = {
    id: 'shop-local-1',
    name: 'Ozon 一店',
    alias: '一店',
    status: 'active',
    clientId: '4067587',
    credentialRevision: 2,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
  const runtime = createLocalSmartReplyRuntime({
    db,
    fallbackScopeId: 'test-fallback',
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/v3/posting/fbs/list') {
        return new Response(JSON.stringify({ result: { postings: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === '/v2/posting/fbo/list') {
        return new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    },
    shopRepository: {
      listShops: () => [shop],
      getShopCredentialsForInternalUse: () => ({
        shopId: shop.id,
        clientId: shop.clientId,
        apiKey: 'private-ozon-api-key',
      }),
    },
  });
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (!runtime.handleRequest({ req, res, requestUrl, corsHeaders: {} })) {
      res.writeHead(404).end();
    }
  });

  try {
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      'content-type': 'application/json',
      'x-wangzai-cache-scope': 'license-user-a',
    };
    const entitlementResponse = await fetch(
      `${baseUrl}/v1/internal/smart-reply/shop-entitlements`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          grants: [{ clientId: shop.clientId, expireAt: '2099-01-01T00:00:00.000Z' }],
        }),
      },
    );
    assert.equal(entitlementResponse.status, 200);

    const saveResponse = await fetch(`${baseUrl}/api/smart-reply/mode`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'local' }),
    });
    assert.equal(saveResponse.status, 200);
    assert.equal((await saveResponse.json()).mode, 'local');

    const readResponse = await fetch(`${baseUrl}/api/smart-reply/mode`, {
      headers: { 'x-wangzai-cache-scope': 'license-user-a' },
    });
    assert.equal(readResponse.status, 200);
    assert.equal((await readResponse.json()).mode, 'local');

    const credentialsResponse = await fetch(`${baseUrl}/api/smart-reply/local/credentials`, {
      headers: { 'x-wangzai-cache-scope': 'license-user-a' },
    });
    assert.equal(credentialsResponse.status, 200);
    assert.deepEqual(await credentialsResponse.json(), [{
      client_id: '4067587',
      shop_name: '一店',
      configured: true,
      status: 'active',
      last_verified_at: '2026-08-24T00:00:00.000Z',
    }]);

    const storedEnvelope = db.prepare(`
      SELECT value_json FROM profile_settings
      WHERE namespace = 'smart-reply-local-internal-v1'
    `).get();
    assert.ok(storedEnvelope?.value_json);
    assert.doesNotMatch(storedEnvelope.value_json, /4067587|private-ozon-api-key/u);

    const ruleResponse = await fetch(`${baseUrl}/api/smart-reply/local/rules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scene: 'shipmentNotice',
        shop_client_ids: [shop.clientId],
        template_id: 'shipment-test',
        message_template: 'Заказ {{货件编号}} отправлен',
        enabled: true,
      }),
    });
    assert.equal(ruleResponse.status, 200);
    db.prepare(`
      INSERT INTO ozon_notification_events (
        id, shop_id, domain, event_type, posting_number, enabled, created_at
      ) VALUES (?, ?, 'orders', 'order_status_changed', ?, 1, ?)
    `).run(
      'notification-1',
      shop.id,
      '4067587-0001-1',
      new Date(Date.now() + 1000).toISOString(),
    );
    const notificationPollResponse = await fetch(
      `${baseUrl}/api/smart-reply/local/notification-poll`,
      { method: 'POST', headers, body: '{}' },
    );
    assert.equal(notificationPollResponse.status, 200);
    assert.deepEqual(await notificationPollResponse.json(), {
      ok: true,
      accepted: 1,
      scanned: 1,
      mode: 'local',
    });

    const repeatedPollResponse = await fetch(
      `${baseUrl}/api/smart-reply/local/notification-poll`,
      { method: 'POST', headers, body: '{}' },
    );
    assert.equal(repeatedPollResponse.status, 200);
    assert.deepEqual(await repeatedPollResponse.json(), {
      ok: true,
      accepted: 0,
      scanned: 0,
      mode: 'local',
    });
  } finally {
    await runtime.stop();
    await close(server);
    db.close();
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = previousSecret;
  }
});
