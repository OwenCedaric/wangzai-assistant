import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectionPricingOwnerScopeFromSession,
  proxyCustomerChatFile,
  proxyProductImageThumbnail,
  proxyPurchaseBridgeImage,
  registerAppProtocol,
} from './appProtocol.js';

function registerTestProtocol(localDataRoot, {
  ownerSession = { authenticated: true, user: { id: 'user-a' } },
} = {}) {
  let handler;
  const protocol = {
    isProtocolHandled: () => false,
    handle: (_scheme, nextHandler) => {
      handler = nextHandler;
    },
  };
  registerAppProtocol({
    protocol,
    appHost: 'wangzai',
    frontendDist: localDataRoot,
    localDataRoot,
    purchaseBridge: null,
    getCollectionPricingOwnerSession: async () => ownerSession,
  });
  return handler;
}

test('purchase image protocol keeps capability in the main process', async () => {
  let captured;
  const response = await proxyPurchaseBridgeImage({
    requestUrl: new URL('app://wangzai/purchase-image?url=https%3A%2F%2Fimg.example%2Fa.jpg'),
    purchaseBridge: { baseUrl: 'http://127.0.0.1:3788', authToken: 'test-capability' },
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(captured.options.headers['X-Wangzai-Purchase-Token'], 'test-capability');
  assert.equal(
    captured.url,
    'http://127.0.0.1:3788/api/purchase/image-proxy?url=https%3A%2F%2Fimg.example%2Fa.jpg',
  );
});

test('purchase image protocol rejects non-http URLs before fetch', async () => {
  const response = await proxyPurchaseBridgeImage({
    requestUrl: new URL('app://wangzai/purchase-image?url=file%3A%2F%2F%2FC%3A%2Fsecret'),
    purchaseBridge: { baseUrl: 'http://127.0.0.1:3788' },
    fetchImpl: async () => assert.fail('must not fetch'),
  });
  assert.equal(response.status, 400);
});

test('product image thumbnail protocol keeps local-api auth in the main process and returns cacheable binary WebP', async () => {
  let captured;
  const response = await proxyProductImageThumbnail({
    request: new Request('app://wangzai/api/product-images/assets/pimg_asset-1/thumbnail?shopId=shop-1&v=v1'),
    requestUrl: new URL('app://wangzai/api/product-images/assets/pimg_asset-1/thumbnail?shopId=shop-1&v=v1'),
    localApi: {
      baseUrl: 'http://127.0.0.1:3790',
      authToken: 'local-api-private-token-which-is-long-enough',
    },
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: {
          'content-type': 'image/webp',
          'cache-control': 'private, max-age=86400, immutable',
          etag: '"thumb-etag"',
        },
      });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'http://127.0.0.1:3790/api/product-images/assets/pimg_asset-1/thumbnail?shopId=shop-1&v=v1');
  assert.equal(captured.options.headers['x-wangzai-local-api-token'], 'local-api-private-token-which-is-long-enough');
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=86400, immutable');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii'), 'RIFF');
});

