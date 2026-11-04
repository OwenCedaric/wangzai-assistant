import assert from 'node:assert/strict';
import test from 'node:test';
import { createCacheMergeService } from '../src/cache/cacheMergeService.js';
import { createProductRepository } from '../src/db/repositories/productRepository.js';
import { createProductsService } from '../src/domain/products/productsService.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createWriteGuardService } from '../src/security/writeGuardService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function createFakeWriteScheduler({
  ok = true,
  readBackRows = [],
  readBackEndpointRows = null,
  error = null,
  data = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async executeWrite(input) {
      calls.push(input);
      if (!ok) {
        return {
          ok: false,
          status: 'failed',
          error: error || { code: 'FAKE_WRITE_FAILED', message: 'fake write failed' },
        };
      }
      return {
        ok: true,
        status: 'success',
        jobId: `fake-write-${calls.length}`,
        readBackRows,
        readBackEndpointRows,
        data,
      };
    },
  };
}

function createFakeWriteSchedulerWithReadback({ writeReadBackRows = [], readOnlyResults = [] } = {}) {
  const calls = [];
  const readOnlyCalls = [];
  return {
    calls,
    readOnlyCalls,
    async executeWrite(input) {
      calls.push(input);
      return {
        ok: true,
        status: 'success',
        jobId: `fake-write-${calls.length}`,
        realWrite: true,
        dryRun: false,
        readBackRows: writeReadBackRows,
        data: { result: [{ updated: true }] },
      };
    },
    async executeReadOnly(input) {
      readOnlyCalls.push(input);
      const next = readOnlyResults.shift() || {};
      return {
        ok: next.ok !== false,
        status: next.status || 'success',
        data: next.data || { items: next.rows || [] },
      };
    },
  };
}

function createAsyncSettledWriteScheduler({ settledResult } = {}) {
  const calls = [];
  return {
    calls,
    async executeWrite(input) {
      calls.push(input);
      setTimeout(() => {
        input.onAsyncWriteSettled?.(settledResult);
      }, 0);
      return {
        ok: true,
        accepted: true,
        pending: true,
        status: 'accepted',
        jobId: 'fake-async-write-1',
        realWrite: true,
        dryRun: false,
      };
    },
  };
}

function createGuardWithProductsExecutor(db, scheduler) {
  const shopRepository = createShopRepository(db);
  const productsService = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner() {},
  });
  return createWriteGuardService(db, {
    executors: {
      products: (context) => productsService.executeConfirmedWrite(context),
    },
  });
}

test('product write preview only records diff and does not execute Ozon write before confirm', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_preview');
    const scheduler = createFakeWriteScheduler();
    const guard = createGuardWithProductsExecutor(db, scheduler);

    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { product_id: '101', price: '88.00' },
      after: { price: '88.00' },
      idempotencyKey: 'preview-only-1',
    });

    assert.equal(preview.ok, true);
    assert.equal(preview.requiresConfirmation, true);
    assert.equal(scheduler.calls.length, 0);
  } finally {
    db.close();
  }
});

test('product write confirm requires previewId and confirm=true', async () => {
  const db = createMigratedTestDb();
  try {
    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler());
    const missing = await guard.confirmWrite('products', { confirm: true });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'WRITE_CONFIRMATION_REQUIRED');
  } finally {
    db.close();
  }
});

test('product write action cannot be rewritten to another endpoint after allowlist removal', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_endpoint_mismatch');
    const scheduler = createFakeWriteScheduler();
    const guard = createGuardWithProductsExecutor(db, scheduler);

    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.archive',
      payload: { product_id: [101] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.archive',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, false);
    assert.equal(confirm.error.code, 'PRODUCT_WRITE_ENDPOINT_MISMATCH');
    assert.equal(scheduler.calls.length, 0);
  } finally {
    db.close();
  }
});

test('product write fake confirm enters scheduler and merges read-back rows into SQLite', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_success');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 101, offer_id: 'offer-101', name: 'old title', visibility: 'IN_SALE' }],
    });

    const scheduler = createFakeWriteScheduler({
      readBackRows: [{ id: 101, offer_id: 'offer-101', name: 'new title', primary_image: 'https://img.example/new.jpg' }],
    });
    const guard = createGuardWithProductsExecutor(db, scheduler);
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateInfo',
      endpointKey: 'products.import',
      payload: { product_id: 101, name: 'new title' },
      after: { name: 'new title' },
      idempotencyKey: 'write-success-1',
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateInfo',
      idempotencyKey: 'write-success-1',
    });

    assert.equal(confirm.ok, true);
    assert.equal(scheduler.calls.length, 1);
    assert.equal(scheduler.calls[0].priority, 'WRITE');
    assert.equal(scheduler.calls[0].endpointKey, 'products.import');
    const page = repository.listProducts({ shopId, productIds: ['101'], pageSize: 20 });
    assert.equal(page.rows[0].name, 'new title');
    assert.equal(page.rows[0].primaryImageUrl, 'https://img.example/new.jpg');
  } finally {
    db.close();
  }
});

