import assert from 'node:assert/strict';
import test from 'node:test';
import { registerDesktopIpcHandlers } from './desktopIpc.js';
import { createLocalApiProxy, requiredPermissionForLocalApi } from './localApiProxy.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function wiredRecovery({ failureStatus = 401, safeAuthRetry = true, alwaysFail = false } = {}) {
  const handlers = new Map();
  const remoteContextCalls = [];
  const forwarded = [];
  const oldFetch = globalThis.fetch;
  let token = 'synthetic-main-expired-token';
  let recoveryRuntime;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:49152/api/app/recovery/command', 'fixture must not access any real service');
    const body = JSON.parse(options.body);
    // Registration performs one startup enrollment probe even when its
    // periodic timer is immediately stopped. Keep that probe unenrolled.
    if (body.command === 'status') return json({ ok: true, enrolled: false });
    forwarded.push(body);
    if (forwarded.length === 1 || alwaysFail) return json({ ok: false, error: {
      code: failureStatus === 401 ? 'RECOVERY_REMOTE_AUTH_REQUIRED' : 'RECOVERY_REMOTE_ACCESS_DENIED',
      message: 'synthetic remote authorization outcome', remoteStatus: failureStatus, safeAuthRetry,
    } }, failureStatus);
    return json({ ok: true, verified: true, operationId: body.operationId });
  };
  const licenseRuntime = {
    rebindSessionObserver() {},
    getRuntime: async () => ({ mode: 'enforce' }),
    getSession: async () => ({ authorized: true, entitlement: { permissions: ['dashboard.view'] } }),
    async getRecoveryRemoteContext(options = {}) {
      remoteContextCalls.push({ ...options });
      if (options.forceRefresh) token = 'synthetic-main-fresh-token';
      return { baseUrl: 'https://synthetic-recovery.invalid', accessToken: token };
    },
  };
  try {
    recoveryRuntime = registerDesktopIpcHandlers({
      app: {},
      ipcMain: { removeHandler: channel => handlers.delete(channel), handle: (channel, handler) => handlers.set(channel, handler) },
      paths: {},
      existingLicenseRuntime: licenseRuntime,
      runtimeInfo: {
        localApi: { baseUrl: 'http://127.0.0.1:49152', authToken: 'synthetic-local-capability', profile: { profileId: 'fixture-profile' } },
        purchaseBridge: { baseUrl: 'http://127.0.0.1:49153', authToken: 'synthetic-purchase-capability', updateLicenseState() {} },
      },
    });
    // This test exercises installed IPC handlers, not the periodic backup job.
    recoveryRuntime.recoveryAutoBackupScheduler.stop();
  } catch (error) {
    globalThis.fetch = oldFetch;
    throw error;
  }
  return {
    invoke: input => handlers.get('desktop:recovery-request')({}, input),
    remoteContextCalls,
    forwarded,
    close() { recoveryRuntime.recoveryAutoBackupScheduler.stop(); globalThis.fetch = oldFetch; },
  };
}

test('installed recovery IPC passes a private rejected-token context and refreshes before one same-operation replay', async () => {
  const f = wiredRecovery();
  try {
    const input = { command: 'purge-account-owner', operationId: 'same-pending-operation',
      remote: { baseUrl: 'https://renderer.invalid', accessToken: 'renderer-forged-token' },
      authContext: { accessToken: 'renderer-forged-context' } };
    const result = await f.invoke(input);
    assert.equal(result.ok, true);
    assert.equal(result.data.verified, true);
    assert.deepEqual(f.remoteContextCalls, [
      {}, { forceRefresh: true, rejectedAccessToken: 'synthetic-main-expired-token' }, {},
    ]);
    assert.equal(f.forwarded.length, 2);
    assert.equal(f.forwarded[0].remote.accessToken, 'synthetic-main-expired-token');
    assert.equal(f.forwarded[1].remote.accessToken, 'synthetic-main-fresh-token');
    assert.equal(f.forwarded[0].operationId, f.forwarded[1].operationId);
    assert.equal(f.forwarded.every(body => body.remote.baseUrl === 'https://synthetic-recovery.invalid'), true);
    assert.equal(f.forwarded.some(body => body.authContext?.accessToken === 'synthetic-main-expired-token'), false);
    assert.equal(JSON.stringify(result).includes('synthetic-main-'), false);
    assert.equal(input.remote.accessToken, 'renderer-forged-token', 'renderer input is never mutated to carry Main tokens');
  } finally { f.close(); }
});

