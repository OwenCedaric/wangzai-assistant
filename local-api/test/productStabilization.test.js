import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductRepository } from '../src/db/repositories/productRepository.js';
import { createProductCanonicalFactRepository } from '../src/db/repositories/productCanonicalFactRepository.js';
import { createProductsService } from '../src/domain/products/productsService.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createCacheCleanupService } from '../src/cache/cacheCleanupService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function createNoopScheduler() {
  return {
    calls: [],
    async executeReadOnly(input) {
      this.calls.push(input);
      return {
        ok: false,
        status: 'failed',
        errors: [{ message: '模拟 Ozon 失败' }],
      };
    },
  };
}

function insertResponseCache(db, rows = [], defaultShopId = 'shop-cache') {
  const statement = db.prepare(`
    INSERT INTO ozon_response_cache (
      id, domain, shop_id, endpoint_key, cache_key, payload_hash,
      response_hash, remote_hash, status, is_stale, expires_at,
      last_seen_at, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    statement.run(
      row.id,
      row.domain || 'products',
      row.shopId || defaultShopId,
      row.endpointKey,
      row.cacheKey,
      row.payloadHash || row.cacheKey,
      row.responseHash || row.cacheKey,
      row.remoteHash || row.cacheKey,
      row.status || 'confirmed',
      row.expiresAt || null,
      row.lastSeenAt || row.updatedAt,
      row.updatedAt,
      JSON.stringify(row.payload ?? { value: row.cacheKey }),
    );
  }
}

test('software all products are shop scoped non-stale rows and use Ozon status evidence from snapshots', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_stable_all');
  const otherShopId = saveUnitShop(shopRepository, 'shop_product_stable_other');
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: [{ product_id: 1001, offer_id: 'archived-1001', name: '已下架商品', visibility: 'ARCHIVED', archived: true }],
  });
  repository.upsertProducts({
    shopId,
    visibility: 'ALL',
    rows: [{ product_id: 1002, offer_id: 'snapshot-1002', name: '仅 ALL 快照商品' }],
  });
  repository.upsertProducts({
    shopId: otherShopId,
    visibility: 'ARCHIVED',
    rows: [{ product_id: 2001, offer_id: 'other-2001', name: '其他店铺商品', visibility: 'ARCHIVED', archived: true }],
  });
  db.prepare(`
    UPDATE ozon_products
    SET snapshot_visibilities_json = '["ALL","ARCHIVED","TO_SUPPLY"]',
        visibility = 'ALL',
        status_label = ''
    WHERE shop_id = ? AND product_id = '1002'
  `).run(shopId);
  createProductCanonicalFactRepository(db).projectRows({
    shopId,
    productIds: ['1002'],
  });
  db.prepare(`
    UPDATE ozon_products
    SET is_stale = 1
    WHERE shop_id = ? AND product_id = '2001'
  `).run(otherShopId);
  createProductCanonicalFactRepository(db).projectRows({
    shopId: otherShopId,
    productIds: ['2001'],
  });

  const allPage = repository.listProducts({ shopId, scope: 'software_all', pageSize: 100 });
  assert.equal(allPage.total, 2);
  assert.equal(allPage.counts.ALL, 2);
  assert.equal(allPage.counts.ARCHIVED, 2);
  assert.equal(allPage.counts.TO_SUPPLY, 1);

  const archivedPage = repository.listProducts({ shopId, visibility: 'ARCHIVED', pageSize: 100 });
  assert.equal(archivedPage.total, 2);
  assert.deepEqual(archivedPage.rows.map((row) => row.productId).sort(), ['1001', '1002']);

  const aggregatePage = repository.listProducts({ shopId: 'all', scope: 'software_all', pageSize: 100 });
  assert.equal(aggregatePage.total, 2);
  assert.equal(aggregatePage.rows.some((row) => row.shopId === otherShopId), false);
});

test('product cache pages use stable ordering and page-size bounded rows', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_stable_sort');
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: [
      { product_id: 3002, offer_id: 'offer-3002', name: 'B', visibility: 'ARCHIVED', archived: true },
      { product_id: 3001, offer_id: 'offer-3001', name: 'A', visibility: 'ARCHIVED', archived: true },
      { product_id: 3003, offer_id: 'offer-3003', name: 'C', visibility: 'ARCHIVED', archived: true },
    ],
  });

  const before = repository.listProducts({ shopId, visibility: 'ARCHIVED', page: 1, pageSize: 2 }).rows.map((row) => row.productId);
  repository.mergeProductPriceRows({
    shopId,
    rows: [{ product_id: 3001, offer_id: 'offer-3001', price: { marketing_seller_price: '99', currency_code: 'CNY' } }],
  });
  const after = repository.listProducts({ shopId, visibility: 'ARCHIVED', page: 1, pageSize: 2 }).rows.map((row) => row.productId);

  assert.deepEqual(before, after);
  assert.equal(after.length, 2);
});

test('product read cache key separates software scope, status, page, keyword and sort', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_cache_key');
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: [
      { product_id: 4001, offer_id: 'offer-4001', name: '第一页', visibility: 'ARCHIVED', archived: true },
      { product_id: 4002, offer_id: 'offer-4002', name: '第二页', visibility: 'ARCHIVED', archived: true },
    ],
  });
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: createNoopScheduler(),
    backgroundRunner() {},
  });

  const firstPage = service.readCache({ shopId, scope: 'software_all', visibility: 'ALL', page: 1, pageSize: 1, sort: 'stable' });
  const secondPage = service.readCache({ shopId, scope: 'software_all', visibility: 'ALL', page: 2, pageSize: 1, sort: 'stable' });
  const archivedPage = service.readCache({ shopId, visibility: 'ARCHIVED', page: 1, pageSize: 1, sort: 'stable' });

  assert.equal(firstPage.rows.length, 1);
  assert.equal(secondPage.rows.length, 1);
  assert.notEqual(firstPage.rows[0].productId, secondPage.rows[0].productId);
  assert.equal(archivedPage.total, 2);
});

test('product stock sorting is full SQLite sorting and keeps database total', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_stock_sort_full');
  const repository = createProductRepository(db);

  const rows = Array.from({ length: 150 }, (_, index) => {
    const productId = 7000 + index;
    const stock = index === 78 ? 30 : index === 121 ? 20 : 0;
    return {
      product_id: productId,
      offer_id: `offer-${productId}`,
      name: `stock-${stock}-${productId}`,
      visibility: 'IN_SALE',
      stocks: [{ warehouse_id: 1, present: stock }],
    };
  });
  repository.upsertProducts({ shopId, visibility: 'IN_SALE', rows });

  const firstPage = repository.listProducts({
    shopId,
    visibility: 'ALL',
    page: 1,
    pageSize: 20,
    sort: 'stock_desc',
  });

  assert.equal(firstPage.total, 150);
  assert.equal(firstPage.rows.length, 20);
  assert.equal(firstPage.sort, 'stock_desc');
  assert.equal(firstPage.rows[0].stockValue, 30);
  assert.equal(firstPage.rows[1].stockValue, 20);
});

test('archived product pagination keeps full total and requested page size', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_archived_paging');
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: Array.from({ length: 129 }, (_, index) => ({
      product_id: 8000 + index,
      offer_id: `archived-${8000 + index}`,
      name: `archived-${index}`,
      visibility: 'ARCHIVED',
      archived: true,
    })),
  });

  const page = repository.listProducts({ shopId, visibility: 'ARCHIVED', page: 1, pageSize: 20 });
  assert.equal(page.total, 129);
  assert.equal(page.rows.length, 20);
  assert.equal(page.pageSize, 20);
});

test('product display price prefers Ozon marketing price over seller and base prices', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_marketing_price');
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: 'IN_SALE',
    rows: [{ product_id: 9001, offer_id: 'offer-9001', name: 'marketing price', visibility: 'IN_SALE' }],
  });
  repository.mergeProductPriceRows({
    shopId,
    rows: [
      {
        product_id: 9001,
        offer_id: 'offer-9001',
        price: {
          price: '68',
          marketing_seller_price: '68',
          marketing_price: '34.6',
          currency_code: 'CNY',
        },
      },
    ],
  });

  const row = repository.listProducts({ shopId, productIds: ['9001'], pageSize: 20 }).rows[0];
  assert.equal(row.priceValue, 34.6);
  assert.equal(row.priceJson.marketing_price, '34.6');
  assert.equal(row.priceJson.marketing_seller_price, '68');
});

test('product stock json warehouse total repairs stock_value and raw stock_json.present', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_stock_json_repair');
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: 'IN_SALE',
    rows: [{ product_id: 9101, offer_id: 'offer-9101', name: 'stock repair', visibility: 'IN_SALE' }],
  });
  db.prepare(
    `
      UPDATE ozon_products
      SET stock_value = 0,
          stocks_synced_at = ?,
          stock_json = ?
      WHERE shop_id = ? AND product_id = '9101'
    `,
  ).run(
    new Date().toISOString(),
    JSON.stringify({
      present: 0,
      stocks: [
        { warehouse_id: 1020005014175280, present: 0 },
        { warehouse_id: 1020005020379050, present: 20 },
      ],
    }),
    shopId,
  );

  const row = repository.listProducts({ shopId, productIds: ['9101'], pageSize: 20 }).rows[0];
  assert.equal(row.stockValue, 20);

  const raw = db
    .prepare("SELECT stock_value, stock_json FROM ozon_products WHERE shop_id = ? AND product_id = '9101'")
    .get(shopId);
  assert.equal(raw.stock_value, 20);
  assert.equal(JSON.parse(raw.stock_json).present, 20);
});

test('archived Ozon evidence overrides stale sellable status on public product rows', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_archived_evidence');
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: 'IN_SALE',
    rows: [{ product_id: 9201, offer_id: 'offer-9201', name: 'archived evidence', visibility: 'IN_SALE' }],
  });
  db.prepare(
    `
      UPDATE ozon_products
      SET visibility = 'ALL',
          status_label = NULL,
          raw_json = ?,
          snapshot_visibilities_json = '["ALL","ARCHIVED"]'
      WHERE shop_id = ? AND product_id = '9201'
    `,
  ).run(JSON.stringify({ archived: true }), shopId);
  createProductCanonicalFactRepository(db).projectRows({
    shopId,
    productIds: ['9201'],
  });

  const row = repository.listProducts({ shopId, productIds: ['9201'], pageSize: 20 }).rows[0];
  assert.equal(row.visibility, 'ARCHIVED');
  assert.equal(row.statusLabel, '已下架');
  const archivedPage = repository.listProducts({ shopId, visibility: 'ARCHIVED', pageSize: 20 });
  assert.equal(archivedPage.total, 1);
  assert.equal(archivedPage.rows[0].productId, '9201');
  const inSalePage = repository.listProducts({ shopId, visibility: 'IN_SALE', pageSize: 20 });
  assert.equal(inSalePage.total, 0);
});

test('visibility archived stock sorting uses SQLite total, requested sort and archived evidence', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_archived_stock_sort');
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: [
      {
        product_id: 9301,
        offer_id: 'archived-stock-30',
        name: 'archived stock 30',
        visibility: 'ARCHIVED',
        archived: true,
        stocks: [{ warehouse_id: 1, present: 30 }],
      },
      {
        product_id: 9302,
        offer_id: 'archived-stock-5',
        name: 'archived stock 5',
        visibility: 'ARCHIVED',
        archived: true,
        stocks: [{ warehouse_id: 1, present: 5 }],
      },
    ],
  });

  const page = repository.listProducts({ shopId, visibility: 'ARCHIVED', pageSize: 20, sort: 'stock_desc' });
  assert.equal(page.total, 2);
  assert.equal(page.sort, 'stock_desc');
  assert.deepEqual(page.rows.map((row) => row.productId), ['9301', '9302']);
  assert.equal(page.rows[0].statusLabel, '已下架');
});

test('failed product refresh does not clear existing SQLite product cache', async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_failed_refresh');
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: [{ product_id: 5001, offer_id: 'offer-5001', name: '旧缓存商品', visibility: 'ARCHIVED', archived: true }],
  });
  const pending = [];
  const scheduler = createNoopScheduler();
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) { pending.push(task()); },
  });

  const accepted = service.startSync({ shopId, visibility: 'ARCHIVED', pageSize: 100, maxPages: 1, hydrate: true });
  assert.equal(accepted.accepted, true);
  await Promise.all(pending);

  const cache = service.readCache({ shopId, visibility: 'ARCHIVED', pageSize: 20 });
  assert.equal(cache.total, 1);
  assert.equal(cache.rows[0].name, '旧缓存商品');
});

test('response cache cleanup prunes only response_cache with explicit thresholds and never deletes products', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_product_cleanup');
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: [{ product_id: 6001, offer_id: 'offer-6001', name: '主表商品', visibility: 'ARCHIVED', archived: true }],
  });
  insertResponseCache(db, [
    { id: 'expired-1', endpointKey: 'products.attributes', cacheKey: 'expired-1', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' },
    { id: 'keep-1', endpointKey: 'products.attributes', cacheKey: 'keep-1', updatedAt: '2026-06-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' },
    { id: 'keep-2', endpointKey: 'products.attributes', cacheKey: 'keep-2', updatedAt: '2026-06-02T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' },
    { id: 'drop-old', endpointKey: 'products.attributes', cacheKey: 'drop-old', updatedAt: '2026-05-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' },
  ], shopId);

  const cleanup = createCacheCleanupService(db, {
    responseCache: {
      maxRowsPerEndpoint: 2,
      endpointMaxRows: { 'products.attributes': 2 },
      maxTotalRows: 10,
      maxTotalPayloadBytes: 1024 * 1024,
      now: '2026-06-29T00:00:00.000Z',
    },
  });
  const result = cleanup.cleanupResponseCache();

  assert.equal(result.deletedExpired, 1);
  assert.equal(result.deletedByEndpointLimit, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache').get().count, 2);
  assert.equal(repository.listProducts({ shopId, pageSize: 20 }).total, 1);
});

test('response cache cleanup preserves each shop last trusted warehouse and delivery method cache', () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_logistics_cache_preserved');
  insertResponseCache(db, [
    {
      id: 'warehouse-last-trusted',
      endpointKey: 'warehouse.list',
      cacheKey: `logistics:${shopId}:warehouse.list`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'delivery-last-trusted',
      endpointKey: 'deliveryMethod.list',
      cacheKey: `logistics:${shopId}:deliveryMethod.list`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'ordinary-expired',
      endpointKey: 'products.attributes',
      cacheKey: 'ordinary-expired',
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    },
  ], shopId);

  const cleanup = createCacheCleanupService(db, {
    responseCache: {
      maxRowsPerEndpoint: 1,
      maxTotalRows: 1,
      maxTotalPayloadBytes: 1,
      now: '2026-06-29T00:00:00.000Z',
    },
  });
  cleanup.cleanupResponseCache();

  const remaining = db.prepare(`
    SELECT endpoint_key AS endpointKey
    FROM ozon_response_cache
    ORDER BY endpoint_key
  `).all().map((row) => row.endpointKey);
  assert.deepEqual(remaining, ['deliveryMethod.list', 'warehouse.list']);
});