test('customer chat image protocol keeps local-api auth private and forwards only the exact Ozon image route', async () => {
  let captured;
  const remoteUrl = 'https://api-seller.ozon.ru/v2/chat/file/messenger/a.jpg';
  const requestUrl = new URL(
    `app://wangzai/api/customer-service/chat-file?shopId=shop-2&url=${encodeURIComponent(remoteUrl)}`,
  );
  const response = await proxyCustomerChatFile({
    request: new Request(requestUrl),
    requestUrl,
    localApi: {
      baseUrl: 'http://127.0.0.1:3790',
      authToken: 'local-api-private-token-which-is-long-enough',
    },
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(captured.options.headers['x-wangzai-local-api-token'], 'local-api-private-token-which-is-long-enough');
  assert.equal(
    captured.url,
    `http://127.0.0.1:3790/api/customer-service/chat-file?shopId=shop-2&url=${encodeURIComponent(remoteUrl)}`,
  );
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
});

test('customer chat image protocol rejects non-Ozon image hosts before local-api fetch', async () => {
  const requestUrl = new URL(
    'app://wangzai/api/customer-service/chat-file?shopId=shop-2&url=https%3A%2F%2Fexample.com%2Fv2%2Fchat%2Ffile%2Fa.jpg',
  );
  const response = await proxyCustomerChatFile({
    request: new Request(requestUrl),
    requestUrl,
    localApi: { baseUrl: 'http://127.0.0.1:3790', authToken: 'private-token' },
    fetchImpl: async () => assert.fail('foreign URL must not be forwarded'),
  });
  assert.equal(response.status, 400);
});

test('registered app protocol routes product thumbnails through the authenticated binary proxy instead of the SPA fallback', async () => {
  let handler;
  let captured;
  const protocol = {
    isProtocolHandled: () => false,
    handle: (_scheme, nextHandler) => { handler = nextHandler; },
  };
  registerAppProtocol({
    protocol,
    appHost: 'wangzai',
    frontendDist: 'C:/fixture/frontend',
    localDataRoot: 'C:/fixture/local-data',
    purchaseBridge: null,
    localApi: { baseUrl: 'http://127.0.0.1:3790', authToken: 'local-api-private-token-which-is-long-enough' },
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400, immutable' },
      });
    },
  });
  const response = await handler(new Request('app://wangzai/api/product-images/assets/pimg_asset-2/thumbnail?shopId=shop-2&v=v1'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /image\/webp/u);
  assert.equal(captured.url, 'http://127.0.0.1:3790/api/product-images/assets/pimg_asset-2/thumbnail?shopId=shop-2&v=v1');
});

test('app protocol replaces its handler after recovery restarts local services', () => {
  const calls = [];
  const protocol = {
    isProtocolHandled: (scheme) => scheme === 'app',
    unhandle: (scheme) => calls.push(['unhandle', scheme]),
    handle: (scheme, handler) => calls.push(['handle', scheme, typeof handler]),
  };
  registerAppProtocol({
    protocol,
    appHost: 'wangzai',
    frontendDist: 'C:/fixture/frontend',
    localDataRoot: 'C:/fixture/local-data',
    purchaseBridge: { baseUrl: 'http://127.0.0.1:3788' },
  });
  assert.deepEqual(calls, [
    ['unhandle', 'app'],
    ['handle', 'app', 'function'],
  ]);
});

test('missing hashed assets return 404 instead of the SPA html fallback', async () => {
  const frontendDist = await mkdtemp(path.join(tmpdir(), 'wangzai-protocol-static-'));
  try {
    await writeFile(path.join(frontendDist, 'index.html'), '<!doctype html><main>app shell</main>', 'utf8');
    const handler = registerTestProtocol(frontendDist);

    const chunkResponse = await handler(new Request('app://wangzai/assets/OrdersPage-old-hash.js'));
    assert.equal(chunkResponse.status, 404);
    assert.match(chunkResponse.headers.get('content-type') || '', /javascript/u);
    assert.equal(await chunkResponse.text(), 'Static asset not found');

    const routeResponse = await handler(new Request('app://wangzai/orders'));
    assert.equal(routeResponse.status, 200);
    assert.match(routeResponse.headers.get('content-type') || '', /text\/html/u);
    assert.match(await routeResponse.text(), /app shell/u);
  } finally {
    await rm(frontendDist, { recursive: true, force: true });
  }
});

