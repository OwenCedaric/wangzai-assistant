import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(
  resolve('src/db/migrations/077_normalize_data_backup_import_shop_scope.sql'),
  'utf8',
).replace(/^\uFEFF/u, '');

function createDatabase(ownerColumn) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE shops (
      profile_id TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (profile_id, id)
    );
    INSERT INTO shops (profile_id, id) VALUES ('profile-a', 'shop-a');
    CREATE TABLE data_backup_imports (
      import_id TEXT PRIMARY KEY,
      source_backup_id TEXT NOT NULL,
      package_sha256 TEXT NOT NULL,
      source_data_fingerprint TEXT NOT NULL,
      target_profile_id TEXT NOT NULL,
      ${ownerColumn} TEXT NOT NULL,
      target_shop_incarnation TEXT NOT NULL,
      strategy TEXT NOT NULL,
      preflight_fingerprint TEXT NOT NULL,
      result_data_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      domain_summary_json TEXT NOT NULL DEFAULT '[]',
      skipped_summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO data_backup_imports VALUES (
      'import-a', 'backup-a', ?, ?, 'profile-a', 'shop-a', 'inc-a',
      'preserve', ?, ?, 'completed', '[]', '{}', ?, ?
    )
  `).run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64),
    '2026-07-28T00:00:00.000Z', '2026-07-28T00:01:00.000Z');
  return db;
}

for (const ownerColumn of ['target_shop_id', 'shop_id']) {
  test(`migration 077 normalizes ${ownerColumn} without losing import history`, () => {
    const db = createDatabase(ownerColumn);
    db.exec(migration);
    const columns = db.prepare('PRAGMA table_info(data_backup_imports)').all()
      .map((column) => column.name);
    assert.ok(columns.includes('shop_id'));
    assert.ok(!columns.includes('target_shop_id'));
    assert.equal(
      db.prepare('SELECT shop_id FROM data_backup_imports WHERE import_id = ?').get('import-a').shop_id,
      'shop-a',
    );
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 77);
    db.close();
  });
}
