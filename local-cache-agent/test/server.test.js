import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForReady(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for await (const chunk of child.stdout) {
    stdout += chunk;
    const line = stdout.split(/\r?\n/u).find(Boolean);
    if (line) {
      const payload = JSON.parse(line);
      if (payload?.service === 'wangzai-local-cache-agent') return;
    }
  }
  throw new Error(`cache agent exited before ready: ${stderr}`);
}

test('serves authenticated local-only record APIs without plaintext persistence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wangzai-cache-http-'));
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('base64url');
  const encryptionKey = crypto.randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: packageRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WANGZAI_CACHE_AGENT_PORT: String(port),
      WANGZAI_CACHE_AGENT_TOKEN: token,
      WANGZAI_CACHE_AGENT_ENCRYPTION_KEY: encryptionKey,
      WANGZAI_CACHE_AGENT_DATA_ROOT: root,
    },
  });
  try {
    await waitForReady(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const unauthenticated = await fetch(`${baseUrl}/v1/status`);
    assert.equal(unauthenticated.status, 401);

    const marker = 'http-api-key-plain-marker';
    const saved = await fetch(`${baseUrl}/v1/records`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-wangzai-cache-agent-token': token },
      body: JSON.stringify({ scopeId: 'user:shop', namespace: 'shops', key: 'shop-1', payload: { apiKey: marker } }),
    });
    assert.equal(saved.status, 200);
    const read = await fetch(`${baseUrl}/v1/records/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wangzai-cache-agent-token': token },
      body: JSON.stringify({ scopeId: 'user:shop', namespace: 'shops', key: 'shop-1' }),
    });
    assert.equal((await read.json()).record.payload.apiKey, marker);
    const database = await fs.readFile(path.join(root, 'wangzai-user-cache.sqlite'));
    assert.equal(database.toString('latin1').includes(marker), false);

    const shopSecret = 'ozon-http-shop-secret';
    const shopSave = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wangzai-cache-agent-token': token,
        'x-wangzai-cache-scope': 'user-http:shop-profile',
      },
      body: JSON.stringify({ id: 'shop-http', name: 'HTTP 店铺', clientId: '90001', apiKey: shopSecret }),
    });
    assert.equal(shopSave.status, 201);
    const shopList = await fetch(`${baseUrl}/api/shops`, {
      headers: {
        'x-wangzai-cache-agent-token': token,
        'x-wangzai-cache-scope': 'user-http:shop-profile',
      },
    });
    const shopPayload = await shopList.json();
    assert.equal(shopPayload.shops[0].hasApiKey, true);
    assert.equal(Object.hasOwn(shopPayload.shops[0], 'apiKey'), false);
    const smartReplyMode = await fetch(`${baseUrl}/api/smart-reply/mode`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wangzai-cache-agent-token': token,
        'x-wangzai-cache-scope': 'user-http:shop-profile',
      },
      body: JSON.stringify({ mode: 'local' }),
    });
    assert.equal(smartReplyMode.status, 200);
    assert.equal((await smartReplyMode.json()).mode, 'local');
    const entitlementSync = await fetch(`${baseUrl}/v1/internal/smart-reply/shop-entitlements`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wangzai-cache-agent-token': token,
        'x-wangzai-cache-scope': 'user-http:shop-profile',
      },
      body: JSON.stringify({
        grants: [{ clientId: '90001', expireAt: '2099-08-24T10:00:00.000Z' }],
      }),
    });
    assert.equal(entitlementSync.status, 200);
    const localRule = await fetch(`${baseUrl}/api/smart-reply/local/rules`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wangzai-cache-agent-token': token,
        'x-wangzai-cache-scope': 'user-http:shop-profile',
      },
      body: JSON.stringify({
        scene: 'shipmentNotice',
        shop_client_ids: ['90001'],
        template_id: 'shipment-http',
        message_template: 'Заказ {{货件编号}} отправлен',
        enabled: false,
      }),
    });
    assert.equal(localRule.status, 200);
    assert.equal((await localRule.json()).scene, 'shipmentNotice');
    const currentDatabase = await fs.readFile(path.join(root, 'wangzai-user-cache.sqlite'));
    assert.equal(currentDatabase.toString('latin1').includes(shopSecret), false);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
