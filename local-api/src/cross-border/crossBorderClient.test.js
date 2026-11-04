import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrossBorderClient } from './crossBorderClient.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('enterprise token reads and returns the refresh token on first generation', async () => {
  const calls = [];
  const client = createCrossBorderClient({
    transport: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({ code: 1, data: { access_token: 'access-1', expires_token: 'expires-1', expires_in: 15552000 } });
    },
  });

  const result = await client.requestEnterpriseToken({ companySecret: 'company-secret' });

  assert.equal(calls[0].url.endsWith('/erpapi/token/index'), true);
  assert.deepEqual(calls[0].body, { client_secret: 'company-secret' });
  assert.equal(result.accessToken, 'access-1');
  assert.equal(result.expiresToken, 'expires-1');
  assert.equal(result.expiresIn, '15552000');
  assert.equal(result.tokenSource, 'initial');
});

test('enterprise token uses the saved expires token for refresh', async () => {
  const calls = [];
  const client = createCrossBorderClient({
    transport: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({ code: 1, access_token: 'access-2', expires_token: 'expires-2' });
    },
  });

  const result = await client.requestEnterpriseToken({
    companySecret: 'company-secret',
    expiresToken: 'expires-1',
  });

  assert.equal(calls[0].url.endsWith('/erpapi/token/refresh'), true);
  assert.deepEqual(calls[0].body, { client_secret: 'company-secret', expires_token: 'expires-1' });
  assert.equal(result.accessToken, 'access-2');
  assert.equal(result.expiresToken, 'expires-2');
  assert.equal(result.tokenSource, 'refresh');
});

test('explicit authorization resets an already-generated token once and persists the returned lifecycle values', async () => {
  const calls = [];
  const client = createCrossBorderClient({
    transport: async (url, options) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, headers: options.headers, body: JSON.parse(options.body) });
      if (path === '/erpapi/user/authorization' && options.headers.authorization === 'stale-access') {
        return jsonResponse({ code: 0, message: 'token invalid' }, 401);
      }
      if (path === '/erpapi/token/index') {
        return jsonResponse({ code: 0, message: '您已经生成Token,请使用expires_token获取最新Token' }, 401);
      }
      if (path === '/erpapi/token/resettoken') {
        return jsonResponse({ code: 1, data: { access_token: 'fresh-access', expires_token: 'fresh-expires' } });
      }
      if (path === '/erpapi/user/authorization' && options.headers.authorization === 'fresh-access') {
        return jsonResponse({ code: 1, data: { app_uid: 'fresh-app-uid' } });
      }
      return jsonResponse({ code: 0, message: 'unexpected request' }, 500);
    },
  });

  const result = await client.authorizeUser({
    credentials: {
      companySecret: 'company-secret',
      userName: 'user-name',
      password: 'password',
      accessToken: 'stale-access',
    },
  });

  assert.deepEqual(calls.map((call) => call.path), [
    '/erpapi/user/authorization',
    '/erpapi/token/index',
    '/erpapi/token/resettoken',
    '/erpapi/user/authorization',
  ]);
  assert.equal(result.accessToken, 'fresh-access');
  assert.equal(result.expiresToken, 'fresh-expires');
  assert.equal(result.appUid, 'fresh-app-uid');
});

test('treats an already-authorized user as idempotent success when the saved app uid is available', async () => {
  const requests = [];
  const client = createCrossBorderClient({
    transport: async (url) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      if (path === '/erpapi/user/authorization') {
        return jsonResponse({ code: 0, message: '用户已授权' });
      }
      throw new Error(`unexpected path: ${path}`);
    },
  });

  const result = await client.authorizeUser({
    credentials: {
      companySecret: 'company-secret',
      userName: 'user-name',
      password: 'password',
      accessToken: 'saved-access',
      expiresToken: 'saved-expires',
      appUid: 'saved-app-uid',
    },
  });

  assert.equal(result.appUid, 'saved-app-uid');
  assert.equal(result.accessToken, 'saved-access');
  assert.equal(result.expiresToken, 'saved-expires');
  assert.equal(result.idempotent, true);
  assert.deepEqual(requests, ['/erpapi/user/authorization']);
});

test('background token requests do not reset an already-generated token', async () => {
  const calls = [];
  const client = createCrossBorderClient({
    transport: async (url) => {
      calls.push(new URL(String(url)).pathname);
      return jsonResponse({ code: 0, message: '您已经生成Token,请使用expires_token获取最新Token' }, 401);
    },
  });

  await assert.rejects(
    client.requestEnterpriseToken({ companySecret: 'company-secret' }),
    (error) => error?.status === 401,
  );
  assert.deepEqual(calls, ['/erpapi/token/index']);
});
