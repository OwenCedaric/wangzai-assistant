import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDataAnalysisRepository } from '../src/db/repositories/dataAnalysisRepository.js';
import { createDataAnalysisService } from '../src/domain/dataAnalysis/dataAnalysisService.js';

function createTestDatabase() {
  const db = new DatabaseSync(':memory:');
  const migration = readFileSync(new URL('../src/db/migrations/032_create_data_analysis_cache_tables.sql', import.meta.url), 'utf8');
  db.exec(migration);
  return db;
}

test('dataAnalysisRepository upserts and reads compact analysis snapshots', () => {
  const db = createTestDatabase();
  try {
    const repository = createDataAnalysisRepository(db);
    const first = repository.upsertSnapshot({
      shopId: 'ozon-1',
      analysisType: 'blue-ocean-keyword',
      sourceType: 'alphashop',
      sourceKey: 'phone-case',
      title: '手机壳蓝海词',
      rowCount: 3,
      summary: { conclusion: '有机会，但需要复核竞争度' },
      metrics: { avgPrice: 12.3 },
      payload: { sampleRows: [{ keyword: 'phone case', score: 88 }] },
      sourceStatus: 'synced',
      sourceSyncedAt: '2026-07-09T00:00:00.000Z',
    });

    assert.equal(first.shopId, 'ozon-1');
    assert.equal(first.analysisType, 'blue-ocean-keyword');
    assert.equal(first.rowCount, 3);
    assert.equal(first.summary.conclusion, '有机会，但需要复核竞争度');

    const list = repository.listSnapshots({ shopId: 'ozon-1' });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].title, '手机壳蓝海词');

    repository.upsertSnapshot({
      shopId: 'ozon-1',
      analysisType: 'blue-ocean-keyword',
      sourceType: 'alphashop',
      sourceKey: 'phone-case',
      title: '手机壳蓝海词更新',
      rowCount: 5,
      summary: { conclusion: '更新后机会变弱' },
    });
    const updated = repository.listSnapshots({ shopId: 'ozon-1' });
    assert.equal(updated.total, 1);
    assert.equal(updated.rows[0].title, '手机壳蓝海词更新');
    assert.equal(updated.rows[0].rowCount, 5);
  } finally {
    db.close();
  }
});

test('dataAnalysisService reads cache and rebuilds real local analysis snapshots', () => {
  const db = createTestDatabase();
  try {
    const service = createDataAnalysisService({ db });
    service.saveSnapshot({
      shopId: 'ozon-1',
      analysisType: 'ranking',
      sourceType: 'local-test',
      sourceKey: 'top-100',
      title: '榜单测试缓存',
      rowCount: 100,
    });

    const cache = service.readCache({ shopId: 'ozon-1' });
    assert.equal(cache.ok, true);
    assert.equal(cache.domain, 'data-analysis');
    assert.equal(cache.cache.enabled, true);
    assert.equal(cache.total, 1);
    assert.equal(cache.rows[0].title, '榜单测试缓存');

    const sync = service.startSync({ shopId: 'ozon-1', analysisType: 'all' });
    assert.equal(sync.ok, true);
    assert.equal(sync.accepted, true);
    assert.equal(sync.completed, true);
    assert.equal(sync.mode, 'local-analysis-rebuild');
    assert.equal(sync.snapshotCount, 16);
    assert.equal(sync.aggregateSnapshotCount, 8);
    assert.equal(sync.syncState.status, 'success');

    const rebuilt = service.readCache({ shopId: 'ozon-1' });
    assert.equal(rebuilt.dashboard.dataPolicy.fakeDataAllowed, false);
    assert.equal(rebuilt.dashboard.modules.find((item) => item.id === 'traffic').status, 'not_synced');
    assert.equal(rebuilt.total, 8);
  } finally {
    db.close();
  }
});

test('data analysis market sync diagnostics preserve the last success and delete only legacy global rows', () => {
  const db = createTestDatabase();
  try {
    const repository = createDataAnalysisRepository(db);
    repository.upsertSnapshot({
      shopId: '',
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'profile-a',
    });
    repository.upsertSnapshot({
      shopId: 'shop-a',
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'profile-a',
    });
    const removed = repository.deleteLegacyGlobalSnapshot({
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'profile-a',
    });
    assert.equal(removed.deletedCount, 1);
    assert.equal(repository.listSnapshots({
      shopId: 'shop-a',
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'profile-a',
    }).total, 1);

    repository.recordSyncState({
      shopId: 'shop-a',
      analysisType: 'ozon-browser-market',
      status: 'success',
      lastSuccessAt: '2026-08-06T01:00:00.000Z',
      lastAttemptAt: '2026-08-06T01:00:00.000Z',
      lastError: null,
    });
    const failed = repository.recordSyncState({
      shopId: 'shop-a',
      analysisType: 'ozon-browser-market',
      status: 'failed',
      lastAttemptAt: '2026-08-06T02:00:00.000Z',
      lastError: { code: 'ROUTE_TIMEOUT', failedRoutes: ['market-keywords'] },
    });
    assert.equal(failed.lastSuccessAt, '2026-08-06T01:00:00.000Z');
    assert.equal(failed.lastAttemptAt, '2026-08-06T02:00:00.000Z');
    assert.deepEqual(failed.lastError.failedRoutes, ['market-keywords']);

    repository.recordSyncState({
      shopId: 'shop-a',
      analysisType: 'ozon-browser-market',
      status: 'syncing',
      lastAttemptAt: '2026-08-06T03:00:00.000Z',
      lastError: null,
    });
    const ignoredOlderFinal = repository.recordSyncState({
      shopId: 'shop-a',
      analysisType: 'ozon-browser-market',
      status: 'cancelled',
      lastAttemptAt: '2026-08-06T02:30:00.000Z',
      lastError: { code: 'OZON_MARKET_REFRESH_SUPERSEDED', failedRoutes: [] },
    });
    assert.equal(ignoredOlderFinal.status, 'syncing');
    assert.equal(ignoredOlderFinal.lastAttemptAt, '2026-08-06T03:00:00.000Z');
    assert.equal(ignoredOlderFinal.lastError, null);
  } finally {
    db.close();
  }
});

test('market cache read recovers a stale syncing state left by an interrupted renderer', () => {
  const db = createTestDatabase();
  try {
    const repository = createDataAnalysisRepository(db);
    const service = createDataAnalysisService({ db });
    repository.recordSyncState({
      shopId: 'shop-stale',
      analysisType: 'ozon-browser-market',
      status: 'success',
      lastSuccessAt: '2019-12-31T23:00:00.000Z',
      lastAttemptAt: '2019-12-31T23:00:00.000Z',
      lastError: null,
    });
    repository.recordSyncState({
      shopId: 'shop-stale',
      analysisType: 'ozon-browser-market',
      status: 'syncing',
      lastAttemptAt: '2020-01-01T00:00:00.000Z',
      lastError: null,
    });

    const cache = service.readCache({
      shopId: 'shop-stale',
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'profile-stale',
    });

    assert.equal(cache.syncState.status, 'failed');
    assert.equal(cache.syncState.lastSuccessAt, '2019-12-31T23:00:00.000Z');
    assert.equal(cache.syncState.lastAttemptAt, '2020-01-01T00:00:00.000Z');
    assert.equal(cache.syncState.lastError.code, 'OZON_MARKET_REFRESH_INTERRUPTED');
    assert.deepEqual(cache.syncState.lastError.failedRoutes, []);
  } finally {
    db.close();
  }
});
