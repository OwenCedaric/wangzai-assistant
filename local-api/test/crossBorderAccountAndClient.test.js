import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrossBorderClient } from '../src/cross-border/crossBorderClient.js';
import { assertCrossBorderReadEndpoint, listCrossBorderEndpoints } from '../src/cross-border/crossBorderEndpointRegistry.js';
import { createApp } from '../src/app/createApp.js';
import { createCrossBorderAccountRepository } from '../src/db/repositories/crossBorderAccountRepository.js';
import { createMigratedTestDb } from './testDb.js';

async function withServer(db, fn, crossBorderClient = { async requestReadOnly() { throw new Error('cross-border client was not expected'); } }) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: { async requestReadOnly() { throw new Error('cross-border account tests must not call Ozon'); } },
    crossBorderClient,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('cross-border account repository encrypts credentials and returns only flags publicly', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderAccountRepository(db);
    const saved = repository.saveAccount({
      id: 'cb-main',
      name: '跨境巴士主授权',
      ['company' + 'Secret']: 'company-credential-1',
      ['access' + 'Token']: 'credential-1',
      appUid: 'app-uid-1',
      status: 'active',
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.account.hasCompanySecret, true);
    assert.equal(saved.account.hasAccessToken, true);
    assert.equal(saved.account.hasAppUid, true);
    assert.equal(JSON.stringify(saved.account).includes('credential-1'), false);
    assert.equal(JSON.stringify(repository.listAccounts()).includes('company-credential-1'), false);

    const internal = repository.getCredentialsForInternalUse('cb-main');
    assert.equal(internal.companySecret, 'company-credential-1');
    assert.equal(internal.accessToken, 'credential-1');
    assert.equal(internal.appUid, 'app-uid-1');
  } finally {
    db.close();
  }
});

