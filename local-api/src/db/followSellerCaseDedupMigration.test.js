import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ensureMigrationTable, listMigrationFiles, runMigrations } from './database.js';

function executeMigration(db, migration) {
  db.exec(readFileSync(migration.path, 'utf8').replace(/^\uFEFF/u, ''));
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
    .run(migration.version, migration.fileName);
}

test('migration 090 keeps patrol history but marks only the newest shop and SKU row as current', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    ensureMigrationTable(db);
    const migrations = listMigrationFiles();
    migrations
      .filter((migration) => migration.version < '090_deduplicate_follow_seller_cases')
      .forEach((migration) => executeMigration(db, migration));

    db.prepare(`
      INSERT INTO shops (id, name, status)
      VALUES ('shop-dedup', '去重迁移测试店铺', 'active')
    `).run();
    const insert = db.prepare(`
      INSERT INTO follow_seller_cases (
        id, shop_id, offer_id, sku, status, stage, created_at, updated_at
      ) VALUES (?, 'shop-dedup', ?, ?, ?, 'completed', ?, ?)
    `);
    insert.run('case-old', 'OFFER-OLD', 'SKU-SAME', 'detected', '2026-08-15T01:00:00.000Z', '2026-08-15T01:00:00.000Z');
    insert.run('case-new', 'OFFER-NEW', 'SKU-SAME', 'clear', '2026-08-15T02:00:00.000Z', '2026-08-15T02:00:00.000Z');
    insert.run('case-other', 'OFFER-OTHER', 'SKU-OTHER', 'detected', '2026-08-15T03:00:00.000Z', '2026-08-15T03:00:00.000Z');

    const migration090 = listMigrationFiles()
      .find((migration) => migration.version === '090_deduplicate_follow_seller_cases');
    assert.ok(migration090, 'migration 090 must exist');
    executeMigration(db, migration090);
    const rows = db.prepare(`
      SELECT id, sku, status, is_latest
        FROM follow_seller_cases
       ORDER BY id
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { id: 'case-new', sku: 'SKU-SAME', status: 'clear', is_latest: 1 },
      { id: 'case-old', sku: 'SKU-SAME', status: 'detected', is_latest: 0 },
      { id: 'case-other', sku: 'SKU-OTHER', status: 'detected', is_latest: 1 },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM follow_seller_cases').get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM follow_seller_cases WHERE is_latest = 1').get().count, 2);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 90);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?')
        .get('090_deduplicate_follow_seller_cases').count,
      1,
    );
  } finally {
    db.close();
  }
});