test('installed list-generations IPC resolves the Main remote and supports the same bounded auth retry', async () => {
  const f = wiredRecovery();
  try {
    assert.equal((await f.invoke({ command: 'list-generations', shopId: 'fixture-shop' })).ok, true);
    assert.equal(f.forwarded.length, 2);
    assert.ok(f.forwarded.every(body => body.command === 'list-generations' && body.remote.baseUrl === 'https://synthetic-recovery.invalid'));
    assert.equal(f.remoteContextCalls.filter(call => call.forceRefresh).length, 1);
  } finally { f.close(); }
});

test('installed recovery IPC does not retry post-mutation 401 or access-denied responses', async () => {
  for (const options of [{ failureStatus: 401, safeAuthRetry: false }, { failureStatus: 403, safeAuthRetry: true }]) {
    const f = wiredRecovery(options);
    try {
      const result = await f.invoke({ command: 'purge-account-owner', operationId: 'pending-not-safe-to-repeat' });
      assert.equal(result.ok, false);
      assert.equal(f.forwarded.length, 1);
      assert.equal(f.remoteContextCalls.some(call => call.forceRefresh), false);
    } finally { f.close(); }
  }
});

test('installed recovery IPC stops at the second 401 instead of looping authorization refresh', async () => {
  const f = wiredRecovery({ alwaysFail: true });
  try {
    const result = await f.invoke({ command: 'list-generations' });
    assert.equal(result.status, 401);
    assert.equal(result.ok, false);
    assert.equal(f.forwarded.length, 2);
    assert.equal(f.remoteContextCalls.filter(call => call.forceRefresh).length, 1);
  } finally { f.close(); }
});

test('client-failure grants only the exact POST route with dashboard permission', async () => {
  const route = '/api/account-removal/client-failure';
  assert.equal(requiredPermissionForLocalApi(route, {}, 'POST'), 'dashboard.view');
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal(requiredPermissionForLocalApi(route, {}, method), null);
  assert.equal(requiredPermissionForLocalApi(`${route}/extra`, {}, 'POST'), null);
  const forwarded = [];
  const proxy = createLocalApiProxy({
    baseUrl: 'http://127.0.0.1:49152', authToken: 'synthetic-local-capability',
    licenseRuntime: { getRuntime: async () => ({ mode: 'enforce' }), getSession: async () => ({ authorized: true, entitlement: { permissions: ['dashboard.view'] } }) },
    fetchImpl: async (url, options) => { forwarded.push({ url, options }); return json({ ok: true, operationId: 'same-operation' }); },
  });
  const body = { operationId: 'same-operation', nonce: 'same-challenge', errorCode: 'RECOVERY_REMOTE_LOGIN_REQUIRED' };
  const result = await proxy({ method: 'POST', path: route, body });
  assert.equal(result.ok, true);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(JSON.parse(forwarded[0].options.body), body);
  assert.equal(forwarded[0].options.headers['x-wangzai-local-api-token'], 'synthetic-local-capability');
  for (const method of ['GET', 'PATCH']) assert.equal((await proxy({ method, path: route })).status, 403);
  assert.equal(forwarded.length, 1);
});

test('client-failure refuses an unauthorized session or unrelated entitlement without forwarding', async () => {
  for (const session of [
    { authorized: false, entitlement: { permissions: ['dashboard.view'] } },
    { authorized: true, entitlement: { permissions: ['orders.view'] } },
  ]) {
    let forwarded = 0;
    const proxy = createLocalApiProxy({
      baseUrl: 'http://127.0.0.1:49152', authToken: 'synthetic-local-capability',
      licenseRuntime: { getRuntime: async () => ({ mode: 'enforce' }), getSession: async () => session },
      fetchImpl: async () => { forwarded += 1; return json({ ok: true }); },
    });
    assert.equal((await proxy({ method: 'POST', path: '/api/account-removal/client-failure', body: { operationId: 'same-op' } })).status, 403);
    assert.equal(forwarded, 0);
  }
});
