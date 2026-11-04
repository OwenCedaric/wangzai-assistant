import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createSnapshot({ selectedSourceType = 'official' } = {}) {
  return {
    activityRows: [
      {
        id: 'shared-activity',
        title: '平台活动',
        originalTitle: 'Official action',
        source: '平台活动',
        sourceTone: 'primary',
        count: 2,
        description: '平台活动说明',
        available: 4,
        hasAvailableCount: true,
        estimate: '2026-07',
        dateStart: '2026-07-01T00:00:00.000Z',
        dateEnd: '2026-07-31T23:59:59.000Z',
        isOnline: true,
        sourceType: 'official',
      },
      {
        id: 'shared-activity',
        title: '自主活动',
        originalTitle: 'Seller action',
        source: '商家自主',
        sourceTone: 'warning',
        count: 1,
        description: '商家活动说明',
        available: 3,
        hasAvailableCount: true,
        estimate: '2026-07',
        dateStart: '2026-07-02T00:00:00.000Z',
        dateEnd: '2026-07-30T23:59:59.000Z',
        isOnline: true,
        sourceType: 'sellerActions',
      },
    ],
    productPool: [
      {
        id: 'product-42',
        name: '缓存商品',
        offerId: 'offer-42',
        ozonSku: 'ozon-sku-42',
        sku: 'legacy-sku-42',
        price: '99.90',
        sourceActivityPrice: '88.80',
        activityPrice: '87.70',
        stock: 8,
        status: '已添加',
        statusTone: 'success',
        review: '正常',
        reviewTone: 'success',
      },
    ],
    marketingSummary: {
      activityTotal: 2,
      joinedActivityTotal: 2,
      joinedProductTotal: 1,
      issueProductTotal: 0,
    },
    selectedActivityId: 'shared-activity',
    selectedSourceType,
    productScope: 'all',
    selectedProductIds: ['product-42'],
    cachedAt: '2026-07-13T00:00:00.000Z',
  };
}

