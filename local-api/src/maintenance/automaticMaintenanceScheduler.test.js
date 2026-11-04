import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAutomaticMaintenanceScheduler, AUTOMATIC_MAINTENANCE_POLICY } from './automaticMaintenanceScheduler.js';
import { createTechnicalRetentionPreviewService } from './technicalRetentionPreview.js';
import { createTechnicalRetentionRunner } from './technicalRetentionRunner.js';

test('automatic maintenance uses the size/daily policy and deletes only terminal runtime rows', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, created_at TEXT, status TEXT);');
  db.prepare('INSERT INTO events VALUES (?, ?, ?)').run('old-terminal', '2026-06-01T00:00:00.000Z', 'completed');
  db.prepare('INSERT INTO events VALUES (?, ?, ?)').run('old-running', '2026-06-01T00:00:00.000Z', 'running');
  const service = createTechnicalRetentionPreviewService(db, {
    now: () => new Date('2026-07-28T00:00:00.000Z'),
    policies: [{
      table: 'events',
      timestamp: 'created_at',
      maxAgeDays: 3,
      maxRows: 1,
      terminalStatuses: ['completed'],
    }],
  });
  const runner = createTechnicalRetentionRunner({ service, schedule: (callback) => callback() });
  const scheduler = createAutomaticMaintenanceScheduler({
    db,
    retentionService: service,
    retentionRunner: runner,
    now: () => new Date('2026-07-28T00:00:00.000Z'),
    logger: { error() {}, warn() {} },
  });
  try {
    const result = await scheduler.runOnce({ force: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.lastDeletedRows, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM events WHERE id = 'old-terminal'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM events WHERE id = 'old-running'`).get().count, 1);
    assert.equal(result.policy.sizeTriggerBytes, 2_000_000_000);
    assert.equal(AUTOMATIC_MAINTENANCE_POLICY.checkIntervalMs, 60 * 60 * 1_000);
    assert.equal(AUTOMATIC_MAINTENANCE_POLICY.timeTriggerMs, 24 * 60 * 60 * 1_000);
  } finally {
    scheduler.stop();
    db.close();
  }
});

test('automatic maintenance can be disabled without installing timers or deleting rows', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, created_at TEXT, status TEXT);');
  db.prepare('INSERT INTO events VALUES (?, ?, ?)').run('old', '2026-06-01T00:00:00.000Z', 'completed');
  const service = createTechnicalRetentionPreviewService(db, {
    policies: [{ table: 'events', timestamp: 'created_at', maxAgeDays: 1, maxRows: 0 }],
  });
  const runner = createTechnicalRetentionRunner({ service, schedule: (callback) => callback() });
  const scheduler = createAutomaticMaintenanceScheduler({
    db,
    retentionService: service,
    retentionRunner: runner,
    enabled: false,
  });
  try {
    assert.equal(scheduler.start().status, 'disabled');
    assert.equal((await scheduler.runOnce({ force: true })).status, 'disabled');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM events').get().count, 1);
  } finally {
    scheduler.stop();
    db.close();
  }
});

test('automatic maintenance completes encrypted archive publication before generic retention', async () => {
  const db = new DatabaseSync(':memory:');
  const order = [];
  const scheduler = createAutomaticMaintenanceScheduler({
    db,
    stageCompactor: {
      compactExpiredTerminalStagePayloads() {
        order.push('product-stage-compaction');
        return { compactedBatches: 4 };
      },
    },
    archiveService: {
      runCycle() {
        order.push('archive');
        return { ok: true, archivedRecords: 3, deletedHotRows: 2, expiredArchives: 1 };
      },
    },
    retentionService: {
      inspect() {
        order.push('retention-preview');
        return { ok: true, maximumCandidateRows: 0, previewFingerprint: 'preview' };
      },
    },
    retentionRunner: {
      start() {
        order.push('retention-start');
        return { ok: true };
      },
      getStatus() {
        return { ok: true, status: 'completed', active: false, processedRows: 0 };
      },
    },
    now: () => new Date('2026-07-29T00:00:00.000Z'),
    logger: { error() {}, warn() {} },
  });
  try {
    const result = await scheduler.runOnce({ force: true });
    assert.deepEqual(order, ['product-stage-compaction', 'archive', 'retention-preview', 'retention-start']);
    assert.equal(result.lastCompactedProductStageBatches, 4);
    assert.equal(result.lastArchivedRecords, 3);
    assert.equal(result.lastExpiredArchives, 1);
    assert.equal(result.lastDeletedRows, 2);
  } finally {
    scheduler.stop();
    db.close();
  }
});

test('automatic maintenance defers while startup synchronization is admitted and retries later', async () => {
  const db = new DatabaseSync(':memory:');
  let busy = true;
  let retentionInspections = 0;
  let deferredCallback = null;
  const scheduler = createAutomaticMaintenanceScheduler({
    db,
    activityProbe: () => ({ busy, pending: busy ? 5 : 0, active: busy ? 3 : 0 }),
    retentionService: {
      inspect() {
        retentionInspections += 1;
        return { ok: true, maximumCandidateRows: 0, previewFingerprint: 'preview' };
      },
    },
    retentionRunner: {
      start() {
        return { ok: true };
      },
      getStatus() {
        return { ok: true, status: 'completed', active: false, processedRows: 0 };
      },
    },
    setTimeoutImpl(callback) {
      deferredCallback = callback;
      return { unref() {} };
    },
    clearTimeoutImpl() {
      deferredCallback = null;
    },
    now: () => new Date('2026-08-18T00:00:00.000Z'),
    logger: { error() {}, warn() {} },
  });
  try {
    const deferred = await scheduler.runOnce();
    assert.equal(deferred.status, 'idle');
    assert.equal(deferred.lastTrigger, 'deferred-runtime-busy');
    assert.equal(retentionInspections, 0);
    assert.equal(typeof deferredCallback, 'function');

    busy = false;
    const completed = await scheduler.runOnce({ force: true });
    assert.equal(completed.status, 'completed');
    assert.equal(retentionInspections, 1);
  } finally {
    scheduler.stop();
    db.close();
  }
});

test('automatic maintenance exposes actual archive pressure and preserves unknown capacity as unverified', async (t) => {
  const db = new DatabaseSync(':memory:');
  const warnings = [];
  const archiveResults = [
    { ok: true, archiveBytes: 3_000, archiveByteLimit: 2_000, archiveCapacitySatisfied: false, invalidArchives: 1 },
    { ok: true, archiveBytes: 1_000, archiveByteLimit: 2_000, archiveCapacitySatisfied: true, invalidArchives: 0 },
    { ok: true, enabled: false },
  ];
  const scheduler = createAutomaticMaintenanceScheduler({
    db,
    archiveService: { runCycle: () => archiveResults.shift() },
    retentionService: { inspect: () => ({ ok: true, maximumCandidateRows: 0, previewFingerprint: 'no-runtime-candidates' }) },
    retentionRunner: {
      start: () => ({ ok: true }),
      getStatus: () => ({ ok: true, status: 'completed', active: false, processedRows: 0 }),
    },
    logger: { error() {}, warn: (message, details) => warnings.push({ message, details }) },
  });
  t.after(() => { scheduler.stop(); db.close(); });
  assert.equal(scheduler.getStatus().lastArchiveCapacitySatisfied, null);
  assert.equal(scheduler.getStatus().archiveCapacityCheckStatus, 'unknown');
  assert.equal(scheduler.getStatus().lastArchiveMeasuredAt, null);
  const pressure = await scheduler.runOnce({ force: true });
  assert.equal(pressure.lastArchiveBytes, 3_000);
  assert.equal(pressure.lastArchiveByteLimit, 2_000);
  assert.equal(pressure.lastArchiveCapacitySatisfied, false);
  assert.equal(pressure.lastArchiveCapacityReason, 'TECHNICAL_ARCHIVE_UNVERIFIED_PACKAGES_PRESERVED');
  assert.equal(pressure.archiveCapacityCheckStatus, 'measured');
  assert.ok(Number.isFinite(Date.parse(pressure.lastArchiveMeasuredAt)));
  assert.ok(warnings.some(item => item.details?.code === pressure.lastArchiveCapacityReason));
  const recovered = await scheduler.runOnce({ force: true });
  assert.equal(recovered.lastArchiveBytes, 1_000);
  assert.equal(recovered.lastArchiveCapacitySatisfied, true);
  assert.equal(recovered.lastArchiveCapacityReason, null);
  const unavailable = await scheduler.runOnce({ force: true });
  assert.equal(unavailable.lastArchiveBytes, null);
  assert.equal(unavailable.lastArchiveByteLimit, null);
  assert.equal(unavailable.lastArchiveCapacitySatisfied, null);
  assert.equal(unavailable.lastArchiveCapacityReason, null);
  assert.equal(unavailable.archiveCapacityCheckStatus, 'unknown');
  assert.equal(unavailable.lastArchiveMeasuredAt, null);
});

test('failed and deferred cycles distinguish the last archive measurement from a new successful check', async (t) => {
  const db = new DatabaseSync(':memory:');
  let clock = '2026-09-05T01:00:00.000Z';
  let busy = false;
  let archiveAttempts = 0;
  const scheduler = createAutomaticMaintenanceScheduler({
    db,
    now: () => new Date(clock),
    activityProbe: () => ({ busy }),
    archiveService: {
      runCycle() {
        archiveAttempts += 1;
        if (archiveAttempts === 2) throw new Error('SYNTHETIC_ARCHIVE_READ_FAILED');
        return { ok: true, archiveBytes: 100, archiveByteLimit: 200, archiveCapacitySatisfied: true };
      },
    },
    retentionService: { inspect: () => ({ ok: true, maximumCandidateRows: 0, previewFingerprint: 'empty-fixture' }) },
    retentionRunner: {
      start: () => ({ ok: true }),
      getStatus: () => ({ ok: true, status: 'completed', active: false, processedRows: 0 }),
    },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl() {},
    logger: { warn() {}, error() {} },
  });
  t.after(() => { scheduler.stop(); db.close(); });
  const first = await scheduler.runOnce({ force: true });
  assert.equal(first.archiveCapacityCheckStatus, 'measured');
  assert.equal(first.lastArchiveMeasuredAt, clock);
  clock = '2026-09-05T02:00:00.000Z';
  const failed = await scheduler.runOnce({ force: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.archiveCapacityCheckStatus, 'failed');
  assert.equal(failed.lastArchiveBytes, 100);
  assert.equal(failed.lastArchiveCapacitySatisfied, true);
  assert.equal(failed.lastArchiveMeasuredAt, first.lastArchiveMeasuredAt);
  assert.notEqual(failed.lastArchiveMeasuredAt, failed.lastFinishedAt);
  busy = true;
  clock = '2026-09-05T03:00:00.000Z';
  const deferred = await scheduler.runOnce();
  assert.equal(deferred.lastTrigger, 'deferred-runtime-busy');
  assert.equal(deferred.archiveCapacityCheckStatus, 'deferred');
  assert.equal(deferred.lastArchiveMeasuredAt, first.lastArchiveMeasuredAt);
  assert.equal(archiveAttempts, 2);
  busy = false;
  const notDue = await scheduler.runOnce();
  assert.equal(notDue.archiveCapacityCheckStatus, 'not-due');
  assert.equal(notDue.lastArchiveMeasuredAt, first.lastArchiveMeasuredAt);
  assert.equal(archiveAttempts, 2);
});

test('a later retention failure does not invalidate a completed archive measurement', async (t) => {
  const db = new DatabaseSync(':memory:');
  const clock = '2026-09-05T01:00:00.000Z';
  const scheduler = createAutomaticMaintenanceScheduler({
    db,
    now: () => new Date(clock),
    archiveService: { runCycle: () => ({ ok: true, archiveBytes: 100, archiveByteLimit: 200, archiveCapacitySatisfied: true }) },
    retentionService: { inspect: () => ({ ok: false }) },
    retentionRunner: { start: () => ({ ok: true }), getStatus: () => ({ ok: true, status: 'completed', active: false }) },
    logger: { warn() {}, error() {} },
  });
  t.after(() => { scheduler.stop(); db.close(); });
  const failed = await scheduler.runOnce({ force: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.archiveCapacityCheckStatus, 'measured');
  assert.equal(failed.lastArchiveMeasuredAt, clock);
  assert.equal(failed.lastArchiveCapacitySatisfied, true);
});
