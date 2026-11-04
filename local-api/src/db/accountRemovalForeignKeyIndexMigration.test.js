import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './database.js';

const REQUIRED_INDEXES = Object.freeze([
  ['ozon_error_events', 'idx_ozon_error_events_job_id', 'job_id'],
  ['ozon_sync_snapshots', 'idx_ozon_sync_snapshots_source_job_id', 'source_job_id'],
  ['ozon_notification_events', 'idx_ozon_notification_events_snapshot_id', 'snapshot_id'],
  ['ozon_notification_events', 'idx_ozon_notification_events_source_attempt_id', 'source_attempt_id'],
  ['ozon_notification_events', 'idx_ozon_notification_events_source_job_id', 'source_job_id'],
  ['shop_domain_sync_state', 'idx_shop_domain_sync_state_bootstrap_run_id', 'bootstrap_run_id'],
  ['product_sync_outbox', 'idx_product_sync_outbox_run_id', 'run_id'],
  ['product_sync_quarantine', 'idx_product_sync_quarantine_run_id', 'run_id'],
  ['product_image_usage_events', 'idx_product_image_usage_events_asset_id', 'asset_id'],
  ['follow_seller_cases', 'idx_follow_seller_cases_product_identity_id', 'product_identity_id'],
]);

test('account-removal foreign-key checks have leading indexes and migration is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    const applied = runMigrations(db);
    assert.equal(applied.includes('093_add_account_removal_foreign_key_indexes'), true);
    for (const [table, indexName, expectedColumn] of REQUIRED_INDEXES) {
      const index = db.prepare(`PRAGMA index_list("${table}")`).all()
        .find((entry) => entry.name === indexName);
      assert.ok(index, `${indexName} must exist`);
      const columns = db.prepare(`PRAGMA index_info("${indexName}")`).all();
      assert.equal(columns[0]?.name, expectedColumn, `${indexName} must lead with ${expectedColumn}`);
    }
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 112);
    assert.deepEqual(runMigrations(db), []);
  } finally {
    db.close();
  }
});