test('product write fast ack returns job id without waiting for read-back merge', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_fast_ack');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'ARCHIVED',
      rows: [{ product_id: 151, offer_id: 'offer-151', name: 'fast old', visibility: 'ARCHIVED' }],
    });
    const calls = [];
    const scheduler = {
      calls,
      async executeWrite(input) {
        calls.push(input);
        return {
          ok: true,
          accepted: true,
          pending: true,
          status: 'accepted',
          jobId: 'fast-write-job-1',
          job: { jobId: 'fast-write-job-1', status: 'running' },
          realWrite: true,
          dryRun: false,
        };
      },
    };
    const guard = createGuardWithProductsExecutor(db, scheduler);
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.unarchive',
      endpointKey: 'products.unarchive',
      payload: {
        product_id: [151],
        visibility: 'TO_SUPPLY',
        statusLabel: 'TO_SUPPLY',
        readBackRows: [{ id: 151, visibility: 'TO_SUPPLY' }],
      },
      after: { product_id: [151], visibility: 'TO_SUPPLY' },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.unarchive',
      realWrite: true,
      dryRun: false,
      fastAck: true,
      asyncWrite: true,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.accepted, true);
    assert.equal(confirm.pending, true);
    assert.equal(confirm.schedulerResult.jobId, 'fast-write-job-1');
    assert.equal(scheduler.calls[0].waitForResult, false);
    assert.equal(scheduler.calls[0].fastAck, true);
    assert.deepEqual(scheduler.calls[0].params, { product_id: [151] });
    const page = repository.listProducts({ shopId, productIds: ['151'], pageSize: 20 });
    assert.equal(page.rows[0].statusLabel, '已下架');
  } finally {
    db.close();
  }
});

test('product archive and unarchive require clean product_id payload before scheduler', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_payload_guard');
    const scheduler = createFakeWriteScheduler();
    const guard = createGuardWithProductsExecutor(db, scheduler);

    const missingPreview = guard.previewWrite('products', {
      shopId,
      action: 'product.archive',
      endpointKey: 'products.archive',
      payload: { visibility: 'ARCHIVED' },
      after: { visibility: 'ARCHIVED' },
    });
    const missing = await guard.confirmWrite('products', {
      previewId: missingPreview.previewId,
      confirm: true,
      shopId,
      action: 'product.archive',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'PRODUCT_WRITE_PRODUCT_ID_REQUIRED');
    assert.equal(scheduler.calls.length, 0);

    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.archive',
      endpointKey: 'products.archive',
      payload: { product_id: ['151', 151, '152'], visibility: 'ARCHIVED', statusLabel: 'TO_SUPPLY' },
      after: { product_id: ['151', '152'], visibility: 'ARCHIVED' },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.archive',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(scheduler.calls.length, 1);
    assert.deepEqual(scheduler.calls[0].params, { product_id: [151, 152] });
  } finally {
    db.close();
  }
});

test('product write previews support exact release and expire without accumulating memory', async () => {
  const db = createMigratedTestDb();
  let clock = Date.parse('2026-08-08T00:00:00.000Z');
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_preview_lifecycle');
    const guard = createWriteGuardService(db, {
      previewTtlMs: 1_000,
      now: () => clock,
    });
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateInfo',
      after: { items: [{ offer_id: 'sku-1' }] },
      idempotencyKey: 'preview-lifecycle-chunk-1',
    });
    const retriedPreview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateInfo',
      after: { items: [{ offer_id: 'sku-1' }] },
      idempotencyKey: 'preview-lifecycle-chunk-1',
    });
    assert.equal(retriedPreview.previewId, preview.previewId);
    assert.equal(retriedPreview.reused, true);
    assert.equal(guard.countOwnerPreviews(shopId), 1);

    const wrongOwner = guard.releasePreview('products', {
      previewId: preview.previewId,
      shopId: 'shop-other',
    });
    assert.equal(wrongOwner.ok, false);
    assert.equal(wrongOwner.error.code, 'WRITE_PREVIEW_OWNER_MISMATCH');
    assert.equal(guard.countOwnerPreviews(shopId), 1);

    const released = guard.releasePreview('products', {
      previewId: preview.previewId,
      shopId,
    });
    assert.equal(released.released, true);
    assert.equal(guard.countOwnerPreviews(shopId), 0);

    const expiring = guard.previewWrite('products', {
      shopId,
      action: 'product.updatePrice',
      after: { prices: [{ offer_id: 'sku-1', price: '100' }] },
    });
    clock += 1_001;
    const expired = await guard.confirmWrite('products', {
      previewId: expiring.previewId,
      confirm: true,
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.error.code, 'WRITE_PREVIEW_EXPIRED');
    assert.equal(guard.countOwnerPreviews(shopId), 0);
  } finally {
    db.close();
  }
});

