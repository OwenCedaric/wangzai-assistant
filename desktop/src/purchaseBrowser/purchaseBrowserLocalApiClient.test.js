import assert from 'node:assert/strict';
import test from 'node:test';
import { createPurchaseBrowserLocalApiClient } from './purchaseBrowserLocalApiClient.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('pending browser cleanup reads durable operation status with a read-only authenticated route', async () => {
  let captured;
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152', authToken: 'fixture-local', purchaseBrowserToken: 'fixture-browser',
    fetchImpl: async (url, options) => { captured = { url: String(url), ...options }; return jsonResponse({ operationId: 'completed-op', completed: true }); },
  });
  assert.equal((await client.getAccountRemovalOperation('completed-op')).completed, true);
  assert.equal(captured.url, 'http://127.0.0.1:49152/api/account-removal/operations/completed-op');
  assert.equal(captured.method, 'GET');
  assert.equal(captured.body, undefined);
  assert.equal(captured.headers['x-wangzai-purchase-browser-token'], 'fixture-browser');
});

test('main-only client lists masked purchase accounts with an authenticated GET', async () => {
  const requests = [];
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        headers: options.headers,
        body: options.body,
      });
      return jsonResponse({
        ok: true,
        accounts: [{ id: 'purchase-a', platformUrl: 'https://www.1688.com/', isDefault: true }],
      });
    },
  });

  const payload = await client.listAccounts();

  assert.equal(payload.accounts[0].id, 'purchase-a');
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:49152/api/purchase/accounts',
    method: 'GET',
    headers: {
      'content-type': 'application/json',
      'x-wangzai-local-api-token': 'local-api-token',
      'x-wangzai-purchase-browser-token': 'main-only-browser-token',
    },
    body: undefined,
  }]);
});

test('main-only client lists integration profiles for Ozon browser prewarm', async () => {
  const requests = [];
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method });
      return jsonResponse({ ok: true, profiles: [{ id: 'ozon-a', integrationType: 'ozon-browser-session' }] });
    },
  });

  const payload = await client.listIntegrationProfiles();

  assert.equal(payload.profiles[0].id, 'ozon-a');
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:49152/api/integrations/profiles',
    method: 'GET',
  }]);
});

test('main-only client saves only verified purchase browser login metadata', async () => {
  let captured = null;
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async (url, options) => {
      captured = {
        url: String(url),
        headers: options.headers,
        body: JSON.parse(options.body),
      };
      return jsonResponse({
        ok: true,
        account: {
          id: 'purchase/login-a',
          cookieStatus: 'Cookie 已保存',
          lastLoginVerifiedAt: '2026-08-11T08:30:00.000Z',
        },
      });
    },
  });

  const payload = await client.savePurchaseAccountLoginStatus('purchase/login-a', {
    loggedIn: true,
    cookieSaved: true,
    verifiedAt: '2026-08-11T08:30:00.000Z',
  });

  assert.equal(payload.account.cookieStatus, 'Cookie 已保存');
  assert.equal(captured.url, 'http://127.0.0.1:49152/api/internal/purchase-browser/accounts/purchase%2Flogin-a/login-status');
  assert.equal(captured.headers['x-wangzai-purchase-browser-token'], 'main-only-browser-token');
  assert.deepEqual(captured.body, {
    loggedIn: true,
    cookieSaved: true,
    verifiedAt: '2026-08-11T08:30:00.000Z',
  });
});

test('main-only client persists and invalidates Ozon integration profile login metadata', async () => {
  const requests = [];
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url: String(url), body, headers: options.headers });
      const connected = body.loggedIn === true && body.cookieSaved === true;
      return jsonResponse({
        ok: true,
        connected,
        profile: {
          id: 'ozon/profile-a',
          configStatus: connected ? '连接成功' : '需要重新登录',
          tokenStatus: connected ? 'Cookie 已保存' : 'Cookie 已失效',
        },
      });
    },
  });

  const connected = await client.saveIntegrationProfileLoginStatus('ozon/profile-a', {
    loggedIn: true,
    cookieSaved: true,
    verifiedAt: '2026-08-12T01:45:00.000Z',
  });
  const invalidated = await client.saveIntegrationProfileLoginStatus('ozon/profile-a', {
    loggedIn: false,
    cookieSaved: false,
    verifiedAt: '2026-08-12T02:00:00.000Z',
  });

  assert.equal(connected.profile.tokenStatus, 'Cookie 已保存');
  assert.equal(invalidated.profile.tokenStatus, 'Cookie 已失效');
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    'http://127.0.0.1:49152/api/internal/purchase-browser/integration-profiles/ozon%2Fprofile-a/login-status',
  );
  assert.equal(requests[0].headers['x-wangzai-purchase-browser-token'], 'main-only-browser-token');
});

