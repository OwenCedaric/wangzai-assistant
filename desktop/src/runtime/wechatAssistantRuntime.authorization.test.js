import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWechatAssistantRuntime } from './wechatAssistantRuntime.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'wangzai-wechat-auth-fixture-'));
  const desktopRoot = path.resolve(import.meta.dirname, '../..');
  let live = false, environment, scope = '', calls = 0;
  const runtime = createWechatAssistantRuntime({ app: { isPackaged: false }, desktopRoot, workspaceRoot: path.resolve(desktopRoot, '..'),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`fixture:${value}`), decryptString: value => value.toString().slice(8) },
    paths: { dataLayout: () => ({ dataRoot: root }), localApiDatabasePath: () => path.join(root, 'unused.sqlite') },
    portProbe: async () => live,
    spawnProcess(_executable, args, config) {
      assert.ok(args.includes('gateway'), 'only fake gateway startup is permitted; plugin registration is already a fixture');
      environment = config.env; live = true;
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
      child.kill = () => { live = false; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; };
      return child;
    },
  });
  t.after(async () => {
    await runtime.stop();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith('wangzai-wechat-auth-fixture-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  runtime.configure({ getPointsWallet: options.getPointsWallet || (async () => ({ balancePoints: 100, reservedPoints: 0, availablePoints: 100 })),
    executeModelRequest: async () => { calls += 1; if (options.executeModelRequest) return options.executeModelRequest(); return { response: { id: `owner-${scope[0]}-${calls}`, model: 'gpt-5.6-terra',
      choices: [{ message: { role: 'assistant', content: `owner-${scope[0]}` }, finish_reason: 'stop' }] }, billing: { chargedPoints: 3 } }; },
    executeBusinessRequest: options.executeBusinessRequest || (async () => { throw new Error('unexpected fixture business request'); }) });
  assert.equal((await runtime.command({ command: 'save-settings', settings: { modelSource: 'builtin-points', modelName: 'gpt-5.6-terra',
    toolAccessMode: options.directWrite ? 'direct-write' : 'read-only', allowedOperationActions: options.directWrite ? ['products:product.updatePrice'] : [] } })).ok, true);
  const pluginPath = path.join(desktopRoot, 'openclaw-runtime/node_modules/@tencent-weixin/openclaw-weixin');
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginPath, 'package.json'), 'utf8')).version;
  fs.mkdirSync(path.join(runtime.paths.stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(runtime.paths.stateDir, 'state/openclaw.sqlite'), '');
  fs.writeFileSync(path.join(runtime.paths.root, 'plugin-registration.json'), JSON.stringify({ pluginPath, pluginVersion }));
  return { runtime, get environment() { return environment; }, get calls() { return calls; },
    auth(value) { scope = value || ''; return runtime.handleLicenseSession({ authorized: Boolean(value), authorizationScope: value }); },
    modelRequest(env = environment) { return fetch(env.WANGZAI_OPENCLAW_MODEL_RELAY_URL + '/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${env.WANGZAI_OPENCLAW_MODEL_RELAY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'same fixture request' }] }),
    }); },
  };
}

test('runtime rotates model/MCP/gateway capabilities across logout and owners while same-owner retry stays idempotent', async t => {
  const f = await fixture(t);
  assert.equal((await f.runtime.handleLicenseSession({ authorized: true })).code, 'WECHAT_AUTHORIZATION_SCOPE_REQUIRED');
  await f.auth(A);
  const firstEnvironment = f.environment;
  const first = await (await f.modelRequest()).json();
  assert.equal(firstEnvironment.WANGZAI_OPENCLAW_READONLY_RELAY_TOKEN, firstEnvironment.WANGZAI_OPENCLAW_MODEL_RELAY_TOKEN);
  await f.auth(null);
  assert.equal((await f.modelRequest(firstEnvironment)).status, 401);
  await f.auth(B);
  assert.notEqual(f.environment.WANGZAI_OPENCLAW_GATEWAY_TOKEN, firstEnvironment.WANGZAI_OPENCLAW_GATEWAY_TOKEN);
  assert.notEqual(f.environment.WANGZAI_OPENCLAW_MODEL_RELAY_TOKEN, firstEnvironment.WANGZAI_OPENCLAW_MODEL_RELAY_TOKEN);
  const second = await (await f.modelRequest()).json();
  assert.notEqual(second.id, first.id);
  await f.auth(A);
  assert.equal((await (await f.modelRequest()).json()).id, first.id);
  assert.equal(f.calls, 2);
  assert.equal((await f.modelRequest(firstEnvironment)).status, 401);
});

test('authorization loss between a permitted preview and confirm never dispatches the write', async t => {
  const started = deferred(), gate = deferred();
  const routes = [];
  const f = await fixture(t, { directWrite: true, executeBusinessRequest: request => {
    routes.push(request.path); started.resolve(); return gate.promise;
  } });
  t.after(() => gate.resolve({ ok: false }));
  await f.auth(A);
  const env = f.environment;
  const response = fetch(env.WANGZAI_OPENCLAW_ACTION_RELAY_URL + '/actions/preview', { method: 'POST',
    headers: { Authorization: `Bearer ${env.WANGZAI_OPENCLAW_ACTION_RELAY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'products', action: 'product.updatePrice', shopId: 'fixture-shop', payload: { price: 10 } }),
  });
  await started.promise;
  const logout = f.auth(null);
  gate.resolve({ ok: true, data: { ok: true, previewId: 'fixture-preview' } });
  assert.equal((await response).status, 409);
  await logout;
  assert.deepEqual(routes, ['/api/write/products/preview']);
});

test('same-owner cached reply does not replace a current wallet with its old billing snapshot', async t => {
  let balance = 100;
  const f = await fixture(t, {
    getPointsWallet: async () => ({ balancePoints: balance, reservedPoints: 0, availablePoints: balance }),
    executeModelRequest: async () => ({ response: { id: 'charged-once', model: 'gpt-5.6-terra',
      choices: [{ message: { role: 'assistant', content: 'cached reply' }, finish_reason: 'stop' }] },
      billing: { chargedPoints: 3, pointsRemaining: 97 } }),
  });
  await f.auth(A); await (await f.modelRequest()).json();
  await f.auth(null); balance = 45; await f.auth(A);
  await (await f.modelRequest()).json();
  assert.equal(f.calls, 1);
  assert.equal((await f.runtime.status()).points.availablePoints, 45);
});