test('cross-border account HTTP routes save list and run real read-only connection test through local-api', async () => {
  const db = createMigratedTestDb();
  try {
    const calls = [];
    const fakeCrossBorderClient = {
      async requestReadOnly(input) {
        calls.push(input);
        return { ok: true, data: { code: 1, message: '用户授权正常' } };
      },
    };
    await withServer(db, async (base) => {
      const saveResponse = await fetch(`${base}/api/logistics/cross-border/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'cb-http',
          name: 'HTTP授权',
          ['company' + 'Secret']: 'credential-a',
          ['access' + 'Token']: 'credential-b',
          appUid: 'uid',
        }),
      });
      const savePayload = await saveResponse.json();
      assert.equal(saveResponse.status, 200);
      assert.equal(savePayload.account.hasAccessToken, true);
      assert.equal(JSON.stringify(savePayload).includes('credential-b'), false);

      const listPayload = await (await fetch(`${base}/api/logistics/cross-border/accounts`)).json();
      assert.equal(listPayload.rows.length, 1);
      assert.equal(JSON.stringify(listPayload).includes('credential-a'), false);

      const testResponse = await fetch(`${base}/api/logistics/cross-border/accounts/cb-http/test`, { method: 'POST' });
      const testPayload = await testResponse.json();
      assert.equal(testResponse.status, 200);
      assert.equal(testPayload.ok, true);
      assert.equal(testPayload.endpointKey, 'auth.queryAuthorization');
      assert.equal(testPayload.data.message, '用户授权正常');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].endpointKey, 'auth.queryAuthorization');
      assert.equal(calls[0].body.app_user_id, 'uid');
      assert.equal(calls[0].credentials.accessToken, 'credential-b');
      assert.equal(JSON.stringify(testPayload).includes('credential-b'), false);
    }, fakeCrossBorderClient);
  } finally {
    db.close();
  }
});

test('cross-border client obtains the enterprise token and authorizes a user with the official JSON contract', async () => {
  const calls = [];
  const client = createCrossBorderClient({
    baseUrl: 'https://example.invalid',
    transport: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/erpapi/token/index')) {
        return new Response(JSON.stringify({ code: 1, access_token: 'enterprise-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 1, message: '授权成功', app_uid: 903 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await client.authorizeUser({
    credentials: {
      companySecret: 'company-secret',
      userName: '15239990903',
      password: 'account-password',
    },
  });

  assert.equal(result.accessToken, 'enterprise-token');
  assert.equal(result.appUid, '903');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://example.invalid/erpapi/token/index');
  assert.deepEqual(JSON.parse(calls[0].options.body), { client_secret: 'company-secret' });
  assert.equal(calls[1].url, 'https://example.invalid/erpapi/user/authorization');
  assert.equal(calls[1].options.headers.authorization, 'enterprise-token');
  assert.equal(calls[1].options.headers['k-client-secret'], 'company-secret');
  assert.equal('k-app-uid' in calls[1].options.headers, false);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    user_name: '15239990903',
    password: 'account-password',
  });
});

test('cross-border client refreshes an expired stored enterprise token once before authorizing', async () => {
  const calls = [];
  const client = createCrossBorderClient({
    baseUrl: 'https://example.invalid',
    transport: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/erpapi/token/index')) {
        return new Response(JSON.stringify({ code: 1, access_token: 'fresh-token' }), { status: 200 });
      }
      if (options.headers.authorization === 'expired-token') {
        return new Response(JSON.stringify({ code: 0, message: 'token expired' }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 1, app_uid: 'fresh-app-uid' }), { status: 200 });
    },
  });

  const result = await client.authorizeUser({
    credentials: {
      companySecret: 'company-secret',
      accessToken: 'expired-token',
      userName: '15239990903',
      password: 'account-password',
    },
  });

  assert.equal(result.accessToken, 'fresh-token');
  assert.equal(result.appUid, 'fresh-app-uid');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.authorization, 'expired-token');
  assert.equal(calls[1].url, 'https://example.invalid/erpapi/token/index');
  assert.equal(calls[2].options.headers.authorization, 'fresh-token');
});

test('cross-border authorization route verifies and encrypts the returned account authorization without exposing secrets', async () => {
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderAccountRepository(db);
    repository.saveAccount({
      id: 'cb-authorize',
      name: '自动授权',
      userName: '15239990903',
      password: 'account-password',
      companySecret: 'company-secret',
      status: 'active',
    });
    const calls = [];
    const fakeCrossBorderClient = {
      async authorizeUser(input) {
        calls.push({ type: 'authorize', input });
        return { ok: true, accessToken: 'issued-token', appUid: 'issued-app-uid' };
      },
      async requestReadOnly(input) {
        calls.push({ type: 'verify', input });
        return { ok: true, data: { code: 1, message: '用户授权正常' } };
      },
    };

    await withServer(db, async (base) => {
      const response = await fetch(`${base}/api/logistics/cross-border/accounts/cb-authorize/authorize`, {
        method: 'POST',
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.verified, true);
      assert.equal(payload.account.hasAccessToken, true);
      assert.equal(payload.account.hasAppUid, true);
      assert.equal(payload.message, '用户授权正常');
      assert.equal(JSON.stringify(payload).includes('issued-token'), false);
      assert.equal(JSON.stringify(payload).includes('issued-app-uid'), false);
      assert.equal(JSON.stringify(payload).includes('account-password'), false);
      assert.equal(calls[0].input.credentials.userName, '15239990903');
      assert.equal(calls[1].input.body.app_user_id, 'issued-app-uid');
      const stored = repository.getCredentialsForInternalUse('cb-authorize');
      assert.equal(stored.accessToken, 'issued-token');
      assert.equal(stored.appUid, 'issued-app-uid');
    }, fakeCrossBorderClient);
  } finally {
    db.close();
  }
});

test('cross-border legacy HTTP delete is blocked until the unified removal flow is confirmed', async () => {
  const db = createMigratedTestDb();
  try {
    const repository = createCrossBorderAccountRepository(db);
    repository.saveAccount({
      id: 'cb-delete',
      name: '待删除授权',
      ['company' + 'Secret']: 'delete-company',
      ['access' + 'Token']: 'delete-token',
      appUid: 'delete-uid',
      status: 'active',
    });
    repository.saveAccount({
      id: 'cb-keep',
      name: '保留授权',
      ['company' + 'Secret']: 'keep-company',
      ['access' + 'Token']: 'keep-token',
      appUid: 'keep-uid',
      status: 'active',
    });

    await withServer(db, async (base) => {
      const deleteResponse = await fetch(`${base}/api/logistics/cross-border/accounts/cb-delete`, {
        method: 'DELETE',
      });
      const deletePayload = await deleteResponse.json();
      assert.equal(deleteResponse.status, 409);
      assert.equal(deletePayload.ok, false);
      assert.equal(deletePayload.completed, false);
      assert.equal(deletePayload.error.code, 'ACCOUNT_REMOVAL_LEGACY_ROUTE_PREVIEW_REQUIRED');
      assert.equal(JSON.stringify(deletePayload).includes('delete-token'), false);

      const listPayload = await (await fetch(`${base}/api/logistics/cross-border/accounts`)).json();
      assert.deepEqual(
        listPayload.rows.map((account) => account.id).sort(),
        ['cb-delete', 'cb-keep'],
      );
      assert.equal(repository.getCredentialsForInternalUse('cb-delete').accessToken, 'delete-token');
      assert.equal(repository.getCredentialsForInternalUse('cb-keep').accessToken, 'keep-token');
    });
  } finally {
    db.close();
  }
});

test('cross-border endpoint registry blocks write endpoints from read-only client', () => {
  const endpoints = listCrossBorderEndpoints();
  assert.ok(endpoints.find((endpoint) => endpoint.key === 'order.search' && endpoint.risk === 'read'));
  assert.ok(endpoints.find((endpoint) => endpoint.key === 'order.associate' && endpoint.risk === 'write'));
  assert.ok(endpoints.find((endpoint) => endpoint.key === 'order.syncStatus' && endpoint.risk === 'write'));
  assert.throws(() => assertCrossBorderReadEndpoint('order.create'), /not read-only/);
});

test('cross-border client sends read-only request with injected transport and redacts error payload', async () => {
  const calls = [];
  const client = createCrossBorderClient({
    baseUrl: 'https://example.invalid',
    transport: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ code: 0, message: 'bad credential', ['access_' + 'token']: 'leaked-credential' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await assert.rejects(
    () => client.requestReadOnly({
      endpointKey: 'order.search',
      credentials: { ['company' + 'Secret']: 'credential-a', ['access' + 'Token']: 'credential-b', appUid: 'uid' },
      body: { order_id: 'bus-1' },
    }),
    (error) => {
      assert.equal(error.code, 'CROSS_BORDER_API_ERROR');
      assert.equal(error.response.access_token, '[REDACTED]');
      assert.equal(JSON.stringify(error).includes('leaked-credential'), false);
      return true;
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.invalid/erpapi/orderlist/search');
  assert.equal(calls[0].options.headers.authorization, 'credential-b');
  assert.match(calls[0].options.body, /order_id=bus-1/);
});

test('cross-border client sends create-order payload as application/json', async () => {
  const calls = [];
  const client = createCrossBorderClient({
    baseUrl: 'https://example.invalid',
    transport: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ code: 1, data: [{ id: 'bus-1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await client.requestWrite({
    endpointKey: 'order.create',
    credentials: { ['company' + 'Secret']: 'credential-a', ['access' + 'Token']: 'credential-b', appUid: 'uid' },
    body: {
      sid: '362',
      order_data: [{ order_number: 'mz-1', package_list: [{ sku: 123 }] }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.invalid/erpapi/order/createOrder');
  assert.equal(calls[0].options.headers.authorization, 'credential-b');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sid: '362',
    order_data: [{ order_number: 'mz-1', package_list: [{ sku: 123 }] }],
  });
});