test('product archive merges only Ozon readback status before showing archived', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_archive_readback');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 601, offer_id: 'offer-601', name: 'archive me', visibility: 'IN_SALE' }],
    });
    const guard = createGuardWithProductsExecutor(
      db,
      createFakeWriteScheduler({
        readBackRows: [{ product_id: 601, offer_id: 'offer-601', archived: true }],
      }),
    );
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.archive',
      endpointKey: 'products.archive',
      payload: { product_id: [601] },
      after: { product_id: [601] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.archive',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'readback_merged');
    assert.equal(confirm.readBack.status, 'merged');
    const row = repository.listProducts({ shopId, productIds: ['601'], pageSize: 20 }).rows[0];
    assert.equal(row.visibility, 'ARCHIVED');
    assert.equal(row.statusLabel, '已下架');
  } finally {
    db.close();
  }
});

test('product archive accepted without readback remains submitted waiting readback', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_archive_pending');
    const guard = createGuardWithProductsExecutor(db, {
      async executeWrite() {
        return {
          ok: true,
          accepted: true,
          pending: true,
          status: 'accepted',
          jobId: 'archive-pending-1',
          realWrite: true,
          dryRun: false,
        };
      },
    });
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.archive',
      endpointKey: 'products.archive',
      payload: { product_id: [602] },
      after: { product_id: [602] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.archive',
      realWrite: true,
      dryRun: false,
      fastAck: true,
      asyncWrite: true,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
  } finally {
    db.close();
  }
});

test('product unarchive uses Ozon readback status and never forces in-sale', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_unarchive_readback');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'ARCHIVED',
      rows: [{ product_id: 603, offer_id: 'offer-603', name: 'unarchive me', visibility: 'ARCHIVED', archived: true }],
    });
    const guard = createGuardWithProductsExecutor(
      db,
      createFakeWriteScheduler({
        readBackRows: [{ product_id: 603, offer_id: 'offer-603', visibility: 'TO_SUPPLY' }],
      }),
    );
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.unarchive',
      endpointKey: 'products.unarchive',
      payload: { product_id: [603] },
      after: { product_id: [603] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.unarchive',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'readback_merged');
    const row = repository.listProducts({ shopId, productIds: ['603'], pageSize: 20 }).rows[0];
    assert.equal(row.visibility, 'TO_SUPPLY');
    assert.equal(row.statusLabel, '待销售');
  } finally {
    db.close();
  }
});

test('product price write does not treat ack rows as readback and merges Ozon prices result', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_price_readback');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 604, offer_id: 'offer-604', name: 'price readback', visibility: 'IN_SALE' }],
    });
    const scheduler = createFakeWriteSchedulerWithReadback({
      writeReadBackRows: [{ product_id: 604, offer_id: 'offer-604', updated: true }],
      readOnlyResults: [
        {
          rows: [
            {
              product_id: 604,
              offer_id: 'offer-604',
              price: {
                price: '68',
                marketing_seller_price: '68',
                marketing_price: '34.6',
                currency_code: 'CNY',
              },
            },
          ],
        },
      ],
    });
    const guard = createGuardWithProductsExecutor(db, scheduler);
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices: [{ product_id: 604, offer_id: 'offer-604', price: '68' }] },
      after: { prices: [{ product_id: 604, offer_id: 'offer-604', price: '68' }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'readback_merged');
    assert.equal(scheduler.readOnlyCalls.length, 1);
    assert.equal(scheduler.readOnlyCalls[0].endpointKey, 'products.prices');
    const row = repository.listProducts({ shopId, productIds: ['604'], pageSize: 20 }).rows[0];
    assert.equal(row.priceValue, 34.6);
  } finally {
    db.close();
  }
});

