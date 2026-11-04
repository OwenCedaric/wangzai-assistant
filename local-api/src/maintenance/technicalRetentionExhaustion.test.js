import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createTechnicalRetentionPreviewService, TECHNICAL_RETENTION_CONFIRMATION } from './technicalRetentionPreview.js';
import { createTechnicalRetentionRunner } from './technicalRetentionRunner.js';

test('a retention job completes when its stale preview has been exhausted by another authorized cleanup', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TABLE synthetic_runtime_trace(id INTEGER PRIMARY KEY, created_at TEXT); INSERT INTO synthetic_runtime_trace VALUES(1, '2020-01-01T00:00:00.000Z');");
  const service = createTechnicalRetentionPreviewService(db, { now: () => new Date('2026-09-05T00:00:00.000Z'),
    policies: [{ table: 'synthetic_runtime_trace', timestamp: 'created_at', maxAgeDays: 7, maxRows: 100 }] });
  const callbacks = [];
  const runner = createTechnicalRetentionRunner({ service, schedule: (callback) => callbacks.push(callback) });
  const preview = service.inspect();
  runner.start({ confirmation: TECHNICAL_RETENTION_CONFIRMATION, backupAcknowledged: true, previewFingerprint: preview.previewFingerprint });
  db.exec('DELETE FROM synthetic_runtime_trace');
  callbacks.shift()();
  assert.equal(runner.getStatus().active, false);
  assert.equal(runner.getStatus().status, 'completed');
  assert.equal(callbacks.length, 0);
});

test('an exact empty retention plan explicitly reports completed zero work', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE synthetic_runtime_trace(id INTEGER PRIMARY KEY, created_at TEXT)');
  const service = createTechnicalRetentionPreviewService(db, {
    policies: [{ table: 'synthetic_runtime_trace', timestamp: 'created_at', maxAgeDays: 7, maxRows: 100 }],
  });
  const result = service.applyConfirmed({ confirmation: TECHNICAL_RETENTION_CONFIRMATION, backupAcknowledged: true,
    previewFingerprint: service.inspect().previewFingerprint });
  assert.equal(result.complete, true);
  assert.equal(result.remainingCandidateRows, 0);
});

test('fresh runtime log writes between slices cannot starve an already confirmed retention job', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE synthetic_runtime_trace(id INTEGER PRIMARY KEY, created_at TEXT); CREATE TABLE business_facts(id TEXT PRIMARY KEY, value TEXT);');
  db.prepare('INSERT INTO business_facts VALUES (?, ?)').run('order-profit-proof', 'must-survive');
  const insert = db.prepare('INSERT INTO synthetic_runtime_trace VALUES (?, ?)');
  for (let id = 1; id <= 3; id += 1) insert.run(id, '2020-01-01T00:00:00.000Z');
  const service = createTechnicalRetentionPreviewService(db, {
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    policies: [{ table: 'synthetic_runtime_trace', timestamp: 'created_at', maxAgeDays: 7, maxRows: 100 }],
  });
  const callbacks = [];
  const runner = createTechnicalRetentionRunner({ service, batchRows: 1, schedule: callback => callbacks.push(callback) });
  runner.start({ confirmation: TECHNICAL_RETENTION_CONFIRMATION, backupAcknowledged: true,
    previewFingerprint: service.inspect().previewFingerprint });

  let slices = 0;
  while (callbacks.length && slices < 6) {
    slices += 1;
    // An ordinary new, non-expired log changes totalRows in the preview.
    insert.run(100 + slices, '2026-09-05T00:00:00.000Z');
    callbacks.shift()();
  }

  assert.equal(runner.getStatus().status, 'completed');
  assert.equal(runner.getStatus().processedRows, 3);
  assert.equal(slices, 3);
  assert.equal(callbacks.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM synthetic_runtime_trace WHERE created_at = '2026-09-05T00:00:00.000Z'").get().count, 3);
  assert.equal(db.prepare('SELECT value FROM business_facts').get().value, 'must-survive');
});
