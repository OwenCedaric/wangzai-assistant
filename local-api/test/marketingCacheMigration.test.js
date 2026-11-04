import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMarketingRepository } from '../src/db/repositories/marketingRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function runMigrationsBeforeMarketingV2(db) {
  const migrationsDir = resolve('src/db/migrations');
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/u.test(name) && name < '052_upgrade_marketing_cache_v2.sql')
    .sort();
  files.forEach((name) => db.exec(readFileSync(resolve(migrationsDir, name), 'utf8').replace(/^\uFEFF/u, '')));
}

function marketingSnapshot({ selectedSourceType = 'seller', activityId = 'same-action' } = {}) {
  return {
    activityRows: [
      {
        id: activityId,
        title: '平台活动',
        originalTitle: 'Official action',
        source: '平台活动',
        sourceType: 'actions',
        count: 2,
        available: 5,
        hasAvailableCount: true,
        description: '官方活动',
        estimate: '2026 summer',
        dateStart: '2026-07-10T00:00:00.000Z',
        dateEnd: '2026-08-10T00:00:00.000Z',
        isOnline: true,
      },
      {
        id: activityId,
        title: '商家活动',
        originalTitle: 'Seller action',
        source: '商家自主',
        sourceType: 'sellerActions',
        count: 1,
        available: 3,
        hasAvailableCount: true,
        description: '商家活动',
        estimate: '2026 seller',
        dateStart: '2026-07-11T00:00:00.000Z',
        dateEnd: '2026-08-11T00:00:00.000Z',
        isOnline: true,
      },
    ],
    productPool: [
      {
        id: 'product-1',
        name: '营销商品',
        offerId: 'offer-1',
        ozonSku: 'ozon-sku-1',
        sku: 'sku-1',
        price: '100',
        sourceActivityPrice: '85',
        activityPrice: '85',
        stock: '7',
        // Browser validation accepts the historic English spelling in any
        // case; the importer must canonicalize it to the typed UI label.
        status: 'JOINED',
        statusTone: 'success',
        review: '已确认',
        reviewTone: 'success',
      },
    ],
    marketingSummary: {
      activityTotal: 2,
      joinedActivityTotal: 2,
      joinedProductTotal: 1,
      issueProductTotal: 0,
    },
    selectedActivityId: activityId,
    selectedSourceType,
    productScope: 'joined',
    selectedProductIds: ['product-1'],
    cachedAt: '2026-07-13T00:00:00.000Z',
  };
}

