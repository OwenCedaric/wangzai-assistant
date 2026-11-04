import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketingRepository } from '../src/db/repositories/marketingRepository.js';
import {
  buildMarketingActivityProductCacheKey,
  buildMarketingHydrationBatchIdentity,
  createMarketingService,
} from '../src/domain/marketing/marketingService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createWriteGuardService } from '../src/security/writeGuardService.js';

function createFakeMarketingScheduler() {
  const calls = [];
  return {
    calls,
    async executeWrite(input) {
      calls.push(input);
      return {
        ok: true,
        accepted: input.fastAck === true,
        pending: input.fastAck === true,
        status: input.fastAck === true ? 'accepted' : 'success',
        jobId: 'marketing-write-job-1',
        job: { jobId: 'marketing-write-job-1', status: input.fastAck === true ? 'running' : 'success' },
        realWrite: input.realWrite === true,
        dryRun: input.dryRun !== false,
      };
    },
    async executeReadOnly(input) {
      calls.push(input);
      if (input.endpointKey === 'actions.list') {
        return {
          ok: true,
          status: 'success',
          data: {
            result: [
              {
                id: 101,
                title: 'Official action',
                participating_products_count: 2,
                potential_products_count: 5,
              },
            ],
          },
        };
      }
      if (input.endpointKey === 'sellerActions.list') {
        return {
          ok: true,
          status: 'success',
          data: {
            result: [
              {
                id: 202,
                title: 'Seller action',
                products_count: 1,
                candidates_count: 3,
              },
            ],
          },
      };
    }
      if (input.endpointKey === 'actions.products') {
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              products: [
                {
                  product_id: 11,
                  offer_id: 'joined-11',
                  name: 'Joined product',
                  action_price: '10.00',
                  stock: 0,
                },
              ],
              total: 1,
            },
          },
        };
      }
      if (input.endpointKey === 'sellerActions.productsList') {
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              products: [
                {
                  product_id: 21,
                  offer_id: 'seller-joined-21',
                  name: 'Seller joined product',
                  action_price: '12.00',
                },
              ],
              total: 1,
            },
          },
        };
      }
      if (input.endpointKey === 'actions.candidates') {
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              products: [
                {
                  product_id: 12,
                  offer_id: 'candidate-12',
                  name: 'Candidate product',
                  action_price: '8.00',
                },
                {
                  product_id: 11,
                  offer_id: 'duplicate-joined-11',
                  name: 'Duplicate joined product',
                },
              ],
              total: 2,
            },
          },
        };
      }
      if (input.endpointKey === 'sellerActions.productsCandidates') {
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              products: [
                {
                  product_id: 22,
                  offer_id: 'seller-candidate-22',
                  name: 'Seller candidate product',
                  action_price: '9.00',
                },
              ],
              total: 1,
            },
          },
        };
      }
      if (input.endpointKey === 'products.infoList') {
        const ids = input.params?.product_id || [];
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              items: ids.map((id) => ({
                id,
                product_id: id,
                offer_id: `hydrated-offer-${id}`,
                sku: `hydrated-sku-${id}`,
                name: `Hydrated product ${id}`,
              })),
            },
          },
        };
      }
      if (input.endpointKey === 'products.prices') {
        const ids = input.params?.filter?.product_id || [];
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              items: ids.map((id) => ({
                product_id: id,
                offer_id: `hydrated-offer-${id}`,
                price: { marketing_seller_price: String(Number(id) + 0.5), currency_code: 'CNY' },
              })),
            },
          },
        };
      }
      if (input.endpointKey === 'products.stocks') {
        const ids = input.params?.filter?.product_id || [];
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              items: ids.map((id) => ({
                product_id: id,
                offer_id: `hydrated-offer-${id}`,
                present: Number(id) + 2,
              })),
            },
          },
        };
      }
    return { ok: false, status: 'failed', error: { code: 'UNKNOWN_ENDPOINT', message: input.endpointKey } };
  },
  };
}

