import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createProductsService } from '../src/domain/products/productsService.js';
import { createOzonClient } from '../src/ozon/ozonClient.js';
import { createOzonScheduler } from '../src/ozon/ozonScheduler.js';
import { createWriteGuardService } from '../src/security/writeGuardService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function createGuardWithRealScheduler(db, { allowRealWrite = false, transport } = {}) {
  const shopRepository = createShopRepository(db);
  const ozonClient = createOzonClient({
    baseUrl: 'https://example.invalid',
    transport: transport || (async () => {
      throw new Error('transport should not be called');
    }),
  });
  const scheduler = createOzonScheduler({
    db,
    shopRepository,
    ozonClient,
    allowRealWrite,
    queueOptions: { concurrency: 1 },
  });
  const productsService = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner() {},
  });
  const guard = createWriteGuardService(db, {
    executors: {
      products: (context) => productsService.executeConfirmedWrite(context),
    },
  });
  return { guard, shopRepository };
}

test('product confirm without double real-write keys remains dry-run and does not call transport', async () => {
  const db = createMigratedTestDb();
  try {
    const calls = [];
    const { guard, shopRepository } = createGuardWithRealScheduler(db, {
      allowRealWrite: true,
      transport: async (...args) => {
        calls.push(args);
        return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const shopId = saveUnitShop(shopRepository, 'shop_real_write_dryrun');
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices: [{ offer_id: 'offer-1', price: '11.00' }] },
      after: { price: '11.00' },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updatePrice',
      dryRun: false,
      // realWrite intentionally omitted: one key is not enough.
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.schedulerResult.status, 'dry_run');
    assert.equal(calls.length, 0);
  } finally {
    db.close();
  }
});

test('product real write is blocked when local-api real-write switch is disabled', async () => {
  const db = createMigratedTestDb();
  try {
    const calls = [];
    const { guard, shopRepository } = createGuardWithRealScheduler(db, {
      allowRealWrite: false,
      transport: async (...args) => {
        calls.push(args);
        return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const shopId = saveUnitShop(shopRepository, 'shop_real_write_disabled');
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: { stocks: [{ offer_id: 'offer-1', stock: 7 }] },
      after: { stock: 7 },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updateStock',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, false);
    assert.equal(confirm.error.code, 'REAL_OZON_WRITE_DISABLED');
    assert.equal(calls.length, 0);
  } finally {
    db.close();
  }
});

test('product real write calls Ozon write transport only after switch and double keys', async () => {
  const db = createMigratedTestDb();
  try {
    const calls = [];
    const { guard, shopRepository } = createGuardWithRealScheduler(db, {
      allowRealWrite: true,
      transport: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ result: [{ offer_id: 'offer-1', price: '12.00' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const shopId = saveUnitShop(shopRepository, 'shop_real_write_enabled');
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices: [{ offer_id: 'offer-1', price: '12.00' }] },
      after: { price: '12.00' },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.updatePrice',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.schedulerResult.status, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.invalid/v1/product/import/prices');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Client-Id'], `client-${shopId}`);
    assert.equal(calls[0].options.headers['Api-Key'], `key-${shopId}`);
    assert.match(calls[0].options.body, /offer-1/);
  } finally {
    db.close();
  }
});

test('product real write keeps Ozon 400 response detail for unarchive failures', async () => {
  const db = createMigratedTestDb();
  try {
    const calls = [];
    const { guard, shopRepository } = createGuardWithRealScheduler(db, {
      allowRealWrite: true,
      transport: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ code: 11, message: 'restore limit exceeded' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const shopId = saveUnitShop(shopRepository, 'shop_real_write_ozon_400_detail');
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.unarchive',
      endpointKey: 'products.unarchive',
      payload: { product_id: [4392383960] },
      after: { product_id: [4392383960], visibility: 'TO_SUPPLY' },
    });
    const confirm = await guard.confirmWrite('products', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'product.unarchive',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.invalid/v1/product/unarchive');
    assert.deepEqual(JSON.parse(calls[0].options.body), { product_id: [4392383960] });
    assert.equal(confirm.error.code, 'OZON_HTTP_ERROR');
    assert.equal(confirm.error.status, 400);
    assert.match(confirm.error.message, /restore limit exceeded/);
    assert.deepEqual(confirm.error.response, { code: 11, message: 'restore limit exceeded' });

    const jobId = confirm.schedulerResult.jobId;
    const job = db.prepare('SELECT last_error FROM ozon_request_jobs WHERE id = ?').get(jobId);
    assert.match(job.last_error, /restore limit exceeded/);
    const attempt = db.prepare('SELECT error_message, status_code FROM ozon_request_attempts WHERE job_id = ?').get(jobId);
    assert.equal(attempt.status_code, 400);
    assert.match(attempt.error_message, /restore limit exceeded/);
  } finally {
    db.close();
  }
});

test('product stock write treats Ozon item errors in HTTP 200 response as real failure', async () => {
  const db = createMigratedTestDb();
  try {
    const calls = [];
    const { guard, shopRepository } = createGuardWithRealScheduler(db, {
      allowRealWrite: true,
      transport: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({
          result: [
            {
              warehouse_id: 1020005020379050,
              product_id: 4393519072,
              offer_id: 'offer-archived',
              updated: false,
              errors: [
                {
                  code: 'PRODUCT_IS_ARCHIVED',
                  message: "Can't set positive stock to archived product",
                },
              ],
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const shopId = saveUnitShop(shopRepository, 'shop_real_write_stock_business_error');
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: {
        stocks: [
          {
            offer_id: 'offer-archived',
            product_id: 4393519072,
            stock: 20,
            warehouse_id: 1020005020379050,
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
      realWrite: true,
      dryRun: false,
    });

    assert.equal(calls.length, 1);
    assert.equal(confirm.ok, false);
    assert.equal(confirm.writeStatus, 'write_failed');
    assert.equal(confirm.error.code, 'OZON_WRITE_APPLICATION_ERROR');
    assert.match(confirm.error.message, /PRODUCT_IS_ARCHIVED|archived product|Ozon 已拒绝写入/u);
    assert.equal(confirm.schedulerResult.status, 'failed');
    assert.equal(confirm.stockWriteAudit.writeStatus, 'failed');
    assert.equal(confirm.stockWriteAudit.ozonResponse.result[0].updated, false);
    assert.equal(confirm.stockWriteAudit.submittedRows[0].submitted_qty, 20);
    assert.equal(confirm.stockWriteAudit.submittedRows[0].warehouse_id, '1020005020379050');

    const job = db.prepare('SELECT status, failed_count, last_error FROM ozon_request_jobs WHERE id = ?').get(confirm.schedulerResult.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.failed_count, 1);
    assert.match(job.last_error, /PRODUCT_IS_ARCHIVED|archived product|Ozon 已拒绝写入/u);

    const attempt = db.prepare('SELECT status, error_message FROM ozon_request_attempts WHERE job_id = ?').get(confirm.schedulerResult.jobId);
    assert.equal(attempt.status, 'failed');
    const auditRow = db
      .prepare(
        "SELECT status, audit_payload_json FROM ozon_write_audit_log WHERE action = 'product.updateStock' AND status = 'failed' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    assert.equal(auditRow.status, 'failed');
    const auditPayload = JSON.parse(auditRow.audit_payload_json);
    assert.equal(auditPayload.result.stockWriteAudit.writeStatus, 'failed');
    assert.equal(auditPayload.result.stockWriteAudit.ozonResponse.result[0].updated, false);
    assert.equal(auditPayload.result.stockWriteAudit.submittedRows[0].product_id, '4393519072');
    assert.match(attempt.error_message, /PRODUCT_IS_ARCHIVED|archived product|Ozon 已拒绝写入/u);
  } finally {
    db.close();
  }
});

test('async product stock write marks background job failed when Ozon item response has errors', async () => {
  const db = createMigratedTestDb();
  try {
    const { guard, shopRepository } = createGuardWithRealScheduler(db, {
      allowRealWrite: true,
      transport: async () =>
        new Response(JSON.stringify({
          result: [
            {
              warehouse_id: 1020005020379050,
              product_id: 4393519072,
              offer_id: 'offer-archived',
              updated: false,
              errors: [{ code: 'PRODUCT_IS_ARCHIVED', message: "Can't set positive stock to archived product" }],
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const shopId = saveUnitShop(shopRepository, 'shop_real_write_stock_async_business_error');
    const preview = guard.previewWrite('products', {
      shopId,
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: {
        stocks: [
          {
            offer_id: 'offer-archived',
            product_id: 4393519072,
            stock: 20,
            warehouse_id: 1020005020379050,
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
      realWrite: true,
      dryRun: false,
      fastAck: true,
      asyncWrite: true,
      waitForResult: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    const jobId = confirm.schedulerResult.jobId;

    let job = null;
    for (let index = 0; index < 20; index += 1) {
      job = db.prepare('SELECT status, failed_count, last_error FROM ozon_request_jobs WHERE id = ?').get(jobId);
      if (job?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(job.status, 'failed');
    assert.equal(job.failed_count, 1);
    assert.match(job.last_error, /PRODUCT_IS_ARCHIVED|archived product|Ozon 已拒绝写入/u);
    let auditPayload = null;
    for (let index = 0; index < 20; index += 1) {
      const row = db
        .prepare(
          "SELECT audit_payload_json FROM ozon_write_audit_log WHERE action = 'product.updateStock' AND status = 'failed' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      if (row) {
        auditPayload = JSON.parse(row.audit_payload_json);
        if (auditPayload.result?.stockWriteAudit?.writeStatus === 'failed') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(auditPayload.result.writeStatus, 'write_failed');
    assert.equal(auditPayload.result.stockWriteAudit.writeStatus, 'failed');
    assert.equal(auditPayload.result.stockWriteAudit.ozonResponse.result[0].updated, false);
    assert.equal(auditPayload.result.stockWriteAudit.submittedRows[0].warehouse_id, '1020005020379050');
  } finally {
    db.close();
  }
});
