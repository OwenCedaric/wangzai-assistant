import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDataAnalysisService } from './dataAnalysisService.js';
import { createDataAnalysisRepository } from '../../db/repositories/dataAnalysisRepository.js';

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  const migration = new URL('../../db/migrations/032_create_data_analysis_cache_tables.sql', import.meta.url);
  db.exec(readFileSync(migration, 'utf8'));
  return db;
}

test('data analysis reads the durable dashboard snapshot and then L1 instead of rebuilding per page open', () => {
  const db = createDatabase();
  const service = createDataAnalysisService({ db });
  const query = {
    shopId: 'shop-a',
    analysisType: 'all',
    sourceType: 'all',
    startDate: '2026-07-03',
    endDate: '2026-08-01',
  };

  const rebuilt = service.startSync(query);
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.snapshotCount, 16);
  assert.equal(rebuilt.aggregateSnapshotCount, 8);

  const first = service.readCache(query);
  assert.equal(first.cache.readTier, 'sqlite-snapshot-l2');
  assert.equal(first.cache.hot, false);
  assert.equal(first.dashboard.shopId, 'shop-a');

  const second = service.readCache(query);
  assert.equal(second.cache.readTier, 'memory-l1');
  assert.equal(second.cache.hot, true);
  db.close();
});

test('data analysis rebuilds an older dashboard snapshot that still contains store-level traffic points', () => {
  const db = createDatabase();
  const repository = createDataAnalysisRepository(db);
  repository.upsertSnapshot({
    shopId: 'shop-a',
    analysisType: 'dashboard',
    sourceType: 'derived-sqlite',
    sourceKey: 'business-dashboard-v2:2026-07-28:2026-08-25',
    timeRangeStart: '2026-07-28',
    timeRangeEnd: '2026-08-25',
    payload: {
      dashboard: {
        shopId: 'shop-a',
        traffic: {
          dailyTrend: [
            { date: '2026-08-03', visitorSessions: 19 },
            { date: '2026-08-03', visitorSessions: 3569 },
            { date: '2026-08-03', visitorSessions: 6414 },
          ],
        },
      },
    },
  });
  const service = createDataAnalysisService({ db });

  const result = service.readCache({
    shopId: 'shop-a',
    startDate: '2026-07-28',
    endDate: '2026-08-25',
  });

  assert.equal(result.cache.readTier, 'sqlite-live-fallback');
  assert.deepEqual(result.dashboard.traffic.dailyTrend, []);
  assert.equal(
    repository.getDashboardSnapshot({
      shopId: 'shop-a',
      startDate: '2026-07-28',
      endDate: '2026-08-25',
    }).sourceKey,
    'business-dashboard-v3-traffic-date-grain:2026-07-28:2026-08-25',
  );
  db.close();
});

test('ordinary all-shop dashboard reads exclude the large opt-in market capture', () => {
  const db = createDatabase();
  const service = createDataAnalysisService({ db });
  createDataAnalysisRepository(db).upsertSnapshot({
    analysisType: 'ozon-browser-market',
    sourceType: 'ozon-browser-capture',
    sourceKey: 'legacy-global-market',
    payload: { rows: ['x'.repeat(512 * 1024)] },
  });

  const business = service.readCache({ analysisType: 'all', sourceType: 'all' });
  assert.equal(business.rows.some((row) => row.analysisType === 'ozon-browser-market'), false);

  const market = service.readCache({
    analysisType: 'ozon-browser-market',
    sourceType: 'ozon-browser-capture',
    sourceKey: 'legacy-global-market',
    legacyGlobalOnly: true,
  });
  assert.equal(market.rows.length, 1);
  assert.equal(market.rows[0].sourceKey, 'legacy-global-market');
  db.close();
});

test('all-shop data-analysis reads persist L2 and reuse a dedicated L1 entry while exact shops stay isolated', () => {
  const db = createDatabase();
  const memory = new Map();
  const cacheCalls = { build: [], get: [], set: [] };
  const hotCache = {
    buildKey(input) {
      cacheCalls.build.push(input);
      return JSON.stringify(input);
    },
    get(key) {
      cacheCalls.get.push(key);
      return memory.get(key) || null;
    },
    set(key, payload, options) {
      cacheCalls.set.push({ key, options });
      memory.set(key, payload);
      return { ok: true };
    },
    invalidate() {
      memory.clear();
      return { ok: true, removed: 0 };
    },
    count() {
      return memory.size;
    },
    getStatus() {
      return { entries: memory.size };
    },
  };
  const service = createDataAnalysisService({ db, hotCache });

  const allFirst = service.readCache({ analysisType: 'all', sourceType: 'all' });
  const allSecond = service.readCache({ analysisType: 'all', sourceType: 'all' });
  assert.equal(allFirst.cache.aggregateMode, 'sqlite-active-shop-rows');
  assert.equal(allFirst.cache.hot, false);
  assert.equal(allSecond.cache.hot, true);
  assert.equal(cacheCalls.build.length, 2);
  assert.equal(cacheCalls.set.length, 1);

  assert.equal(service.readCache({ shopId: 'shop-a' }).cache.hot, false);
  assert.equal(service.readCache({ shopId: 'shop-a' }).cache.hot, true);
  assert.equal(service.readCache({ shopId: 'shop-b' }).cache.hot, false);
  assert.equal(service.readCache({ shopId: 'shop-b' }).cache.hot, true);
  assert.equal(cacheCalls.set.length, 3);
  assert.notEqual(cacheCalls.set[1].key, cacheCalls.set[2].key);
  db.close();
});
