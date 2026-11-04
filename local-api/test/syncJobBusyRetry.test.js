import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createSyncJobService, isSqliteBusyError, SYNC_JOB_STATUS } from '../src/sync/syncJobService.js';
import { createMigratedTestDb } from './testDb.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

test('sync job status write survives a competing SQLite writer and persists after the lock clears', async () => {
  const tempRoot = resolve('.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(resolve(tempRoot, 'sync-job-busy-retry-'));
  const databasePath = resolve(directory, 'runtime.sqlite');
  const db = createMigratedTestDb(databasePath);
  const lockDb = new DatabaseSync(databasePath);
  const retryEvents = [];
  let lockOpen = false;

  try {
    db.exec('PRAGMA busy_timeout = 1;');
    lockDb.exec('PRAGMA busy_timeout = 1;');
    const jobs = createSyncJobService(db, {
      busyRetryDelaysMs: [5, 10, 20, 40],
      logBusyRetry(event) {
        retryEvents.push(event);
      },
    });
    jobs.createJob({ id: 'job-locked-write', domain: 'finance', status: SYNC_JOB_STATUS.running });

    lockDb.exec('BEGIN IMMEDIATE;');
    lockOpen = true;
    const projected = jobs.updateJob('job-locked-write', {
      status: SYNC_JOB_STATUS.failed,
      lastError: 'upstream request failed',
      finishedAt: '2026-08-19T00:00:00.000Z',
    });

    assert.equal(projected.status, SYNC_JOB_STATUS.failed);
    assert.equal(projected.lastError, 'upstream request failed');
    assert.equal(jobs.getJob('job-locked-write').status, SYNC_JOB_STATUS.running);
    assert.equal(retryEvents[0]?.code, 'SQLITE_BUSY_RETRY_SCHEDULED');

    await new Promise((resolvePromise) => {
      setTimeout(() => {
        lockDb.exec('COMMIT;');
        lockOpen = false;
        resolvePromise();
      }, 8);
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));

    const persisted = jobs.getJob('job-locked-write');
    assert.equal(persisted.status, SYNC_JOB_STATUS.failed);
    assert.equal(persisted.lastError, 'upstream request failed');
    assert.equal(persisted.finishedAt, '2026-08-19T00:00:00.000Z');
    assert.equal(retryEvents.some((event) => event.code === 'SQLITE_BUSY_RETRY_EXHAUSTED'), false);
  } finally {
    if (lockOpen) {
      try { lockDb.exec('ROLLBACK;'); } catch {}
    }
    lockDb.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite busy detection is narrow and does not hide unrelated database failures', () => {
  assert.equal(isSqliteBusyError(Object.assign(new Error('database is locked'), { errcode: 5 })), true);
  assert.equal(isSqliteBusyError(Object.assign(new Error('constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 19 })), false);
});
