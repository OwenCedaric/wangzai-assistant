import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createDataAnalysisRepository } from '../db/repositories/dataAnalysisRepository.js';
import { createIntegrationProfileRepository } from '../db/repositories/integrationProfileRepository.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function seedMarketProfile(db, { profileId, shopId }) {
  db.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)')
    .run(shopId, shopId, 'active');
  createIntegrationProfileRepository(db).saveProfile({
    id: profileId,
    integrationType: 'ozon-browser-session',
    platformName: profileId,
    shopId,
    configStatus: '连接成功',
    tokenStatus: 'Cookie 已保存',
  });
}

test('Ozon browser market snapshot route persists compact confirmed data in SQLite', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    seedMarketProfile(db, { profileId: 'ozon-profile-a', shopId: 'shop-a' });
    createDataAnalysisRepository(db).upsertSnapshot({
      shopId: '',
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'ozon-profile-a',
      rowCount: 1,
      updatedAt: '2026-07-29T09:18:27.643Z',
      payload: {
        schemaVersion: 1,
        marketData: {
          profileId: 'ozon-profile-a',
          sections: { competitor: { recordCount: 1, records: [{ id: 'legacy-sku' }] } },
        },
      },
    });
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const marketData = {
      status: 'ready',
      statusLabel: '三类市场数据已接入',
      updatedAt: '2026-07-22T08:00:00.000Z',
      observerVersion: '2.4.0',
      endpointCount: 12,
      confirmedDatasetCount: 3,
      profileId: 'ozon-profile-a',
      legacyGlobalMigration: {
        sourceKey: 'ozon-profile-a',
        sourceRowCount: 1,
        sourceUpdatedAt: '2026-07-29T09:18:27.643Z',
      },
      sections: {
        competitor: { status: 'ready', recordCount: 1, records: [{ id: 'sku-1', title: '遥控汽车' }] },
      },
    };
    const write = await fetch(`${baseUrl}/api/cache/data-analysis/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopId: '',
        analysisType: 'ozon-browser-market',
        sourceType: 'ozon-browser-capture',
        sourceKey: 'ozon-profile-a',
        title: 'Ozon 浏览器市场热缓存',
        status: 'ready',
        rowCount: 1,
        payload: { schemaVersion: 1, marketData },
        sourceStatus: 'confirmed_browser_capture',
        sourceSyncedAt: marketData.updatedAt,
        lastSeenAt: marketData.updatedAt,
        updatedAt: marketData.updatedAt,
      }),
    });
    const written = await write.json();
    assert.equal(write.status, 200);
    assert.equal(written.row.sourceKey, 'ozon-profile-a');
    assert.equal(written.row.shopId, 'shop-a');
    assert.equal(written.legacyDeletedCount, 1);
    assert.equal(written.marketSyncState.status, 'success');
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM data_analysis_snapshots WHERE shop_id = '' AND source_key = 'ozon-profile-a'").get().total, 0);

    const read = await fetch(`${baseUrl}/api/cache/data-analysis?shopId=shop-a&analysisType=ozon-browser-market&sourceType=ozon-browser-capture&sourceKey=ozon-profile-a`);
    const cached = await read.json();
    assert.equal(read.status, 200);
    assert.equal(cached.rows.length, 1);
    assert.equal(cached.rows[0].payload.marketData.sections.competitor.records[0].title, '遥控汽车');
    assert.equal(cached.rows[0].sourceStatus, 'confirmed_browser_capture');
    assert.equal(cached.rows[0].shopId, 'shop-a');
    assert.equal(cached.syncState.status, 'success');

    const mixedScopeWrite = await fetch(`${baseUrl}/api/cache/data-analysis/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-a',
        analysisType: 'ozon-browser-market',
        sourceType: 'ozon-browser-capture',
        sourceKey: 'ozon-profile-a',
        payload: { marketData: { profileId: 'another-profile', sections: {} } },
      }),
    });
    assert.equal(mixedScopeWrite.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM data_analysis_snapshots WHERE shop_id = 'shop-a' AND source_key = 'ozon-profile-a'").get().total, 1);

    const failedStateResponse = await fetch(`${baseUrl}/api/cache/data-analysis/sync-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId: 'ozon-profile-a',
        sourceKey: 'ozon-profile-a',
        analysisType: 'ozon-browser-market',
        status: 'failed',
        lastAttemptAt: '2026-08-06T02:00:00.000Z',
        lastError: { code: 'ROUTE_TIMEOUT', failedRoutes: ['market-keywords'] },
      }),
    });
    const failedState = await failedStateResponse.json();
    assert.equal(failedStateResponse.status, 200);
    assert.equal(failedState.syncState.shopId, 'shop-a');
    assert.equal(failedState.syncState.status, 'failed');
    assert.equal(failedState.syncState.lastError.failedRoutes[0], 'market-keywords');
    assert.equal(failedState.syncState.lastSuccessAt, written.marketSyncState.lastSuccessAt);

    const remove = await fetch(`${baseUrl}/api/cache/data-analysis/snapshot`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-a',
        analysisType: 'ozon-browser-market',
        sourceType: 'ozon-browser-capture',
        sourceKey: 'ozon-profile-a',
      }),
    });
    const removed = await remove.json();
    assert.equal(remove.status, 200);
    assert.equal(removed.deletedCount, 1);

    const afterRemove = await fetch(`${baseUrl}/api/cache/data-analysis?shopId=shop-a&analysisType=ozon-browser-market&sourceType=ozon-browser-capture&sourceKey=ozon-profile-a`);
    const empty = await afterRemove.json();
    assert.equal(empty.rows.length, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('Ozon browser market snapshot route accepts a normalized payload larger than the old four MiB ceiling', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    seedMarketProfile(db, { profileId: 'large-ozon-profile', shopId: 'shop-large' });
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const body = {
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'large-ozon-profile',
      title: 'Ozon 浏览器市场热缓存',
      status: 'ready',
      rowCount: 10_000,
      payload: {
        schemaVersion: 1,
        marketData: {
          status: 'ready',
          profileId: 'large-ozon-profile',
          sections: { search: { status: 'ready', recordCount: 10_000 } },
          datasetViews: [{
            dataset: 'keywords',
            recordCount: 10_000,
            records: [{ id: 'keyword-1', title: '关键词', padding: 'x'.repeat(5 * 1024 * 1024) }],
          }],
        },
      },
      sourceStatus: 'confirmed_browser_capture',
      sourceSyncedAt: '2026-07-22T18:00:00.000Z',
      lastSeenAt: '2026-07-22T18:00:00.000Z',
      updatedAt: '2026-07-22T18:00:00.000Z',
    };
    const response = await fetch(`http://127.0.0.1:${port}/api/cache/data-analysis/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.row.rowCount, 10_000);
    assert.equal(payload.row.sourceKey, 'large-ozon-profile');
    assert.equal(payload.row.shopId, 'shop-large');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('first scoped migration rejects a shrunken partial snapshot and deletes global only after full merged coverage is stored', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    seedMarketProfile(db, { profileId: 'migration-profile', shopId: 'migration-shop' });
    const legacyRecords = Array.from({ length: 1_000 }, (_, index) => ({
      dataset: 'keywords',
      title: `legacy-keyword-${index}`,
      searches: index + 1,
    }));
    createDataAnalysisRepository(db).upsertSnapshot({
      shopId: '',
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'migration-profile',
      rowCount: legacyRecords.length,
      updatedAt: '2026-07-29T09:18:27.643Z',
      sourceStatus: 'confirmed_browser_capture',
      payload: {
        marketData: {
          profileId: 'migration-profile',
          sections: { search: { recordCount: legacyRecords.length, records: legacyRecords } },
          datasetViews: [{ dataset: 'keywords', recordCount: legacyRecords.length, records: legacyRecords }],
        },
      },
    });
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseBody = {
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'migration-profile',
      sourceStatus: 'confirmed_browser_capture',
      legacyProof: {
        sourceKey: 'migration-profile',
        sourceRowCount: 1_000,
        sourceUpdatedAt: '2026-07-29T09:18:27.643Z',
      },
    };
    const firstPage = legacyRecords.slice(0, 10).map((record) => ({ ...record, searches: 99_999 }));
    const shrunken = await fetch(`http://127.0.0.1:${port}/api/cache/data-analysis/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseBody,
        rowCount: 10,
        payload: {
          marketData: {
            profileId: 'migration-profile',
            legacyGlobalMigration: baseBody.legacyProof,
            captureIntegrity: { complete: true, failedRoutes: ['all-queries'] },
            sections: { search: { recordCount: 10, records: firstPage } },
            datasetViews: [{ dataset: 'keywords', recordCount: 10, records: firstPage }],
          },
        },
      }),
    });
    const shrunkenPayload = await shrunken.json();
    assert.equal(shrunken.status, 400);
    assert.match(shrunkenPayload.error.message, /LEGACY_MIGRATION_INCOMPLETE/u);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM data_analysis_snapshots WHERE shop_id = 'migration-shop' AND source_key = 'migration-profile'").get().total, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM data_analysis_snapshots WHERE shop_id = '' AND source_key = 'migration-profile'").get().total, 1);

    const mergedRecords = [...firstPage, ...legacyRecords.slice(10)];
    const complete = await fetch(`http://127.0.0.1:${port}/api/cache/data-analysis/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseBody,
        rowCount: 1_000,
        payload: {
          marketData: {
            profileId: 'migration-profile',
            legacyGlobalMigration: baseBody.legacyProof,
            captureIntegrity: { complete: true, failedRoutes: ['all-queries'] },
            sections: { search: { recordCount: 1_000, records: mergedRecords } },
            datasetViews: [{ dataset: 'keywords', recordCount: 1_000, records: mergedRecords }],
          },
        },
      }),
    });
    const completedPayload = await complete.json();
    assert.equal(complete.status, 200);
    assert.equal(completedPayload.row.shopId, 'migration-shop');
    assert.equal(completedPayload.row.rowCount, 1_000);
    assert.equal(completedPayload.legacyDeletedCount, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM data_analysis_snapshots WHERE shop_id = '' AND source_key = 'migration-profile'").get().total, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('a failed scoped market write never deletes the legacy global fallback', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    createDataAnalysisRepository(db).upsertSnapshot({
      shopId: '',
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
      sourceKey: 'missing-profile',
      payload: { marketData: { profileId: 'missing-profile', sections: {} } },
    });
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/cache/data-analysis/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        analysisType: 'ozon-browser-market',
        sourceType: 'ozon-browser-capture',
        sourceKey: 'missing-profile',
        payload: { marketData: { profileId: 'missing-profile', sections: {} } },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM data_analysis_snapshots WHERE shop_id = '' AND source_key = 'missing-profile'").get().total, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