test('marketing V2/V3 migrations backfill typed fields and derive historical view summaries from facts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    runMigrationsBeforeMarketingV2(db);
    db.prepare(`
      INSERT INTO ozon_marketing_activities (shop_id, activity_id, source_type, raw_json)
      VALUES (?, ?, ?, ?)
    `).run('shop-v2', 'valid-date', 'official', JSON.stringify({
      dateStart: '2026-07-01T00:00:00.000Z',
      end_at: '2026-07-31T00:00:00.000Z',
      sourceTone: 'warning',
    }));
    db.prepare(`
      INSERT INTO ozon_marketing_activities (shop_id, activity_id, source_type, raw_json)
      VALUES (?, ?, ?, ?)
    `).run('shop-v2', 'invalid-date', 'official', '{not-valid-json');
    db.prepare(`
      INSERT INTO ozon_marketing_activity_products (shop_id, activity_id, source_type, product_id, sku, raw_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('shop-v2', 'valid-date', 'official', 'product-valid', 'fallback-sku', JSON.stringify({ ozonSku: 'typed-ozon-sku' }));
    db.prepare(`
      INSERT INTO ozon_marketing_activity_products (shop_id, activity_id, source_type, product_id, sku, raw_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('shop-v2', 'invalid-date', 'official', 'product-invalid', 'fallback-only-sku', '{bad-json');

    db.exec(readFileSync(resolve('src/db/migrations/052_upgrade_marketing_cache_v2.sql'), 'utf8').replace(/^\uFEFF/u, ''));

    assert.deepEqual(
      { ...db.prepare(`SELECT date_start, date_end FROM ozon_marketing_activities WHERE activity_id = ?`).get('valid-date') },
      {
        date_start: '2026-07-01T00:00:00.000Z',
        date_end: '2026-07-31T00:00:00.000Z',
      },
    );
    assert.deepEqual(
      { ...db.prepare(`SELECT date_start, date_end FROM ozon_marketing_activities WHERE activity_id = ?`).get('invalid-date') },
      { date_start: '', date_end: '' },
    );
    assert.equal(db.prepare(`SELECT ozon_sku FROM ozon_marketing_activity_products WHERE product_id = ?`).get('product-valid').ozon_sku, 'typed-ozon-sku');
    assert.equal(db.prepare(`SELECT ozon_sku FROM ozon_marketing_activity_products WHERE product_id = ?`).get('product-invalid').ozon_sku, 'fallback-only-sku');
    assert.equal(Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'marketing_view_state'`).get()), true);

    db.exec(readFileSync(resolve('src/db/migrations/053_upgrade_marketing_view_state_v2.sql'), 'utf8').replace(/^\uFEFF/u, ''));
    assert.equal(db.prepare(`SELECT source_tone FROM ozon_marketing_activities WHERE activity_id = ?`).get('valid-date').source_tone, '');

    // This is an already-upgraded 053 database: the compact counters exist but
    // still contain SQLite's historical defaults instead of business facts.
    db.prepare(`UPDATE ozon_marketing_activities SET joined_count = ? WHERE activity_id = ?`).run(1, 'valid-date');
    db.prepare(`UPDATE ozon_marketing_activity_products SET row_status = ?, price = ?, stock = ?, review = ?, status_tone = ?, review_tone = ? WHERE product_id = ?`)
      .run('已添加', '99', '5', '正常', 'success', 'success', 'product-valid');
    db.prepare(`UPDATE ozon_marketing_activity_products SET row_status = ?, price = ?, stock = ?, review = ?, status_tone = ?, review_tone = ? WHERE product_id = ?`)
      .run('可添加', '', '0', '库存不足', 'warning', 'error', 'product-invalid');
    db.prepare(`
      INSERT INTO marketing_view_state (
        shop_id, selected_activity_id, selected_source_type, product_scope,
        selected_product_ids_json, cached_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'shop-v2',
      'valid-date',
      'official',
      'all',
      '[]',
      '2026-07-13T00:00:00.000Z',
      '2026-07-13T00:00:00.000Z',
      '2026-07-13T00:00:00.000Z',
    );

    db.exec(readFileSync(resolve('src/db/migrations/054_repair_marketing_cache_v2_backfill.sql'), 'utf8').replace(/^\uFEFF/u, ''));
    assert.deepEqual(
      { ...db.prepare(`SELECT source_tone FROM ozon_marketing_activities WHERE activity_id = ?`).get('valid-date') },
      { source_tone: 'warning' },
    );
    assert.equal(
      db.prepare(`SELECT summary_initialized FROM marketing_view_state WHERE shop_id = ?`).get('shop-v2').summary_initialized,
      0,
    );
    assert.deepEqual(
      createMarketingRepository(db).readSnapshot({ shopId: 'shop-v2' }).snapshot.marketingSummary,
      {
        activityTotal: 2,
        joinedActivityTotal: 1,
        joinedProductTotal: 1,
        issueProductTotal: 1,
      },
    );
  } finally {
    db.close();
  }
});

test('legacy marketing snapshot import writes source-aware facts and a verified SQLite view state', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-marketing-legacy');
    const repository = createMarketingRepository(db);
    const result = repository.importLegacySnapshots({
      entries: [{ legacyScope: 'old-client-id', shopId, snapshot: marketingSnapshot() }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.readbackVerified, true);
    assert.equal(result.activityCount, 2);
    assert.equal(result.productCount, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_marketing_activities WHERE shop_id = ?`).get(shopId).count, 2);
    assert.deepEqual(
      db.prepare(`
        SELECT source_type, date_start, date_end, source_tone
        FROM ozon_marketing_activities
        WHERE shop_id = ? AND activity_id = ?
        ORDER BY source_type
      `).all(shopId, 'same-action').map((row) => ({ ...row })),
      [
        {
          source_type: 'official',
          date_start: '2026-07-10T00:00:00.000Z',
          date_end: '2026-08-10T00:00:00.000Z',
          source_tone: '',
        },
        {
          source_type: 'seller',
          date_start: '2026-07-11T00:00:00.000Z',
          date_end: '2026-08-11T00:00:00.000Z',
          source_tone: '',
        },
      ],
    );
    assert.deepEqual(
      { ...db.prepare(`SELECT source_type, ozon_sku FROM ozon_marketing_activity_products WHERE shop_id = ?`).get(shopId) },
      { source_type: 'seller', ozon_sku: 'ozon-sku-1' },
    );

    repository.upsertActivityProducts({
      shopId,
      activityId: 'same-action',
      sourceType: 'official',
      rowStatus: '已添加',
      rows: [{ product_id: 'product-1', sku: 'official-sku' }],
      markStale: false,
    });
    assert.equal(repository.readSummary({ shopId }).cachedActivityProductTotal, 2);

    const snapshot = repository.readSnapshot({ shopId });
    assert.equal(snapshot.found, true);
    assert.equal(snapshot.snapshot.selectedActivityId, 'same-action');
    assert.equal(snapshot.snapshot.selectedSourceType, 'seller');
    assert.deepEqual(snapshot.snapshot.selectedProductIds, ['product-1']);
  } finally {
    db.close();
  }
});

test('legacy marketing import validates every shop before writing any source-aware fact', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const firstShopId = saveUnitShop(shopRepository, 'shop-marketing-good');
    const secondShopId = saveUnitShop(shopRepository, 'shop-marketing-bad');
    const repository = createMarketingRepository(db);
    const badSnapshot = marketingSnapshot({ activityId: 'bad-action' });
    badSnapshot.activityRows = 'not-an-array';

    assert.throws(
      () => repository.importLegacySnapshots({
        entries: [
          { shopId: firstShopId, snapshot: marketingSnapshot({ activityId: 'good-action' }) },
          { shopId: secondShopId, snapshot: badSnapshot },
        ],
      }),
      /MARKETING_LEGACY_ARRAY_REQUIRED/,
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_marketing_activities`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_marketing_activity_products`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM marketing_view_state`).get().count, 0);
  } finally {
    db.close();
  }
});

test('legacy marketing import rejects a selected product that is absent from the selected activity pool', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-marketing-selection');
    const repository = createMarketingRepository(db);
    const snapshot = marketingSnapshot();
    snapshot.selectedProductIds = ['not-in-product-pool'];

    assert.throws(
      () => repository.importLegacySnapshots({ entries: [{ shopId, snapshot }] }),
      /MARKETING_LEGACY_SELECTED_PRODUCT_UNMAPPED/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activities WHERE shop_id = ?').get(shopId).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activity_products WHERE shop_id = ?').get(shopId).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM marketing_view_state WHERE shop_id = ?').get(shopId).count, 0);
  } finally {
    db.close();
  }
});