test('product write fake failure preserves existing product cache', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_failed');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 201, offer_id: 'offer-201', name: 'keep title', visibility: 'IN_SALE', primary_image: 'https://img.example/keep.jpg' }],
    });

    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler({ ok: false }));
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateInfo',
      endpointKey: 'products.import',
      payload: { product_id: 201, name: 'bad title' },
      after: { name: 'bad title' },
    });
    const confirm = await guard.confirmWrite('products', { previewId: preview.previewId, confirm: true, shopId });

    assert.equal(confirm.ok, false);
    const page = repository.listProducts({ shopId, productIds: ['201'], pageSize: 20 });
    assert.equal(page.rows[0].name, 'keep title');
    assert.equal(page.rows[0].primaryImageUrl, 'https://img.example/keep.jpg');
  } finally {
    db.close();
  }
});

test('product write keeps submitted status when Ozon result has no readback rows', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_wait_readback');
    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler({ readBackRows: [] }));
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: { stocks: [{ product_id: 251, warehouse_id: 1, stock: 2 }] },
      after: { stocks: [{ product_id: 251, warehouse_id: 1, stock: 2 }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    assert.match(confirm.message, /仅显示处理中|等待回读确认/u);
    assert.doesNotMatch(confirm.message, /写入完成/u);
  } finally {
    db.close();
  }
});

test('product stock write updates SQLite only after Ozon stock readback rows are merged', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_stock_readback_merge');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 252, offer_id: 'offer-252', name: 'stock merge', visibility: 'IN_SALE', stocks: { present: 1 } }],
    });
    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler({
      readBackRows: [
        {
          product_id: 252,
          offer_id: 'offer-252',
          stocks: [{ type: 'FBS', present: 9 }],
        },
        {
          product_id: 252,
          offer_id: 'offer-252',
          warehouse_id: 1,
          present: 9,
          free_stock: 9,
        },
      ],
      readBackEndpointRows: {
        'products.stocks': {
          rows: [{
            product_id: 252,
            offer_id: 'offer-252',
            stocks: [{ type: 'FBS', present: 9 }],
          }],
        },
        'products.stocksByWarehouseFbs': {
          rows: [{
            product_id: 252,
            offer_id: 'offer-252',
            warehouse_id: 1,
            present: 9,
            free_stock: 9,
          }],
          pagination: { explicitComplete: true },
        },
      },
    }));
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: { stocks: [{ product_id: 252, offer_id: 'offer-252', warehouse_id: 1, stock: 9 }] },
      after: { stocks: [{ product_id: 252, offer_id: 'offer-252', warehouse_id: 1, stock: 9 }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'readback_merged');
    assert.equal(confirm.readBack.status, 'merged');
    const row = repository.listProducts({ shopId, productIds: ['252'], pageSize: 20 }).rows[0];
    assert.equal(row.stockValue, 9);
    assert.equal(row.sellerWarehouseStockTotal, 9);
  } finally {
    db.close();
  }
});

test('warehouse write never trusts or merges inline stock rows without explicit v2 endpoint provenance', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      'shop_product_write_inline_stock_untrusted',
    );
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{
        product_id: 258,
        offer_id: 'offer-258',
        name: 'inline stock untrusted',
        visibility: 'IN_SALE',
        stocks: { present: 1 },
      }],
    });
    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler({
      readBackRows: [{
        product_id: 258,
        offer_id: 'offer-258',
        warehouse_id: 3001,
        present: 9,
        free_stock: 9,
      }],
    }));
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: {
        stocks: [{
          product_id: 258,
          offer_id: 'offer-258',
          warehouse_id: 3001,
          stock: 9,
        }],
      },
      after: { stock: 9 },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    assert.equal(
      confirm.readBack.verification.reason,
      'warehouse_stock_readback_pending',
    );
    assert.equal(
      confirm.readBack.merge.reason,
      'stock_readback_endpoint_provenance_missing',
    );
    const product = repository.listProducts({
      shopId,
      productIds: ['258'],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.stockValue, 1);
    assert.equal(product.sellerWarehouseStockTotal, null);
  } finally {
    db.close();
  }
});