test('marketing repository stores activity cache rows in SQLite', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createMarketingRepository(db);
    const result = repository.upsertActivities({
      shopId: 'shop-marketing-repo',
      sourceType: 'official',
      sourceLabel: '平台活动',
      rows: [{ id: 1, title: 'Promo', participating_products_count: 4, potential_products_count: 9 }],
    });
    assert.equal(result.changed, 1);
    const page = repository.listActivities({ shopId: 'shop-marketing-repo' });
    assert.equal(page.total, 1);
    assert.equal(page.activityRows[0].id, '1');
    assert.equal(page.activityRows[0].sourceType, 'official');
    assert.equal(page.activityRows[0].count, 4);
    assert.equal(page.activityRows[0].available, 9);
  } finally {
    db.close();
  }
});

test('marketing page snapshot can omit the large product pool while retaining activity selection and summary', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createMarketingRepository(db);
    const shopId = saveUnitShop(createShopRepository(db), 'shop_marketing_light_snapshot');
    repository.upsertActivities({
      shopId,
      sourceType: 'official',
      rows: [{ id: 101, title: 'Promo', participating_products_count: 1, potential_products_count: 1 }],
    });
    repository.upsertActivityProducts({
      shopId,
      activityId: 101,
      sourceType: 'official',
      rowStatus: '已添加',
      rows: [{ product_id: 9001, offer_id: 'offer-9001', name: 'Cached product' }],
    });

    const complete = repository.readSnapshot({ shopId });
    const lightweight = repository.readSnapshot({
      shopId,
      includeProductPool: false,
    });

    assert.equal(complete.productPool.length, 1);
    assert.equal(complete.includesProductPool, true);
    assert.deepEqual(lightweight.productPool, []);
    assert.equal(lightweight.includesProductPool, false);
    assert.equal(lightweight.activityRows.length, 1);
    assert.equal(lightweight.selectedActivityId, '101');
    assert.equal(lightweight.selectedSourceType, 'official');
    assert.equal(lightweight.marketingSummary.joinedProductTotal, 1);

    const savedViewState = repository.saveViewState({
      shopId,
      viewState: {
        selectedActivityId: '101',
        selectedSourceType: 'official',
        productScope: 'joined',
        selectedProductIds: ['9001'],
        marketingSummary: {
          activityTotal: 1,
          joinedActivityTotal: 1,
          joinedProductTotal: 1,
          issueProductTotal: 0,
        },
      },
    });
    assert.equal(savedViewState.ok, true);
    assert.equal(savedViewState.viewState.marketingSummary.joinedProductTotal, 1);

    repository.saveViewState({
      shopId,
      viewState: {
        selectedActivityId: '101',
        selectedSourceType: 'official',
        productScope: 'joined',
        selectedProductIds: [],
        marketingSummary: {
          activityTotal: 1,
          joinedActivityTotal: 0,
          joinedProductTotal: 0,
          issueProductTotal: 0,
        },
      },
    });
    const reconciled = repository.readSnapshot({ shopId, includeProductPool: false });
    assert.equal(reconciled.snapshot.marketingSummary.joinedActivityTotal, 1);
    assert.equal(reconciled.snapshot.marketingSummary.joinedProductTotal, 1);
  } finally {
    db.close();
  }
});

test('marketing repository hides ended activities by default and can include them for diagnostics', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createMarketingRepository(db);
    repository.upsertActivities({
      shopId: 'shop-marketing-active-filter',
      sourceType: 'official',
      sourceLabel: '平台活动',
      rows: [
        {
          id: 101,
          title: 'Active Promo',
          participating_products_count: 1,
          date_start: '2026-01-01T00:00:00Z',
          date_end: '2099-01-01T00:00:00Z',
        },
        {
          id: 102,
          title: 'Ended Promo',
          participating_products_count: 2,
          date_start: '2024-01-01T00:00:00Z',
          date_end: '2024-02-01T00:00:00Z',
        },
      ],
    });

    const activeOnly = repository.listActivities({ shopId: 'shop-marketing-active-filter' });
    const withEnded = repository.listActivities({ shopId: 'shop-marketing-active-filter', includeEnded: true });

    assert.equal(activeOnly.total, 1);
    assert.equal(activeOnly.activityRows[0].id, '101');
    assert.equal(activeOnly.activityRows[0].isOnline, true);
    assert.equal(withEnded.total, 2);
    assert.equal(withEnded.activityRows.some((activity) => activity.id === '102'), true);
  } finally {
    db.close();
  }
});

