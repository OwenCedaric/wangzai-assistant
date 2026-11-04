import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { UI_UPDATE_CONTRACT, uiUpdateHash, uiUpdateSigningBytes, verifyUiBundle } from './signedUiBundle.js';
import { createSignedUiUpdateStore } from './signedUiUpdateStore.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const time = Date.parse('2026-09-07T00:00:00Z');
const options = { appId: 'isolated-pilot', channel: 'pilot', publicKey, shellApi: 1, now: time };
function bundle(sequence = 1, content = 'old', overrides = {}) {
  const contents = { 'index.html': Buffer.from(`<p>${content}</p>`).toString('base64'), 'assets/main.js': Buffer.from(`/* ${content} */`).toString('base64') };
  const manifest = { contract: UI_UPDATE_CONTRACT, appId: options.appId, channel: options.channel,
    sequence, shellApi: 1, createdAt: new Date(time - 1000).toISOString(), expiresAt: new Date(time + 60_000).toISOString(),
    files: Object.entries(contents).map(([path, content]) => ({ path, bytes: Buffer.from(content, 'base64').length, sha256: uiUpdateHash(Buffer.from(content, 'base64')) })), ...overrides };
  return { manifest, contents, signature: sign(null, uiUpdateSigningBytes(manifest), keys.privateKey).toString('base64') };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-ui-update-test-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'wangzai-ui-update-test-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, 'updates');
  const create = () => createSignedUiUpdateStore({ ...options, now: () => time, directory });
  return { root, directory, create, store: create() };
}

test('staging does not activate; healthy startup commits and an unacknowledged next boot rolls back without touching business data', t => {
  const f = fixture(t), data = path.join(f.root, 'business.sqlite');
  fs.writeFileSync(data, 'isolated-business-data');
  const first = f.store.stage(bundle());
  assert.equal(first.activated, false);
  assert.equal(f.store.status().active, null);
  assert.equal(f.store.prepareBoot().id, first.id);
  assert.equal(f.store.markHealthy(first.id).healthy, true);
  assert.equal(f.create().prepareBoot().id, first.id);
  const second = f.store.stage(bundle(2, 'next'));
  assert.equal(f.create().prepareBoot().id, second.id);
  const boot = f.create().prepareBoot();
  assert.equal(boot.rolledBack, true);
  assert.equal(boot.id, first.id);
  assert.equal(f.store.readAsset(first.id, 'index.html').toString(), '<p>old</p>');
  assert.equal(fs.readFileSync(data, 'utf8'), 'isolated-business-data');
  assert.throws(() => f.store.stage(bundle(1)), { code: 'UI_UPDATE_DOWNGRADE_OR_REPLAY' });
  assert.throws(() => f.store.stage(bundle(2)), { code: 'UI_UPDATE_DOWNGRADE_OR_REPLAY' });
});

test('rejects unsigned/tampered/wrong-scope/expired/incompatible packages before writing anything', t => {
  const f = fixture(t);
  const changedManifest = bundle(); changedManifest.manifest.sequence = 999;
  const changedContent = bundle(); changedContent.contents['index.html'] = Buffer.from('wrong').toString('base64');
  for (const bad of [changedManifest, changedContent, bundle(1, 'x', { appId: 'someone-else' }),
    bundle(1, 'x', { channel: 'stable' }), bundle(1, 'x', { shellApi: 2 }),
    bundle(1, 'x', { expiresAt: new Date(time - 1).toISOString() }),
    { ...bundle(), signature: '' }, { ...bundle(), unknown: true }]) assert.throws(() => f.store.stage(bad));
  assert.equal(fs.existsSync(f.directory), false);
});

test('rejects traversal, Windows special names, executables and case-insensitive collisions', () => {
  for (const name of ['../business.sqlite', 'assets/../../a.js', 'assets/CON.js', 'assets/NUL/a.js', 'assets/a.js:stream',
    'assets/./a.js', 'assets//a.js', 'assets/a./b.js', 'assets/main.dll', 'assets/a.js/file.js']) {
    const bad = bundle();
    bad.manifest.files.push({ path: name, bytes: 0, sha256: uiUpdateHash('') });
    bad.contents[name] = '';
    if (name === 'assets/a.js/file.js') { bad.manifest.files.push({ path: 'assets/a.js', bytes: 0, sha256: uiUpdateHash('') }); bad.contents['assets/a.js'] = ''; }
    bad.signature = sign(null, uiUpdateSigningBytes(bad.manifest), keys.privateKey).toString('base64');
    assert.throws(() => verifyUiBundle(bad, options));
  }
  const bad = bundle(); bad.manifest.files.push({ ...bad.manifest.files[1], path: 'assets/MAIN.js' });
  assert.throws(() => verifyUiBundle(bad, options), { code: 'UI_UPDATE_DUPLICATE_PATH' });
});