test('scheduler stock readback keeps v4 total and v2 warehouse rows in separate projections', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      'shop_product_write_stock_separate_readback',
    );
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{
        product_id: 255,
        offer_id: 'offer-255',
        sku: 'sku-255',
        name: 'separate stock readback',
        visibility: 'IN_SALE',
      }],
    });
    const scheduler = createFakeWriteSchedulerWithReadback({
      writeReadBackRows: [],
      readOnlyResults: [
        {
          rows: [{
            product_id: 255,
            offer_id: 'offer-255',
            stocks: [
              { type: 'FBO', present: 4 },
              { type: 'FBS', present: 6 },
            ],
          }],
        },
        {
          data: {
            products: [
              {
                product_id: 255,
                offer_id: 'offer-255',
                sku: 'sku-255',
                warehouse_id: 1001,
                warehouse_name: '仓库一',
                present: 2,
                free_stock: 2,
              },
              {
                product_id: 255,
                offer_id: 'offer-255',
                sku: 'sku-255',
                warehouse_id: 1002,
                warehouse_name: '仓库二',
                present: 4,
                free_stock: 4,
              },
            ],
            has_next: false,
            cursor: '',
          },
        },
      ],
    });
    const guard = createGuardWithProductsExecutor(db, scheduler);
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: {
        stocks: [{
          product_id: 255,
          offer_id: 'offer-255',
          warehouse_id: 1002,
          stock: 4,
        }],
      },
      after: { stock: 4 },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'readback_merged');
    assert.equal(confirm.readBack.verification.ok, true);
    assert.equal(scheduler.readOnlyCalls.length, 2);
    const product = repository.listProducts({
      shopId,
      productIds: ['255'],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.stockValue, 10);
    assert.equal(product.stockJson.present, 10);
    assert.equal(product.sellerWarehouseStockTotal, 6);
    assert.equal(product.warehouseStockCount, 2);
    assert.equal(product.facetObservations.stocks.endpointKey, 'products.stocks');
    assert.equal(
      product.facetObservations.warehouse_stocks.endpointKey,
      'products.stocksByWarehouseFbs',
    );
    assert.equal(confirm.stockWriteAudit.finalRows[0].stock_value, 10);
    assert.equal(
      confirm.stockWriteAudit.finalRows[0].seller_warehouse_stock_total,
      6,
    );
    assert.equal(
      confirm.stockWriteAudit.finalRows[0].warehouse_stock_complete,
      true,
    );
    assert.deepEqual(
      confirm.stockWriteAudit.finalRows[0].warehouse_stocks.map((stock) => [
        stock.warehouse_id,
        stock.present,
      ]),
      [["1001", 2], ["1002", 4]],
    );
  } finally {
    db.close();
  }
});

test('warehouse-specific stock write stays pending when v2 readback is partial and retains old warehouse facts', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      'shop_product_write_warehouse_partial_readback',
    );
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{
        product_id: 256,
        offer_id: 'offer-256',
        sku: 'sku-256',
        name: 'partial warehouse readback',
        visibility: 'IN_SALE',
      }],
    });
    repository.mergeProductWarehouseStockRows({
      shopId,
      rows: [
        {
          product_id: 256,
          offer_id: 'offer-256',
          sku: 'sku-256',
          warehouse_id: 1001,
          warehouse_name: '仓库一',
          present: 2,
          free_stock: 2,
        },
        {
          product_id: 256,
          offer_id: 'offer-256',
          sku: 'sku-256',
          warehouse_id: 1002,
          warehouse_name: '仓库二',
          present: 3,
          free_stock: 3,
        },
      ],
      provenance: {
        contractVersion: 'ozon-products-stocks-by-warehouse-fbs-v2',
      },
    });
    const scheduler = createFakeWriteSchedulerWithReadback({
      readOnlyResults: [
        {
          rows: [{
            product_id: 256,
            offer_id: 'offer-256',
            stocks: [
              { type: 'FBO', present: 3 },
              { type: 'FBS', present: 9 },
            ],
          }],
        },
        {
          status: 'partial',
          data: {
            products: [{
              product_id: 256,
              offer_id: 'offer-256',
              warehouse_id: 1002,
              present: 9,
              free_stock: 9,
            }],
            has_next: false,
            cursor: '',
          },
        },
      ],
    });
    const guard = createGuardWithProductsExecutor(db, scheduler);
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: {
        stocks: [{
          product_id: 256,
          offer_id: 'offer-256',
          warehouse_id: 1002,
          stock: 9,
        }],
      },
      after: { stock: 9 },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    assert.equal(confirm.readBack.verification.reason, 'warehouse_stock_readback_pending');
    assert.equal(confirm.readBack.errors[0].endpointKey, 'products.stocksByWarehouseFbs');
    assert.equal(
      confirm.readBack.errors[0].code,
      'PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE',
    );
    const product = repository.listProducts({
      shopId,
      productIds: ['256'],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.stockValue, 12);
    assert.equal(product.sellerWarehouseStockTotal, 5);
    assert.equal(product.warehouseStockCount, 2);
    assert.equal(product.warehouseStockObservation.status, 'stale_previous');
    assert.equal(product.warehouseStockObservation.currentStatus, 'contract_invalid');
  } finally {
    db.close();
  }
});

