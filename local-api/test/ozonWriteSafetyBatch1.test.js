import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOrdersService } from '../src/domain/orders/ordersService.js';
import { createWriteGuardService } from '../src/security/writeGuardService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('real-write policy blocks only disabled switch and missing shop id; no write allowlist is required', async () => {
  const disabledDb = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(disabledDb);
    saveUnitShop(shopRepository, 'shop-any');
    let executed = false;
    const guard = createWriteGuardService(disabledDb, {
      realWritePolicy: { enabled: false },
      executors: {
        products: () => {
          executed = true;
          return { ok: true };
        },
      },
    });
    const preview = guard.previewWrite('products', {
      shopId: 'shop-any',
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices: [{ offer_id: 'offer-1', price: '12.00' }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId: 'shop-any',
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, false);
    assert.equal(confirm.error.code, 'REAL_OZON_WRITE_DISABLED');
    assert.equal(confirm.writeStatus, 'blocked_real_write_disabled');
    assert.equal(confirm.error.message, '真实写入未开启，本次不会提交 Ozon。');
    assert.equal(executed, false);
  } finally {
    disabledDb.close();
  }

  const missingShopDb = createMigratedTestDb();
  try {
    let executed = false;
    const guard = createWriteGuardService(missingShopDb, {
      realWritePolicy: { enabled: true },
      executors: {
        products: () => {
          executed = true;
          return { ok: true };
        },
      },
    });
    const preview = guard.previewWrite('products', {
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices: [{ offer_id: 'offer-1', price: '12.00' }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, false);
    assert.equal(confirm.error.code, 'REAL_OZON_WRITE_SHOP_ID_REQUIRED');
    assert.equal(confirm.writeStatus, 'blocked_shop_missing');
    assert.equal(confirm.error.message, '店铺缺少真实写入配置，本次不会提交 Ozon。');
    assert.equal(executed, false);
  } finally {
    missingShopDb.close();
  }

  const allowedDb = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(allowedDb);
    saveUnitShop(shopRepository, 'shop-not-in-any-list');
    let executed = false;
    const guard = createWriteGuardService(allowedDb, {
      realWritePolicy: {
        enabled: true,
      },
      executors: {
        products: () => {
          executed = true;
          return { ok: true, writeStatus: 'executor_ok' };
        },
      },
    });
    const preview = guard.previewWrite('products', {
      shopId: 'shop-not-in-any-list',
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices: [{ offer_id: 'offer-1', price: '12.00' }] },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId: 'shop-not-in-any-list',
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'executor_ok');
    assert.equal(executed, true);
    const rejectedAudit = allowedDb.prepare("SELECT COUNT(*) AS count FROM ozon_write_audit_log WHERE status = 'rejected'").get();
    assert.equal(rejectedAudit.count, 0);
  } finally {
    allowedDb.close();
  }
});

test('orders write executor maps action to endpoint and only marks complete after readback merge', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_write');
    const schedulerCalls = [];
    const ordersService = createOrdersService({
      db,
      ozonScheduler: {
        async executeWrite(input) {
          schedulerCalls.push(input);
          return {
            ok: true,
            status: 'success',
            jobId: 'orders-write-job-1',
            realWrite: input.realWrite === true,
            dryRun: input.dryRun === true,
            readBackRows: [
              {
                posting_number: 'posting-1',
                order_id: 'order-1',
                status: 'awaiting_deliver',
                products: [{ offer_id: 'offer-1', quantity: 1 }],
              },
            ],
            data: { result: true },
          };
        },
      },
      backgroundRunner() {},
    });
    const guard = createWriteGuardService(db, {
      executors: {
        orders: (context) => ordersService.executeConfirmedWrite(context),
      },
    });

    const preview = guard.previewWrite('orders', {
      shopId,
      action: 'shipFbsPosting',
      endpointKey: 'orders.shipFbsPosting',
      payload: { posting_number: 'posting-1', packages: [] },
      after: { posting_number: 'posting-1', status: 'awaiting_deliver' },
      idempotencyKey: 'orders-write-1',
    });
    const confirm = await guard.confirmWrite('orders', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'shipFbsPosting',
      endpointKey: 'orders.shipFbsPosting',
      realWrite: true,
      dryRun: false,
      idempotencyKey: 'orders-write-1',
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'readback_merged');
    assert.match(confirm.message, /SQLite 已合并/u);
    assert.equal(confirm.readBack.rows, 1);
    assert.equal(schedulerCalls.length, 1);
    assert.equal(schedulerCalls[0].domain, 'orders');
    assert.equal(schedulerCalls[0].endpointKey, 'orders.shipFbsPosting');
    assert.equal(schedulerCalls[0].realWrite, true);
    assert.equal(schedulerCalls[0].dryRun, false);

    const cache = ordersService.readCache({ shopId, postingNumber: 'posting-1' });
    assert.equal(cache.total, 1);
    assert.equal(cache.rows[0].posting_number, 'posting-1');
    assert.equal(cache.rows[0].status, 'awaiting_deliver');
  } finally {
    db.close();
  }
});

test('orders write executor keeps submitted status when Ozon result has no readback rows', async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_orders_wait_readback');
    const ordersService = createOrdersService({
      db,
      ozonScheduler: {
        async executeWrite(input) {
          return {
            ok: true,
            status: 'success',
            jobId: 'orders-write-job-no-readback',
            realWrite: input.realWrite === true,
            dryRun: false,
            data: { result: true },
          };
        },
      },
      backgroundRunner() {},
    });
    const guard = createWriteGuardService(db, {
      executors: {
        orders: (context) => ordersService.executeConfirmedWrite(context),
      },
    });

    const preview = guard.previewWrite('orders', {
      shopId,
      action: 'cancelFbsPosting',
      endpointKey: 'orders.cancelFbsPosting',
      payload: { posting_number: 'posting-no-readback', cancel_reason_id: 1 },
    });
    const confirm = await guard.confirmWrite('orders', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'cancelFbsPosting',
      endpointKey: 'orders.cancelFbsPosting',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    assert.match(confirm.message, /仅显示处理中/u);
    assert.doesNotMatch(confirm.message, /写入完成/u);
  } finally {
    db.close();
  }
});

test('legacy /api/ozon/request rejects write endpoints even when confirmed=true', async () => {
  const db = createMigratedTestDb();
  const server = createApp({
    db,
    config: {
      security: {},
      ozon: {
        enableRealWrite: true,
      },
    },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: {
      async requestReadOnly() {
        throw new Error('read should not be called');
      },
      async requestWrite() {
        throw new Error('legacy write must not be called');
      },
    },
  });

  try {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/ozon/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: '/v4/posting/fbs/ship',
        access: 'write',
        confirmed: true,
        realWrite: true,
        dryRun: false,
        body: { posting_number: 'posting-legacy', packages: [] },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'LEGACY_OZON_WRITE_FORBIDDEN');
    assert.match(payload.error.message, /安全门/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
