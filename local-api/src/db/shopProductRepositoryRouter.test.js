import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createProductRepository } from './repositories/productRepository.js';
import { createShopRepository } from './repositories/shopRepository.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopProductRepositoryRouter } from './shopProductRepositoryRouter.js';
import { createShopProductStorage } from './shopProductStorage.js';
import { createProductsService } from '../domain/products/productsService.js';
import { withDomainReadCache } from '../domain/domainReadCache.js';

function saveShop(shops, id) {
  return shops.saveShop({
    id,
    name: id,
    clientId: `client-${id}`,
    apiKey: `secret-${id}`,
    status: 'active',
  });
}

function product(id, price = 100) {
  return {
    product_id: `product-${id}`,
    offer_id: `offer-${id}`,
    sku: `sku-${id}`,
    name: `Product ${id}`,
    visibility: 'IN_SALE',
    price,
    stocks: [{ warehouse_id: 'warehouse-1', present: 7 }],
    images: [`https://example.test/${id}.jpg`],
    attributes: [],
  };
}

async function createFixture() {
  const databaseRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-product-direct-'));
  const canonicalDb = createMigratedTestDb();
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-product-direct',
    createIncarnation: () => 'inc-product-direct-1',
  });
  const manager = createShopDatabaseManager({ root: databaseRoot, profileId: shops.profileId });
  const shopDatabaseRouter = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const storage = createShopProductStorage({
    canonicalDb,
    shopDatabaseRouter,
    enabledShopIds: ['shop-1'],
    directWriteShopIds: ['shop-1'],
  });
  const canonicalRepository = createProductRepository(canonicalDb, {
    resolveProductReadDatabase(query = {}) {
      const shopId = String(query.shopId || query.shop_id || '').trim();
      const readiness = shopId ? storage.resolveVerifiedReadSession({ shopId }) : null;
      return readiness?.ready ? { db: readiness.db, shopId } : { db: canonicalDb, shopId };
    },
  });
    const repository = createShopProductRepositoryRouter({ canonicalRepository, shopProductStorage: storage });
  return {
    canonicalDb,
    shops,
    manager,
    shopDatabaseRouter,
    storage,
    canonicalRepository,
    repository,
    async close() {
      repository.closeProductReadConnections();
      manager.closeAll();
      canonicalDb.close();
      await rm(databaseRoot, { recursive: true, force: true });
    },
  };
}

test('direct product writes update only the exact shop database and never the canonical product tables', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.canonicalRepository.upsertProducts({ shopId: 'shop-1', rows: [product('before-cutover')] });
    fixture.storage.mirrorShop({ shopId: 'shop-1' });
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).writeMode, 'direct');

    const canonicalBefore = fixture.canonicalDb.prepare(
      'SELECT COUNT(*) AS total FROM ozon_products WHERE shop_id = ?',
    ).get('shop-1').total;
    const result = fixture.repository.upsertProducts({ shopId: 'shop-1', rows: [product('direct')] });
    const canonicalAfter = fixture.canonicalDb.prepare(
      'SELECT COUNT(*) AS total FROM ozon_products WHERE shop_id = ?',
    ).get('shop-1').total;
    const shopDb = fixture.shopDatabaseRouter.open('shop-1').db;
    const directTotal = shopDb.prepare(
      'SELECT COUNT(*) AS total FROM ozon_products WHERE shop_id = ?',
    ).get('shop-1').total;

    assert.equal(result.changed, 1);
    assert.equal(canonicalBefore, 1);
    assert.equal(canonicalAfter, 1);
    assert.equal(directTotal, 2);
    assert.equal(fixture.repository.listProducts({ shopId: 'shop-1', pageSize: 20 }).total, 2);
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).ready, true);
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).directWriteRevision, 1);
    assert.equal(fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' }).reason, 'direct_write_ready');
    assert.equal(fixture.repository.snapshotDirectWrites().directWrites, 1);
    assert.equal(fixture.repository.snapshotDirectWrites().canonicalWrites, 0);
  } finally {
    await fixture.close();
  }
});

