import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { withRollbackJournalTransaction } from './recoveryJournalModeGuard.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-journal-guard-'));
  const paths = [join(root, 'main.sqlite'), join(root, 'shop.sqlite')];
  const databases = paths.map(path => {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE facts(value TEXT)');
    return db;
  });
  t.after(() => { databases.forEach(db => db.close()); rmSync(root, { recursive: true, force: true }); });
  return { databases, paths, run: work => withRollbackJournalTransaction({ db: databases[0], databases,
    closeOwnedReaders() {}, busyTimeoutMs: 0 }, work) };
}

test('two WAL stores commit on one rollback-journal transaction and restore their modes', t => {
  const f = fixture(t);
  const result = f.run(({ db, aliases }) => {
    db.prepare('INSERT INTO main.facts VALUES (?)').run('central');
    db.prepare(`INSERT INTO "${aliases.get(f.databases[1])}".facts VALUES (?)`).run('shop');
    return 'readback';
  });
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(result.value, 'readback');
  assert.equal(result.globalQuiescenceProven, false);
  assert.deepEqual(result.restoration.journalModes.map(row => row.currentMode), ['wal', 'wal']);
  assert.equal(f.databases[1].prepare('SELECT value FROM facts').get().value, 'shop');
});

test('callback failure rolls back all stores before restoring WAL', t => {
  const f = fixture(t);
  const result = f.run(({ db, aliases }) => {
    db.exec(`INSERT INTO main.facts VALUES ('one'); INSERT INTO "${aliases.get(f.databases[1])}".facts VALUES ('two')`);
    throw new Error('INJECTED');
  });
  assert.equal(result.businessOutcome, 'rolled-back');
  assert.equal(result.businessReplaySafe, true);
  f.databases.forEach(db => assert.equal(db.prepare('SELECT COUNT(*) n FROM facts').get().n, 0));
  assert.equal(result.restoration.ok, true);
});

test('an open independent reader prevents conversion without invoking business writes', t => {
  const f = fixture(t);
  const reader = new DatabaseSync(f.paths[1], { readOnly: true });
  reader.prepare('SELECT * FROM facts').all();
  let calls = 0;
  let result;
  try { result = f.run(() => { calls += 1; }); } finally { reader.close(); }
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.equal(result.businessOutcome, 'not-started');
  assert.equal(result.restoration.ok, true);
  assert.deepEqual(result.restoration.journalModes.map(row => row.currentMode), ['wal', 'wal']);
});

test('pre-existing transactions and async work are rejected before invoking work', t => {
  const f = fixture(t);
  f.databases[0].exec('BEGIN IMMEDIATE');
  const result = f.run(() => { throw new Error('MUST_NOT_RUN'); });
  assert.equal(result.code, 'RECOVERY_JOURNAL_EXISTING_TRANSACTION');
  assert.equal(result.callbackInvoked, false);
  f.databases[0].exec('ROLLBACK');
  const asyncResult = f.run(async () => undefined);
  assert.equal(asyncResult.code, 'RECOVERY_JOURNAL_ASYNC_CALLBACK_REJECTED');
});

test('in-memory coordination cannot claim cross-file crash atomicity', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const result = withRollbackJournalTransaction({ db, closeOwnedReaders() {} }, () => undefined);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RECOVERY_JOURNAL_FILE_DATABASE_REQUIRED');
});