test('complete empty v2 stock readback retains old warehouse facts and records not-returned evidence', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      'shop_product_write_warehouse_empty_readback',
    );
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{
        product_id: 257,
        offer_id: 'offer-257',
        sku: 'sku-257',
        name: 'empty warehouse readback',
        visibility: 'IN_SALE',
      }],
    });
    repository.mergeProductWarehouseStockRows({
      shopId,
      rows: [{
        product_id: 257,
        offer_id: 'offer-257',
        sku: 'sku-257',
        warehouse_id: 2001,
        warehouse_name: '原仓库',
        present: 4,
        free_stock: 4,
      }],
      provenance: {
        contractVersion: 'ozon-products-stocks-by-warehouse-fbs-v2',
      },
    });
    const scheduler = createFakeWriteSchedulerWithReadback({
      readOnlyResults: [
        {
          rows: [{
            product_id: 257,
            offer_id: 'offer-257',
            stocks: [{ type: 'FBS', present: 0 }],
          }],
        },
        {
          data: { products: [], has_next: false, cursor: '' },
        },
      ],
    });
    const guard = createGuardWithProductsExecutor(db, scheduler);
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: {
        stocks: [{
          product_id: 257,
          offer_id: 'offer-257',
          warehouse_id: 2001,
          stock: 0,
        }],
      },
      after: { stock: 0 },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    const product = repository.listProducts({
      shopId,
      productIds: ['257'],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.stockValue, 0);
    assert.equal(product.sellerWarehouseStockTotal, 4);
    assert.equal(product.warehouseStockCount, 1);
    assert.equal(product.warehouseStockObservation.status, 'stale_previous');
    assert.equal(product.warehouseStockObservation.currentStatus, 'not_returned');
  } finally {
    db.close();
  }
});

test('product stock write audit records Ozon response readback merge and final stock evidence', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_stock_audit_final');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 4392243976, offer_id: 'mz-26050109-135366', name: 'stock audit', visibility: 'IN_SALE' }],
    });
    const ozonResponse = {
      result: [
        {
          product_id: 4392243976,
          offer_id: 'mz-26050109-135366',
          warehouse_id: 1020005020379050,
          updated: true,
        },
      ],
    };
    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler({
      data: ozonResponse,
      readBackRows: [
        {
          product_id: 4392243976,
          offer_id: 'mz-26050109-135366',
          stocks: [
            { warehouse_id: 1020005014175280, present: 0 },
            { warehouse_id: 1020005020379050, present: 20 },
          ],
        },
      ],
      readBackEndpointRows: {
        'products.stocks': {
          rows: [{
            product_id: 4392243976,
            offer_id: 'mz-26050109-135366',
            stocks: [{ type: 'FBS', present: 20 }],
          }],
        },
        'products.stocksByWarehouseFbs': {
          rows: [
            {
              product_id: 4392243976,
              offer_id: 'mz-26050109-135366',
              warehouse_id: 1020005014175280,
              present: 0,
              free_stock: 0,
            },
            {
              product_id: 4392243976,
              offer_id: 'mz-26050109-135366',
              warehouse_id: 1020005020379050,
              present: 20,
              free_stock: 20,
            },
          ],
          pagination: { explicitComplete: true },
        },
      },
    }));
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: {
        stocks: [
          {
            product_id: 4392243976,
            offer_id: 'mz-26050109-135366',
            warehouse_id: 1020005020379050,
            stock: 20,
          },
        ],
      },
      after: { stock: 20 },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'readback_merged');
    assert.equal(confirm.stockWriteAudit.writeStatus, 'readback_merged');
    assert.deepEqual(confirm.stockWriteAudit.ozonResponse, ozonResponse);
    assert.equal(confirm.stockWriteAudit.readBack.status, 'merged');
    assert.equal(confirm.stockWriteAudit.readBack.rows.length, 2);
    assert.equal(confirm.stockWriteAudit.sqliteMerge.changed, 2);
    assert.equal(confirm.stockWriteAudit.finalRows[0].stock_value, 20);
    assert.equal(confirm.stockWriteAudit.finalRows[0].stock_json.present, 20);
    assert.equal(confirm.stockWriteAudit.finalRows[0].seller_warehouse_stock_total, 20);
    assert.equal(confirm.stockWriteAudit.finalRows[0].warehouse_stocks.length, 2);
    assert.equal(confirm.stockWriteAudit.submittedRows[0].submitted_qty, 20);
    assert.equal(confirm.stockWriteAudit.readBack.rows[1].readback_qty, 20);

    const auditRow = db
      .prepare(
        "SELECT status, audit_payload_json FROM ozon_write_audit_log WHERE action = 'product.updateStock' AND status = 'executed' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    assert.equal(auditRow.status, 'executed');
    const auditPayload = JSON.parse(auditRow.audit_payload_json);
    assert.equal(auditPayload.result.stockWriteAudit.writeStatus, 'readback_merged');
    assert.equal(auditPayload.result.stockWriteAudit.readBack.status, 'merged');
    assert.equal(auditPayload.result.stockWriteAudit.finalRows[0].stock_value, 20);
    assert.equal(auditPayload.result.stockWriteAudit.finalRows[0].stock_json.present, 20);
    assert.equal(auditPayload.result.stockWriteAudit.submittedRows[0].warehouse_id, '1020005020379050');
    assert.equal(auditPayload.result.stockWriteAudit.readBack.rows[1].warehouse_id, '1020005020379050');
  } finally {
    db.close();
  }
});

