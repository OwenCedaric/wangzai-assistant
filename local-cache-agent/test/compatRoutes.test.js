import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCompatibilityRoutes, supportsCompatibilityRoute } from '../src/compatRoutes.js';
import { createLocalCacheStore } from '../src/store.js';

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cache-compat-'));
  const store = createLocalCacheStore({
    databasePath: path.join(root, 'cache.sqlite'),
    assetRoot: path.join(root, 'assets'),
    encryptionKey: crypto.randomBytes(32),
  });
  return { root, store, routes: createCompatibilityRoutes({ store }) };
}

function request(routes, input) {
  return routes.handle({
    method: input.method || 'GET',
    pathname: input.pathname,
    searchParams: new URLSearchParams(input.search || ''),
    payload: input.payload || {},
    scopeId: input.scopeId || 'user-1:profile-1',
  });
}

test('saves Ozon credentials only in the encrypted customer-local shop record', async () => {
  const fixture = createFixture();
  try {
    const created = await request(fixture.routes, {
      method: 'POST', pathname: '/api/shops',
      payload: { id: 'shop-1', name: '测试店铺', alias: '一店', status: 'active', clientId: '10001', apiKey: 'ozon-key-secret' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.payload.shop.hasApiKey, true);
    assert.equal(Object.hasOwn(created.payload.shop, 'apiKey'), false);
    const list = await request(fixture.routes, { pathname: '/api/shops' });
    assert.equal(list.payload.shops.length, 1);
    assert.equal(list.payload.shops[0].clientId, '10001');
    const stored = fixture.store.getRecord({ scopeId: 'user-1:profile-1', namespace: 'shops', key: 'shop-1' });
    assert.equal(stored.payload.apiKey, 'ozon-key-secret');
    assert.equal(fs.readFileSync(path.join(fixture.root, 'cache.sqlite')).toString('latin1').includes('ozon-key-secret'), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('imports legacy Ozon shops and preferences in one encrypted local transaction', async () => {
  const fixture = createFixture();
  try {
    const imported = await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/shops/legacy-import',
      payload: {
        shops: [
          { id: 'legacy-1', name: '旧一店', alias: '一店', status: 'active', clientId: '71001', apiKey: 'legacy-secret-one' },
          { id: 'legacy-2', name: '旧二店', alias: '二店', status: 'inactive', clientId: '71002', apiKey: 'legacy-secret-two' },
        ],
        preferences: {
          version: 1,
          shops: [{ id: 'legacy-1', shopAlias: '一店' }, { id: 'legacy-2', shopAlias: '二店' }],
          activeShopId: 'legacy-2',
          defaultWarehouseIds: { 'legacy-1': 'warehouse-a' },
          updatedAt: '2026-08-20T00:00:00.000Z',
        },
      },
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.payload.importedCount, 2);
    assert.equal(imported.payload.scopeCount, 2);
    assert.match(imported.payload.digest, /^[a-f0-9]{64}$/u);

    const list = await request(fixture.routes, { pathname: '/api/shops' });
    assert.equal(list.payload.shops.length, 2);
    assert.equal(list.payload.shops.every((shop) => Object.hasOwn(shop, 'apiKey') === false), true);
    const preferences = await request(fixture.routes, {
      pathname: '/api/profile-settings/ozon-shop-preferences',
    });
    assert.equal(preferences.payload.setting.value.activeShopId, 'legacy-2');
    assert.equal(preferences.payload.setting.value.defaultWarehouseIds['legacy-1'], 'warehouse-a');

    const databaseBytes = fs.readFileSync(path.join(fixture.root, 'cache.sqlite')).toString('latin1');
    assert.equal(databaseBytes.includes('legacy-secret-one'), false);
    assert.equal(databaseBytes.includes('legacy-secret-two'), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects an invalid legacy shop batch without leaving partial records', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      request(fixture.routes, {
        method: 'POST',
        pathname: '/api/shops/legacy-import',
        payload: {
          shops: [
            { id: 'duplicate', name: '第一条', clientId: '72001', apiKey: 'secret-a' },
            { id: 'duplicate', name: '第二条', clientId: '72002', apiKey: 'secret-b' },
          ],
          preferences: {
            version: 1,
            shops: [{ id: 'duplicate' }],
            activeShopId: 'duplicate',
            defaultWarehouseIds: {},
          },
        },
      }),
      { code: 'SHOP_LEGACY_IMPORT_ID_DUPLICATE' },
    );
    assert.equal(fixture.store.listRecords({
      scopeId: 'user-1:profile-1', namespace: 'shops',
    }).length, 0);
    assert.equal(fixture.store.getRecord({
      scopeId: 'user-1:profile-1', namespace: 'profile-settings', key: 'ozon-shop-preferences',
    }), null);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('preserves saved credentials when a renderer writes only non-secret shop fields', async () => {
  const fixture = createFixture();
  try {
    await request(fixture.routes, {
      method: 'POST', pathname: '/api/shops',
      payload: { id: 'shop-1', name: '原店铺', clientId: '10001', apiKey: 'keep-me' },
    });
    const updated = await request(fixture.routes, {
      method: 'POST', pathname: '/api/shops', payload: { id: 'shop-1', name: '新店名', alias: '新别名' },
    });
    assert.equal(updated.status, 200);
    const stored = fixture.store.getRecord({ scopeId: 'user-1:profile-1', namespace: 'shops', key: 'shop-1' }).payload;
    assert.equal(stored.apiKey, 'keep-me');
    assert.equal(stored.clientId, '10001');
    assert.equal(stored.credentialRevision, 1);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('keeps profile preferences local and rejects credential-shaped fields', async () => {
  const fixture = createFixture();
  try {
    const saved = await request(fixture.routes, {
      method: 'PUT', pathname: '/api/profile-settings/ozon-shop-preferences',
      payload: { value: { version: 1, shops: [{ id: 'shop-1', alias: '一店' }], activeShopId: 'shop-1', defaultWarehouseIds: {} } },
    });
    assert.equal(saved.payload.setting.value.activeShopId, 'shop-1');
    const read = await request(fixture.routes, { pathname: '/api/profile-settings/ozon-shop-preferences' });
    assert.equal(read.payload.setting.value.shops[0].alias, '一店');
    await assert.rejects(
      request(fixture.routes, {
        method: 'PUT', pathname: '/api/profile-settings/ozon-shop-preferences', payload: { value: { apiKey: 'forbidden' } },
      }),
      { code: 'PROFILE_SETTING_SECRET_FIELD_FORBIDDEN' },
    );
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('isolates the same shop id between signed-in user scopes', async () => {
  const fixture = createFixture();
  try {
    await request(fixture.routes, { method: 'POST', pathname: '/api/shops', scopeId: 'user-a:profile', payload: { id: 'same', name: 'A', apiKey: 'a' } });
    await request(fixture.routes, { method: 'POST', pathname: '/api/shops', scopeId: 'user-b:profile', payload: { id: 'same', name: 'B', apiKey: 'b' } });
    const first = await request(fixture.routes, { pathname: '/api/shops', scopeId: 'user-a:profile' });
    const second = await request(fixture.routes, { pathname: '/api/shops', scopeId: 'user-b:profile' });
    assert.equal(first.payload.shops[0].name, 'A');
    assert.equal(second.payload.shops[0].name, 'B');
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('reveals shop credentials only through the main-process internal route and exact scope', async () => {
  const fixture = createFixture();
  try {
    await request(fixture.routes, {
      method: 'POST', pathname: '/api/shops', scopeId: 'user-a:profile',
      payload: { id: 'shop-1', name: 'A', clientId: '10001', apiKey: 'temporary-key' },
    });
    const internal = await request(fixture.routes, {
      method: 'POST', pathname: '/v1/internal/shop-credentials/get', scopeId: 'user-a:profile', payload: { shopId: 'shop-1' },
    });
    assert.deepEqual(internal.payload.credentials, { clientId: '10001', apiKey: 'temporary-key' });
    await assert.rejects(
      request(fixture.routes, {
        method: 'POST', pathname: '/v1/internal/shop-credentials/get', scopeId: 'user-b:profile', payload: { shopId: 'shop-1' },
      }),
      { code: 'SHOP_NOT_FOUND' },
    );
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('keeps model relay credentials encrypted and exposes them only to the exact main-process scope', async () => {
  const fixture = createFixture();
  try {
    const first = await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/model-api/accounts',
      scopeId: 'user-a:profile',
      payload: {
        id: 'model-a',
        apiAlias: '主中转',
        websiteUrl: 'https://relay.example/dashboard',
        loginAccount: 'relay-user',
        loginPassword: 'relay-login-secret',
        apiKey: 'relay-api-secret',
        defaultModel: 'gpt-image-2',
        capabilities: ['image-generation'],
        isDefault: true,
      },
    });
    assert.equal(first.status, 200);
    assert.equal(first.payload.account.hasLoginPassword, true);
    assert.equal(first.payload.account.hasApiKey, true);
    assert.equal(JSON.stringify(first.payload).includes('relay-api-secret'), false);
    assert.match(first.payload.account.detectionStatus, /等待服务器/u);

    const updated = await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/model-api/accounts',
      scopeId: 'user-a:profile',
      payload: { id: 'model-a', apiAlias: '主中转已改名', quality: 'high' },
    });
    assert.equal(updated.payload.account.hasApiKey, true);
    const second = await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/model-api/accounts',
      scopeId: 'user-a:profile',
      payload: { id: 'model-b', apiAlias: '备用中转', apiKey: 'backup-api-secret', isDefault: true },
    });
    assert.equal(second.payload.account.isDefault, true);

    const list = await request(fixture.routes, {
      pathname: '/api/model-api/accounts', scopeId: 'user-a:profile',
    });
    assert.equal(list.payload.total, 2);
    assert.equal(list.payload.accounts[0].id, 'model-b');
    assert.equal(list.payload.accounts.find((account) => account.id === 'model-a').isDefault, false);
    assert.equal(JSON.stringify(list.payload).includes('relay-login-secret'), false);
    assert.equal(JSON.stringify(list.payload).includes('backup-api-secret'), false);

    const internal = await request(fixture.routes, {
      method: 'POST',
      pathname: '/v1/internal/model-api-credentials/get',
      scopeId: 'user-a:profile',
      payload: { accountId: 'model-a' },
    });
    assert.deepEqual(internal.payload.credentials, {
      loginAccount: 'relay-user',
      loginPassword: 'relay-login-secret',
      apiKey: 'relay-api-secret',
    });
    await assert.rejects(
      request(fixture.routes, {
        method: 'POST',
        pathname: '/v1/internal/model-api-credentials/get',
        scopeId: 'user-b:profile',
        payload: { accountId: 'model-a' },
      }),
      { code: 'MODEL_API_ACCOUNT_NOT_FOUND' },
    );
    const databaseBytes = fs.readFileSync(path.join(fixture.root, 'cache.sqlite')).toString('latin1');
    assert.equal(databaseBytes.includes('relay-login-secret'), false);
    assert.equal(databaseBytes.includes('relay-api-secret'), false);
    assert.equal(databaseBytes.includes('backup-api-secret'), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('stores profit ledger snapshots in the encrypted customer-local database', async () => {
  const fixture = createFixture();
  try {
    const snapshotKey = 'ozon-profit-ledger-v1:shop-a:2026-08';
    const saved = await request(fixture.routes, {
      method: 'PUT',
      pathname: '/api/profit/ledger-snapshot',
      payload: { snapshotKey, snapshot: { rows: [{ ledgerKey: 'secret-ledger-row' }] } },
    });
    assert.equal(saved.payload.source, 'sqlite');
    assert.equal(saved.payload.snapshot.rows[0].ledgerKey, 'secret-ledger-row');
    const read = await request(fixture.routes, {
      pathname: '/api/profit/ledger-snapshot',
      search: `keys=${encodeURIComponent(`missing,${snapshotKey}`)}`,
    });
    assert.equal(read.payload.snapshotKey, snapshotKey);
    assert.equal(read.payload.snapshot.rows[0].ledgerKey, 'secret-ledger-row');
    assert.equal(fs.readFileSync(path.join(fixture.root, 'cache.sqlite')).toString('latin1').includes('secret-ledger-row'), false);
    const removed = await request(fixture.routes, {
      method: 'DELETE',
      pathname: '/api/profit/ledger-snapshot',
      payload: { snapshotKeys: [snapshotKey] },
    });
    assert.deepEqual(removed.payload.stats, { changed: true, removedSnapshots: 1 });
    const after = await request(fixture.routes, {
      pathname: '/api/profit/ledger-snapshot',
      search: `keys=${encodeURIComponent(snapshotKey)}`,
    });
    assert.equal(after.payload.snapshot, null);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deduplicates profile assets and returns bytes only on an explicit scoped read', async () => {
  const fixture = createFixture();
  try {
    const dataBase64 = Buffer.from('profile-image-secret-bytes').toString('base64');
    const first = await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/profile-assets',
      payload: { mimeType: 'image/png', dataBase64, sourceType: 'smart-tool' },
    });
    const second = await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/profile-assets',
      payload: { mimeType: 'image/png', dataBase64, sourceType: 'smart-tool' },
    });
    assert.equal(first.payload.created, true);
    assert.equal(second.payload.created, false);
    assert.equal(second.payload.asset.id, first.payload.asset.id);
    assert.equal(Object.hasOwn(first.payload.asset, 'dataBase64'), false);
    const read = await request(fixture.routes, {
      pathname: `/api/profile-assets/${encodeURIComponent(first.payload.asset.id)}`,
    });
    assert.equal(read.payload.asset.dataBase64, dataBase64);
    const storedBytes = fs.readFileSync(
      path.join(fixture.root, 'assets', fixture.store.getAsset({
        scopeId: 'user-1:profile-1',
        assetId: first.payload.asset.id,
      }).relativePath),
    );
    assert.equal(storedBytes.includes(Buffer.from('profile-image-secret-bytes')), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('stages customer outbound files only in encrypted local assets', async () => {
  const fixture = createFixture();
  try {
    const marker = 'customer-private-image-marker';
    const staged = await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/customer-service/outbound-file/stage',
      payload: {
        shopId: 'shop-customer',
        chatId: 'chat-1',
        name: 'evidence.png',
        mimeType: 'image/png',
        base64Content: Buffer.from(marker).toString('base64'),
      },
    });
    assert.equal(staged.status, 200);
    assert.match(staged.payload.file.token, /^customer-file-/u);
    assert.equal(staged.payload.file.size, Buffer.byteLength(marker));
    const asset = fixture.store.readAsset({
      scopeId: 'user-1:profile-1',
      assetId: staged.payload.file.token,
    });
    assert.equal(asset.content.toString('utf8'), marker);
    const encrypted = fs.readFileSync(path.join(fixture.root, 'assets', asset.relativePath));
    assert.equal(encrypted.includes(Buffer.from(marker)), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('reads customer order route context from exact local purchase cache and exposes a bounded realtime cursor', async () => {
  const fixture = createFixture();
  try {
    await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/purchase/orders/overrides',
      payload: {
        shopId: 'shop-route',
        orderKey: 'posting-1',
        postingNumber: 'posting-1',
        purchaseOrderNumber: '1688-order-1',
      },
    });
    await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/purchase/source-links',
      payload: {
        shopId: 'shop-route',
        orderKey: 'posting-1',
        links: [{ url: 'https://supplier.invalid/order-1', platform: '1688' }],
      },
    });
    const context = await request(fixture.routes, {
      pathname: '/api/customer-service/order-route-context',
      search: 'shopId=shop-route&postingNumber=posting-1',
    });
    assert.equal(context.payload.purchaseRows.length, 1);
    assert.equal(context.payload.purchaseLinks.length, 1);
    assert.equal(context.payload.source, 'local-cache-agent');
    const realtime = await request(fixture.routes, {
      pathname: '/api/customer-service/realtime/wait',
      search: 'shopId=shop-route&afterSequence=0&timeoutMs=1000',
    });
    assert.deepEqual(
      { sequence: realtime.payload.sequence, changed: realtime.payload.changed, timedOut: realtime.payload.timedOut },
      { sequence: 0, changed: false, timedOut: true },
    );
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('cross-border client stores only an opaque server grant and rejects enterprise credentials', async () => {
  const fixture = createFixture();
  try {
    const authorizationRef = 'opaque-server-grant-marker';
    const saved = await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/logistics/cross-border/accounts',
      payload: {
        id: 'cross-border-1',
        name: '跨境巴士测试授权',
        status: 'active',
        authorizationRef,
        authorizationExpiresAt: '2026-09-30T00:00:00.000Z',
        shopIds: ['shop-1'],
      },
    });
    assert.equal(saved.payload.account.hasServerAuthorization, true);
    assert.equal(saved.payload.account.authorizationRef, authorizationRef);
    const listed = await request(fixture.routes, {
      pathname: '/api/logistics/cross-border/accounts',
    });
    assert.equal(listed.payload.rows.length, 1);
    assert.equal(listed.payload.rows[0].shopIds[0], 'shop-1');
    assert.equal(
      fs.readFileSync(path.join(fixture.root, 'cache.sqlite')).toString('latin1').includes(authorizationRef),
      false,
    );
    await assert.rejects(
      request(fixture.routes, {
        method: 'POST',
        pathname: '/api/logistics/cross-border/accounts',
        payload: {
          id: 'cross-border-bad',
          name: '禁止保存企业密钥',
          companySecret: 'must-never-enter-client-cache',
        },
      }),
      (error) => error?.code === 'CROSS_BORDER_ENTERPRISE_SECRET_FORBIDDEN',
    );
    await request(fixture.routes, {
      method: 'POST',
      pathname: '/api/logistics/cross-border/accounts',
      payload: {
        id: 'cross-border-2',
        name: '第二个独立授权',
        authorizationRef: 'opaque-server-grant-marker-2',
        shopIds: ['shop-2'],
      },
    });
    const multiAccountList = await request(fixture.routes, {
      pathname: '/api/logistics/cross-border/accounts',
    });
    assert.deepEqual(
      new Set(multiAccountList.payload.rows.map((account) => account.id)),
      new Set(['cross-border-1', 'cross-border-2']),
    );
    const deleted = await request(fixture.routes, {
      method: 'DELETE',
      pathname: '/api/logistics/cross-border/server-accounts/cross-border-1',
    });
    assert.equal(deleted.payload.deleted, true);
    const afterDelete = await request(fixture.routes, {
      pathname: '/api/logistics/cross-border/accounts',
    });
    assert.deepEqual(afterDelete.payload.rows.map((account) => account.id), ['cross-border-2']);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('publishes migration support only for compatibility routes with real handlers', () => {
  for (const [method, pathname] of [
    ['GET', '/api/model-api/accounts'],
    ['POST', '/api/shops'],
    ['PUT', '/api/profile-settings/prompt-library'],
    ['POST', '/api/profile-assets'],
    ['GET', '/api/profile-assets/profile-123'],
    ['GET', '/api/profit/ledger-snapshot'],
    ['PUT', '/api/profit/ledger-snapshot'],
    ['DELETE', '/api/profit/ledger-snapshot'],
    ['POST', '/api/customer-service/outbound-file/stage'],
    ['GET', '/api/customer-service/order-route-context'],
    ['GET', '/api/customer-service/realtime/wait'],
  ]) {
    assert.equal(supportsCompatibilityRoute(method, pathname), true, `${method} ${pathname}`);
  }
  assert.equal(supportsCompatibilityRoute('GET', '/api/unimplemented-route'), false);
});

test('keeps source links and purchase overrides encrypted, scoped and cursor-readable', async () => {
  const fixture = createFixture();
  try {
    const source = {
      shopId: 'shop-links',
      productKey: 'product-1',
      primaryIndex: 0,
      links: [{ url: 'https://supplier.invalid/item', title: '货源标题', sourceProductId: 'supplier-1' }],
    };
    const savedProduct = await request(fixture.routes, { method: 'POST', pathname: '/api/products/source-links', payload: source });
    assert.equal(savedProduct.payload.changed, 1);
    const productRows = await request(fixture.routes, { pathname: '/api/products/source-links', search: 'shopId=shop-links&productKey=product-1' });
    assert.equal(productRows.payload[0].sourceProductId, 'supplier-1');

    const purchase = await request(fixture.routes, {
      method: 'POST', pathname: '/api/purchase/source-links',
      payload: { shopId: 'shop-links', orderKey: 'order-1', links: [{ link: 'https://supplier.invalid/order', platform: '1688' }] },
    });
    assert.equal(purchase.payload.links.length, 1);
    const sales = await request(fixture.routes, {
      method: 'POST', pathname: '/api/sales/source-links',
      payload: { shopId: 'shop-links', orderKey: 'order-1', links: [{ link: 'https://supplier.invalid/sale', platform: '淘宝' }] },
    });
    assert.equal(sales.payload.rows.length, 1);

    const override = await request(fixture.routes, {
      method: 'POST', pathname: '/api/purchase/orders/overrides',
      payload: { shopId: 'shop-links', orderKey: 'order-1', purchaseOrderNumber: '1688-001', note: '本地覆盖' },
    });
    assert.equal(override.payload.override.purchaseOrderNumber, '1688-001');
    const listed = await request(fixture.routes, { pathname: '/api/purchase/orders/overrides', search: 'shopId=shop-links&orderKey=order-1' });
    assert.equal(listed.payload.rows[0].note, '本地覆盖');

    const otherScope = await request(fixture.routes, { pathname: '/api/products/source-links', scopeId: 'other-user:profile', search: 'shopId=shop-links' });
    assert.deepEqual(otherScope.payload, []);
    const databaseBytes = fs.readFileSync(path.join(fixture.root, 'cache.sqlite')).toString('latin1');
    assert.equal(databaseBytes.includes('supplier-1'), false);
    assert.equal(databaseBytes.includes('1688-001'), false);
  } finally {
    fixture.store.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
