import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryReconcileState } from './recoveryReconcileState.js';
import { createMigratedTestDb } from '../../test/testDb.js';

test('recovery reconcile state stays pending until the startup sync accepts at least one policy', () => {
  const db = createMigratedTestDb();
  const clock = new Date('2026-07-11T12:00:00.000Z');
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-recovery', 'Recovery Shop', 'active', clock.toISOString(), clock.toISOString());
    const state = createRecoveryReconcileState({ db, now: () => clock });
    const pending = state.prepare({
      restoreId: 'restore-1',
      generationId: 'generation-1',
      shopId: 'shop-recovery',
      overlapMinutes: 30,
    });
    assert.equal(pending.status, 'pending');
    assert.equal(state.listPending().length, 1);

    const stillPending = state.markQueued({
      restoreId: 'restore-1',
      shopId: 'shop-recovery',
      queuedPolicyCount: 0,
      lastError: 'service_not_connected',
    });
    assert.equal(stillPending.status, 'pending');
    assert.equal(stillPending.lastError, 'service_not_connected');

    const queued = state.markQueued({
      restoreId: 'restore-1',
      shopId: 'shop-recovery',
      queuedPolicyCount: 3,
    });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.queuedPolicyCount, 3);
    assert.equal(state.getStatus().pending, 0);
    assert.equal(state.getStatus().queued, 1);
  } finally {
    db.close();
  }
});

test('recovery reconcile state finalizes tracked jobs only after every accepted scheduler job is terminal', () => {
  const db = createMigratedTestDb();
  const clock = new Date('2026-07-12T01:00:00.000Z');
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-reconcile-final', 'Recovery Final Shop', 'active', clock.toISOString(), clock.toISOString());
    const state = createRecoveryReconcileState({ db, now: () => clock });
    state.prepare({ restoreId: 'restore-final', generationId: 'generation-final', shopId: 'shop-reconcile-final' });
    state.markQueued({
      restoreId: 'restore-final',
      shopId: 'shop-reconcile-final',
      queuedPolicyCount: 2,
      jobIds: ['reconcile-success', 'reconcile-running'],
    });
    assert.deepEqual(state.reconcileQueuedJobs({
      getJob: (jobId) => ({ status: jobId === 'reconcile-success' ? 'success' : 'running' }),
    }), []);
    assert.equal(state.get('restore-final', 'shop-reconcile-final').status, 'queued');

    const finalized = state.reconcileQueuedJobs({
      getJob: (jobId) => jobId === 'reconcile-success'
        ? { status: 'success' }
        : { status: 'failed', lastError: 'fixture failure' },
    });
    assert.equal(finalized.length, 1);
    const result = state.get('restore-final', 'shop-reconcile-final');
    assert.equal(result.status, 'partial');
    assert.equal(result.completedPolicyCount, 1);
    assert.equal(result.failedPolicyCount, 1);
    assert.equal(result.lastError, 'fixture failure');
    assert.equal(state.getStatus().partial, 1);

    state.prepare({ restoreId: 'restore-missing', generationId: 'generation-missing', shopId: 'shop-reconcile-final' });
    state.markQueued({ restoreId: 'restore-missing', shopId: 'shop-reconcile-final', queuedPolicyCount: 1, jobIds: ['pruned-job'] });
    state.reconcileQueuedJobs({ getJob: () => null });
    const missing = state.get('restore-missing', 'shop-reconcile-final');
    assert.equal(missing.status, 'failed');
    assert.match(missing.lastError, /pruned-job: job_missing_or_failed/);
  } finally {
    db.close();
  }
});
