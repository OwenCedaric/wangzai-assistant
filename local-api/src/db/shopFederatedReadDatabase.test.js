import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createProductRepository } from './repositories/productRepository.js';
import { createShopRepository } from './repositories/shopRepository.js';
import { createShopDatabaseManager } from './shopDatabaseManager.js';
import { createShopDatabaseRouter } from './shopDatabaseRouter.js';
import { createShopFederatedReadDatabase } from './shopFederatedReadDatabase.js';
import { createShopProductStorage } from './shopProductStorage.js';

function product(id, price) {
  return {
    product_id: `product-${id}`,
    offer_id: `offer-${id}`,
    name: id,
    visibility: 'IN_SALE',
    price,
    stocks: [],
    images: [],
    attributes: [],
  };
}

test('federated read database shadows frozen business tables with per-shop unions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-shop-federated-read-'));
  const canonicalPath = path.join(root, 'canonical.sqlite');
  const canonicalDb = createMigratedTestDb(canonicalPath);
  const shops = createShopRepository(canonicalDb, {
    profileId: 'profile-federated-read',
    createIncarnation: () => 'inc-federated-read',
  });
  for (const shopId of ['shop-1', 'shop-2']) {
    shops.saveShop({ id: shopId, name: shopId, clientId: `client-${shopId}`, apiKey: `secret-${shopId}`, status: 'active' });
  }
  const manager = createShopDatabaseManager({ root: path.join(root, 'shops'), profileId: shops.profileId });
  const router = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const canonicalRepository = createProductRepository(canonicalDb);
  canonicalRepository.upsertProducts({ shopId: 'shop-1', rows: [product('one-old', 10)] });
  canonicalRepository.upsertProducts({ shopId: 'shop-2', rows: [product('two-old', 20)] });
  const storage = createShopProductStorage({
    canonicalDb,
    shopDatabaseRouter: router,
    enabledShopIds: ['shop-1', 'shop-2'],
    directWriteShopIds: ['shop-1', 'shop-2'],
  });
  let federated = null;
  try {
    storage.mirrorShop({ shopId: 'shop-1' });
    storage.mirrorShop({ shopId: 'shop-2' });
    const shopOne = storage.resolveDirectWriteSession({ shopId: 'shop-1' });
    createProductRepository(shopOne.db).upsertProducts({ shopId: 'shop-1', rows: [product('one-direct', 30)] });
    assert.equal(canonicalDb.prepare('SELECT COUNT(*) AS total FROM ozon_products').get().total, 2);

    federated = createShopFederatedReadDatabase({ canonicalDb, shopRepository: shops, shopDatabaseRouter: router });
    const refreshed = federated.refresh();
    assert.equal(refreshed.shopCount, 2);
    assert.equal(federated.db.prepare('SELECT COUNT(*) AS total FROM ozon_products').get().total, 3);
    assert.equal(federated.db.prepare('SELECT COUNT(*) AS total FROM shops').get().total, 2);
    assert.deepEqual(
      federated.db.prepare('SELECT shop_id, COUNT(*) AS total FROM ozon_products GROUP BY shop_id ORDER BY shop_id').all()
        .map((row) => ({ ...row })),
      [{ shop_id: 'shop-1', total: 2 }, { shop_id: 'shop-2', total: 1 }],
    );
  } finally {
    federated?.close();
    manager.closeAll();
    canonicalDb.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('missing registered shop database is an explicit error, never a smaller successful aggregate', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-federation-missing-'));
  const db = new DatabaseSync(path.join(root, 'main.sqlite'));
  const federation = createShopFederatedReadDatabase({ canonicalDb: db,
    shopRepository: { listShops: () => [{ id: 'missing', status: 'active' }] },
    shopDatabaseRouter: { resolve: () => ({ databasePath: path.join(root, 'missing.sqlite') }) },
  });
  t.after(async () => { federation.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  assert.throws(() => federation.refresh(), error => error.code === 'SHOP_FEDERATED_DATABASE_MISSING' && error.missingShopIds[0] === 'missing');
  assert.equal(federation.snapshot().complete, false);
  assert.throws(() => federation.db.prepare('SELECT 1').get(), { code: 'SHOP_FEDERATED_DATABASE_MISSING' });
});

test('a shop table created by background migration replaces the canonical fallback on the next read', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-federation-schema-'));
  const db = new DatabaseSync(path.join(root, 'main.sqlite'));
  db.exec("CREATE TABLE ozon_orders(shop_id TEXT, order_key TEXT); INSERT INTO ozon_orders VALUES ('a','old-main')");
  const file = path.join(root, 'shop.sqlite');
  const shop = new DatabaseSync(file);
  shop.exec('PRAGMA journal_mode=WAL; CREATE TABLE metadata(id TEXT)');
  const federation = createShopFederatedReadDatabase({ canonicalDb: db,
    shopRepository: { listShops: () => [{ id: 'a', status: 'active' }] },
    shopDatabaseRouter: { resolve: () => ({ databasePath: file }) },
  });
  t.after(async () => { federation.close(); shop.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(federation.db.prepare('SELECT order_key FROM ozon_orders').get().order_key, 'old-main');
  shop.exec("CREATE TABLE ozon_orders(shop_id TEXT, order_key TEXT); INSERT INTO ozon_orders VALUES ('a','new-shop')");
  assert.equal(federation.db.prepare('SELECT order_key FROM ozon_orders').get().order_key, 'new-shop');
});

test('explicit legacy fallback is restricted to the registered profile shop set', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-federation-legacy-scope-'));
  const db = new DatabaseSync(path.join(root, 'main.sqlite'));
  db.exec("CREATE TABLE ozon_orders(shop_id TEXT, order_key TEXT); INSERT INTO ozon_orders VALUES ('allowed','one'),('another-profile','private')");
  const federation = createShopFederatedReadDatabase({ canonicalDb: db, requiredShopIds: [],
    shopRepository: { listShops: () => [{ id: 'allowed', status: 'active' }] },
    shopDatabaseRouter: { resolve: () => ({ databasePath: path.join(root, 'not-migrated.sqlite') }) },
  });
  t.after(async () => { federation.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(federation.db.prepare('SELECT order_key FROM ozon_orders').all().map(row => row.order_key), ['one']);
});

test('eleven shop stores remain readable and later writes invalidate the overflow projection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangzai-federation-overflow-'));
  const db = new DatabaseSync(path.join(root, 'main.sqlite'));
  db.exec('CREATE TABLE ozon_orders(shop_id TEXT, order_key TEXT)');
  db.exec("CREATE TABLE ozon_returns(shop_id TEXT, marker TEXT); INSERT INTO ozon_returns VALUES ('s0','allowed'),('outside-profile','private')");
  const files = new Map();
  const writers = [];
  for (let index = 0; index < 11; index++) {
    const id = `s${index}`;
    const file = path.join(root, `${id}.sqlite`);
    const writer = new DatabaseSync(file);
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE ozon_orders(shop_id TEXT, order_key TEXT)');
    writer.prepare('INSERT INTO ozon_orders VALUES (?,?)').run(id, 'same-key');
    files.set(id, file); writers.push(writer);
  }
  const federation = createShopFederatedReadDatabase({ canonicalDb: db,
    shopRepository: { listShops: () => [...files.keys()].map(id => ({ id, status: 'active' })) },
    shopDatabaseRouter: { resolve: id => ({ databasePath: files.get(id) }) },
  });
  t.after(async () => { federation.close(); writers.forEach(writer => writer.close()); db.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(federation.refresh().mode, 'versioned-temp-projection');
  assert.equal(federation.db.prepare('SELECT COUNT(*) AS n FROM ozon_orders').get().n, 11);
  assert.deepEqual(federation.db.prepare('SELECT marker FROM ozon_returns').all().map(row => row.marker), ['allowed']);
  writers[0].prepare('INSERT INTO ozon_orders VALUES (?,?)').run('s0', 'new-key');
  assert.equal(federation.db.prepare('SELECT COUNT(*) AS n FROM ozon_orders').get().n, 12);
  assert.throws(() => federation.db.exec('DELETE FROM ozon_orders'), /readonly/i);
  assert.equal(writers[0].prepare('SELECT COUNT(*) AS n FROM ozon_orders').get().n, 2);
});
