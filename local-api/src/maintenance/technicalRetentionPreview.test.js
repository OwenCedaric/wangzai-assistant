import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createTechnicalRetentionPreviewService,
  DEFAULT_TECHNICAL_RETENTION_POLICIES,
  TECHNICAL_RETENTION_CONFIRMATION,
} from './technicalRetentionPreview.js';

function createEventsDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, created_at TEXT, status TEXT);');
  return db;
}

function policy() {
  return [{ table: 'events', timestamp: 'created_at', maxAgeDays: 7, maxRows: 1 }];
}

test('technical retention preview is read-only, excludes undated live rows, and reports exact union candidates', () => {
  const db = createEventsDb();
  try {
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('old', '2025-01-01T00:00:00.000Z', 'complete');
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('recent', '2026-07-10T00:00:00.000Z', 'complete');
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('live', null, 'running');
    const preview = createTechnicalRetentionPreviewService(db, {
      now: () => new Date('2026-07-11T12:34:56.000Z'), policies: policy(),
    }).inspect();
    assert.equal(preview.mode, 'read-only-preview');
    assert.equal(preview.tables[0].datedRows, 2);
    assert.equal(preview.tables[0].eligibleByAge, 1);
    assert.equal(preview.tables[0].eligibleByRowLimit, 1);
    assert.equal(preview.tables[0].candidateRows, 1);
    assert.match(preview.previewFingerprint, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 3);
  } finally {
    db.close();
  }
});

test('technical retention requires backup acknowledgement and exact preview then deletes only candidates', () => {
  const db = createEventsDb();
  try {
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('old', '2025-01-01T00:00:00.000Z', 'complete');
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('recent', '2026-07-10T00:00:00.000Z', 'complete');
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('live', null, 'running');
    const service = createTechnicalRetentionPreviewService(db, {
      now: () => new Date('2026-07-11T00:00:00.000Z'), policies: policy(),
    });
    const preview = service.inspect();
    assert.equal(service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
    }).code, 'TECHNICAL_RETENTION_CONFIRMATION_REQUIRED');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 3);

    const result = service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.deleted, [{ table: 'events', rows: 1 }]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE id = 'old'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE id = 'recent'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE id = 'live'`).get().count, 1);
    assert.equal(result.preview.maximumCandidateRows, 0);
  } finally {
    db.close();
  }
});

test('terminal-status retention never deletes an old queued or running request job', () => {
  const db = createEventsDb();
  try {
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('success', '2025-01-01T00:00:00.000Z', 'success');
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('queued', '2025-01-01T00:00:00.000Z', 'queued');
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('running', '2025-01-01T00:00:00.000Z', 'running');
    const service = createTechnicalRetentionPreviewService(db, {
      now: () => new Date('2026-07-11T00:00:00.000Z'),
      policies: [{ table: 'events', timestamp: 'created_at', maxAgeDays: 7, maxRows: 0, terminalStatuses: ['success'] }],
    });
    const preview = service.inspect();
    assert.equal(preview.tables[0].datedRows, 1);
    assert.equal(preview.tables[0].candidateRows, 1);

    const result = service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
    });
    assert.equal(result.ok, true);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE id = 'success'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE id IN ('queued', 'running')`).get().count, 2);
  } finally {
    db.close();
  }
});

test('default technical retention keeps seven days and hard-caps high-volume technical rows', () => {
  const byTable = new Map(DEFAULT_TECHNICAL_RETENTION_POLICIES.map((policy) => [policy.table, policy]));
  assert.equal(byTable.get('product_sync_runs').maxAgeDays, 7);
  assert.equal(byTable.get('product_sync_runs').maxRows, Number.MAX_SAFE_INTEGER);
  assert.equal(byTable.get('product_sync_runs').batchRows, 10);
  assert.deepEqual(byTable.get('product_sync_runs').terminalStatuses, [
    'completed',
    'completed_with_source_gaps',
    'partial',
    'failed',
    'interrupted',
    'invalid',
    'canceled',
  ]);
  for (const policyEntry of DEFAULT_TECHNICAL_RETENTION_POLICIES) {
    assert.equal(policyEntry.maxAgeDays, 7, policyEntry.table);
  }
  assert.equal(byTable.get('ozon_scheduler_trace_events').maxRows, 150_000);
  assert.equal(byTable.get('ozon_request_attempts').maxRows, 150_000);
  assert.equal(byTable.get('ozon_sync_snapshots').maxRows, 50_000);
  assert.equal(byTable.get('ozon_request_jobs').maxRows, 100_000);
  assert.equal(byTable.get('ozon_cache_merge_log').maxRows, 100_000);
  assert.equal(byTable.get('ozon_sync_locks').maxRows, 20_000);
  assert.deepEqual(byTable.get('ozon_request_jobs').terminalStatuses, ['success', 'partial', 'failed', 'canceled', 'blocked']);
});