function createRouteServer(db, scheduler = {}) {
  return createApp({
    db,
    config: { security: {}, sync: {}, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
    ozonScheduler: scheduler,
  });
}

test('marketing legacy import maps explicit shop scope into typed V2 SQLite rows without scheduling Ozon', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, 'shop-marketing-route');
    const schedulerCalls = [];
    server = createRouteServer(db, {
      executeReadOnly(input) {
        schedulerCalls.push(input);
        return Promise.resolve({ ok: false });
      },
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const importedResponse = await fetch(`${baseUrl}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: 'shop-marketing-route', snapshot: createSnapshot() }),
    });
    const imported = await importedResponse.json();
    assert.equal(importedResponse.status, 200);
    assert.equal(imported.ok, true);
    assert.equal(imported.importedShopCount, 1);
    assert.equal(imported.activityCount, 2);
    assert.equal(imported.productCount, 1);
    assert.equal(schedulerCalls.length, 0);

    const snapshotResponse = await fetch(`${baseUrl}/api/cache/marketing?scope=snapshot&shopId=shop-marketing-route`);
    const snapshotPayload = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotPayload.found, true);
    assert.equal(snapshotPayload.snapshot.selectedActivityId, 'shared-activity');
    assert.equal(snapshotPayload.snapshot.selectedSourceType, 'official');
    assert.deepEqual(snapshotPayload.snapshot.marketingSummary, {
      activityTotal: 2,
      joinedActivityTotal: 2,
      joinedProductTotal: 1,
      issueProductTotal: 0,
    });
    assert.deepEqual(snapshotPayload.snapshot.selectedProductIds, ['product-42']);
    assert.equal(snapshotPayload.snapshot.productPool[0].ozonSku, 'ozon-sku-42');
    assert.equal(snapshotPayload.snapshot.productPool[0].sku, 'legacy-sku-42');
    const officialActivity = snapshotPayload.snapshot.activityRows.find((row) => row.sourceType === 'official');
    assert.equal(officialActivity.dateStart, '2026-07-01T00:00:00.000Z');
    assert.equal(officialActivity.dateEnd, '2026-07-31T23:59:59.000Z');
    assert.equal(officialActivity.sourceTone, 'primary');
    assert.equal(schedulerCalls.length, 0);

    const savedViewStateResponse = await fetch(`${baseUrl}/api/cache/marketing/view-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-marketing-route',
        viewState: {
          selectedActivityId: 'shared-activity',
          selectedSourceType: 'seller',
          productScope: 'available',
          selectedProductIds: [],
          marketingSummary: {
            activityTotal: 2,
            joinedActivityTotal: 2,
            joinedProductTotal: 1,
            issueProductTotal: 0,
          },
          cachedAt: '2026-07-13T00:05:00.000Z',
        },
      }),
    });
    const savedViewState = await savedViewStateResponse.json();
    assert.equal(savedViewStateResponse.status, 200);
    assert.equal(savedViewState.viewState.selectedSourceType, 'seller');
    assert.equal(savedViewState.viewState.productScope, 'available');
    assert.equal(schedulerCalls.length, 0);

    const typedActivity = db.prepare(`
      SELECT source_tone, date_start, date_end
      FROM ozon_marketing_activities
      WHERE shop_id = ? AND activity_id = ? AND source_type = ?
    `).get('shop-marketing-route', 'shared-activity', 'official');
    assert.deepEqual(Object.assign({}, typedActivity), {
      source_tone: 'primary',
      date_start: '2026-07-01T00:00:00.000Z',
      date_end: '2026-07-31T23:59:59.000Z',
    });
    assert.equal(
      db.prepare('SELECT ozon_sku FROM ozon_marketing_activity_products WHERE shop_id = ?').get('shop-marketing-route').ozon_sku,
      'ozon-sku-42',
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('marketing legacy batch import requires an explicit scope mapping and rolls every shop back on invalid input', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, 'shop-marketing-a');
    saveUnitShop(shopRepository, 'shop-marketing-b');
    server = createRouteServer(db);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const unmappedResponse = await fetch(`${baseUrl}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshots: { oldScopeA: createSnapshot() } }),
    });
    assert.equal(unmappedResponse.status, 400);
    assert.match((await unmappedResponse.json()).error.message, /SCOPE_MAPPING_REQUIRED/);

    const invalidSnapshot = createSnapshot();
    invalidSnapshot.productPool[0].apiKey = 'must-not-store';
    const failedBatchResponse = await fetch(`${baseUrl}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshots: {
          oldScopeA: createSnapshot(),
          oldScopeB: invalidSnapshot,
        },
        scopeMapping: {
          oldScopeA: 'shop-marketing-a',
          oldScopeB: 'shop-marketing-b',
        },
      }),
    });
    assert.equal(failedBatchResponse.status, 400);
    assert.match((await failedBatchResponse.json()).error.message, /MARKETING_LEGACY_UNKNOWN_FIELD/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activities WHERE shop_id IN (?, ?)').get('shop-marketing-a', 'shop-marketing-b').count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activity_products WHERE shop_id IN (?, ?)').get('shop-marketing-a', 'shop-marketing-b').count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM marketing_view_state WHERE shop_id IN (?, ?)').get('shop-marketing-a', 'shop-marketing-b').count, 0);

    const successResponse = await fetch(`${baseUrl}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshots: { oldScopeA: createSnapshot() },
        scopeMapping: { oldScopeA: 'shop-marketing-a' },
      }),
    });
    assert.equal(successResponse.status, 200);
    const duplicateResponse = await fetch(`${baseUrl}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: 'shop-marketing-a', snapshot: createSnapshot() }),
    });
    assert.equal(duplicateResponse.status, 409);
    assert.match((await duplicateResponse.json()).error.message, /MARKETING_LEGACY_CANONICAL_EXISTS/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('marketing legacy import fails closed for an unknown selected source type instead of guessing official', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, 'shop-marketing-source-type');
    server = createRouteServer(db);
    const port = await listen(server);
    const snapshot = createSnapshot({ selectedSourceType: 'unrecognized-source-type' });
    const response = await fetch(`http://127.0.0.1:${port}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: 'shop-marketing-source-type', snapshot }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /MARKETING_LEGACY_SOURCE_TYPE_INVALID/);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activities WHERE shop_id = ?')
        .get('shop-marketing-source-type').count,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activity_products WHERE shop_id = ?')
        .get('shop-marketing-source-type').count,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM marketing_view_state WHERE shop_id = ?')
        .get('shop-marketing-source-type').count,
      0,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('marketing legacy batch import rolls back every shop when a later SQLite write faults', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, 'shop-marketing-write-fault-a');
    saveUnitShop(shopRepository, 'shop-marketing-write-fault-b');
    db.exec(`
      CREATE TRIGGER force_marketing_legacy_import_write_fault
      BEFORE INSERT ON ozon_marketing_activities
      WHEN NEW.shop_id = 'shop-marketing-write-fault-b'
      BEGIN
        SELECT RAISE(ABORT, 'MARKETING_TEST_WRITE_FAULT');
      END;
    `);
    server = createRouteServer(db);
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: [
          { shopId: 'shop-marketing-write-fault-a', snapshot: createSnapshot() },
          { shopId: 'shop-marketing-write-fault-b', snapshot: createSnapshot() },
        ],
      }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'MARKETING_TEST_WRITE_FAULT');
    for (const tableName of [
      'ozon_marketing_activities',
      'ozon_marketing_activity_products',
      'marketing_view_state',
    ]) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE shop_id IN (?, ?)`)
          .get('shop-marketing-write-fault-a', 'shop-marketing-write-fault-b').count,
        0,
        `${tableName} must roll back the first shop after the second shop write fault`,
      );
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('marketing snapshot GET exposes the complete deterministic public DTO after legacy defaulting and date derivation', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, 'shop-marketing-public-dto');
    server = createRouteServer(db);
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-marketing-public-dto',
        snapshot: {
          activityRows: [{
            id: 'sparse-activity',
            sourceType: 'official',
            dateStart: '2000-01-01T00:00:00.000Z',
            dateEnd: '2001-01-01T00:00:00.000Z',
          }],
          productPool: [{ id: 'sparse-product' }],
          selectedActivityId: 'sparse-activity',
          selectedSourceType: 'official',
        },
      }),
    });
    assert.equal(response.status, 200);
    const readback = await (await fetch(
      `http://127.0.0.1:${port}/api/cache/marketing?scope=snapshot&shopId=shop-marketing-public-dto`,
    )).json();
    assert.equal(readback.found, true);
    assert.deepEqual(
      readback.snapshot.activityRows.map((row) => ({
        id: row.id,
        title: row.title,
        originalTitle: row.originalTitle,
        source: row.source,
        sourceTone: row.sourceTone,
        count: row.count,
        description: row.description,
        available: row.available,
        hasAvailableCount: row.hasAvailableCount,
        estimate: row.estimate,
        dateStart: row.dateStart,
        dateEnd: row.dateEnd,
        isOnline: row.isOnline,
        sourceType: row.sourceType,
      })),
      [{
        id: 'sparse-activity',
        title: '活动 sparse-activity',
        originalTitle: '活动 sparse-activity',
        source: '平台活动',
        sourceTone: '',
        count: 0,
        description: '',
        available: 0,
        hasAvailableCount: false,
        estimate: '',
        dateStart: '2000-01-01T00:00:00.000Z',
        dateEnd: '2001-01-01T00:00:00.000Z',
        isOnline: false,
        sourceType: 'official',
      }],
    );
    assert.deepEqual(
      readback.snapshot.productPool.map((row) => ({
        id: row.id,
        name: row.name,
        offerId: row.offerId,
        ozonSku: row.ozonSku,
        sku: row.sku,
        price: row.price,
        sourceActivityPrice: row.sourceActivityPrice,
        activityPrice: row.activityPrice,
        stock: row.stock,
        status: row.status,
        statusTone: row.statusTone,
        review: row.review,
        reviewTone: row.reviewTone,
      })),
      [{
        id: 'sparse-product',
        name: 'sparse-product',
        offerId: '',
        ozonSku: '',
        sku: '',
        price: '',
        sourceActivityPrice: '',
        activityPrice: '',
        stock: '',
        status: '已添加',
        statusTone: 'success',
        review: '已确认',
        reviewTone: 'success',
      }],
    );
    assert.deepEqual(readback.snapshot.marketingSummary, {
      activityTotal: 1,
      joinedActivityTotal: 0,
      joinedProductTotal: 1,
      issueProductTotal: 1,
    });
    assert.deepEqual({
      selectedActivityId: readback.snapshot.selectedActivityId,
      selectedSourceType: readback.snapshot.selectedSourceType,
      productScope: readback.snapshot.productScope,
      selectedProductIds: readback.snapshot.selectedProductIds,
      cachedAt: readback.snapshot.cachedAt,
    }, {
      selectedActivityId: 'sparse-activity',
      selectedSourceType: 'official',
      productScope: 'joined',
      selectedProductIds: [],
      cachedAt: '',
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('marketing snapshot GET keeps identifier-equal suppression and sku fallback as public DTO semantics', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopRepository = createShopRepository(db);
    saveUnitShop(shopRepository, 'shop-marketing-identifier-contract');
    server = createRouteServer(db);
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: 'shop-marketing-identifier-contract',
        snapshot: {
          activityRows: [{ id: 'identifier-activity', title: '标识活动', sourceType: 'official' }],
          productPool: [
            {
              id: 'same-identifier',
              offerId: 'same-identifier',
              ozonSku: 'same-identifier',
              sku: 'same-identifier',
              status: '已添加',
            },
            {
              id: 'fallback-identifier',
              offerId: 'offer-fallback',
              ozonSku: 'ozon-fallback',
              status: '已添加',
            },
          ],
          selectedActivityId: 'identifier-activity',
          selectedSourceType: 'official',
        },
      }),
    });
    assert.equal(response.status, 200);
    const readback = await (await fetch(
      `http://127.0.0.1:${port}/api/cache/marketing?scope=snapshot&shopId=shop-marketing-identifier-contract`,
    )).json();
    const productsById = Object.fromEntries(readback.snapshot.productPool.map((row) => [row.id, row]));
    assert.deepEqual(
      {
        offerId: productsById['same-identifier'].offerId,
        ozonSku: productsById['same-identifier'].ozonSku,
        sku: productsById['same-identifier'].sku,
      },
      { offerId: '', ozonSku: '', sku: '' },
    );
    assert.deepEqual(
      {
        offerId: productsById['fallback-identifier'].offerId,
        ozonSku: productsById['fallback-identifier'].ozonSku,
        sku: productsById['fallback-identifier'].sku,
      },
      { offerId: 'offer-fallback', ozonSku: 'ozon-fallback', sku: 'offer-fallback' },
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('marketing legacy import atomically carries an 8-shop / 5,245-row maximum fixture without crossing shop state', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopRepository = createShopRepository(db);
    const shopIds = Array.from({ length: 8 }, (_, index) => `shop-marketing-max-${index + 1}`);
    shopIds.forEach((shopId) => saveUnitShop(shopRepository, shopId));
    const schedulerCalls = [];
    server = createRouteServer(db, {
      executeReadOnly(input) {
        schedulerCalls.push(input);
        return Promise.resolve({ ok: false });
      },
    });
    const port = await listen(server);
    // Row scale is deliberately independent from the 8 MiB one-time HTTP
    // transport cap; that cap is not a SQLite or recovery storage quota.
    const entries = shopIds.map((shopId, shopIndex) => {
      // 8 activities + 5,237 products = the R8 maximum 5,245 typed rows.
      const productCount = shopIndex === shopIds.length - 1 ? 652 : 655;
      const activityId = `max-activity-${shopIndex + 1}`;
      return {
        legacyScope: `legacy-max-${shopIndex + 1}`,
        shopId,
        snapshot: {
          activityRows: [{
            id: activityId,
            title: `最大量活动 ${shopIndex + 1}`,
            source: '平台活动',
            sourceType: 'official',
            count: productCount,
          }],
          productPool: Array.from({ length: productCount }, (_, productIndex) => ({
            id: `max-product-${shopIndex + 1}-${productIndex + 1}`,
            name: `最大量商品 ${shopIndex + 1}-${productIndex + 1}`,
            ozonSku: `ozon-sku-${shopIndex + 1}-${productIndex + 1}`,
            status: '已添加',
          })),
          selectedActivityId: activityId,
          selectedSourceType: 'official',
          productScope: 'joined',
          selectedProductIds: [`max-product-${shopIndex + 1}-1`],
          cachedAt: '2026-07-13T00:00:00.000Z',
        },
      };
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${baseUrl}/api/cache/marketing/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.importedShopCount, 8);
    assert.equal(payload.activityCount, 8);
    assert.equal(payload.productCount, 5_237);
    assert.equal(payload.activityCount + payload.productCount, 5_245);
    assert.equal(schedulerCalls.length, 0);

    const firstSnapshot = await (await fetch(
      `${baseUrl}/api/cache/marketing?scope=snapshot&shopId=${shopIds[0]}`,
    )).json();
    const lastSnapshot = await (await fetch(
      `${baseUrl}/api/cache/marketing?scope=snapshot&shopId=${shopIds.at(-1)}`,
    )).json();
    assert.equal(firstSnapshot.snapshot.activityRows.length, 1);
    assert.equal(firstSnapshot.snapshot.productPool.length, 655);
    assert.equal(firstSnapshot.snapshot.activityRows[0].id, 'max-activity-1');
    assert.equal(lastSnapshot.snapshot.productPool.length, 652);
    assert.equal(lastSnapshot.snapshot.activityRows[0].id, 'max-activity-8');
    assert.equal(firstSnapshot.snapshot.productPool.some((row) => row.id.startsWith('max-product-8-')), false);
    assert.equal(lastSnapshot.snapshot.productPool.some((row) => row.id.startsWith('max-product-1-')), false);
    assert.equal(schedulerCalls.length, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