test('Ozon login-state persistence retries transient local transport failures before succeeding', async () => {
  let attempts = 0;
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    transportRetryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
        });
      }
      return jsonResponse({
        ok: true,
        connected: true,
        profile: {
          id: 'ozon/profile-retry',
          configStatus: '连接成功',
          tokenStatus: 'Cookie 已保存',
        },
      });
    },
  });

  const result = await client.saveIntegrationProfileLoginStatus('ozon/profile-retry', {
    loggedIn: true,
    cookieSaved: true,
    verifiedAt: '2026-08-17T12:07:39.000Z',
  });

  assert.equal(result.connected, true);
  assert.equal(attempts, 3);
});

test('Ozon login-state persistence exposes a stable transport code after bounded retries', async () => {
  let attempts = 0;
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    transportRetryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
      });
    },
  });

  await assert.rejects(
    client.saveIntegrationProfileLoginStatus('ozon/profile-failed', {
      loggedIn: true,
      cookieSaved: true,
      verifiedAt: '2026-08-17T12:07:39.000Z',
    }),
    (error) => {
      assert.equal(error.code, 'PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED');
      assert.equal(error.causeCode, 'ECONNREFUSED');
      assert.equal(error.attempts, 3);
      return true;
    },
  );
  assert.equal(attempts, 3);
});

test('ten capture requests stop immediately when their browser command is cancelled', async () => {
  let attempts = 0;
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async (_url, options) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  for (let index = 0; index < 10; index += 1) {
    const controller = new AbortController();
    const request = client.previewPurchaseCapture({ target: { targetId: `target-${index}` } }, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(request, (error) => {
      assert.equal(error.code, 'PURCHASE_BROWSER_LOCAL_API_TRANSPORT_FAILED');
      assert.equal(error.causeCode, 'PURCHASE_BROWSER_COMMAND_CANCELLED');
      return true;
    });
  }
  assert.equal(attempts, 10);
});

test('main-only client requests an isolated integration-profile browser binding', async () => {
  let captured = null;
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), body: JSON.parse(options.body) };
      return jsonResponse({
        ok: true,
        binding: {
          accountId: 'integration-ozon-a',
          accountIncarnation: '2026-07-21T00:00:00.000Z',
          platformName: 'Ozon',
          ownerType: 'integration_profile',
        },
      });
    },
  });

  const payload = await client.getOwnerBinding('integration-ozon-a', 'integration_profile');

  assert.equal(payload.binding.platformName, 'Ozon');
  assert.equal(captured.url, 'http://127.0.0.1:49152/api/internal/purchase-browser/account-binding');
  assert.deepEqual(captured.body, {
    accountId: 'integration-ozon-a',
    ownerType: 'integration_profile',
  });
});

test('main-only client records the physical purge receipt and finalizes the durable operation challenge', async () => {
  const requests = [];
  const resourceIds = [
    'backup:remote-recovery-owner-purchase-account',
    'browser:purchase-cookies',
    'filesystem:diagnostic-logs-owner-purchase-account',
  ];
  const fetchImpl = async (url, options) => {
    const request = {
      url: String(url),
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.parse(options.body) : null,
    };
    requests.push(request);
    if (request.url.endsWith('/api/internal/purchase-browser/account-removal/receipt')) {
      return jsonResponse({ ok: true, verified: true });
    }
    if (request.url.endsWith('/api/account-removal/operations/removal-op-1')) {
      return jsonResponse({
        ok: true,
        operationId: 'removal-op-1',
        completed: false,
        requiresClientCleanup: true,
        previewFingerprint: 'a'.repeat(64),
        clientCleanup: { nonce: 'cleanup-nonce-1', resourceIds },
      });
    }
    if (request.url.endsWith('/api/account-removal/client-verify')) {
      return jsonResponse({ ok: true, completed: true, operationId: 'removal-op-1' });
    }
    throw new Error(`unexpected request: ${request.url}`);
  };
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl,
  });
  const proof = {
    verified: true,
    ownerRef: 'b'.repeat(40),
    resourceIds: ['browser:purchase-cookies'],
    partitionUnavailable: true,
    profileAbsent: true,
    artifactsAbsent: true,
    receiptBinding: {
      version: 'purchase-browser-removal-receipt-v2', operationId: 'removal-op-1',
      nonce: 'cleanup-nonce-1', ownerGenerationHash: 'a'.repeat(64),
    },
  };

  await client.recordAccountRemovalReceipt('removal-op-1', proof);
  const finalized = await client.finalizeAccountRemoval('removal-op-1');

  assert.equal(finalized.completed, true);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.headers['x-wangzai-local-api-token'], 'local-api-token');
    assert.equal(request.headers['x-wangzai-purchase-browser-token'], 'main-only-browser-token');
    assert.equal(JSON.stringify(request.body || {}).includes('main-only-browser-token'), false);
  }
  assert.deepEqual(requests[0].body, { operationId: 'removal-op-1', proof });
  assert.equal(requests[1].method, 'GET');
  assert.deepEqual(requests[2].body, {
    operationId: 'removal-op-1',
    nonce: 'cleanup-nonce-1',
    previewFingerprint: 'a'.repeat(64),
    resourceObservations: resourceIds.map((resourceId) => ({ resourceId, state: 'absent' })),
  });
});

