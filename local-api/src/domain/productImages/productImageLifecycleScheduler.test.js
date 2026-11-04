import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductImageLifecycleScheduler } from './productImageLifecycleScheduler.js';

test('runs one cleanup at a time and exposes deletion results', async () => {
  let resolveCleanup;
  let calls = 0;
  const service = {
    cleanupExpiredAssets() {
      calls += 1;
      return new Promise((resolve) => { resolveCleanup = resolve; });
    },
  };
  const scheduler = createProductImageLifecycleScheduler({ service, config: { batchSize: 12 } });
  const first = scheduler.runOnce('manual');
  const second = scheduler.runOnce('manual-duplicate');
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveCleanup({ ok: true, scanned: 4, deleted: 3, failed: 1 });
  assert.equal(await first, await second);
  assert.equal(scheduler.getStatus().lastScanned, 4);
  assert.equal(scheduler.getStatus().lastDeleted, 3);
  assert.equal(scheduler.getStatus().lastFailed, 1);
  assert.equal(scheduler.getStatus().status, 'retry_pending');
});

test('starts and stops lifecycle timers without keeping the process alive', () => {
  const timers = [];
  const cleared = [];
  const timer = () => {
    const value = { unrefCalled: false, unref() { this.unrefCalled = true; } };
    timers.push(value);
    return value;
  };
  const scheduler = createProductImageLifecycleScheduler({
    service: { cleanupExpiredAssets: async () => ({ ok: true, scanned: 0, deleted: 0, failed: 0 }) },
    config: { startupDelayMs: 10, intervalMs: 1000 },
    setTimeoutImpl: timer,
    setIntervalImpl: timer,
    clearTimeoutImpl: (value) => cleared.push(value),
    clearIntervalImpl: (value) => cleared.push(value),
  });
  scheduler.start();
  assert.equal(timers.length, 2);
  assert.ok(timers.every((item) => item.unrefCalled));
  scheduler.stop();
  assert.equal(cleared.length, 2);
});
