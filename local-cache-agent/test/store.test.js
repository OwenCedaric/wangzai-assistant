import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createLocalCacheStore } from '../src/store.js';

function createStore(root, overrides = {}) {
  return createLocalCacheStore({
    databasePath: path.join(root, 'cache.sqlite'),
    assetRoot: path.join(root, 'assets'),
    encryptionKey: crypto.randomBytes(32),
    ...overrides,
  });
}

test('keeps records and outbox state in the customer-local database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cache-agent-'));
  const store = createStore(root);
  try {
    const saved = store.putRecord({ scopeId: 'user-1:shop-1', namespace: 'orders', key: 'order-1', payload: { amount: 12 } });
    assert.equal(saved.revision, 1);
    assert.deepEqual(store.getRecord({ scopeId: 'user-1:shop-1', namespace: 'orders', key: 'order-1' }).payload, { amount: 12 });
    assert.equal(store.putRecord({ scopeId: 'user-1:shop-1', namespace: 'orders', key: 'order-1', payload: { amount: 15 } }).revision, 2);
    const task = store.enqueueTask({ scopeId: 'user-1:shop-1', taskKind: 'orders.refresh', request: { cursor: null } });
    assert.equal(store.listTasks({ scopeId: 'user-1:shop-1' }).length, 1);
    assert.equal(store.completeTask({ scopeId: 'user-1:shop-1', taskId: task.taskId, result: { count: 1 } }).completed, true);
    assert.equal(store.listTasks({ scopeId: 'user-1:shop-1' }).length, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commits an atomic record batch fully or leaves the cache unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cache-atomic-'));
  const store = createStore(root);
  try {
    const saved = store.putRecordsAtomic([
      { scopeId: 'user:profile', namespace: 'shops', key: 'shop-a', payload: { value: 'a' } },
      { scopeId: 'user:profile', namespace: 'profile-settings', key: 'ozon-shop-preferences', payload: { value: 'b' } },
    ]);
    assert.equal(saved.length, 2);
    assert.equal(store.getRecord({ scopeId: 'user:profile', namespace: 'shops', key: 'shop-a' }).payload.value, 'a');

    assert.throws(() => store.putRecordsAtomic([
      { scopeId: 'user:profile', namespace: 'shops', key: 'shop-b', payload: { value: 'must-not-commit' } },
      { scopeId: 'user:profile', namespace: 'INVALID NAMESPACE', key: 'bad', payload: {} },
    ]), { code: 'CACHE_NAMESPACE_INVALID' });
    assert.equal(store.getRecord({ scopeId: 'user:profile', namespace: 'shops', key: 'shop-b' }), null);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('separates every user and shop scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cache-scope-'));
  const store = createStore(root);
  try {
    store.putRecord({ scopeId: 'user-a:shop-a', namespace: 'products', key: 'same', payload: { owner: 'a' } });
    store.putRecord({ scopeId: 'user-b:shop-b', namespace: 'products', key: 'same', payload: { owner: 'b' } });
    assert.equal(store.getRecord({ scopeId: 'user-a:shop-a', namespace: 'products', key: 'same' }).payload.owner, 'a');
    assert.equal(store.getRecord({ scopeId: 'user-b:shop-b', namespace: 'products', key: 'same' }).payload.owner, 'b');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps binary assets on the customer computer and isolates identical asset ids by scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cache-assets-'));
  const assetRoot = path.join(root, 'assets');
  const store = createStore(root, { assetRoot });
  try {
    const firstBytes = Buffer.from('shop-a-image', 'utf8');
    const secondBytes = Buffer.from('shop-b-image', 'utf8');
    const first = store.putAsset({
      scopeId: 'user-a:shop-a',
      assetId: 'same-image',
      extension: 'webp',
      mediaType: 'image/webp',
      contentBase64: firstBytes.toString('base64'),
      metadata: { slot: 'primary' },
    });
    const second = store.putAsset({
      scopeId: 'user-b:shop-b',
      assetId: 'same-image',
      extension: 'webp',
      mediaType: 'image/webp',
      contentBase64: secondBytes.toString('base64'),
    });

    assert.notEqual(first.relativePath, second.relativePath);
    const firstAsset = store.readAsset({ scopeId: 'user-a:shop-a', assetId: 'same-image' });
    const secondAsset = store.readAsset({ scopeId: 'user-b:shop-b', assetId: 'same-image' });
    assert.deepEqual(firstAsset.content, firstBytes);
    assert.deepEqual(secondAsset.content, secondBytes);
    assert.notDeepEqual(fs.readFileSync(path.join(assetRoot, first.relativePath)), firstBytes);
    assert.equal(store.listAssets({ scopeId: 'user-a:shop-a' }).length, 1);
    assert.equal(store.deleteAsset({ scopeId: 'user-a:shop-a', assetId: 'same-image' }).deleted, true);
    assert.equal(store.getAsset({ scopeId: 'user-a:shop-a', assetId: 'same-image' }), null);
    assert.notEqual(store.getAsset({ scopeId: 'user-b:shop-b', assetId: 'same-image' }), null);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migrates the pre-v2 asset manifest to a scope-aware primary key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cache-assets-v1-'));
  const databasePath = path.join(root, 'cache.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE asset_manifest (
      asset_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.close();

  const store = createStore(root, { databasePath, assetRoot: path.join(root, 'assets') });
  try {
    const contentBase64 = Buffer.from('same-id-different-scope', 'utf8').toString('base64');
    store.putAsset({ scopeId: 'user-a:shop-a', assetId: 'same', extension: 'bin', mediaType: 'application/octet-stream', contentBase64 });
    store.putAsset({ scopeId: 'user-b:shop-b', assetId: 'same', extension: 'bin', mediaType: 'application/octet-stream', contentBase64 });
    assert.equal(store.listAssets({ scopeId: 'user-a:shop-a' }).length, 1);
    assert.equal(store.listAssets({ scopeId: 'user-b:shop-b' }).length, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not leave API keys, cookies, task bodies or asset bytes in plaintext at rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cache-encrypted-'));
  const databasePath = path.join(root, 'cache.sqlite');
  const store = createStore(root, { databasePath });
  const apiKey = 'ozon-api-key-plain-marker';
  const cookie = 'seller-cookie-plain-marker';
  const assetText = 'private-image-plain-marker';
  try {
    store.putRecord({ scopeId: 'user:shop', namespace: 'shops', key: 'shop', payload: { apiKey } });
    store.enqueueTask({ scopeId: 'user:shop', taskKind: 'ozon.refresh', request: { cookie } });
    store.putAsset({
      scopeId: 'user:shop', assetId: 'private', extension: 'bin', mediaType: 'application/octet-stream',
      contentBase64: Buffer.from(assetText, 'utf8').toString('base64'), metadata: { cookie },
    });
    const databaseBytes = fs.readFileSync(databasePath).toString('latin1');
    const assetFiles = fs.readdirSync(path.join(root, 'assets'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name)).toString('latin1'))
      .join('');
    assert.equal(databaseBytes.includes(apiKey), false);
    assert.equal(databaseBytes.includes(cookie), false);
    assert.equal(assetFiles.includes(assetText), false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