test('direct product writes fail closed before migration instead of falling back to the shared database', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    assert.throws(
      () => fixture.repository.upsertProducts({ shopId: 'shop-1', rows: [product('blocked')] }),
      (error) => error?.code === 'SHOP_PRODUCT_DIRECT_WRITE_NOT_READY',
    );
    assert.equal(
      fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_products WHERE shop_id = ?').get('shop-1').total,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test('a newly bound shop can initialize an empty direct product database without a canonical product write', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    const initialized = fixture.storage.initializeDirectShop({ shopId: 'shop-1' });
    assert.equal(initialized.initialized, true);
    assert.equal(fixture.storage.resolveDirectWriteSession({ shopId: 'shop-1' }).writeMode, 'direct');
    fixture.repository.upsertProducts({ shopId: 'shop-1', rows: [product('new-shop')] });
    assert.equal(
      fixture.canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_products WHERE shop_id = ?').get('shop-1').total,
      0,
    );
    assert.equal(
      initialized.route.databasePath,
      fixture.shopDatabaseRouter.resolve('shop-1').databasePath,
    );
  } finally {
    await fixture.close();
  }
});

test('direct product support and hydration reads do not fall back to frozen shared rows', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.storage.initializeDirectShop({ shopId: 'shop-1' });
    fixture.repository.upsertProducts({ shopId: 'shop-1', rows: [product('support')] });
    fixture.repository.upsertProductMaterialProfile({ shopId: 'shop-1', productId: 'product-support', weight: '2', source: 'user' });
    fixture.repository.upsertProductSourceLinks({ shopId: 'shop-1', productId: 'product-support', links: [{ url: 'https://example.test/source', platform: '1688' }] });
    assert.equal(fixture.repository.listProductMaterialProfiles({ shopId: 'shop-1' }).length, 1);
    assert.equal(fixture.repository.listProductMaterialProfilesPage({ shopId: 'shop-1' }).total, 1);
    assert.equal(fixture.repository.listProductSourceLinks({ shopId: 'shop-1' }).length, 1);
    assert.equal(fixture.repository.listProductSourceLinksPage({ shopId: 'shop-1' }).total, 1);
    assert.equal(fixture.canonicalRepository.listProductMaterialProfiles({ shopId: 'shop-1' }).length, 0);
    const coverage = fixture.repository.getProductHydrationCoverage({ shopId: 'shop-1', productIds: ['product-support'] });
    assert.deepEqual(coverage, createProductRepository(fixture.shopDatabaseRouter.open('shop-1').db).getProductHydrationCoverage({ shopId: 'shop-1', productIds: ['product-support'] }));
    const localDb = fixture.shopDatabaseRouter.open('shop-1').db;
    localDb.prepare("UPDATE shop_product_storage_state SET status = 'failed', last_error_code = 'TEST_FAILED'").run();
    assert.throws(() => fixture.repository.listProducts({ shopId: 'shop-1' }), { code: 'SHOP_PRODUCT_DIRECT_WRITE_NOT_READY' });
    assert.throws(() => fixture.repository.listProductSourceLinks({ shopId: 'shop-1' }), { code: 'SHOP_PRODUCT_DIRECT_WRITE_NOT_READY' });
  } finally { await fixture.close(); }
});

test('product row and direct revision roll back together when revision commit fails', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.storage.initializeDirectShop({ shopId: 'shop-1' });
    const localDb = fixture.shopDatabaseRouter.open('shop-1').db;
    localDb.exec("CREATE TRIGGER fail_test_revision BEFORE UPDATE ON shop_product_storage_state BEGIN SELECT RAISE(ABORT, 'TEST_REVISION_FAILURE'); END;");
    assert.throws(() => fixture.repository.upsertProducts({ shopId: 'shop-1', rows: [product('rollback')] }), /TEST_REVISION_FAILURE/);
    for (const table of ['ozon_products', 'product_identities', 'product_status_facts']) {
      assert.equal(localDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
    assert.equal(localDb.prepare('SELECT direct_write_revision AS n FROM shop_product_storage_state').get().n, 0);
  } finally { await fixture.close(); }
});

