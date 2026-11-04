import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createSignedUiUpdate } from '../../scripts/create-signed-ui-update.mjs';
import { downloadUiUpdate } from './uiUpdateDownload.js';
import { createSignedUiUpdateStore } from './signedUiUpdateStore.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-ui-delivery-test-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'wangzai-ui-delivery-test-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const inputDirectory = path.join(root, 'input'); fs.mkdirSync(inputDirectory); fs.mkdirSync(path.join(inputDirectory, 'assets'));
  fs.writeFileSync(path.join(inputDirectory, 'index.html'), '<html><script src="assets/app.js"></script></html>');
  fs.writeFileSync(path.join(inputDirectory, 'assets/app.js'), 'document.body.dataset.ready="true";');
  fs.writeFileSync(path.join(inputDirectory, 'favicon.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const keypair = generateKeyPairSync('ed25519');
  const privateKey = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = keypair.publicKey.export({ type: 'spki', format: 'pem' });
  const trust = { appId: 'isolated-pilot', channel: 'pilot', publicKey, shellApi: 1 };
  const bundle = createSignedUiUpdate({ ...trust, privateKey, sequence: 1, inputDirectory, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return { root, inputDirectory, privateKey, trust, bundle };
}

test('publisher → authenticated download → verification → stage → startup → signed asset read', async t => {
  const f = setup(t), calls = [];
  const received = await downloadUiUpdate({ baseUrl: 'https://pilot.example.test/client-updates', token: 'synthetic-token', trust: f.trust,
    fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify(f.bundle), { headers: { 'content-type': 'application/json' } }); } });
  assert.equal(received.available, true);
  assert.equal(calls[0][0], 'https://pilot.example.test/client-updates/pilot/latest');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers.authorization, 'Bearer synthetic-token');
  assert.equal(JSON.stringify(received.bundle).includes(f.privateKey), false);
  const store = createSignedUiUpdateStore({ directory: path.join(f.root, 'updates'), ...f.trust });
  const staged = store.stage(received.bundle);
  assert.equal(staged.activated, false);
  const boot = store.prepareBoot();
  assert.equal(boot.id, received.id);
  assert.equal(store.readAsset(boot.id, 'assets/app.js').toString(), 'document.body.dataset.ready="true";');
  store.markHealthy(boot.id);
  assert.equal(store.prepareBoot().trial, false);
});

test('download errors, untrusted redirects, non-JSON and oversized responses never become update success', async t => {
  const f = setup(t), base = { baseUrl: 'https://pilot.example.test/updates', token: 'synthetic-token', trust: f.trust };
  for (const [response, code] of [
    [new Response('', { status: 401 }), 'UI_UPDATE_UNAUTHORIZED'],
    [new Response('', { status: 403 }), 'UI_UPDATE_UNAUTHORIZED'],
    [new Response('', { status: 500 }), 'UI_UPDATE_SERVER_FAILED'],
    [new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), 'UI_UPDATE_CONTENT_TYPE_INVALID'],
    [new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '9999999999999' } }), 'UI_UPDATE_DOWNLOAD_TOO_LARGE'],
    [new Response('{', { headers: { 'content-type': 'application/json' } }), 'UI_UPDATE_JSON_INVALID'],
  ]) await assert.rejects(downloadUiUpdate({ ...base, fetchImpl: async () => response }), { code });
  await assert.rejects(downloadUiUpdate({ ...base, fetchImpl: async () => { throw new Error('redirect refused'); } }), /redirect refused/u);
  assert.deepEqual(await downloadUiUpdate({ ...base, fetchImpl: async () => new Response(null, { status: 204 }) }), { available: false });
});

test('rejects plaintext/credential-bearing feed URLs and cancellation before contacting the network', async t => {
  const f = setup(t); let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('network must not run'); };
  for (const baseUrl of ['http://pilot.example.test/updates', 'https://user:pass@pilot.example.test/updates', 'https://pilot.example.test/updates?token=bad']) {
    await assert.rejects(downloadUiUpdate({ baseUrl, token: 'synthetic-token', trust: f.trust, fetchImpl }), { code: 'UI_UPDATE_URL_INVALID' });
  }
  const controller = new AbortController(); controller.abort(new Error('fixture-cancelled'));
  await assert.rejects(downloadUiUpdate({ baseUrl: 'https://pilot.example.test/updates', token: 'synthetic-token', trust: f.trust, fetchImpl, signal: controller.signal }), /fixture-cancelled/u);
  assert.equal(requests, 0);
});

test('the public update publisher refuses native binaries, source maps and source-tree extras', t => {
  const f = setup(t);
  for (const name of ['private.pem', 'assets/source.map', 'assets/native.dll']) {
    const file = path.join(f.inputDirectory, name); fs.writeFileSync(file, 'fixture-not-for-clients');
    assert.throws(() => createSignedUiUpdate({ ...f.trust, privateKey: f.privateKey, sequence: 2,
      inputDirectory: f.inputDirectory, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { code: 'UI_UPDATE_ASSET_PATH_INVALID' });
    fs.unlinkSync(file);
  }
});
