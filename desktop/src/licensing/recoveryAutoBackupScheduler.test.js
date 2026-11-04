import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryAutoBackupScheduler } from './recoveryAutoBackupScheduler.js';

test('recovery auto backup scheduler coalesces overlapping attempts and records failures without throwing', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const scheduler = createRecoveryAutoBackupScheduler({
    runBackup: async () => {
      calls += 1;
      await pending;
      return { uploaded: true };
    },
    now: () => '2026-07-11T12:00:00.000Z',
  });
  const first = scheduler.runNow('test');
  assert.deepEqual(await scheduler.runNow('test'), { ok: false, skipped: 'already-running' });
  release();
  assert.deepEqual(await first, { ok: true, result: { uploaded: true } });
  assert.equal(calls, 1);
  assert.equal(scheduler.getStatus().lastSuccessAt, '2026-07-11T12:00:00.000Z');
});

test('recovery auto backup scheduler converts a retryable run failure into observable status', async () => {
  const scheduler = createRecoveryAutoBackupScheduler({
    runBackup: async () => { throw new Error('network unavailable'); },
  });
  assert.deepEqual(await scheduler.runNow(), { ok: false, error: 'network unavailable' });
  assert.equal(scheduler.getStatus().lastError, 'network unavailable');
});