test('retired purchase plugin context is not available through generic local-data and accepts only a migration marker', async () => {
  const localDataRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-protocol-retired-plugin-'));
  let handler;
  const protocol = {
    isProtocolHandled: () => false,
    handle: (_scheme, nextHandler) => {
      handler = nextHandler;
    },
  };
  try {
    registerAppProtocol({
      protocol,
      appHost: 'wangzai',
      frontendDist: localDataRoot,
      localDataRoot,
      purchaseBridge: null,
    });
    const genericResponse = await handler(new Request('app://wangzai/local-data-api/purchase-source-plugin-context'));
    assert.equal(genericResponse.status, 410);

    const marker = {
      migration: 'profile-settings',
      namespace: 'purchase-plugin-context',
      migratedAt: '2026-07-13T00:00:00.000Z',
    };
    const markerResponse = await handler(new Request('app://wangzai/legacy-migration-api/purchase-source-plugin-context', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(marker),
    }));
    assert.equal(markerResponse.status, 200);
    const readbackResponse = await handler(new Request('app://wangzai/legacy-migration-api/purchase-source-plugin-context'));
    assert.equal(readbackResponse.status, 200);
    assert.deepEqual((await readbackResponse.json()).data, marker);

    const rejectedResponse = await handler(new Request('app://wangzai/legacy-migration-api/purchase-source-plugin-context', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { offerId: 'must-not-write-runtime-json' } }),
    }));
    assert.equal(rejectedResponse.status, 400);
  } finally {
    await rm(localDataRoot, { recursive: true, force: true });
  }
});

test('every former generic business JSON route is frozen and cannot recreate a cache file', async () => {
  const localDataRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-protocol-generic-json-frozen-'));
  try {
    const handler = registerTestProtocol(localDataRoot);
    const readResponse = await handler(new Request('app://wangzai/local-data-api/purchase-source-links'));
    const writeResponse = await handler(new Request('app://wangzai/local-data-api/purchase-source-links', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'shop-1:order-1': { links: [] } }),
    }));

    assert.equal(readResponse.status, 410);
    assert.equal(writeResponse.status, 410);
    await assert.rejects(
      () => readFile(path.join(localDataRoot, '分类缓存/07-拍单采购/purchase-source-links.json'), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(localDataRoot, { recursive: true, force: true });
  }
});

test('collection pricing draft migrates once and keeps user scopes independent across restart', async () => {
  const localDataRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-protocol-collection-pricing-'));
  const legacyFilePath = path.join(localDataRoot, '分类缓存/17-采集核价/collection-pricing-draft.json');
  const scopedPath = (scope) => path.join(
    localDataRoot,
    '分类缓存/17-采集核价/scopes',
    `${createHash('sha256').update(scope, 'utf8').digest('hex')}.json`,
  );
  try {
    const firstHandler = registerTestProtocol(localDataRoot);
    const attackerResponse = await firstHandler(new Request('app://wangzai/collection-pricing-draft-api?scope=user-b'));
    assert.equal(attackerResponse.status, 403);
    assert.equal((await attackerResponse.json()).code, 'COLLECTION_PRICING_DRAFT_OWNER_MISMATCH');
    const product = {
      id: '1688:907805856885',
      title: '采集商品',
      sourceUrl: 'https://detail.1688.com/offer/907805856885.html',
      skus: [{ id: 'sku-1' }],
      mainImages: ['https://img.example/main.jpg'],
    };
    const legacy = { schemaVersion: 1, savedAt: '2026-08-03T00:00:00.000Z', items: [product] };
    await mkdir(path.dirname(legacyFilePath), { recursive: true });
    await writeFile(legacyFilePath, JSON.stringify(legacy), 'utf8');

    const migratedResponse = await firstHandler(new Request('app://wangzai/collection-pricing-draft-api'));
    assert.equal(migratedResponse.status, 200);
    const migrated = (await migratedResponse.json()).data;
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.items, [product]);
    assert.deepEqual(JSON.parse(await readFile(scopedPath('user-a'), 'utf8')), migrated);

    const restartedHandler = registerTestProtocol(localDataRoot);
    const readResponse = await restartedHandler(new Request('app://wangzai/collection-pricing-draft-api?scope=user-a&shopId=shop-b'));
    assert.equal(readResponse.status, 200);
    assert.deepEqual((await readResponse.json()).data, migrated);

    const cleared = { schemaVersion: 2, savedAt: '2026-08-03T00:01:00.000Z', items: [] };
    const clearResponse = await restartedHandler(new Request('app://wangzai/collection-pricing-draft-api?scope=user-a', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cleared),
    }));
    assert.equal(clearResponse.status, 200);
    assert.deepEqual(JSON.parse(await readFile(scopedPath('user-a'), 'utf8')), cleared);

    const otherUserHandler = registerTestProtocol(localDataRoot, {
      ownerSession: { authenticated: true, user: { id: 'user-b' } },
    });
    const otherScopeResponse = await otherUserHandler(new Request('app://wangzai/collection-pricing-draft-api?scope=user-b'));
    assert.equal(otherScopeResponse.status, 200);
    assert.deepEqual((await otherScopeResponse.json()).data, { schemaVersion: 2, savedAt: '', items: [] });
  } finally {
    await rm(localDataRoot, { recursive: true, force: true });
  }
});

