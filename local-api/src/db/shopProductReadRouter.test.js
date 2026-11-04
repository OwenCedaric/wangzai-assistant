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
import { createShopProductReadRouter } from './shopProductReadRouter.js';
import { createShopProductStorage } from './shopProductStorage.js';

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-product-read-'));
  const canonicalDb = createMigratedTestDb();
  let incarnation = 0;
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-product-read',
    createIncarnation: () => `inc-product-read-${++incarnation}`,
  });
  const manager = createShopDatabaseManager({ root, profileId: shops.profileId });
  const databaseRouter = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const storage = createShopProductStorage({
    canonicalDb,
    shopDatabaseRouter: databaseRouter,
    enabledShopIds: ['shop-1'],
    backgroundRunner() {},
  });
  return {
    canonicalDb,
    shops,
    manager,
    storage,
    async close() {
      manager.closeAll();
      canonicalDb.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function saveShop(shops, id) {
  shops.saveShop({ id, name: id, clientId: `client-${id}`, apiKey: `secret-${id}`, status: 'active' });
}

function product(id) {
  return {
    product_id: `product-${id}`,
    offer_id: `offer-${id}`,
    sku: `sku-${id}`,
    name: `Product ${id}`,
    visibility: 'IN_SALE',
    price: 88,
    stocks: [{ warehouse_id: 'warehouse-1', present: 5 }],
    images: [`https://example.test/${id}.jpg`],
    attributes: [{ id: 9048, values: [{ value: 'model-family' }] }],
  };
}

test('verified shop-1 product, SKU, image, stock and price reads match the canonical repository', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    saveShop(fixture.shops, 'shop-2');
    const canonicalRepository = createProductRepository(fixture.canonicalDb);
    canonicalRepository.upsertProducts({ shopId: 'shop-1', rows: [product('one'), product('two')] });
    canonicalRepository.upsertProducts({ shopId: 'shop-2', rows: [product('foreign')] });
    fixture.storage.mirrorShop({ shopId: 'shop-1' });

    const readRouter = createShopProductReadRouter({
      canonicalDb: fixture.canonicalDb,
      shopProductStorage: fixture.storage,
    });
    const routedRepository = createProductRepository(fixture.canonicalDb, {
      resolveProductReadDatabase: readRouter.resolve,
      onProductReadDatabaseError(error, context) {
        readRouter.recordQueryFallback({ shopId: context.shopId, errorCode: error.code || error.message });
      },
    });
    const query = { shopId: 'shop-1', visibility: 'ALL', pageSize: 100 };
    assert.deepEqual(routedRepository.listProducts(query), canonicalRepository.listProducts(query));
    assert.deepEqual(
      routedRepository.listWarehousePickerProducts({ ...query, projection: 'warehouse-picker' }),
      canonicalRepository.listWarehousePickerProducts({ ...query, projection: 'warehouse-picker' }),
    );
    assert.deepEqual(
      routedRepository.listSkuFamily({ shopId: 'shop-1', sku: 'sku-one' }),
      canonicalRepository.listSkuFamily({ shopId: 'shop-1', sku: 'sku-one' }),
    );
    assert.equal(readRouter.snapshot().localSelections, 3);

    assert.deepEqual(
      routedRepository.listProducts({ shopId: 'shop-2', pageSize: 100 }),
      canonicalRepository.listProducts({ shopId: 'shop-2', pageSize: 100 }),
    );
    assert.deepEqual(
      routedRepository.listProducts({ shopIds: ['shop-1', 'shop-2'], pageSize: 100 }),
      canonicalRepository.listProducts({ shopIds: ['shop-1', 'shop-2'], pageSize: 100 }),
    );
    assert.equal(readRouter.snapshot().disabledSelections, 1);
    assert.equal(readRouter.snapshot().aggregateSelections, 1);
  } finally {
    await fixture.close();
  }
});

test('local product query failures fall back to the canonical database', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    const canonicalRepository = createProductRepository(fixture.canonicalDb);
    canonicalRepository.upsertProducts({ shopId: 'shop-1', rows: [product('safe')] });
    const readRouter = createShopProductReadRouter({
      canonicalDb: fixture.canonicalDb,
      shopProductStorage: {
        isEnabledShop: () => true,
        resolveVerifiedReadSession: () => ({
          ready: true,
          db: { prepare() { throw new Error('BROKEN_PRODUCT_DATABASE'); } },
        }),
      },
    });
    const routedRepository = createProductRepository(fixture.canonicalDb, {
      resolveProductReadDatabase: readRouter.resolve,
      onProductReadDatabaseError(error, context) {
        readRouter.recordQueryFallback({ shopId: context.shopId, errorCode: error.message });
      },
    });
    assert.deepEqual(
      routedRepository.listProducts({ shopId: 'shop-1', pageSize: 100 }),
      canonicalRepository.listProducts({ shopId: 'shop-1', pageSize: 100 }),
    );
    assert.equal(readRouter.snapshot().queryFallbacks, 1);
    assert.equal(readRouter.snapshot().lastFallbackReason, 'BROKEN_PRODUCT_DATABASE');
  } finally {
    await fixture.close();
  }
});

test('a direct shop read failure is never disguised by a stale shared-db result', async () => {
  const fixture = await createFixture();
  try {
    saveShop(fixture.shops, 'shop-1');
    const router = createShopProductReadRouter({ canonicalDb: fixture.canonicalDb, shopProductStorage: {
      isEnabledShop: () => true, isDirectWriteShop: () => true,
      resolveVerifiedReadSession: () => ({ ready: true, writeMode: 'direct', db: { prepare() { throw new Error('BROKEN_DIRECT'); } } }),
    } });
    const repository = createProductRepository(fixture.canonicalDb, { resolveProductReadDatabase: router.resolve });
    assert.throws(() => repository.listProducts({ shopId: 'shop-1' }), /BROKEN_DIRECT/);
    const notReady = createShopProductReadRouter({ canonicalDb: fixture.canonicalDb, shopProductStorage: {
      isEnabledShop: () => true, isDirectWriteShop: () => true,
      resolveVerifiedReadSession: () => ({ ready: false, reason: 'direct_file_missing' }),
    } });
    assert.throws(() => notReady.resolve({ shopId: 'shop-1' }), { code: 'SHOP_PRODUCT_DIRECT_READ_NOT_READY' });
  } finally { await fixture.close(); }
});