test('marketing write guard enters executor with fast ack and double real-write keys', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_marketing_write_fast_ack');
    const scheduler = createFakeMarketingScheduler();
    const service = createMarketingService({ db, ozonScheduler: scheduler });
    const guard = createWriteGuardService(db, {
      executors: {
        marketing: (context) => service.executeConfirmedWrite(context),
      },
    });
    const preview = guard.previewWrite('marketing', {
      shopId,
      action: 'marketing.products.add',
      endpointKey: 'actions.productsActivate',
      payload: {
        action_id: 101,
        products: [{ product_id: 11, action_price: 10 }],
      },
      after: { activityId: '101', selectedCount: 1 },
      idempotencyKey: 'marketing-write-1',
    });
    const confirm = await guard.confirmWrite('marketing', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'marketing.products.add',
      realWrite: true,
      dryRun: false,
      fastAck: true,
      asyncWrite: true,
      idempotencyKey: 'marketing-write-1',
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.accepted, true);
    assert.equal(confirm.pending, true);
    assert.equal(confirm.schedulerResult.jobId, 'marketing-write-job-1');
    const writeCall = scheduler.calls.find((item) => item.action === 'marketing.products.add');
    assert.equal(writeCall.domain, 'marketing');
    assert.equal(writeCall.endpointKey, 'actions.productsActivate');
    assert.equal(writeCall.realWrite, true);
    assert.equal(writeCall.dryRun, false);
    assert.equal(writeCall.fastAck, true);
    assert.equal(writeCall.waitForResult, false);
  } finally {
    db.close();
  }
});

test('marketing write guard keeps submitted status until product pool readback is merged', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_marketing_write_wait_readback');
    const scheduler = createFakeMarketingScheduler();
    const service = createMarketingService({ db, ozonScheduler: scheduler });
    const guard = createWriteGuardService(db, {
      executors: {
        marketing: (context) => service.executeConfirmedWrite(context),
      },
    });
    const preview = guard.previewWrite('marketing', {
      shopId,
      action: 'marketing.products.add',
      endpointKey: 'actions.productsActivate',
      payload: {
        action_id: 101,
        products: [{ product_id: 11, action_price: 10 }],
      },
      after: { activityId: '101', selectedCount: 1 },
      idempotencyKey: 'marketing-write-wait-readback',
    });
    const confirm = await guard.confirmWrite('marketing', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'marketing.products.add',
      endpointKey: 'actions.productsActivate',
      realWrite: true,
      dryRun: false,
      fastAck: false,
      asyncWrite: false,
      waitForResult: true,
      idempotencyKey: 'marketing-write-wait-readback',
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    assert.match(confirm.message, /等待/u);
    assert.doesNotMatch(confirm.message, /完成/u);
    const writeCall = scheduler.calls.find((item) => item.action === 'marketing.products.add');
    assert.equal(writeCall.realWrite, true);
    assert.equal(writeCall.dryRun, false);
    assert.equal(writeCall.fastAck, false);
    assert.equal(writeCall.waitForResult, true);
  } finally {
    db.close();
  }
});


