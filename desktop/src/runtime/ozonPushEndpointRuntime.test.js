import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createInternalOzonPushSignature,
  createOzonPushBindingToken,
  createOzonPushEndpointRuntime,
  toInternalOzonPushEnvelope,
} from './ozonPushEndpointRuntime.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('per-shop token is stable, scoped, and internal envelope pins seller identity', () => {
  const secret = 'test-secret-material-that-is-long-enough-123456';
  const a = createOzonPushBindingToken(secret, { bindingId: 'binding-a', shopId: 'shop-a', clientId: '100' });
  const again = createOzonPushBindingToken(secret, { bindingId: 'binding-a', shopId: 'shop-a', clientId: '100' });
  const b = createOzonPushBindingToken(secret, { bindingId: 'binding-a', shopId: 'shop-b', clientId: '100' });
  assert.equal(a, again);
  assert.notEqual(a, b);

  const envelope = toInternalOzonPushEnvelope({
    message_type: 'TYPE_ORDER_NEW',
    order_number: 'ORDER-1',
  }, { id: 'shop-a', clientId: '100' }, '2026-08-28T10:00:00.000Z');
  assert.equal(envelope.events[0].seller_id, '100');
  assert.equal(envelope.events[0].payload.seller_id, '100');
  assert.match(createInternalOzonPushSignature(secret, envelope, 100), /^t=100,v1=[a-f0-9]{64}$/u);
  assert.throws(
    () => toInternalOzonPushEnvelope({ message_type: 'TYPE_ORDER_NEW', seller_id: '200' }, { clientId: '100' }),
    /OZON_PUSH_SELLER_SCOPE_MISMATCH/u,
  );
});