test('async product stock fast ack appends final audit after background readback merge', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_async_stock_audit_final');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 254, offer_id: 'offer-254', name: 'async stock audit', visibility: 'IN_SALE' }],
    });
    const ozonResponse = { result: [{ product_id: 254, offer_id: 'offer-254', warehouse_id: 1, updated: true }] };
    const scheduler = createAsyncSettledWriteScheduler({
      settledResult: {
        ok: true,
        status: 'success',
        jobId: 'fake-async-write-1',
        realWrite: true,
        dryRun: false,
        data: ozonResponse,
        readBackRows: [{ product_id: 254, offer_id: 'offer-254', stocks: [{ warehouse_id: 1, present: 20 }] }],
        readBackEndpointRows: {
          'products.stocks': {
            rows: [{
              product_id: 254,
              offer_id: 'offer-254',
              stocks: [{ type: 'FBS', present: 20 }],
            }],
          },
          'products.stocksByWarehouseFbs': {
            rows: [{
              product_id: 254,
              offer_id: 'offer-254',
              warehouse_id: 1,
              present: 20,
              free_stock: 20,
            }],
            pagination: { explicitComplete: true },
          },
        },
      },
    });
    const guard = createGuardWithProductsExecutor(db, scheduler);
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: { stocks: [{ product_id: 254, offer_id: 'offer-254', warehouse_id: 1, stock: 20 }] },
      after: { stocks: [{ product_id: 254, offer_id: 'offer-254', warehouse_id: 1, stock: 20 }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
      fastAck: true,
      asyncWrite: true,
      waitForResult: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    assert.equal(scheduler.calls[0].waitForResult, false);

    let auditPayload = null;
    for (let index = 0; index < 20; index += 1) {
      const row = db
        .prepare(
          "SELECT audit_payload_json FROM ozon_write_audit_log WHERE action = 'product.updateStock' AND status = 'executed' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      if (row) {
        auditPayload = JSON.parse(row.audit_payload_json);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(auditPayload.result.writeStatus, 'readback_merged');
    assert.equal(auditPayload.result.readBack.status, 'merged');
    assert.equal(auditPayload.result.stockWriteAudit.writeStatus, 'readback_merged');
    assert.equal(auditPayload.result.stockWriteAudit.ozonResponse.result[0].updated, true);
    assert.equal(auditPayload.result.stockWriteAudit.finalRows[0].stock_value, 20);
    assert.equal(auditPayload.result.stockWriteAudit.finalRows[0].stock_json.present, 20);
    assert.equal(auditPayload.result.stockWriteAudit.submittedRows[0].warehouse_id, '1');
    assert.equal(auditPayload.result.stockWriteAudit.readBack.rows[0].readback_qty, 20);
    const product = repository.listProducts({ shopId, productIds: ['254'], pageSize: 20 }).rows[0];
    assert.equal(product.stockValue, 20);
  } finally {
    db.close();
  }
});

test('product stock write keeps old stock when readback lacks current stock evidence', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_stock_readback_empty');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 253, offer_id: 'offer-253', name: 'stock pending', visibility: 'IN_SALE', stocks: { present: 7 } }],
    });
    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler({
      readBackRows: [{ product_id: 253, offer_id: 'offer-253', stocks: [] }],
    }));
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: { stocks: [{ product_id: 253, offer_id: 'offer-253', warehouse_id: 1, stock: 3 }] },
      after: { stocks: [{ product_id: 253, offer_id: 'offer-253', warehouse_id: 1, stock: 3 }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    assert.equal(confirm.readBack.merge.reason, 'readback_missing_stock_evidence');
    const row = repository.listProducts({ shopId, productIds: ['253'], pageSize: 20 }).rows[0];
    assert.equal(row.stockValue, 7);
  } finally {
    db.close();
  }
});

