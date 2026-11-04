import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initializeDatabase } from '../../local-api/src/db/database.js';
import { createShopRepository } from '../../local-api/src/db/repositories/shopRepository.js';
import { createOrderRepository } from '../../local-api/src/db/repositories/orderRepository.js';
import { createShopDatabaseManager } from '../../local-api/src/db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../../local-api/src/db/shopDatabaseRouter.js';
import { createShopOrderStorage } from '../../local-api/src/db/shopOrderStorage.js';
import { createShopOrderRepositoryRouter } from '../../local-api/src/db/shopOrderRepositoryRouter.js';
import { createProductRepository } from '../../local-api/src/db/repositories/productRepository.js';
import { createShopProductStorage } from '../../local-api/src/db/shopProductStorage.js';
import { createShopProductRepositoryRouter } from '../../local-api/src/db/shopProductRepositoryRouter.js';
import { resolveDataLayout } from '../src/runtime/dataLayout.js';
import { ensureProfileMetadata } from '../src/runtime/profileMetadata.js';

export const PERFORMANCE_FIXTURE_LIMITS = Object.freeze({ shops: 20, products: 100000, orders: 500000, batchSize: 500 });
const createdFixtures = new WeakMap();

export function probeRendererPerformanceFixture(fixture) {
  assert.ok(createdFixtures.has(fixture), 'PERFORMANCE_FIXTURE_PROBE_NOT_OWNED');
  const layout = resolveDataLayout({ dataRoot: fixture.dataRoot });
  const oldFile = process.env.LOCAL_API_SECRET_FILE, oldSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET_FILE = layout.secretPath;
  delete process.env.LOCAL_API_SECRET;
  let connections;
  try {
    connections = openFixtureRepositories(layout, fixture.profileId, fixture.shopIds);
    const common = { pageSize: 1000, since: new Date(Date.now() - 90 * 86400000).toISOString(), to: new Date().toISOString() };
    return [
      { ...common, shopIds: fixture.shopIds, page: 1 }, { ...common, shopIds: fixture.shopIds, page: 2 },
      { ...common, shopId: fixture.shopIds[0], page: 1 }, { ...common, shopId: fixture.shopIds[0], page: 2 },
    ].map(query => {
      const started = performance.now(), result = connections.orderRepository.listOrders(query);
      const expected = query.shopId ? fixture.shopReceipts.find(shop => shop.shopId === query.shopId).orders : fixture.orders;
      assert.equal(result.total, expected, 'PERFORMANCE_POST_RUN_ORDER_COUNT_CHANGED');
      return { query, total: result.total, rows: result.rows.length, durationMs: performance.now() - started };
    });
  } finally {
    connections?.close();
    if (oldFile === undefined) delete process.env.LOCAL_API_SECRET_FILE; else process.env.LOCAL_API_SECRET_FILE = oldFile;
    if (oldSecret === undefined) delete process.env.LOCAL_API_SECRET; else process.env.LOCAL_API_SECRET = oldSecret;
  }
}

/** Only disposes a fixture created by this process, after its connections close. */
export function disposeRendererPerformanceFixture(fixture, { ownedRoot } = {}) {
  const identity = createdFixtures.get(fixture);
  assert.ok(identity && path.resolve(ownedRoot || '') === identity.ownedRoot, 'PERFORMANCE_FIXTURE_DISPOSE_NOT_OWNED');
  const target = fs.realpathSync(fixture.dataRoot);
  const parent = fs.realpathSync(identity.ownedRoot);
  const relative = path.relative(parent, target);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'PERFORMANCE_FIXTURE_DISPOSE_OUTSIDE_ROOT');
  assert.equal(fs.lstatSync(fixture.dataRoot).isSymbolicLink(), false, 'PERFORMANCE_FIXTURE_DISPOSE_LINK');
  const profile = JSON.parse(fs.readFileSync(path.join(target, 'profile.json'), 'utf8'));
  assert.equal(profile.profileId, identity.profileId, 'PERFORMANCE_FIXTURE_DISPOSE_IDENTITY_CHANGED');
  function verify(directory) {
    for (const entry of fs.readdirSync(directory)) {
      const file = path.join(directory, entry), stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, 'PERFORMANCE_FIXTURE_DISPOSE_LINK');
      if (stat.isDirectory()) verify(file);
      else assert.ok(stat.isFile() && stat.nlink === 1, 'PERFORMANCE_FIXTURE_DISPOSE_SHARED_FILE');
    }
  }
  verify(target);
  fs.rmSync(target, { recursive: true, force: false });
  createdFixtures.delete(fixture);
  return { disposed: !fs.existsSync(target) };
}