test('collection pricing owner uses only the authenticated stable user id', () => {
  assert.equal(collectionPricingOwnerScopeFromSession({
    authenticated: true,
    user: { id: 51, email: 'owner@example.com', username: 'owner-name' },
  }), '51');
  assert.equal(collectionPricingOwnerScopeFromSession({
    authenticated: true,
    user: { userId: 'stable-user', email: 'owner@example.com' },
  }), 'stable-user');
  assert.equal(collectionPricingOwnerScopeFromSession({
    authenticated: true,
    user: { email: 'owner@example.com', username: 'owner-name' },
  }), '');
  assert.equal(collectionPricingOwnerScopeFromSession({
    authenticated: false,
    user: { id: 51 },
  }), '');
});

test('collection pricing draft rejects requests without an authenticated owner', async () => {
  const localDataRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-protocol-collection-owner-'));
  try {
    const handler = registerTestProtocol(localDataRoot, { ownerSession: null });
    const response = await handler(new Request('app://wangzai/collection-pricing-draft-api?scope=user-a'));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'COLLECTION_PRICING_DRAFT_OWNER_REQUIRED');
  } finally {
    await rm(localDataRoot, { recursive: true, force: true });
  }
});

test('retired marketing cache rejects generic data writes and CAS conflict preserves the newer source', async () => {
  const localDataRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-protocol-retired-marketing-conflict-'));
  const cacheDirectory = path.join(localDataRoot, '分类缓存/12-营销活动');
  const cacheFilePath = path.join(cacheDirectory, 'marketing-activity-cache.json');
  const sourceA = {
    'shop-a': {
      activityRows: [{ id: 'activity-a', sourceType: 'official' }],
      productPool: [],
    },
  };
  const sourceB = {
    'shop-a': {
      activityRows: [{ id: 'activity-a', sourceType: 'seller' }],
      productPool: [{ id: 'product-b' }],
    },
  };
  try {
    const handler = registerTestProtocol(localDataRoot);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(cacheFilePath, JSON.stringify(sourceA), 'utf8');

    const genericResponse = await handler(new Request('app://wangzai/local-data-api/marketing-activity-cache'));
    assert.equal(genericResponse.status, 410);
    const genericWriteResponse = await handler(new Request('app://wangzai/local-data-api/marketing-activity-cache', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sourceB),
    }));
    assert.equal(genericWriteResponse.status, 410);
    assert.deepEqual(JSON.parse(await readFile(cacheFilePath, 'utf8')), sourceA);

    const readResponse = await handler(new Request('app://wangzai/legacy-migration-api/marketing-activity-cache'));
    assert.equal(readResponse.status, 200);
    const readPayload = await readResponse.json();
    assert.equal(readPayload.ok, true);
    assert.equal(readPayload.exists, true);
    assert.deepEqual(readPayload.data, sourceA);
    assert.match(readPayload.revision, /^[a-f0-9]{64}$/u);

    const businessPayloadResponse = await handler(new Request('app://wangzai/legacy-migration-api/marketing-activity-cache', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: readPayload.revision, data: sourceA }),
    }));
    assert.equal(businessPayloadResponse.status, 400);

    // Simulate a newer legacy writer after the renderer's GET and before its
    // cleanup request.  The conditional clear must leave B intact.
    await writeFile(cacheFilePath, JSON.stringify(sourceB), 'utf8');
    const conflictResponse = await handler(new Request('app://wangzai/legacy-migration-api/marketing-activity-cache', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: readPayload.revision }),
    }));
    assert.equal(conflictResponse.status, 409);
    assert.deepEqual(await conflictResponse.json(), {
      ok: false,
      code: 'LEGACY_SOURCE_CHANGED',
    });
    assert.deepEqual(JSON.parse(await readFile(cacheFilePath, 'utf8')), sourceB);
  } finally {
    await rm(localDataRoot, { recursive: true, force: true });
  }
});