test('product dry-run wording is explicit and never says write completed', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_dry_run_wording');
    const guard = createGuardWithProductsExecutor(db, {
      async executeWrite() {
        return {
          ok: true,
          status: 'dry_run',
          jobId: 'product-dry-run-job-1',
          dryRun: true,
          realWrite: false,
          readBackRows: [],
        };
      },
    });
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices: [{ product_id: 252, price: '12.30' }] },
      after: { prices: [{ product_id: 252, price: '12.30' }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'dry_run_recorded');
    assert.match(confirm.message, /已记录 dry-run，未写入 Ozon/u);
    assert.doesNotMatch(confirm.message, /已完成|写入完成/u);
  } finally {
    db.close();
  }
});

test('product write read-back empty values do not overwrite existing title image price or attributes', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_empty_readback');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: [{ product_id: 301, offer_id: 'offer-301', name: 'stable title', visibility: 'IN_SALE', primary_image: 'https://img.example/stable.jpg' }],
    });
    repository.mergeProductPriceRows({ shopId, rows: [{ product_id: 301, offer_id: 'offer-301', price: { marketing_seller_price: '45.67', currency_code: 'CNY' } }] });
    repository.mergeProductAttributeRows({ shopId, rows: [{ id: 301, offer_id: 'offer-301', attributes: [{ id: 1, name: 'Brand', values: [{ value: 'ACME' }] }] }] });

    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler({
      readBackRows: [{ id: 301, offer_id: 'offer-301', name: '', images: [], primary_image: '', price: null, attributes: [] }],
    }));
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateInfo',
      endpointKey: 'products.import',
      payload: { product_id: 301, name: '' },
      after: { name: '' },
    });
    const confirm = await guard.confirmWrite('products', { previewId: preview.previewId, confirm: true, shopId });

    assert.equal(confirm.ok, true);
    const row = repository.listProducts({ shopId, productIds: ['301'], pageSize: 20 }).rows[0];
    assert.equal(row.name, 'stable title');
    assert.equal(row.primaryImageUrl, 'https://img.example/stable.jpg');
    assert.equal(row.priceValue, 45.67);
    assert.equal(row.attributes[0].name, 'Brand');
  } finally {
    db.close();
  }
});

test('product write audit log redacts secrets after preview confirm and execution', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_audit');
    const guard = createGuardWithProductsExecutor(db, createFakeWriteScheduler({
      readBackRows: [{ id: 401, offer_id: 'offer-401', name: 'audit product' }],
    }));
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateInfo',
      endpointKey: 'products.import',
      payload: { product_id: 401, ['tok' + 'en']: 'opaque-token' },
      after: { name: 'audit product', ['client' + 'Id']: 'opaque-client', ['api' + 'Key']: 'opaque-key' },
    });
    await guard.confirmWrite('products', { previewId: preview.previewId, confirm: true, shopId });

    const auditText = db.prepare('SELECT GROUP_CONCAT(audit_payload_json, ?) AS payload FROM ozon_write_audit_log').get('\n').payload;
    assert.equal(auditText.includes('opaque-token'), false);
    assert.equal(auditText.includes('opaque-client'), false);
    assert.equal(auditText.includes('opaque-key'), false);
    assert.equal(auditText.includes('[REDACTED]'), true);
  } finally {
    db.close();
  }
});

test('throttled response cache cleanup prunes response_cache only and never deletes ozon_products', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_product_write_cleanup');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: 'ARCHIVED',
      rows: [{ product_id: 501, offer_id: 'offer-501', name: 'main product', visibility: 'ARCHIVED', archived: true }],
    });

    const merge = createCacheMergeService(db, {
      cleanupEveryWrites: 2,
      cleanupPolicy: {
        responseCache: {
          maxRowsPerEndpoint: 1,
          endpointMaxRows: { 'products.attributes': 1 },
          maxTotalRows: 10,
          maxTotalPayloadBytes: 1024 * 1024,
        },
      },
    });

    const first = merge.mergeResponse({
      domain: 'products',
      shopId,
      endpointKey: 'products.attributes',
      cacheKey: 'attributes:first',
      payload: { index: 1 },
      remoteHash: 'first',
    });
    assert.equal(first.cleanup.skipped, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache').get().count, 1);

    const second = merge.mergeResponse({
      domain: 'products',
      shopId,
      endpointKey: 'products.attributes',
      cacheKey: 'attributes:second',
      payload: { index: 2 },
      remoteHash: 'second',
    });
    assert.equal(second.cleanup.ok, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache').get().count, 1);
    assert.equal(repository.listProducts({ shopId, pageSize: 20 }).total, 1);
  } finally {
    db.close();
  }
});