test('technical retention deletes expired rows before trimming the remaining dated rows to the cap', () => {
  const db = createEventsDb();
  try {
    const records = [
      ['old-1', '2026-06-01T00:00:00.000Z'],
      ['old-2', '2026-06-02T00:00:00.000Z'],
      ['recent-1', '2026-07-08T00:00:00.000Z'],
      ['recent-2', '2026-07-09T00:00:00.000Z'],
      ['recent-3', '2026-07-10T00:00:00.000Z'],
    ];
    for (const [id, createdAt] of records) {
      db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run(id, createdAt, 'complete');
    }
    const service = createTechnicalRetentionPreviewService(db, {
      now: () => new Date('2026-07-11T00:00:00.000Z'),
      policies: [{ table: 'events', timestamp: 'created_at', maxAgeDays: 7, maxRows: 2 }],
    });
    const preview = service.inspect();
    assert.equal(preview.tables[0].eligibleByAge, 2);
    assert.equal(preview.tables[0].eligibleByRowLimit, 3);
    assert.equal(preview.tables[0].candidateRows, 3);

    const result = service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.deleted, [{ table: 'events', rows: 3 }]);
    assert.deepEqual(
      db.prepare('SELECT id FROM events ORDER BY created_at ASC').all().map((row) => row.id),
      ['recent-2', 'recent-3'],
    );
  } finally {
    db.close();
  }
});

test('technical retention bounds a confirmed cleanup to one resumable batch', () => {
  const db = createEventsDb();
  try {
    for (const [id, createdAt] of [
      ['old-1', '2026-06-01T00:00:00.000Z'],
      ['old-2', '2026-06-02T00:00:00.000Z'],
      ['old-3', '2026-06-03T00:00:00.000Z'],
    ]) {
      db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run(id, createdAt, 'complete');
    }
    const service = createTechnicalRetentionPreviewService(db, {
      now: () => new Date('2026-07-11T00:00:00.000Z'),
      policies: [{ table: 'events', timestamp: 'created_at', maxAgeDays: 7, maxRows: 0 }],
    });
    const preview = service.inspect();
    const first = service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
      maxDeleteRows: 1,
    });

    assert.equal(first.ok, true);
    assert.equal(first.mode, 'confirmed-batch');
    assert.equal(first.batchRows, 1);
    assert.equal(first.remainingCandidateRows, 2);
    assert.deepEqual(first.deleted, [{ table: 'events', rows: 1 }]);
  } finally {
    db.close();
  }
});

test('technical retention honors a smaller parent-table batch cap within the global maintenance slice', () => {
  const db = createEventsDb();
  try {
    for (const [id, createdAt] of [
      ['old-1', '2026-06-01T00:00:00.000Z'],
      ['old-2', '2026-06-02T00:00:00.000Z'],
      ['old-3', '2026-06-03T00:00:00.000Z'],
    ]) {
      db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run(id, createdAt, 'complete');
    }
    const service = createTechnicalRetentionPreviewService(db, {
      now: () => new Date('2026-07-11T00:00:00.000Z'),
      policies: [{ table: 'events', timestamp: 'created_at', maxAgeDays: 7, maxRows: 0, batchRows: 1 }],
    });
    const preview = service.inspect();
    const result = service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
      maxDeleteRows: 20_000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'confirmed-batch');
    assert.equal(result.batchRows, 1);
    assert.equal(result.remainingCandidateRows, 2);
  } finally {
    db.close();
  }
});

test('technical retention rejects a stale preview without deleting rows', () => {
  const db = createEventsDb();
  try {
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('old', '2025-01-01T00:00:00.000Z', 'complete');
    const service = createTechnicalRetentionPreviewService(db, {
      now: () => new Date('2026-07-11T00:00:00.000Z'), policies: policy(),
    });
    const preview = service.inspect();
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('new-old', '2025-02-01T00:00:00.000Z', 'complete');
    const result = service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TECHNICAL_RETENTION_PREVIEW_STALE');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 2);
  } finally {
    db.close();
  }
});

test('technical retention detects replacement candidates even when the candidate count does not change', () => {
  const db = createEventsDb();
  try {
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('old', '2025-01-01T00:00:00.000Z', 'complete');
    const service = createTechnicalRetentionPreviewService(db, {
      now: () => new Date('2026-07-11T00:00:00.000Z'), policies: policy(),
    });
    const preview = service.inspect();
    db.prepare(`DELETE FROM events WHERE id = 'old'`).run();
    db.prepare('INSERT INTO events (id, created_at, status) VALUES (?, ?, ?)').run('replacement-old', '2025-02-01T00:00:00.000Z', 'complete');

    const result = service.applyConfirmed({
      confirmation: TECHNICAL_RETENTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'TECHNICAL_RETENTION_PREVIEW_STALE');
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events WHERE id = 'replacement-old'`).get().count, 1);
  } finally {
    db.close();
  }
});