test('initialization and stale mirror calls never reset or overwrite direct products', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.storage.initializeDirectShop({ shopId: 'shop-1' });
    fixture.repository.upsertProducts({ shopId: 'shop-1', rows: [product('retain')] });
    assert.equal(fixture.storage.initializeDirectShop({ shopId: 'shop-1' }).initialized, false);
    assert.equal(fixture.storage.resolveVerifiedReadSession({ shopId: 'shop-1' }).directWriteRevision, 1);
    assert.throws(() => fixture.storage.mirrorShop({ shopId: 'shop-1' }), { code: 'SHOP_PRODUCT_STORAGE_DIRECT_MIRROR_FORBIDDEN' });
    const localDb = fixture.shopDatabaseRouter.open('shop-1').db;
    localDb.prepare("UPDATE shop_product_storage_state SET status = 'failed'").run();
    assert.throws(() => fixture.storage.enqueueShopSnapshot({ shopId: 'shop-1' }), { code: 'SHOP_PRODUCT_DIRECT_RECOVERY_REQUIRED' });
    assert.equal(localDb.prepare('SELECT COUNT(*) AS n FROM ozon_products').get().n, 1);
  } finally { await fixture.close(); }
});

test('initializing a shop with unmigrated products does not mark it empty or ready', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.canonicalRepository.upsertProducts({ shopId: 'shop-1', rows: [product('history')] });
    const result = fixture.storage.initializeDirectShop({ shopId: 'shop-1' });
    assert.equal(result.initialized, false);
    assert.equal(result.requiresBackfill, true);
    assert.throws(() => fixture.storage.resolveDirectWriteSession({ shopId: 'shop-1' }), { code: 'SHOP_PRODUCT_DIRECT_WRITE_NOT_READY' });
  } finally { await fixture.close(); }
});

test('direct mutations invalidate both product service and outer domain page caches', async () => {
  const fixture = await createFixture();
  let service;
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.storage.initializeDirectShop({ shopId: 'shop-1' });
    let wrapped;
    service = createProductsService({
      db: fixture.canonicalDb, shopRepository: fixture.shops, shopProductStorage: fixture.storage,
      onProductDataChanged: (id) => wrapped.invalidateOwnerHotCache(id),
    });
    wrapped = withDomainReadCache('products', service);
    assert.equal(wrapped.readCache({ shopId: 'shop-1', pageSize: 20 }).total, 0);
    assert.equal(wrapped.readCache({ shopId: 'shop-1', pageSize: 20 }).runtimeCache.hit, true);
    service.productRepository.upsertProducts({ shopId: 'shop-1', rows: [product('new-cache')] });
    assert.equal(wrapped.readCache({ shopId: 'shop-1', pageSize: 20 }).total, 1);
  } finally {
    service?.productRepository?.closeProductReadConnections();
    await fixture.close();
  }
});

test('legacy single-shop import arrays use the direct database and reject mixed shop writes', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    fixture.storage.initializeDirectShop({ shopId: 'shop-1' });
    const result = fixture.repository.importLegacyProductSourceLinks([
      { shopId: 'shop-1', productId: 'product-legacy', links: [{ url: 'https://example.test/legacy', platform: '1688' }] },
    ]);
    assert.equal(result.importedCount, 1);
    assert.equal(fixture.repository.listProductSourceLinks({ shopId: 'shop-1' }).length, 1);
    assert.equal(fixture.canonicalRepository.listProductSourceLinks({ shopId: 'shop-1' }).length, 0);
    assert.throws(() => fixture.repository.importLegacyProductSourceLinks([{ shopId: 'shop-1' }, { shopId: 'shop-2' }]), { code: 'SHOP_PRODUCT_DIRECT_WRITE_EXACT_SHOP_REQUIRED' });
    assert.throws(() => fixture.repository.listProducts({ shopId: 'shop-1', shopIds: ['shop-2'] }), { code: 'SHOP_PRODUCT_QUERY_SCOPE_CONFLICT' });
    const localDb = fixture.shopDatabaseRouter.open('shop-1').db;
    assert.throws(() => localDb.prepare("UPDATE product_source_links SET shop_id = 'shop-2'").run(), /SHOP_PRODUCT_ROW_SCOPE_MISMATCH/);
  } finally { await fixture.close(); }
});