export function validatePerformanceFixtureSize({ orders = 0, products = 0, shops = 1 } = {}) {
  for (const [name, value] of Object.entries({ orders, products, shops })) {
    assert.ok(Number.isSafeInteger(value) && value >= (name === 'shops' ? 1 : 0)
      && value <= PERFORMANCE_FIXTURE_LIMITS[name], `PERFORMANCE_FIXTURE_SIZE_INVALID:${name}`);
  }
  return { orders, products, shops };
}

function openFixtureRepositories(layout, profileId, shopIds) {
  const { db } = initializeDatabase({ database: { path: layout.databasePath, enableWal: true, busyTimeoutMs: 5000 } });
  let manager;
  let productStorage;
  let productRepository;
  try {
    const shopRepository = createShopRepository(db, { profileId, tenantId: 'com.wangzai.assistant.desktop', userId: profileId });
    manager = createShopDatabaseManager({ root: layout.shopDatabaseRoot, profileId });
    const router = createShopDatabaseRouter({ shopRepository, shopDatabaseManager: manager });
    const orderStorage = createShopOrderStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true, backgroundRunner() {} });
    const orderRepository = createShopOrderRepositoryRouter({ canonicalRepository: createOrderRepository(db), shopOrderStorage: orderStorage, listShopIds: () => shopIds });
    productStorage = createShopProductStorage({ canonicalDb: db, shopDatabaseRouter: router, directWriteAllShops: true });
    productRepository = createShopProductRepositoryRouter({ canonicalRepository: createProductRepository(db), canonicalDb: db, shopProductStorage: productStorage, listShopIds: () => shopIds });
    return {
      db, shopRepository, router, orderStorage, orderRepository, productStorage, productRepository,
      close() { productStorage.stop(); productRepository.closeProductReadConnections(); manager.closeAll(); db.close(); },
    };
  } catch (error) {
    productStorage?.stop(); productRepository?.closeProductReadConnections(); manager?.closeAll(); db.close();
    throw error;
  }
}

const countForShop = (total, shops, index) => Math.floor(total / shops) + (index < total % shops ? 1 : 0);
const productId = (index) => String(70000000 + index);
const offerId = (index) => `fixture-sku-${index}`;

function assertInsertReceipt(receipt, count, kind) {
  assert.ok(receipt && receipt.inserted === count && receipt.changed === count && receipt.rows === count
    && receipt.updated === 0 && receipt.unchanged === 0
    && !receipt.missing && !receipt.missingProductId && receipt.ok !== false,
  `PERFORMANCE_FIXTURE_${kind}_WRITE_RECEIPT_INVALID`);
}