test('marketing repository enriches product identifiers from product cache without faking offer ids', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_marketing_identifier_enrich');
    const repository = createMarketingRepository(db);
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO ozon_products (
        id, shop_id, product_key, product_id, offer_id, sku, name, visibility,
        price_value, stock_value, remote_hash, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ALL', ?, ?, ?, ?, ?, ?)
    `).run(
      `${shopId}:product:99`,
      shopId,
      'product:99',
      '99',
      'offer-99',
      'sku-99',
      'Cached product 99',
      88.8,
      6,
      'hash-product-99',
      timestamp,
      timestamp,
      timestamp,
    );
    const result = repository.upsertActivityProducts({
      shopId,
      activityId: '101',
      sourceType: 'official',
      rowStatus: '已添加',
      rows: [{ id: 99, action_price: '5.00' }],
    });
    assert.equal(result.changed, 1);
    const cache = repository.listActivityProducts({
      shopId,
      activityId: '101',
      sourceType: 'official',
      productScope: 'all',
    });
    assert.equal(cache.total, 1);
    assert.equal(cache.productPool[0].productId, '99');
    assert.equal(cache.productPool[0].offerId, 'offer-99');
    assert.equal(cache.productPool[0].ozonSku, 'sku-99');
    assert.equal(cache.productPool[0].sku, 'offer-99');
    assert.equal(cache.productPool[0].price, '88.8');
    assert.equal(cache.productPool[0].stock, '6');
  } finally {
    db.close();
  }
});

test('marketing repository leaves offer id empty when Ozon and product cache do not provide it', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createMarketingRepository(db);
    const result = repository.upsertActivityProducts({
      shopId: 'shop_marketing_missing_ids',
      activityId: '101',
      sourceType: 'official',
      rowStatus: '已添加',
      rows: [{ id: 99, action_price: '5.00', price: '10.00', stock: '3' }],
    });
    assert.equal(result.changed, 1);
    const cache = repository.listActivityProducts({
      shopId: 'shop_marketing_missing_ids',
      activityId: '101',
      sourceType: 'official',
      productScope: 'all',
    });
    assert.equal(cache.total, 1);
    assert.equal(cache.productPool[0].productId, '99');
    assert.equal(cache.productPool[0].offerId, '');
    assert.equal(cache.productPool[0].ozonSku, '');
    assert.equal(cache.productPool[0].sku, '');
  } finally {
    db.close();
  }
});

test('marketing product and hydration cache identities follow the exact shop, activity and product payload', () => {
  const joinedKey = buildMarketingActivityProductCacheKey({
    shopId: 'shop-cache-a',
    sourceType: 'official',
    activityId: '101',
    rowStatus: '已添加',
  });
  assert.equal(
    joinedKey,
    buildMarketingActivityProductCacheKey({
      shopId: 'shop-cache-a',
      sourceType: 'official',
      activityId: '101',
      rowStatus: '已添加',
    }),
  );
  assert.notEqual(
    joinedKey,
    buildMarketingActivityProductCacheKey({
      shopId: 'shop-cache-a',
      sourceType: 'official',
      activityId: '102',
      rowStatus: '已添加',
    }),
  );

  const firstBatch = buildMarketingHydrationBatchIdentity({
    shopId: 'shop-cache-a',
    endpointKey: 'products.infoList',
    productIds: ['3', '1', '2', '1'],
  });
  const sameBatchDifferentOrder = buildMarketingHydrationBatchIdentity({
    shopId: 'shop-cache-a',
    endpointKey: 'products.infoList',
    productIds: ['2', '3', '1'],
  });
  const differentBatch = buildMarketingHydrationBatchIdentity({
    shopId: 'shop-cache-a',
    endpointKey: 'products.infoList',
    productIds: ['2', '3', '4'],
  });
  assert.deepEqual(firstBatch.productIds, ['1', '2', '3']);
  assert.equal(firstBatch.cacheKey, sameBatchDifferentOrder.cacheKey);
  assert.equal(firstBatch.idempotencyKey, sameBatchDifferentOrder.idempotencyKey);
  assert.notEqual(firstBatch.cacheKey, differentBatch.cacheKey);
});

test('marketing product batch merge rolls stale marks and prior rows back when any row fails', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_marketing_atomic_products');
    const repository = createMarketingRepository(db);
    repository.upsertActivityProducts({
      shopId,
      activityId: '101',
      sourceType: 'official',
      rowStatus: '已添加',
      rows: [{ product_id: 'existing', name: 'Existing product' }],
    });
    db.exec(`
      CREATE TRIGGER reject_marketing_product_fixture
      BEFORE INSERT ON ozon_marketing_activity_products
      WHEN NEW.product_id = 'explode'
      BEGIN
        SELECT RAISE(ABORT, 'forced marketing merge failure');
      END;
    `);

    assert.throws(
      () => repository.upsertActivityProducts({
        shopId,
        activityId: '101',
        sourceType: 'official',
        rowStatus: '已添加',
        rows: [
          { product_id: 'new-good', name: 'New good product' },
          { product_id: 'explode', name: 'Rejected product' },
        ],
      }),
      /forced marketing merge failure/u,
    );

    const cache = repository.listActivityProducts({
      shopId,
      activityId: '101',
      sourceType: 'official',
      productScope: 'joined',
    });
    assert.equal(cache.total, 1);
    assert.equal(cache.productPool[0].productId, 'existing');
  } finally {
    db.close();
  }
});

test('marketing service starts activity sync and exposes cached activities', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_marketing_sync');
    const scheduler = createFakeMarketingScheduler();
    const pendingTasks = [];
    const service = createMarketingService({
      db,
      ozonScheduler: scheduler,
      backgroundRunner(task) {
        pendingTasks.push(task());
      },
    });

    const accepted = service.startSync({
      shopId,
      includeCacheSnapshot: true,
      fastAck: true,
      idempotencyKey: 'marketing-fast-activities',
      source: 'recovery-reconcile',
      syncMode: 'recovery-reconcile',
      recoveryRestoreId: 'restore-marketing-contract',
      recoveryGenerationId: 'generation-marketing-contract',
      recoveryOverlapMinutes: 30,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.fastAck, true);
    assert.equal(accepted.cacheSnapshot.ok, true);
    assert.equal(accepted.cacheSnapshot.total, 0);
    await Promise.all(pendingTasks);
    assert.equal(scheduler.calls.every((call) => call.source === 'recovery-reconcile'), true);
    assert.equal(scheduler.calls.every((call) => call.syncMode === 'recovery-reconcile'), true);
    assert.equal(scheduler.calls.every((call) => call.recoveryRestoreId === 'restore-marketing-contract'), true);
    assert.equal(scheduler.calls.every((call) => call.recoveryGenerationId === 'generation-marketing-contract'), true);
    assert.equal(scheduler.calls.every((call) => call.recoveryOverlapMinutes === 30), true);
    assert.equal(scheduler.calls.every((call) => call.forceRefresh === true), true);

    assert.deepEqual(scheduler.calls.map((item) => item.endpointKey), ['actions.list', 'sellerActions.list']);
    const cache = service.readCache({ shopId });
    assert.equal(cache.ok, true);
    assert.equal(cache.total, 2);
    const reusedFast = service.startSync({ shopId, forceRefresh: true, includeCacheSnapshot: true, fastAck: true, idempotencyKey: 'marketing-fast-activities' });
    assert.equal(reusedFast.cacheSnapshot.total, 2);
    const ackWithoutSnapshot = service.startSync({
      shopId,
      forceRefresh: true,
      includeCacheSnapshot: false,
      fastAck: true,
      idempotencyKey: 'marketing-fast-activities-no-snapshot',
    });
    assert.equal(Object.hasOwn(ackWithoutSnapshot, 'cacheSnapshot'), false);
    await Promise.all(pendingTasks.splice(0));
    assert.equal(cache.activityRows.some((item) => item.sourceType === 'official'), true);
    assert.equal(cache.activityRows.some((item) => item.sourceType === 'seller'), true);
  } finally {
    db.close();
  }
});

test('marketing service syncs activity product pool into SQLite by scope', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_marketing_products');
    const scheduler = createFakeMarketingScheduler();
    const pendingTasks = [];
    const service = createMarketingService({
      db,
      ozonScheduler: scheduler,
      backgroundRunner(task) {
        pendingTasks.push(task());
      },
    });

    const accepted = service.startSync({
      shopId,
      scope: 'products',
      activityId: '101',
      sourceType: 'official',
      productScope: 'all',
      forceRefresh: true,
      maxPages: 1,
      includeCacheSnapshot: true,
      fastAck: true,
      idempotencyKey: 'marketing-fast-products',
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.fastAck, true);
    assert.equal(accepted.cacheSnapshot.ok, true);
    assert.equal(accepted.cacheSnapshot.total, 0);
    await Promise.all(pendingTasks);

    assert.deepEqual(
      scheduler.calls.filter((item) => item.action === 'sync-marketing-product-facts').map((item) => item.endpointKey),
      ['actions.products', 'actions.candidates'],
    );
    assert.deepEqual(
      scheduler.calls.filter((item) => item.action === 'sync-marketing-products-hydrate').map((item) => item.endpointKey),
      ['products.infoList', 'products.prices', 'products.stocks'],
    );
    const cache = service.readCache({
      scope: 'products',
      shopId,
      activityId: '101',
      sourceType: 'official',
      productScope: 'all',
    });
    assert.equal(cache.ok, true);
    assert.equal(cache.total, 2);
    assert.equal(cache.joinedTotal, 1);
    assert.equal(cache.availableTotal, 1);
    assert.equal(cache.productPool.some((item) => item.status === '已添加'), true);
    assert.equal(cache.productPool.some((item) => item.status === '可添加'), true);
    const joinedProduct = cache.productPool.find((item) => item.productId === '11');
    assert.equal(joinedProduct.name, 'Hydrated product 11');
    assert.equal(joinedProduct.ozonSku, 'hydrated-sku-11');
    assert.equal(joinedProduct.price, '11.5');
    assert.equal(joinedProduct.stock, '13');
  } finally {
    db.close();
  }
});

test('marketing service builds full summary through background product-pool sync', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_marketing_summary');
    const scheduler = createFakeMarketingScheduler();
    const pendingTasks = [];
    const service = createMarketingService({
      db,
      ozonScheduler: scheduler,
      backgroundRunner(task) {
        pendingTasks.push(task());
      },
    });

    service.startSync({ shopId, forceRefresh: true, idempotencyKey: 'marketing-summary-activities' });
    await Promise.all(pendingTasks.splice(0));

    const accepted = service.startSync({
      shopId,
      scope: 'summary',
      forceRefresh: true,
      includeCacheSnapshot: true,
      fastAck: true,
      idempotencyKey: 'marketing-summary-full',
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.cacheSnapshot.scope, 'summary');
    await Promise.all(pendingTasks.splice(0));

    const summary = service.readCache({ scope: 'summary', shopId });
    assert.equal(summary.ok, true);
    assert.equal(summary.activityTotal, 2);
    assert.equal(summary.joinedActivityTotal, 2);
    assert.equal(summary.joinedProductTotal, 2);
    assert.equal(summary.issueProductTotal, 0);
    assert.equal(summary.cachedActivityProductTotal, 2);
    const summaryEndpointKeys = scheduler.calls
      .filter((item) => item.action === 'sync-marketing-product-facts')
      .map((item) => item.endpointKey)
      .sort();
    assert.deepEqual(summaryEndpointKeys, [
      'actions.candidates',
      'actions.products',
      'sellerActions.productsCandidates',
      'sellerActions.productsList',
    ]);
    assert.equal(
      scheduler.calls.every((request) => request.waitForResult === true),
      true,
      'marketing domain readers must wait for a coalesced endpoint payload before merging SQLite facts',
    );
  } finally {
    db.close();
  }
});

test('marketing write action cannot be rewritten to another endpoint after allowlist removal', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_marketing_endpoint_mismatch');
    const scheduler = createFakeMarketingScheduler();
    const repository = createMarketingRepository(db);
    const service = createMarketingService({
      db,
      repository,
      ozonScheduler: scheduler,
      shopRepository,
      backgroundRunner() {},
    });
    const guard = createWriteGuardService(db, {
      executors: {
        marketing: (context) => service.executeConfirmedWrite(context),
      },
    });

    const preview = guard.previewWrite('marketing', {
      shopId,
      action: 'marketing.products.add',
      endpointKey: 'actions.productsDeactivate',
      payload: { action_id: 101, products: [{ product_id: 11, action_price: 10 }] },
    });
    const confirm = await guard.confirmWrite('marketing', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'marketing.products.add',
      endpointKey: 'actions.productsDeactivate',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, false);
    assert.equal(confirm.error.code, 'MARKETING_WRITE_ENDPOINT_MISMATCH');
    assert.equal(scheduler.calls.some((item) => item.action === 'marketing.products.add'), false);
  } finally {
    db.close();
  }
});
