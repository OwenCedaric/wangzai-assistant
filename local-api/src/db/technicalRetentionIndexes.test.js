import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { listMigrationFiles } from './database.js';

const RETENTION_INDEXES = [
  ['product_sync_runs', 'idx_product_sync_runs_retention'],
  ['ozon_scheduler_trace_events', 'idx_ozon_scheduler_trace_events_created_at'],
  ['ozon_request_jobs', 'idx_ozon_request_jobs_created_at'],
  ['ozon_request_attempts', 'idx_ozon_request_attempts_created_at'],
  ['ozon_cache_merge_log', 'idx_ozon_cache_merge_log_created_at'],
  ['ozon_sync_locks', 'idx_ozon_sync_locks_released_at'],
  ['ozon_sync_snapshots', 'idx_ozon_sync_snapshots_finished_at'],
];

test('technical retention indexes remain present after every current migration', () => {
  const db = createMigratedTestDb();
  try {
    for (const [table, index] of RETENTION_INDEXES) {
      const indexes = db.prepare(`PRAGMA index_list("${table}")`).all();
      assert.ok(indexes.some((entry) => entry.name === index), `${table} requires ${index}`);
    }
    const latestMigrationNumber = Math.max(
      ...listMigrationFiles().map(({ version }) => Number(version.slice(0, 3))),
    );
    assert.equal(
      db.prepare('PRAGMA user_version').get().user_version,
      latestMigrationNumber,
    );
  } finally {
    db.close();
  }
});