test('rejects a corrupted pending update and continues with the known-good version', t => {
  const f = fixture(t), first = f.store.stage(bundle());
  f.store.prepareBoot(); f.store.markHealthy(first.id);
  const second = f.store.stage(bundle(2, 'next'));
  fs.writeFileSync(path.join(f.directory, second.id, 'index.html'), 'corrupted');
  const boot = f.create().prepareBoot();
  assert.equal(boot.id, first.id); assert.ok(boot.rejectedPending);
  assert.equal(f.store.status().pending, null);
  assert.throws(() => f.store.stage(bundle(2, 'next')), { code: 'UI_UPDATE_DOWNGRADE_OR_REPLAY' });
});

test('prunes only obsolete signed program versions and preserves current/previous/unknown files', t => {
  const f = fixture(t);
  const first = f.store.stage(bundle()); f.store.prepareBoot(); f.store.markHealthy(first.id);
  const second = f.store.stage(bundle(2, 'second')); f.store.prepareBoot(); f.store.markHealthy(second.id);
  fs.writeFileSync(path.join(f.directory, first.id, 'business.sqlite'), 'unexpected-file-must-stay');
  const third = f.store.stage(bundle(3, 'third')); f.store.prepareBoot();
  const receipt = f.store.markHealthy(third.id);
  assert.deepEqual(receipt.removedObsoleteVersions, []);
  assert.equal(fs.readFileSync(path.join(f.directory, first.id, 'business.sqlite'), 'utf8'), 'unexpected-file-must-stay');
  fs.unlinkSync(path.join(f.directory, first.id, 'business.sqlite'));
  const fourth = f.store.stage(bundle(4, 'fourth')); f.store.prepareBoot();
  assert.deepEqual(f.store.markHealthy(fourth.id).removedObsoleteVersions.sort(), [first.id, second.id].sort());
  assert.equal(fs.existsSync(path.join(f.directory, third.id)), true);
  assert.equal(fs.existsSync(path.join(f.directory, fourth.id)), true);
});

test('validates assets again on read and never acknowledges a different startup', t => {
  const f = fixture(t), staged = f.store.stage(bundle());
  f.store.prepareBoot();
  assert.throws(() => f.store.markHealthy('wrong'), { code: 'UI_UPDATE_HEALTH_RECEIPT_MISMATCH' });
  f.store.markHealthy(staged.id);
  fs.writeFileSync(path.join(f.directory, staged.id, 'assets/main.js'), '/* bad */');
  assert.throws(() => f.store.readAsset(staged.id, 'assets/main.js'));
  assert.throws(() => f.store.readAsset(staged.id, '../../business.sqlite'), { code: 'UI_UPDATE_ASSET_NOT_LISTED' });
});

test('cannot adopt an arbitrary directory or a store with another signing key', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory); fs.writeFileSync(path.join(f.directory, 'business.sqlite'), 'keep');
  assert.throws(() => f.store.stage(bundle()), { code: 'UI_UPDATE_FILE_UNSAFE' });
  assert.equal(fs.readFileSync(path.join(f.directory, 'business.sqlite'), 'utf8'), 'keep');
  const second = path.join(f.root, 'second');
  createSignedUiUpdateStore({ ...options, now: () => time, directory: second }).stage(bundle());
  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => createSignedUiUpdateStore({ ...options, directory: second, publicKey: otherKey }).status(), { code: 'UI_UPDATE_STORE_OWNER_MISMATCH' });
});

test('a failed atomic pointer write never reports staging success or overwrites the active version', t => {
  const f = fixture(t), first = f.store.stage(bundle());
  f.store.prepareBoot(); f.store.markHealthy(first.id);
  const original = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(f.directory, 'state.json')) throw Object.assign(new Error('fixture disk fault'), { code: 'EIO' });
    return original(from, to);
  });
  assert.throws(() => f.store.stage(bundle(2, 'next')), { code: 'EIO' });
  mocked.mock.restore();
  assert.equal(f.store.status().active, first.id);
  assert.equal(f.store.status().pending, null);
  const resumed = f.store.stage(bundle(2, 'next'));
  assert.equal(resumed.resumed, true);
});

test('linked update roots and hard-linked manifests are rejected without following them', t => {
  const f = fixture(t), other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'business.sqlite'), 'keep-linked-business');
  fs.symlinkSync(other, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.store.stage(bundle()), { code: 'UI_UPDATE_LINKED_DIRECTORY' });
  assert.equal(fs.readFileSync(path.join(other, 'business.sqlite'), 'utf8'), 'keep-linked-business');
  fs.unlinkSync(f.directory);
  const staged = f.store.stage(bundle());
  const manifest = path.join(f.directory, staged.id, 'manifest.json');
  fs.linkSync(manifest, path.join(f.root, 'linked-manifest.json'));
  const boot = f.store.prepareBoot();
  assert.equal(boot.id, null);
  assert.equal(boot.rejectedPending, 'UI_UPDATE_FILE_UNSAFE');
});