test('finalization fails closed when the durable operation has no client-cleanup challenge', async () => {
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async () => jsonResponse({
      ok: true,
      operationId: 'removal-op-2',
      completed: false,
      requiresClientCleanup: false,
    }),
  });
  await assert.rejects(
    client.finalizeAccountRemoval('removal-op-2'),
    /PURCHASE_BROWSER_ACCOUNT_REMOVAL_FINALIZE_INVALID/u,
  );
});

test('cross-border charge client sends tenant/user/shop scope headers and keeps preview/confirm separate', async () => {
  const requests = [];
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    tenantId: 'tenant-a',
    userId: 'user-a',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
      return jsonResponse({ ok: true, previewId: 'preview-a', confirmationToken: 'token-a', readbackVerified: true });
    },
  });

  await client.previewCrossBorderCharges({ browserAccountRef: 'browser-a', charges: [{ oid: '1', money: 1, type: 'expense' }] }, { shopId: 'shop-a' });
  await client.confirmCrossBorderCharges({ previewId: 'preview-a', confirmationToken: 'token-a' });

  assert.equal(requests[0].url, 'http://127.0.0.1:49152/api/logistics/cross-border/charges/preview');
  assert.equal(requests[0].headers['x-wangzai-tenant-id'], 'tenant-a');
  assert.equal(requests[0].headers['x-wangzai-user-id'], 'user-a');
  assert.equal(requests[0].headers['x-wangzai-shop-id'], 'shop-a');
  assert.equal(requests[1].url, 'http://127.0.0.1:49152/api/logistics/cross-border/charges/confirm');
  assert.equal(requests[1].headers['x-wangzai-shop-id'], undefined);
  assert.equal(JSON.stringify(requests.map((request) => request.body)).includes('main-only-browser-token'), false);
});

test('main-only client keeps PDD refund preview and confirmation on separate authenticated routes', async () => {
  const requests = [];
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
      return jsonResponse({ ok: true, previewId: 'refund-preview', confirmationToken: 'refund-token' });
    },
  });

  await client.previewPurchaseRefund({ target: { shopId: 'shop-a' }, capture: { platform: '拼多多' } });
  await client.confirmPurchaseRefund({ previewId: 'refund-preview', confirmationToken: 'refund-token' });

  assert.deepEqual(requests.map((item) => item.url), [
    'http://127.0.0.1:49152/api/purchase/browser-capture/refund/preview',
    'http://127.0.0.1:49152/api/purchase/browser-capture/refund/confirm',
  ]);
  assert.deepEqual(requests.map((item) => item.method), ['POST', 'POST']);
});

test('main-only client mirrors exact plugin logistics into purchase overrides and cross-border records', async () => {
  const requests = [];
  const client = createPurchaseBrowserLocalApiClient({
    baseUrl: 'http://127.0.0.1:49152',
    authToken: 'local-api-token',
    purchaseBrowserToken: 'main-only-browser-token',
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
      });
      return jsonResponse({ ok: true, rows: [] });
    },
  });

  await client.listPurchaseOrderOverrides({ keyword: '3316981152254029783', limit: 200 });
  await client.savePurchaseOrderOverride({
    shopId: 'shop-a',
    orderKey: '4097603:64720469-0563-1',
    domesticTrackingNumber: '79028134877723',
  });
  await client.saveCrossBorderOrderRecord({
    shopId: 'shop-a',
    recordKey: '64720469-0563-1:79028134877723',
    trackingNumber: '79028134877723',
  });

  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ['GET', 'http://127.0.0.1:49152/api/purchase/orders/overrides?keyword=3316981152254029783&limit=200'],
    ['POST', 'http://127.0.0.1:49152/api/purchase/orders/overrides'],
    ['POST', 'http://127.0.0.1:49152/api/logistics/cross-border/orders'],
  ]);
  assert.equal(requests[1].body.domesticTrackingNumber, '79028134877723');
  assert.equal(requests[2].body.trackingNumber, '79028134877723');
});
