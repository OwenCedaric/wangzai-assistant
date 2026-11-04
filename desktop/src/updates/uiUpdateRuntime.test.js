import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSignedUiUpdate } from '../../scripts/create-signed-ui-update.mjs';
import { createSignedUiUpdateStore } from './signedUiUpdateStore.js';
import { createUiUpdateRuntime, registerUiUpdateIpc } from './uiUpdateRuntime.js';
import { loadUiUpdateConfig } from './uiUpdateConfig.js';
import { uiUpdateHash } from './signedUiBundle.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-ui-runtime-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'wangzai-ui-runtime-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const inputDirectory = path.join(root, 'bundle'); fs.mkdirSync(inputDirectory); fs.writeFileSync(path.join(inputDirectory, 'index.html'), '<p>signed UI</p>');
  const config = { enabled: true, publicKey, appId: 'pilot', channel: 'pilot', shellApi: 1, baseUrl: 'https://pilot.example.test/api/client-updates' };
  const bundle = createSignedUiUpdate({ ...config, privateKey, sequence: 1, inputDirectory, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  let session = { authorized: true, user: { id: 1 } };
  const store = createSignedUiUpdateStore({ ...config, directory: path.join(root, 'signed-ui-updates') });
  const create = overrides => {
    const runtime = createUiUpdateRuntime({ config, dataRoot: root, bundledDirectory: inputDirectory,
      getSession: async () => session, getToken: async () => 'synthetic-token', healthDelayMs: 10,
      fetchImpl: async () => new Response(JSON.stringify(bundle), { headers: { 'content-type': 'application/json' } }), ...overrides });
    t.after(() => runtime.dispose()); return runtime;
  };
  return { root, config, bundle, store, create, publicKey, privateKey, setSession: value => { session = value; } };
}

test('disabled updates and recovery startup use bundled UI without adopting pending updates', t => {
  const f = fixture(t);
  const disabled = f.create({ config: { enabled: false } });
  assert.equal(disabled.prepareBoot().id, null);
  assert.deepEqual(disabled.status(), { enabled: false });
  assert.equal(fs.existsSync(path.join(f.root, 'signed-ui-updates')), false);
  const staged = f.store.stage(f.bundle);
  assert.equal(f.create().prepareBoot({ recoveryMode: true }).id, null);
  assert.equal(f.store.status().pending, staged.id);
});

test('coalesces checks, never live-activates, and requires a trusted stable user through download', async t => {
  const f = fixture(t); let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const runtime = f.create({ fetchImpl: () => pending }); runtime.prepareBoot();
  const first = runtime.check(), second = runtime.check(); assert.equal(first, second);
  f.setSession({ authorized: true, user: { id: 2 } });
  // Let the async session/token acquisition complete before changing owner again.
  await new Promise(resolve => setImmediate(resolve));
  f.setSession({ authorized: true, user: { id: 3 } });
  finish(new Response(JSON.stringify(f.bundle), { headers: { 'content-type': 'application/json' } }));
  assert.equal((await first).code, 'UI_UPDATE_AUTH_SCOPE_CHANGED');
  assert.equal(runtime.status().active, null);
  assert.equal(f.store.status().pending, null);
  const good = f.create(); good.prepareBoot();
  assert.equal((await good.check()).state, 'staged');
  assert.equal(good.status().active, null);
  assert.ok(good.status().pending);
});

test('healthy renderer settles trial but renderer crash before confirmation leaves rollback pending', async t => {
  const f = fixture(t); const staged = f.store.stage(f.bundle);
  const runtime = f.create(); runtime.prepareBoot();
  const window = new EventEmitter(); window.webContents = new EventEmitter(); runtime.bindWindow(window);
  runtime.reportHealth(true); window.webContents.emit('render-process-gone');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.store.status().trial, true);
  assert.equal(f.create().prepareBoot().rolledBack, true);
  assert.equal(f.store.status().failed.includes(staged.id), true);
});

test('a successful boot returns verified static assets and refuses disk tampering', async t => {
  const f = fixture(t); const staged = f.store.stage(f.bundle);
  const runtime = f.create(); runtime.prepareBoot(); runtime.reportHealth(true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(runtime.status().trial, false);
  const response = runtime.readStatic(new URL('app://wangzai/'));
  assert.equal(await response.text(), '<p>signed UI</p>');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(runtime.readStatic(new URL('app://wangzai/assets/missing.js')).status, 404);
  fs.writeFileSync(path.join(f.root, 'signed-ui-updates', staged.id, 'index.html'), 'bad');
  assert.equal(runtime.readStatic(new URL('app://wangzai/')).status, 500);
});

test('only the owned main frame may use update IPC, with no token or file-path IPC', async () => {
  const frame = { url: 'app://wangzai/' }, contents = { mainFrame: frame }, window = { webContents: contents };
  let handler, checked = 0;
  registerUiUpdateIpc({ ipcMain: { removeHandler() {}, handle(_name, fn) { handler = fn; } }, getWindow: () => window,
    runtime: { status: () => ({ enabled: true }), check: () => { checked++; return { ok: true }; }, reportHealth: () => ({ accepted: true }) } });
  for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: { url: 'app://wangzai/' } },
    { sender: contents, senderFrame: { url: 'https://example.test/' } }]) {
    assert.equal((await handler(event, { action: 'check' })).code, 'UI_UPDATE_SENDER_REJECTED');
  }
  assert.equal(checked, 0);
  assert.equal((await handler({ sender: contents, senderFrame: frame }, { action: 'check' })).ok, true);
  assert.equal(checked, 1);
  assert.equal((await handler({ sender: contents, senderFrame: frame }, { action: 'read-file', path: 'business.sqlite' })).code, 'UI_UPDATE_ACTION_INVALID');
});

test('update config is disabled by default and pins an Ed25519 public-only file through sealed metadata', t => {
  const f = fixture(t);
  assert.deepEqual(loadUiUpdateConfig(), { enabled: false });
  const directory = path.join(f.root, 'ui-updates'); fs.mkdirSync(directory);
  const file = path.join(directory, 'public.pem'); fs.writeFileSync(file, f.publicKey);
  const value = { enabled: true, app_id: 'pilot', channel: 'pilot', public_key_sha256: uiUpdateHash(f.publicKey), shell_api: 1 };
  const read = () => loadUiUpdateConfig({ value, licenseRoot: f.root, serverUrl: 'https://pilot.example.test' });
  assert.equal(read().baseUrl, 'https://pilot.example.test/api/client-updates');
  fs.writeFileSync(file, f.privateKey); value.public_key_sha256 = uiUpdateHash(f.privateKey);
  assert.throws(read, /UI_UPDATE_KEY_INVALID/u);
});