test('server-mode endpoint handles Ozon ping, forwards one signed event, and invalidates a rotated URL', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wangzai-ozon-push-'));
  const secretPath = path.join(directory, 'secret.key');
  const secret = 'runtime-secret-material-that-is-long-enough-654321';
  writeFileSync(secretPath, `${secret}\n`, 'utf8');
  const port = await freePort();
  const shops = [{
    id: 'shop-a',
    name: 'A',
    alias: 'A店',
    clientId: '10001',
    status: 'active',
  }];
  const sinkCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/shops' && (!options.method || options.method === 'GET')) {
      return jsonResponse({ shops });
    }
    if (parsed.pathname === '/api/shops' && options.method === 'POST') {
      const input = JSON.parse(options.body);
      Object.assign(shops[0], input);
      return jsonResponse({ shop: { ...shops[0] } });
    }
    if (parsed.pathname === '/api/internal/ozon/push-notifications') {
      sinkCalls.push({
        envelope: JSON.parse(options.body),
        signature: options.headers['x-wangzai-ozon-push-signature'],
      });
      return jsonResponse({ ok: true, accepted: [JSON.parse(options.body).events[0].id], deduped: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const runtime = createOzonPushEndpointRuntime({
    runtimeInfo: { localApi: { baseUrl: 'http://127.0.0.1:3790', authToken: 'local-token' } },
    secretPath,
    fetchImpl,
    env: { WANGZAI_OZON_PUSH_PUBLIC_BASE_URL: 'https://push.example.test' },
    gatewayPort: port,
    now: () => new Date('2026-08-28T11:22:33.000Z'),
  });
  try {
    const created = await runtime.command({ command: 'ensure', shopId: 'shop-a' });
    assert.equal(created.ok, true);
    assert.equal(created.binding.mode, 'server');
    assert.match(created.binding.url, /^https:\/\/push\.example\.test\/api\/ozon\/push\//u);
    const reused = await runtime.command({ command: 'ensure', shopId: 'shop-a' });
    assert.equal(reused.reused, true);
    assert.equal(reused.binding.url, created.binding.url);

    const callbackPath = new URL(created.binding.url).pathname;
    const ping = await fetch(`http://127.0.0.1:${port}${callbackPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_type: 'TYPE_PING', time: '2026-08-28T00:00:00Z' }),
    });
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), {
      version: '1.1.0',
      name: 'Wangzai Ozon Notifications',
      time: '2026-08-28T11:22:33.000Z',
    });

    const event = await fetch(`http://127.0.0.1:${port}${callbackPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_type: 'TYPE_ORDER_NEW', order_number: 'ORDER-2' }),
    });
    assert.equal(event.status, 200);
    assert.deepEqual(await event.json(), { result: true });
    assert.equal(sinkCalls.length, 1);
    assert.equal(sinkCalls[0].envelope.events[0].seller_id, '10001');
    assert.match(sinkCalls[0].signature, /^t=\d+,v1=[a-f0-9]{64}$/u);

    const rotated = await runtime.command({ command: 'rotate', shopId: 'shop-a' });
    assert.equal(rotated.ok, true);
    assert.notEqual(rotated.binding.url, created.binding.url);
    const stale = await fetch(`http://127.0.0.1:${port}${callbackPath}`);
    assert.equal(stale.status, 404);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('desktop provider appends only its exact callback path to Tailscale Funnel', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wangzai-ozon-push-provider-'));
  const secretPath = path.join(directory, 'secret.key');
  writeFileSync(secretPath, 'provider-secret-material-that-is-long-enough-789\n', 'utf8');
  const port = await freePort();
  const shops = [{ id: 'shop-a', name: 'A', clientId: '10001', status: 'active' }];
  const calls = [];
  const runtime = createOzonPushEndpointRuntime({
    runtimeInfo: { localApi: { baseUrl: 'http://127.0.0.1:3790', authToken: 'token' } },
    secretPath,
    gatewayPort: port,
    funnelPort: 8443,
    env: {},
    fetchImpl: async (url, options = {}) => {
      if ((!options.method || options.method === 'GET')) return jsonResponse({ shops });
      Object.assign(shops[0], JSON.parse(options.body));
      return jsonResponse({ shop: shops[0] });
    },
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      if (args[0] === 'status') callback(null, JSON.stringify({ Self: { DNSName: 'node.example.ts.net.' } }), '');
      else callback(null, '', '');
    },
  });
  try {
    const result = await runtime.command({ command: 'ensure', shopId: 'shop-a' });
    assert.equal(result.ok, true);
    assert.equal(result.binding.mode, 'desktop');
    assert.match(result.binding.url, /^https:\/\/node\.example\.ts\.net:8443\/api\/ozon\/push\//u);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], 'funnel');
    assert.ok(calls[1].some((arg) => arg.startsWith('--set-path=/api/ozon/push/')));
    assert.ok(calls[1].at(-1).startsWith(`http://127.0.0.1:${port}/api/ozon/push/`));
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});


function failureRuntime(t, overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wangzai-ozon-push-failure-'));
  const secretPath = path.join(directory, 'secret.key');
  writeFileSync(secretPath, 'failure-secret-material-that-is-long-enough-321\n', 'utf8');
  const shops = [{ id: 'shop-a', name: 'A', clientId: '10001', status: 'active' }];
  const runtime = createOzonPushEndpointRuntime({
    runtimeInfo: { localApi: { baseUrl: 'http://127.0.0.1:3790', authToken: 'token' } },
    secretPath,
    gatewayPort: 0,
    env: {},
    fetchImpl: async (_url, options = {}) => {
      if (!options.method || options.method === 'GET') return jsonResponse({ shops });
      Object.assign(shops[0], JSON.parse(options.body));
      return jsonResponse({ shop: shops[0] });
    },
    execFileImpl: (_file, args, _options, callback) => {
      if (args[0] === 'status') callback(null, JSON.stringify({ Self: { DNSName: 'node.example.ts.net.' } }), '');
      else callback(null, '', '');
    },
    ...overrides,
  });
  t.after(async () => {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime, shops };
}

function commandFailure(error, stdout = '', stderr = '') {
  return (_file, args, _options, callback) => {
    const failure = Object.assign(new Error(error.message || 'command failed'), error, { stdout, stderr });
    callback(failure, stdout, stderr);
  };
}

test('missing Tailscale is reported as not installed instead of a generic network error', async (t) => {
  const { runtime, shops } = failureRuntime(t, { execFileImpl: commandFailure({ code: 'ENOENT' }) });
  const result = await runtime.command({ command: 'ensure', shopId: 'shop-a' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OZON_PUSH_TAILSCALE_NOT_INSTALLED');
  assert.match(result.error, /没有找到 Tailscale/u);
  assert.match(result.error, /OZON_PUSH_TAILSCALE_NOT_INSTALLED/u);
  assert.equal(shops[0].ozonPushBindingId, undefined);
});

test('stopped tailscaled, logged-out state and command timeout map to distinct codes', async (t) => {
  const stopped = failureRuntime(t, {
    execFileImpl: commandFailure({ code: 1 }, '', 'failed to connect to local tailscaled; it doesn\'t appear to be running'),
  });
  assert.equal((await stopped.runtime.command({ command: 'ensure', shopId: 'shop-a' })).code, 'OZON_PUSH_TAILSCALE_NOT_RUNNING');

  const loggedOut = failureRuntime(t, {
    execFileImpl: (_file, _args, _options, callback) => callback(null, JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }), ''),
  });
  assert.equal((await loggedOut.runtime.command({ command: 'ensure', shopId: 'shop-a' })).code, 'OZON_PUSH_TAILSCALE_NOT_LOGGED_IN');

  const timedOut = failureRuntime(t, { execFileImpl: commandFailure({ killed: true, signal: 'SIGTERM' }) });
  assert.equal((await timedOut.runtime.command({ command: 'ensure', shopId: 'shop-a' })).code, 'OZON_PUSH_TAILSCALE_TIMEOUT');

  const optionsSeen = [];
  const withTimeout = failureRuntime(t, {
    execFileImpl: (_file, args, options, callback) => {
      optionsSeen.push(options);
      if (args[0] === 'status') callback(null, JSON.stringify({ Self: { DNSName: 'node.example.ts.net.' } }), '');
      else callback(null, '', '');
    },
  });
  assert.equal((await withTimeout.runtime.command({ command: 'ensure', shopId: 'shop-a' })).ok, true);
  assert.ok(optionsSeen.every((options) => Number(options.timeout) > 0));
});

test('Funnel disabled on the tailnet is reported separately and leaves the shop unbound', async (t) => {
  const { runtime, shops } = failureRuntime(t, {
    execFileImpl: (_file, args, _options, callback) => {
      if (args[0] === 'status') callback(null, JSON.stringify({ Self: { DNSName: 'node.example.ts.net.' } }), '');
      else callback(Object.assign(new Error('exit status 1'), { code: 1 }), '', 'Funnel not enabled. To enable, visit https://login.tailscale.com/f/funnel');
    },
  });
  const result = await runtime.command({ command: 'ensure', shopId: 'shop-a' });
  assert.equal(result.code, 'OZON_PUSH_TAILSCALE_FUNNEL_NOT_ENABLED');
  assert.match(result.error, /Funnel/u);
  assert.equal(shops[0].ozonPushBindingId, undefined);
});

test('a busy gateway port is reported and a later retry can still start the gateway', async (t) => {
  let attempt = 0;
  const { runtime } = failureRuntime(t, {
    createServerImpl: (handler) => {
      attempt += 1;
      if (attempt === 1) {
        return {
          once(event, listener) { if (event === 'error') setImmediate(() => listener(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))); },
          listen() {},
          close(callback) { callback?.(); },
        };
      }
      return net.createServer(handler);
    },
  });
  const first = await runtime.command({ command: 'ensure', shopId: 'shop-a' });
  assert.equal(first.code, 'OZON_PUSH_GATEWAY_PORT_IN_USE');
  assert.match(first.error, /端口被其他程序占用/u);
  const second = await runtime.command({ command: 'ensure', shopId: 'shop-a' });
  assert.equal(second.ok, true);
  assert.equal(attempt, 2);
});

test('local-api outage and unpersisted binding are not reported as success or as a network problem', async (t) => {
  const offline = failureRuntime(t, {
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  const offlineResult = await offline.runtime.command({ command: 'ensure', shopId: 'shop-a' });
  assert.equal(offlineResult.code, 'OZON_PUSH_LOCAL_API_UNAVAILABLE');
  assert.match(offlineResult.error, /本地店铺服务没有响应/u);

  const shops = [{ id: 'shop-a', name: 'A', clientId: '10001', status: 'active' }];
  const rejected = failureRuntime(t, {
    fetchImpl: async (_url, options = {}) => {
      if (!options.method || options.method === 'GET') return jsonResponse({ shops });
      return jsonResponse({ error: { code: 'SHOP_VALIDATION_FAILED', message: 'invalid' } }, 400);
    },
  });
  assert.equal((await rejected.runtime.command({ command: 'ensure', shopId: 'shop-a' })).code, 'OZON_PUSH_BINDING_SAVE_FAILED');

  const silent = failureRuntime(t, {
    fetchImpl: async (_url, options = {}) => {
      if (!options.method || options.method === 'GET') return jsonResponse({ shops });
      return jsonResponse({ shop: shops[0] });
    },
  });
  const silentResult = await silent.runtime.command({ command: 'ensure', shopId: 'shop-a' });
  assert.equal(silentResult.ok, false);
  assert.equal(silentResult.code, 'OZON_PUSH_BINDING_SAVE_FAILED');
});

test('read reports unsaved drafts instead of failing, and ensure refuses them with a save hint', async (t) => {
  const { runtime } = failureRuntime(t);
  const draft = await runtime.command({ command: 'read', shopId: 'shop-draft' });
  assert.deepEqual(draft, { ok: true, shopSaved: false, savedClientId: '', binding: null });
  const saved = await runtime.command({ command: 'read', shopId: 'shop-a' });
  assert.equal(saved.shopSaved, true);
  assert.equal(saved.savedClientId, '10001');
  const ensure = await runtime.command({ command: 'ensure', shopId: 'shop-draft' });
  assert.equal(ensure.ok, false);
  assert.equal(ensure.code, 'OZON_PUSH_SHOP_NOT_SAVED');
  assert.match(ensure.error, /请先点击「保存」或「测试连接」/u);
});
