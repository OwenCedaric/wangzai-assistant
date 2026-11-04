import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createDatabaseCompactionService,
  DATABASE_COMPACTION_CONFIRMATION,
} from './databaseCompactionService.js';

function createFileDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'wangzai-compact-'));
  const databasePath = join(directory, 'app.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE records (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);');
  const insert = db.prepare('INSERT INTO records (payload) VALUES (?)');
  const largePayload = 'x'.repeat(2048);
  for (let index = 0; index < 600; index += 1) insert.run(largePayload);
  db.exec('DELETE FROM records WHERE id <= 450; PRAGMA wal_checkpoint(TRUNCATE);');
  return { db, databasePath, directory };
}

test('database compaction requires backup acknowledgement and reclaims only free SQLite pages', () => {
  const { db, databasePath, directory } = createFileDatabase();
  try {
    const service = createDatabaseCompactionService(db, { databasePath });
    const preview = service.inspect();
    assert.equal(preview.recommended, true);
    assert.ok(preview.sqlite.freePages > 0);
    assert.equal(service.applyConfirmed({
      confirmation: DATABASE_COMPACTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
    }).code, 'DATABASE_COMPACTION_CONFIRMATION_REQUIRED');

    const result = service.applyConfirmed({
      confirmation: DATABASE_COMPACTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'confirmed-vacuum');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM records').get().count, 150);
    assert.ok(result.after.logicalBytes < result.before.logicalBytes);
    assert.equal(result.after.freePages, 0);
    assert.equal(result.after.autoVacuumMode, 2);
    assert.equal(result.walTruncated, true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database compaction rejects a preview changed by later data growth', () => {
  const { db, databasePath, directory } = createFileDatabase();
  try {
    const service = createDatabaseCompactionService(db, { databasePath });
    const preview = service.inspect();
    db.prepare('INSERT INTO records (payload) VALUES (?)').run('changed-after-preview'.repeat(512));
    const result = service.applyConfirmed({
      confirmation: DATABASE_COMPACTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      backupAcknowledged: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DATABASE_COMPACTION_PREVIEW_STALE');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
