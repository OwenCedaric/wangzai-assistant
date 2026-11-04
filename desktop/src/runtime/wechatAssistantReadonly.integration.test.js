import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { initializeDatabase } from '../../../local-api/src/db/database.js';
import { createApp } from '../../../local-api/src/app/createApp.js';
import { createShopRepository } from '../../../local-api/src/db/repositories/shopRepository.js';
import { createOrderRepository } from '../../../local-api/src/db/repositories/orderRepository.js';
import { createShopDatabaseManager } from '../../../local-api/src/db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../../../local-api/src/db/shopDatabaseRouter.js';
import { createShopOrderStorage } from '../../../local-api/src/db/shopOrderStorage.js';
import { createWechatAssistantModelRelay } from './wechatAssistantModelRelay.js';
import { createWechatAssistantReadonly } from './wechatAssistantReadonly.js';

test('real stdio readonly MCP matches the normal HTTP dashboard after shop storage cutover', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-wechat-readonly-http-'));
  const desktopRoot = path.resolve(import.meta.dirname, '../..');
  const projectRoot = path.resolve(desktopRoot, '..');
  const runtimeRoot = path.join(desktopRoot, 'openclaw-runtime');
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'synthetic-readonly-http-fixture-key';
  let db, manager, server, relay, client, transport;
  t.after(async () => {
    await client?.close(); await transport?.close(); await relay?.stop();
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    manager?.closeAll(); db?.close();
    if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET; else process.env.LOCAL_API_SECRET = previousSecret;
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith('wangzai-wechat-readonly-http-'));
    rmSync(root, { recursive: true, force: true });
  });
  const databasePath = path.join(root, 'main.sqlite');
  db = initializeDatabase({ database: { path: databasePath, enableWal: true } }).db;
  const shops = createShopRepository(db, { profileId: 'wechat-readonly-fixture' });
  shops.saveShop({ id: 'fixture-shop', name: 'Fixture', alias: 'Synthetic', clientId: 'fixture-client', apiKey: 'synthetic-only', status: 'active' });
  manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const storage = createShopOrderStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
  storage.initializeEmptyShop({ shopId: 'fixture-shop' }); storage.initializeDirectShop({ shopId: 'fixture-shop' });
  createOrderRepository(router.open('fixture-shop').db).upsertOrders({ shopId: 'fixture-shop', rows: [{
    posting_number: 'fixture-posting', order_id: 'fixture-order', status: 'delivered', in_process_at: '2026-09-05T03:00:00Z',
    products: [{ offer_id: 'fixture-offer', name: 'Fixture product', price: 100, quantity: 1, currency_code: 'CNY' }],
  }] });
  server = createApp({ db, shopDatabaseManager: manager,
    getDatabaseStatus: () => ({ ok: true }), listAppliedMigrations: () => [], startedAt: Date.now(),
    config: { root, database: { path: databasePath }, security: {}, runtime: { profileId: shops.profileId },
      sync: { continuousEnabled: false }, ozon: {}, storage: { orderDirectWriteAllShops: true } },
    ozonClient: { requestReadOnly() { throw new Error('FIXTURE_FORBIDS_PLATFORM'); }, requestWrite() { throw new Error('FIXTURE_FORBIDS_WRITE'); } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  const read = createWechatAssistantReadonly({ executeRequest: async input => {
    const response = await fetch(apiBase + input.path, { method: input.method });
    const data = await response.json();
    calls.push({ path: input.path, method: input.method, source: data.source, ok: data.ok });
    return { ok: response.ok, status: response.status, data };
  } });
  relay = createWechatAssistantModelRelay({ getSettings: () => ({ modelName: 'fixture-model' }), executeReadonlyRequest: read });
  relay.setAuthorization({ authorized: true, ownerScope: 'a'.repeat(64) });
  await relay.start();
  const sdkRoot = path.join(runtimeRoot, 'node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/dist/esm');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(path.join(sdkRoot, 'client/index.js')).href), import(pathToFileURL(path.join(sdkRoot, 'client/stdio.js')).href),
  ]);
  client = new Client({ name: 'fixture-readonly-authority', version: '1.0.0' });
  transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.WECHAT_READONLY_TEST_SCRIPT || path.join(desktopRoot, 'resources/openclaw-workspace/tools/wangzai-readonly-mcp.mjs')],
    stderr: 'pipe', env: { WANGZAI_OPENCLAW_RUNTIME_ROOT: runtimeRoot,
      WANGZAI_OPENCLAW_READONLY_RELAY_URL: relay.baseUrl, WANGZAI_OPENCLAW_READONLY_RELAY_TOKEN: relay.token,
      WANGZAI_LOCAL_API_DB_PATH: databasePath, WANGZAI_DESKTOP_PROJECT_ROOT: projectRoot, LOCAL_API_SECRET: 'synthetic-only' },
  });
  await client.connect(transport);
  const direct = await (await fetch(apiBase + '/api/cache/dashboard-overview?shopIds=fixture-shop&startDate=2026-09-05&endDate=2026-09-05')).json();
  assert.equal(direct.metrics.orderCount.value, 1);
  const response = await client.callTool({ name: 'wangzai_shop_summary', arguments: { shop: 'fixture-shop', date: '2026-09-05' } });
  const summary = JSON.parse(response.content.find(item => item.type === 'text').text);
  assert.equal(summary.ok, true, JSON.stringify({ summary, calls }));
  assert.deepEqual(summary.metrics.orderCount, direct.metrics.orderCount);
  assert.deepEqual(summary.metrics.salesAmount, direct.metrics.salesAmount);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ozon_orders').get().n, 0);
  assert.equal(router.open('fixture-shop').db.prepare('SELECT COUNT(*) n FROM ozon_orders').get().n, 1);
  assert.ok(calls.length >= 2 && calls.every(input => input.method === 'GET' &&
    (input.path === '/api/shops' || input.path.startsWith('/api/cache/dashboard-overview?'))));
  const beforeLogoutReads = calls.length;
  relay.setAuthorization({ authorized: false });
  const denied = await client.callTool({ name: 'wangzai_shop_summary', arguments: { shop: 'fixture-shop', date: '2026-09-05' } });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content.find(item => item.type === 'text').text).code, 'LOCAL_RELAY_UNAUTHORIZED');
  assert.equal(calls.length, beforeLogoutReads, 'an old stdio token must not reach any local API after logout');
});
