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

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info("${tableName}")`).all().map((row) => row.name);
}

test('clean database applies all marketing V2 repair migrations with the typed and view-state columns exactly once', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    const applied = runMigrations(db);
    assert.equal(applied.includes('052_upgrade_marketing_cache_v2'), true);
    assert.equal(applied.includes('053_upgrade_marketing_view_state_v2'), true);
    assert.equal(applied.includes('054_repair_marketing_cache_v2_backfill'), true);
    const activityColumns = tableColumns(db, 'ozon_marketing_activities');
    const productColumns = tableColumns(db, 'ozon_marketing_activity_products');
    const viewColumns = tableColumns(db, 'marketing_view_state');
    assert.equal(activityColumns.includes('date_start'), true);
    assert.equal(activityColumns.includes('date_end'), true);
    assert.equal(activityColumns.includes('source_tone'), true);
    assert.equal(productColumns.includes('ozon_sku'), true);
    for (const column of [
      'selected_source_type',
      'selected_product_ids_json',
      'activity_total',
      'joined_activity_total',
      'joined_product_total',
      'issue_product_total',
      'summary_initialized',
    ]) {
      assert.equal(viewColumns.includes(column), true, `${column} must be present`);
    }
  } finally {
    db.close();
  }
});

test('existing 052 marketing cache databases upgrade through every current migration without duplicate-column failure', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    ensureMigrationTable(db);
    const migrations = listMigrationFiles();
    migrations
      .filter((migration) => migration.version <= '052_upgrade_marketing_cache_v2')
      .forEach((migration) => executeMigration(db, migration));

    const beforeActivityColumns = tableColumns(db, 'ozon_marketing_activities');
    const beforeViewColumns = tableColumns(db, 'marketing_view_state');
    assert.equal(beforeActivityColumns.includes('source_tone'), false);
    assert.equal(beforeViewColumns.includes('activity_total'), false);

    assert.deepEqual(
      runMigrations(db),
      migrations
        .filter((migration) => migration.version > '052_upgrade_marketing_cache_v2')
        .map((migration) => migration.version),
    );
    assert.equal(tableColumns(db, 'ozon_marketing_activities').includes('source_tone'), true);
    const viewColumns = tableColumns(db, 'marketing_view_state');
    assert.equal(viewColumns.includes('activity_total'), true);
    assert.equal(viewColumns.includes('joined_activity_total'), true);
    assert.equal(viewColumns.includes('joined_product_total'), true);
    assert.equal(viewColumns.includes('issue_product_total'), true);
    assert.equal(viewColumns.includes('summary_initialized'), true);
    assert.deepEqual(runMigrations(db), []);
  } finally {
    db.close();
  }
});