// Seeding is only allowed into a new profile beneath a caller-owned managed
// test lease. Never adopt a customer directory or write to the shared legacy DB.
export async function seedRendererPerformanceFixture({ dataRoot, ownedRoot, orders = 0, products = 0, shops = 1, onProgress, batchSetup = false } = {}) {
  validatePerformanceFixtureSize({ orders, products, shops });
  assert.ok(ownedRoot, 'PERFORMANCE_FIXTURE_OWNED_ROOT_REQUIRED');
  assert.ok(typeof dataRoot === 'string' && dataRoot.trim(), 'PERFORMANCE_FIXTURE_DATA_ROOT_REQUIRED');
  const owned = path.resolve(ownedRoot), profileRoot = path.resolve(dataRoot);
  const relative = path.relative(owned, profileRoot);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'PERFORMANCE_FIXTURE_OUTSIDE_OWNED_ROOT');
  assert.match(owned, /[\\/]\.managed-dev-scratch[\\/]run-[a-f0-9-]+[\\/]work$/u);
  for (let current = path.dirname(profileRoot); current !== path.dirname(current); current = path.dirname(current)) {
    assert.ok(fs.lstatSync(current).isDirectory() && !fs.lstatSync(current).isSymbolicLink(), 'PERFORMANCE_FIXTURE_LINKED_ROOT');
  }
  assert.ok(!fs.existsSync(profileRoot), 'PERFORMANCE_FIXTURE_REQUIRES_NEW_PROFILE');
  const shopCount = shops;
  const orderCount = orders;
  const productCount = products;
  const startedAt = performance.now();
  fs.mkdirSync(profileRoot);
  const layout = resolveDataLayout({ dataRoot: profileRoot });
  const profile = ensureProfileMetadata(layout);
  const previousSecretFile = process.env.LOCAL_API_SECRET_FILE;
  const previousSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET_FILE = layout.secretPath;
  delete process.env.LOCAL_API_SECRET;
  const shopIds = Array.from({ length: shopCount }, (_, index) => `ux-fixture-shop-${index + 1}`);
  let connections;
  const shopReceipts = [];
  const anchorTime = Date.now();
  try {
    connections = openFixtureRepositories(layout, profile.profileId, shopIds);
    const { shopRepository, orderStorage: storage, orderRepository: repository, productStorage, productRepository } = connections;
    for (const [shopIndex, shopId] of shopIds.entries()) {
      shopRepository.saveShop({ id: shopId, name: `隔离验收店铺 ${shopIndex + 1}`, alias: `验收${shopIndex + 1}店`, clientId: `fixture-${shopIndex + 1}`, apiKey: `synthetic-not-a-real-key-${shopIndex + 1}`, status: 'active' });
      storage.initializeEmptyShop({ shopId });
      assert.equal(storage.initializeDirectShop({ shopId }).ready, true, 'PERFORMANCE_FIXTURE_ORDER_STORAGE_NOT_READY');
      assert.equal(productStorage.initializeDirectShop({ shopId }).initialized, true, 'PERFORMANCE_FIXTURE_PRODUCT_STORAGE_NOT_READY');
      const productsInShop = countForShop(productCount, shopCount, shopIndex);
      const count = countForShop(orderCount, shopCount, shopIndex);
      const setupDb = batchSetup ? connections.router.open(shopId).db : null;
      const pragmas = () => Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys']
        .map(name => [name, Object.values(setupDb.prepare('PRAGMA ' + name).get())[0]]));
      const setupPragmas = setupDb ? pragmas() : null;
      if (setupDb) {
        assert.equal(storage.resolveDirectWriteSession({ shopId }).db, setupDb);
        assert.equal(productStorage.resolveDirectWriteSession({ shopId }).db, setupDb);
        assert.equal(setupDb.isTransaction, false);
        setupDb.exec('BEGIN IMMEDIATE');
      }
      try {
      for (let offset = 0; offset < productsInShop; offset += PERFORMANCE_FIXTURE_LIMITS.batchSize) {
        const rows = Array.from({ length: Math.min(PERFORMANCE_FIXTURE_LIMITS.batchSize, productsInShop - offset) }, (_, index) => {
          const globalIndex = (offset + index) * shopCount + shopIndex;
          return { product_id: productId(globalIndex), offer_id: offerId(globalIndex), sku: productId(globalIndex),
            name: `隔离测试商品 ${globalIndex}`, visibility: 'IN_SALE', price: '1000.00', currency_code: 'RUB',
            stocks: [{ warehouse_id: 'fixture-warehouse', present: 10 }], images: [], attributes: [] };
        });
        assertInsertReceipt(productRepository.upsertProducts({ shopId, rows, visibility: 'IN_SALE', sortOffset: offset }), rows.length, 'PRODUCT');
        await new Promise((resolve) => setImmediate(resolve));
      }
      for (let offset = 0; offset < count; offset += PERFORMANCE_FIXTURE_LIMITS.batchSize) {
        const rows = Array.from({ length: Math.min(PERFORMANCE_FIXTURE_LIMITS.batchSize, count - offset) }, (_, index) => {
          const globalIndex = (offset + index) * shopCount + shopIndex;
          const itemIndex = productsInShop ? ((offset + index) % productsInShop) * shopCount + shopIndex : globalIndex;
          const posting = `${String(10000000 + globalIndex)}-0001-1`;
          const timestamp = new Date(anchorTime - globalIndex * 1000).toISOString();
          return { posting_number: posting, order_id: String(90000000 + globalIndex), status: 'awaiting_packaging',
            in_process_at: timestamp, payment_at: timestamp,
            products: [{ offer_id: offerId(itemIndex), sku: Number(productId(itemIndex)), name: `隔离测试商品 ${itemIndex}`, price: '1000.00', quantity: 1 }],
            financial_data: { total_price: '1000.00' }, analytics_data: { region: 'Fixture' } };
        });
        assertInsertReceipt(repository.upsertOrders({ shopId, source: 'FBS', rows }), rows.length, 'ORDER');
        await new Promise((resolve) => setImmediate(resolve));
      }
        if (setupDb) {
          setupDb.exec('COMMIT');
          assert.deepEqual(pragmas(), setupPragmas, 'PERFORMANCE_SETUP_DURABILITY_CHANGED');
        }
      } catch (error) {
        if (setupDb?.isTransaction) setupDb.exec('ROLLBACK');
        throw error;
      }
      shopReceipts.push({ shopId, products: productsInShop, orders: count, setupPragmas, route: connections.router.resolve(shopId) });
      onProgress?.({ shopId, completedShops: shopReceipts.length, shops: shopCount,
        products: shopReceipts.reduce((sum, receipt) => sum + receipt.products, 0),
        orders: shopReceipts.reduce((sum, receipt) => sum + receipt.orders, 0) });
    }
    // Reopen every database. An in-memory count before close is not a durable receipt.
    connections.close(); connections = null;
    connections = openFixtureRepositories(layout, profile.profileId, shopIds);
    for (const [shopIndex, receipt] of shopReceipts.entries()) {
      const { shopId } = receipt;
      const route = connections.router.resolve(shopId, { expectedScopeToken: receipt.route.scopeToken });
      assert.equal(route.databasePath, receipt.route.databasePath, 'PERFORMANCE_FIXTURE_READBACK_ROUTE_MISMATCH');
      const orderReadStartedAt = performance.now();
      assert.equal(connections.orderRepository.listOrders({ shopId, pageSize: 1 }).total, receipt.orders, 'PERFORMANCE_FIXTURE_ORDER_READBACK_MISMATCH');
      receipt.orderReadbackMs = Math.round((performance.now() - orderReadStartedAt) * 100) / 100;
      const productReadStartedAt = performance.now();
      const productPage = connections.productRepository.listProducts({ shopId, pageSize: 20 });
      receipt.productReadbackMs = Math.round((performance.now() - productReadStartedAt) * 100) / 100;
      assert.equal(productPage.total, receipt.products, 'PERFORMANCE_FIXTURE_PRODUCT_READBACK_MISMATCH');
      assert.equal(productPage.rows.length, Math.min(receipt.products, 20));
      if (receipt.products) {
        const ids = [...new Set([productId(shopIndex), productId((receipt.products - 1) * shopCount + shopIndex)])];
        const { rows } = connections.productRepository.getProductsByIds({ shopId, productIds: ids });
        assert.equal(rows.length, ids.length, 'PERFORMANCE_FIXTURE_PRODUCT_EDGE_READBACK_MISMATCH');
      }
      receipt.reopened = true;
    }
    for (const [table, kind] of [['ozon_orders', 'ORDERS'], ['ozon_products', 'PRODUCTS']]) {
      assert.equal(connections.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `SHARED_DB_MUST_NOT_OWN_FIXTURE_${kind}`);
    }
    const initialShopId = connections.shopRepository.listShops()[0]?.id;
    assert.ok(shopIds.includes(initialShopId), 'PERFORMANCE_FIXTURE_INITIAL_SHOP_MISSING');
    const result = { dataRoot: profileRoot, databasePath: layout.databasePath, shopIds, shopId: shopIds[0], initialShopId, profileId: profile.profileId,
      orders: orderCount, products: productCount, shops: shopCount, shopReceipts, reopened: true,
      seedCommitMode: batchSetup ? 'test-only-per-shop-transaction' : 'production-batch-calls',
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10 };
    createdFixtures.set(result, { ownedRoot: owned, profileId: profile.profileId });
    return result;
  } finally {
    try { connections?.close(); } finally {
      if (previousSecretFile === undefined) delete process.env.LOCAL_API_SECRET_FILE; else process.env.LOCAL_API_SECRET_FILE = previousSecretFile;
      if (previousSecret === undefined) delete process.env.LOCAL_API_SECRET; else process.env.LOCAL_API_SECRET = previousSecret;
    }
  }
}