test('retired marketing cache CAS revision is based on original raw bytes, not parsed JSON', async () => {
  const localDataRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-protocol-retired-marketing-raw-revision-'));
  const cacheDirectory = path.join(localDataRoot, '分类缓存/12-营销活动');
  const cacheFilePath = path.join(cacheDirectory, 'marketing-activity-cache.json');
  const source = {
    'shop-a': {
      activityRows: [{ id: 'activity-a', sourceType: 'seller' }],
      productPool: [{ id: 'product-a' }],
    },
  };
  try {
    const handler = registerTestProtocol(localDataRoot);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(cacheFilePath, JSON.stringify(source), 'utf8');

    const readResponse = await handler(new Request('app://wangzai/legacy-migration-api/marketing-activity-cache'));
    const readPayload = await readResponse.json();
    const sameDataDifferentBytes = `${JSON.stringify(source, null, 2)}\n`;
    await writeFile(cacheFilePath, sameDataDifferentBytes, 'utf8');

    const clearResponse = await handler(new Request('app://wangzai/legacy-migration-api/marketing-activity-cache', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: readPayload.revision }),
    }));
    assert.equal(clearResponse.status, 409);
    assert.deepEqual(await clearResponse.json(), {
      ok: false,
      code: 'LEGACY_SOURCE_CHANGED',
    });
    assert.equal(await readFile(cacheFilePath, 'utf8'), sameDataDifferentBytes);
  } finally {
    await rm(localDataRoot, { recursive: true, force: true });
  }
});

test('retired marketing cache conditional clear deletes only the exact readback revision', async () => {
  const localDataRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-protocol-retired-marketing-success-'));
  const cacheDirectory = path.join(localDataRoot, '分类缓存/12-营销活动');
  const cacheFilePath = path.join(cacheDirectory, 'marketing-activity-cache.json');
  const source = {
    'shop-a': {
      activityRows: [{ id: 'activity-a', sourceType: 'seller' }],
      productPool: [{ id: 'product-a' }],
    },
  };
  try {
    const handler = registerTestProtocol(localDataRoot);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(cacheFilePath, JSON.stringify(source), 'utf8');

    const initialRead = await handler(new Request('app://wangzai/legacy-migration-api/marketing-activity-cache'));
    const initialPayload = await initialRead.json();
    const clearResponse = await handler(new Request('app://wangzai/legacy-migration-api/marketing-activity-cache', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: initialPayload.revision }),
    }));
    assert.equal(clearResponse.status, 200);
    assert.deepEqual(await clearResponse.json(), { ok: true, data: {} });
    await assert.rejects(() => readFile(cacheFilePath, 'utf8'), { code: 'ENOENT' });

    const emptyRead = await handler(new Request('app://wangzai/legacy-migration-api/marketing-activity-cache'));
    assert.equal(emptyRead.status, 200);
    const emptyPayload = await emptyRead.json();
    assert.equal(emptyPayload.ok, true);
    assert.equal(emptyPayload.exists, false);
    assert.deepEqual(emptyPayload.data, {});
    assert.match(emptyPayload.revision, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(localDataRoot, { recursive: true, force: true });
  }
});