test('aggregate product pages are federated from independent shop databases after direct cutover', async () => {
  const databaseRoot = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-product-federated-'));
  const canonicalDb = createMigratedTestDb();
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-product-federated',
    createIncarnation: () => 'inc-product-federated',
  });
  const manager = createShopDatabaseManager({ root: databaseRoot, profileId: shops.profileId });
  const shopDatabaseRouter = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  let repository;
  try {
    saveShop(shops, 'shop-1');
    saveShop(shops, 'shop-2');
    const storage = createShopProductStorage({
      canonicalDb,
      shopDatabaseRouter,
      enabledShopIds: ['shop-1', 'shop-2'],
      directWriteShopIds: ['shop-1', 'shop-2'],
    });
    const canonicalRepository = createProductRepository(canonicalDb, {
      resolveProductReadDatabase(query = {}) {
        const shopId = String(query.shopId || query.shop_id || '').trim();
        const readiness = shopId ? storage.resolveVerifiedReadSession({ shopId }) : null;
        return readiness?.ready ? { db: readiness.db, shopId } : { db: canonicalDb, shopId };
      },
    });
    canonicalRepository.upsertProducts({ shopId: 'shop-1', rows: [product('one-old', 10)] });
    canonicalRepository.upsertProducts({ shopId: 'shop-2', rows: [product('two-old', 20)] });
    storage.mirrorShop({ shopId: 'shop-1' });
    storage.mirrorShop({ shopId: 'shop-2' });
    repository = createShopProductRepositoryRouter({
      canonicalRepository,
      shopProductStorage: storage,
      listShopIds: () => ['shop-1', 'shop-2'],
    });
    repository.upsertProducts({ shopId: 'shop-1', rows: [product('one-direct', 300)] });
    repository.upsertProducts({ shopId: 'shop-2', rows: [product('two-direct', 200)] });

    const first = repository.listProducts({ shopIds: ['shop-1', 'shop-2'], sort: 'price_desc', page: 1, pageSize: 2 });
    const second = repository.listProducts({ shopId: 'all', sort: 'price_desc', page: 2, pageSize: 2 });
    assert.equal(first.source, 'shop-federated');
    assert.equal(first.total, 4);
    assert.deepEqual(first.rows.map((row) => row.productId), ['product-one-direct', 'product-two-direct']);
    assert.deepEqual(second.rows.map((row) => row.productId), ['product-two-old', 'product-one-old']);
    assert.equal(
      canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_products').get().total,
      2,
      'the shared database remains the frozen pre-cutover fallback',
    );
    // Test-only oracle: compare every global order/pagination mode with the unchanged SQL implementation.
    const oracle = createProductRepository(canonicalDb, { allowCompatibilityRepairs: false });
    for (const shopId of ['shop-1', 'shop-2']) {
      const samples = [product('2', 0), product('10', null),
        product(shopId === 'shop-1' ? 'one-direct' : 'two-direct', shopId === 'shop-1' ? 300 : 200)];
      oracle.upsertProducts({ shopId, rows: samples });
      repository.upsertProducts({ shopId, rows: samples });
    }
    for (const db of [canonicalDb, shopDatabaseRouter.open('shop-1').db, shopDatabaseRouter.open('shop-2').db]) {
      db.exec("UPDATE ozon_products SET updated_at = '2026-01-01'; UPDATE product_status_facts SET updated_at = '2026-01-01';");
    }
    for (const sort of ['stable', 'identity', 'price_asc', 'price_desc', 'stock_asc', 'stock_desc',
      'fee_asc', 'fee_desc', 'profit_asc', 'profit_desc', 'weight_asc', 'weight_desc', 'status_asc', 'status_desc', 'updated_desc']) {
      for (const page of [1, 2, 3, 4]) {
        const query = { shopIds: ['shop-1', 'shop-2'], sort, page, pageSize: 2 };
        const actual = repository.listProducts(query);
        const expected = oracle.listProducts(query);
        assert.equal(actual.total, expected.total, sort);
        assert.deepEqual(actual.rows.map((row) => row.id), expected.rows.map((row) => row.id), `${sort}:page${page}`);
        assert.deepEqual(actual.counts, expected.counts, sort);
      }
    }
  } finally {
    repository?.closeProductReadConnections();
    manager.closeAll();
    canonicalDb.close();
    await rm(databaseRoot, { recursive: true, force: true });
  }
});
