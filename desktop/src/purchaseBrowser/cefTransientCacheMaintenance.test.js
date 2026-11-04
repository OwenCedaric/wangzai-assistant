import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { pruneCefTransientCache, pruneCefTransientCacheInWorker } from './cefBrowserRuntime.js';

function isolated(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cef-cache-${name}-`));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith(`cef-cache-${name}-`));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writeFixture(root, relative, bytes = 128) {
  const target = path.resolve(root, ...relative.split('/'));
  assert.ok(target.startsWith(`${root}${path.sep}`));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes, 5));
  return target;
}

test('CEF maintenance includes the native global cache without deleting global login storage', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-global-cache-prune-'));
  try {
    const root = path.join(fixture, 'cef-cache-root');
    const global = path.join(root, '_global');
    fs.mkdirSync(path.join(global, 'Cache'), { recursive: true });
    fs.mkdirSync(path.join(global, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(global, 'Cache', 'synthetic-cache.bin'), Buffer.alloc(512, 1));
    fs.writeFileSync(path.join(global, 'Cookies'), 'synthetic-cookie');
    fs.writeFileSync(path.join(global, 'Local Storage', 'synthetic-business-state'), 'must-preserve');
    const result = pruneCefTransientCache({ rootCachePath: root, hardLimitBytes: 100, targetBytes: 50 });
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(path.join(global, 'Cache')), false);
    assert.equal(fs.readFileSync(path.join(global, 'Cookies'), 'utf8'), 'synthetic-cookie');
    assert.equal(fs.readFileSync(path.join(global, 'Local Storage', 'synthetic-business-state'), 'utf8'), 'must-preserve');
  } finally {
    assert.equal(path.dirname(fixture), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(fixture).startsWith('cef-global-cache-prune-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('CEF cache pruning never follows a junction in an allowed relative cache path', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cef-cache-junction-'));
  try {
    const root = path.join(fixture, 'cef-cache-root');
    const owner = path.join(root, 'a'.repeat(40));
    const outside = path.join(fixture, 'outside-selected-cache-root');
    const protectedFile = path.join(outside, 'CacheStorage', 'synthetic-protected-state');
    fs.mkdirSync(owner, { recursive: true });
    fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
    fs.writeFileSync(protectedFile, 'must-preserve');
    fs.symlinkSync(outside, path.join(owner, 'Service Worker'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(owner, 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(owner, 'Cache', 'synthetic-cache.bin'), Buffer.alloc(512, 1));
    fs.writeFileSync(path.join(owner, 'Cookies'), Buffer.alloc(100, 2));
    pruneCefTransientCache({ rootCachePath: root, hardLimitBytes: 100, targetBytes: 0 });
    assert.equal(fs.existsSync(protectedFile), true, 'outside-root synthetic storage must survive');
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'must-preserve');
  } finally {
    assert.equal(path.dirname(fixture), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(fixture).startsWith('cef-cache-junction-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('automatic budgets count only pure allowlisted caches and preserve all browser storage', (t) => {
  const root = isolated(t, 'pure-budget');
  const owner = 'b'.repeat(40);
  const pureCache = writeFixture(root, `${owner}/Cache/data`, 40);
  const protectedPaths = [
    'Cookies', 'Network/Cookies', 'IndexedDB/account.ldb', 'Local Storage/leveldb/data.ldb',
    'Session Storage/state', 'blob_storage/blob', 'Service Worker/CacheStorage/offline',
    'unknown-store/data',
  ].map((name) => writeFixture(root, `${owner}/${name}`, 200));
  const result = pruneCefTransientCache({ rootCachePath: root, automatic: true, cacheHardLimitBytes: 100, cacheTargetBytes: 60 });
  assert.equal(result.removed, 0);
  assert.equal(result.cacheBeforeBytes, 40);
  assert.equal(result.mode, 'allowlisted-transient-cache');
  assert.equal(result.protectedBytes, null, 'automatic maintenance does not traverse or miscount business stores');
  assert.equal(fs.existsSync(pureCache), true);
  for (const file of protectedPaths) assert.equal(fs.statSync(file).size, 200);
});

test('automatic capacity maintenance includes global pure caches but never service worker offline content', (t) => {
  const root = isolated(t, 'global-automatic');
  const cache = writeFixture(root, '_global/Cache/data', 512);
  const offline = writeFixture(root, '_global/Service Worker/CacheStorage/offline', 512);
  const result = pruneCefTransientCache({ rootCachePath: root, automatic: true, cacheHardLimitBytes: 100, cacheTargetBytes: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.equal(result.cacheBeforeBytes, 512);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.statSync(offline).size, 512);
});

test('maintenance skips an active account and shared global resources', (t) => {
  const root = isolated(t, 'active');
  const active = 'a'.repeat(40), idle = 'b'.repeat(40);
  const activeCache = writeFixture(root, `${active}/Cache/data`, 256);
  const globalCache = writeFixture(root, '_global/GPUCache/data', 256);
  const idleCache = writeFixture(root, `${idle}/Cache/data`, 256);
  const result = pruneCefTransientCache({ rootCachePath: root, automatic: true,
    cacheHardLimitBytes: 100, cacheTargetBytes: 0, activeProfileRefs: [active] });
  assert.equal(result.skippedActiveProfiles, 2);
  assert.equal(fs.existsSync(activeCache), true);
  assert.equal(fs.existsSync(globalCache), true);
  assert.equal(fs.existsSync(idleCache), false);
});

test('age maintenance uses the newest cache-entry timestamp instead of old account directory time', (t) => {
  const root = isolated(t, 'age');
  const owner = 'c'.repeat(40);
  const nowMs = Date.UTC(2026, 8, 5, 12);
  const oldMs = nowMs - 9 * 24 * 3600 * 1000;
  const recentMs = nowMs - 3600 * 1000;
  const oldCache = writeFixture(root, `${owner}/Cache/old`, 32);
  const hotCache = writeFixture(root, `${owner}/Code Cache/recent`, 32);
  for (const cacheFile of [oldCache, hotCache]) {
    fs.utimesSync(cacheFile, oldMs / 1000, oldMs / 1000);
    fs.utimesSync(path.dirname(cacheFile), oldMs / 1000, oldMs / 1000);
  }
  fs.utimesSync(hotCache, recentMs / 1000, recentMs / 1000);
  const result = pruneCefTransientCache({ rootCachePath: root, automatic: true, maxAgeMs: 7 * 24 * 3600 * 1000, nowMs });
  assert.equal(result.capacityTriggered, false);
  assert.equal(result.expiredRemoved, 1);
  assert.equal(fs.existsSync(oldCache), false);
  assert.equal(fs.existsSync(hotCache), true);
});

test('a linked cache root is rejected before touching its target', (t) => {
  const fixture = isolated(t, 'linked-root');
  const outside = path.join(fixture, 'outside');
  const cache = writeFixture(outside, `${'d'.repeat(40)}/Cache/protected`, 256);
  const root = path.join(fixture, 'linked-cef-cache-root');
  fs.symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pruneCefTransientCache({ rootCachePath: root, hardLimitBytes: 1, targetBytes: 0 }),
    (error) => error.code === 'PURCHASE_BROWSER_CACHE_LINKED_PATH_REJECTED');
  assert.equal(fs.existsSync(cache), true);
});

test('an owner directory or a nested cache link cannot redirect maintenance', (t) => {
  const fixture = isolated(t, 'linked-owner');
  const root = path.join(fixture, 'root');
  const outside = path.join(fixture, 'outside');
  const outsideCache = writeFixture(outside, 'Cache/protected', 256);
  const keptInside = writeFixture(root, `${'e'.repeat(40)}/Cache/inside`, 256);
  fs.symlinkSync(outside, path.join(root, 'd'.repeat(40)), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(outside, path.join(root, 'e'.repeat(40), 'Cache', 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = pruneCefTransientCache({ rootCachePath: root, automatic: true, cacheHardLimitBytes: 1, cacheTargetBytes: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.removed, 0);
  assert.ok(result.errors.every((error) => error.code === 'PURCHASE_BROWSER_CACHE_LINKED_PATH_REJECTED'));
  assert.equal(fs.existsSync(outsideCache), true);
  assert.equal(fs.existsSync(keptInside), true);
});

test('legacy budgets preserve protected storage and report an unreachable budget truthfully', (t) => {
  const root = isolated(t, 'unreachable');
  const owner = 'a'.repeat(40);
  const cookie = writeFixture(root, `${owner}/Cookies`, 256);
  writeFixture(root, `${owner}/Cache/data`, 256);
  const result = pruneCefTransientCache({ rootCachePath: root, hardLimitBytes: 100, targetBytes: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.targetReached, false);
  assert.equal(result.code, 'PURCHASE_BROWSER_CACHE_BUDGET_NOT_REACHABLE');
  assert.equal(result.afterBytes, 256);
  assert.equal(fs.statSync(cookie).size, 256);
});

function controlledWorker() {
  const worker = new EventEmitter();
  const termination = Promise.withResolvers();
  let timeout;
  let terminateCalls = 0;
  worker.terminate = () => { terminateCalls++; return termination.promise; };
  return {
    worker, termination,
    get terminateCalls() { return terminateCalls; },
    timeout() { timeout(); },
    dependencies: { createWorker: () => worker, schedule: (callback) => { timeout = callback; return { unref() {} }; }, cancel() {} },
  };
}

test('worker success is not released until the worker actually exits', async (t) => {
  const root = isolated(t, 'worker-result');
  const control = controlledWorker();
  let settled = false;
  const task = pruneCefTransientCacheInWorker({ rootCachePath: root }, control.dependencies);
  task.then(() => { settled = true; });
  control.worker.emit('message', { ok: true, removed: 2 });
  await Promise.resolve();
  assert.equal(settled, false);
  control.worker.emit('exit', 0);
  assert.deepEqual(await task, { ok: true, removed: 2, exitVerified: true });
});

test('worker timeout waits for termination completion and does not claim zero deletions', async (t) => {
  const root = isolated(t, 'worker-timeout');
  const control = controlledWorker();
  let settled = false;
  const task = pruneCefTransientCacheInWorker({ rootCachePath: root }, control.dependencies);
  task.then(() => { settled = true; });
  control.timeout();
  await Promise.resolve();
  assert.equal(control.terminateCalls, 1);
  assert.equal(settled, false);
  control.termination.resolve(1);
  const result = await task;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitVerified, true);
  assert.equal(result.removed, null);
  assert.equal(result.mutationOutcome, 'unknown');
});

test('same-root worker calls coalesce while a failed worker is still exiting', async (t) => {
  const root = isolated(t, 'worker-singleflight');
  const control = controlledWorker();
  const first = pruneCefTransientCacheInWorker({ rootCachePath: root }, control.dependencies);
  control.worker.emit('error', new Error('isolated worker error'));
  const second = pruneCefTransientCacheInWorker({ rootCachePath: root }, {
    createWorker() { throw new Error('must not create a second worker'); },
  });
  assert.equal(first, second);
  control.worker.emit('exit', 1);
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.exitVerified, true);
});

test('real worker preserves isolated storage and verifies exit after cache deletion', async (t) => {
  const root = isolated(t, 'real-worker');
  const owner = 'a'.repeat(40);
  const cache = writeFixture(root, `${owner}/Cache/data`, 128);
  const protectedStorage = writeFixture(root, `${owner}/IndexedDB/synthetic.ldb`, 128);
  const result = await pruneCefTransientCacheInWorker({ rootCachePath: root, automatic: true, cacheHardLimitBytes: 1, cacheTargetBytes: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.exitVerified, true);
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.statSync(protectedStorage).size, 128);
});

test('abort does not release an idle maintenance fence until its worker exits', async (t) => {
  const root = isolated(t, 'worker-abort');
  const control = controlledWorker();
  const controller = new AbortController();
  let settled = false;
  const task = pruneCefTransientCacheInWorker({ rootCachePath: root }, { ...control.dependencies, signal: controller.signal });
  task.then(() => { settled = true; });
  controller.abort();
  await Promise.resolve();
  assert.equal(control.terminateCalls, 1);
  assert.equal(settled, false);
  control.worker.emit('exit', 1);
  const result = await task;
  assert.equal(result.cancelled, true);
  assert.equal(result.exitVerified, true);
  assert.equal(result.removed, null);
  assert.equal(result.mutationOutcome, 'unknown');
  control.termination.resolve(1);
});

test('already aborted maintenance never starts another worker', async (t) => {
  const root = isolated(t, 'already-aborted');
  const controller = new AbortController();
  controller.abort();
  const result = await pruneCefTransientCacheInWorker({ rootCachePath: root }, {
    signal: controller.signal, createWorker() { throw new Error('must never start'); },
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.started, false);
  assert.equal(result.exitVerified, true);
  assert.equal(result.removed, null);
});

test('a coalesced foreground abort stops the existing same-root worker', async (t) => {
  const root = isolated(t, 'coalesced-abort');
  const control = controlledWorker();
  const controller = new AbortController();
  const first = pruneCefTransientCacheInWorker({ rootCachePath: root }, control.dependencies);
  const second = pruneCefTransientCacheInWorker({ rootCachePath: root }, { signal: controller.signal });
  assert.equal(first, second);
  controller.abort();
  assert.equal(control.terminateCalls, 1);
  control.termination.resolve(1);
  assert.equal((await first).cancelled, true);
});

test('real worker cancellation is observed after exit and preserves protected storage', async (t) => {
  const root = isolated(t, 'real-worker-abort');
  const owner = 'a'.repeat(40);
  writeFixture(root, `${owner}/Cache/data`, 128);
  const storage = writeFixture(root, `${owner}/IndexedDB/synthetic.ldb`, 128);
  const controller = new AbortController();
  let exited = false;
  const task = pruneCefTransientCacheInWorker({ rootCachePath: root, automatic: true, cacheHardLimitBytes: 1, cacheTargetBytes: 0 }, {
    signal: controller.signal,
    createWorker(url, config) {
      assert.equal(Object.hasOwn(config.workerData, 'signal'), false);
      const worker = new Worker(url, config);
      worker.once('exit', () => { exited = true; });
      return worker;
    },
  });
  controller.abort();
  const result = await task;
  assert.equal(exited, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.exitVerified, true);
  assert.equal(result.removed, null);
  assert.equal(fs.statSync(storage).size, 128);
});
