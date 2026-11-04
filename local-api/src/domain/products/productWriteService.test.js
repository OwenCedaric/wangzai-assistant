import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductWriteService } from './productWriteService.js';

function createRepository() {
  const merges = [];
  const merge = (type) => ({ rows = [] } = {}) => {
    merges.push({ type, rows });
    return { changed: rows.length, unchanged: 0, missing: 0, rows: rows.length };
  };
  return {
    merges,
    mergeProductInfoRows: merge('info'),
    mergeProductAttributeRows: merge('attributes'),
    mergeProductPriceRows: merge('prices'),
    mergeProductStockRows: merge('stocks'),
    mergeProductWarehouseStockRows: merge('warehouse-stocks'),
    upsertProducts: merge('list'),
    listProducts: () => ({ rows: [] }),
  };
}

function createInfoScheduler({
  name = 'Updated product',
  images = [],
  attributes = [{ id: 10, values: [{ value: 'Blue' }] }],
  complexAttributes = [],
  typeId = 0,
} = {}) {
  const readCalls = [];
  const writeCalls = [];
  return {
    readCalls,
    writeCalls,
    async executeWrite(input) {
      writeCalls.push(input);
      return { ok: true, status: 'success', realWrite: true, dryRun: false, jobId: 'write-1' };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: {
            items: [{
              id: 101,
              product_id: 101,
              offer_id: 'offer-101',
              sku: 900101,
              statuses: { is_created: true },
              name,
              images,
            }],
          },
        };
      }
      return {
        ok: true,
        status: 'success',
        data: {
          result: [{
            id: 101,
            product_id: 101,
            offer_id: 'offer-101',
            name,
            weight: 250,
            weight_unit: 'g',
            depth: 200,
            width: 100,
            height: 80,
            dimension_unit: 'mm',
            type_id: typeId,
            attributes,
            complex_attributes: complexAttributes,
          }],
        },
      };
    },
  };
}

function createInfoInput(options = {}) {
  const item = {
    offer_id: 'offer-101',
    name: 'Updated product',
    weight: 250,
    depth: 200,
    width: 100,
    height: 80,
    attributes: options.attributes || [{ id: 10, values: [{ value: 'Blue' }] }],
    complex_attributes: options.complexAttributes || [],
    ...(options.typeId ? { type_id: options.typeId } : {}),
    ...(options.images ? { images: options.images } : {}),
  };
  return {
    preview: {
      previewId: 'preview-1',
      action: 'product.updateInfo',
      endpointKey: 'products.import',
      payload: { items: [item] },
      diff: { before: { productId: 101, offerId: 'offer-101' }, after: { items: [item] } },
    },
    input: {
      shopId: 'shop-1',
      action: 'product.updateInfo',
      endpointKey: 'products.import',
      payload: { items: [item] },
      before: { productId: 101, offerId: 'offer-101' },
      realWrite: true,
      dryRun: false,
      waitForResult: true,
    },
  };
}

test('product info write reads info and attributes back before reporting completion', async () => {
  const repository = createRepository();
  const scheduler = createInfoScheduler();
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'merged');
  assert.equal(result.writeStatus, 'readback_merged');
  assert.deepEqual(scheduler.readCalls.map((call) => call.endpointKey), [
    'products.infoList',
    'products.attributes',
  ]);
  assert.deepEqual(repository.merges.map((entry) => entry.type), ['info', 'attributes']);
});

test('model-only attribute update writes through the dedicated Ozon endpoint and verifies exact 9048 readback', async () => {
  const repository = createRepository();
  const writeCalls = [];
  const readCalls = [];
  const scheduler = {
    async executeWrite(input) {
      writeCalls.push(input);
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'attribute-write-1',
        data: { result: { task_id: 6060 } },
      };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      if (input.endpointKey === 'products.importInfo') {
        return {
          ok: true,
          data: { result: { items: [{ offer_id: 'offer-101', product_id: 101, status: 'imported', errors: [] }] } },
        };
      }
      return {
        ok: true,
        data: { result: [{
          id: 101,
          product_id: 101,
          offer_id: 'offer-101',
          attributes: [{ id: 9048, complex_id: 0, values: [{ dictionary_value_id: 0, value: 'WZG-NEW' }] }],
        }] },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0],
  });
  const item = {
    offer_id: 'offer-101',
    attributes: [{ id: 9048, complex_id: 0, values: [{ dictionary_value_id: 0, value: 'WZG-NEW' }] }],
  };

  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: 'preview-attribute-1',
      action: 'product.updateAttributes',
      endpointKey: 'products.updateAttributes',
      payload: { items: [item] },
    },
    input: {
      shopId: 'shop-1',
      action: 'product.updateAttributes',
      endpointKey: 'products.updateAttributes',
      payload: { items: [item] },
      realWrite: true,
      dryRun: false,
      waitForResult: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'merged');
  assert.equal(writeCalls[0].endpointKey, 'products.updateAttributes');
  assert.deepEqual(writeCalls[0].params, { items: [item] });
  assert.deepEqual(readCalls.map((call) => call.endpointKey), ['products.importInfo', 'products.attributes']);
  assert.deepEqual(repository.merges.map((entry) => entry.type), ['attributes']);
});

test('model-only attribute update rejects unrelated attributes before Ozon', async () => {
  const repository = createRepository();
  let writeCount = 0;
  const service = createProductWriteService({
    repository,
    ozonScheduler: {
      async executeWrite() { writeCount += 1; return { ok: true }; },
    },
  });
  const result = await service.executeConfirmedWrite({
    preview: {
      action: 'product.updateAttributes',
      endpointKey: 'products.updateAttributes',
      payload: { items: [{ offer_id: 'offer-101', attributes: [{ id: 10, values: [{ value: 'bad' }] }] }] },
    },
    input: {
      shopId: 'shop-1',
      action: 'product.updateAttributes',
      endpointKey: 'products.updateAttributes',
      payload: { items: [{ offer_id: 'offer-101', attributes: [{ id: 10, values: [{ value: 'bad' }] }] }] },
      realWrite: true,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(writeCount, 0);
  assert.match(result.error.message, /9048|型号/u);
});

test('price write uses Ozon acknowledgement product ids for exact readback', async () => {
  const repository = createRepository();
  const readCalls = [];
  const scheduler = {
    async executeWrite() {
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'price-write-1',
        data: { result: [{ product_id: 101, offer_id: 'offer-101', updated: true }] },
      };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      return {
        ok: true,
        status: 'success',
        data: { items: [{
          product_id: 101,
          offer_id: 'offer-101',
          price: { price: '100' },
        }] },
      };
    },
  };
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });
  const prices = [{ offer_id: 'offer-101', price: '100', old_price: '130', min_price: '70', currency_code: 'CNY' }];

  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: 'price-preview-1',
      shopId: 'shop-1',
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices },
      diff: { after: { prices } },
    },
    input: {
      shopId: 'shop-1',
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      realWrite: true,
      dryRun: false,
      waitForResult: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'merged');
  assert.deepEqual(readCalls.map((call) => ({
    endpointKey: call.endpointKey,
    productIds: call.params?.filter?.product_id,
  })), [{ endpointKey: 'products.prices', productIds: [101] }]);
});

test('price readback resume resolves product ids from SQLite and never repeats the price write', async () => {
  const repository = createRepository();
  repository.listProducts = () => ({ rows: [{ productId: 101, offerId: 'offer-101' }] });
  let writeCalls = 0;
  const readCalls = [];
  const scheduler = {
    async executeWrite() {
      writeCalls += 1;
      throw new Error('price readback resume must not write');
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      return {
        ok: true,
        status: 'success',
        data: { items: [{ product_id: 101, offer_id: 'offer-101', price: { price: '100' } }] },
      };
    },
  };
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });
  const prices = [{ offer_id: 'offer-101', price: '100', old_price: '130', min_price: '70', currency_code: 'CNY' }];

  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: 'price-preview-resume',
      shopId: 'shop-1',
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      payload: { prices },
      diff: { after: { prices } },
    },
    input: {
      shopId: 'shop-1',
      action: 'product.updatePrice',
      endpointKey: 'products.updatePrices',
      resumeReadBackOnly: true,
      readBackJobId: 'price-write-accepted',
      realWrite: true,
      dryRun: false,
      waitForResult: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'merged');
  assert.equal(writeCalls, 0);
  assert.deepEqual(readCalls[0].params.filter.product_id, [101]);
});

test('new-product stock visibility, item cooldown and transport failures retry only unresolved absolute stock rows', async () => {
  const repository = createRepository();
  const writeCalls = [];
  let stockAttempt = 0;
  const stockRows = [
    { offer_id: 'offer-ready', warehouse_id: 9001, stock: 7 },
    { offer_id: 'offer-delayed', warehouse_id: 9001, stock: 7 },
  ];
  const retryableFailure = (code) => ({
    ok: false,
    status: 'partial',
    realWrite: true,
    dryRun: false,
    jobId: `stock-write-${stockAttempt}`,
    error: {
      code: 'OZON_WRITE_APPLICATION_ERROR',
      message: 'Ozon stock projection is not ready',
      failedItems: [{
        label: 'offer-delayed',
        raw: { offer_id: 'offer-delayed' },
        errors: [{
          code,
          message: code === 'TOO_MANY_REQUESTS'
            ? 'Stock is updated too frequently'
            : 'Product is not created',
        }],
      }],
    },
  });
  const scheduler = {
    async executeWrite(input) {
      writeCalls.push(input);
      stockAttempt += 1;
      if (stockAttempt < 3) {
        return retryableFailure(
          stockAttempt === 1 ? 'PRODUCT_IS_NOT_CREATED' : 'TOO_MANY_REQUESTS',
        );
      }
      if (stockAttempt === 3) {
        return {
          ok: false,
          status: 'failed',
          realWrite: true,
          dryRun: false,
          jobId: 'stock-write-network-retry',
          error: { code: 'OZON_SCHEDULER_ERROR', message: 'fetch failed' },
        };
      }
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'stock-write-recovered',
        data: { result: [{ offer_id: 'offer-delayed', updated: true }] },
      };
    },
    async executeReadOnly(input) {
      assert.equal(input.endpointKey, 'products.stocksByWarehouseFbs');
      return {
        ok: true,
        status: 'success',
        data: {
          items: stockRows.map((row) => ({
            offer_id: row.offer_id,
            warehouse_id: row.warehouse_id,
            present: row.stock,
            free_stock: row.stock,
          })),
          cursor: '',
          has_next: false,
        },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForStockVisibility: async () => undefined,
    productStockVisibilityRetryDelaysMs: [0, 0, 0, 0],
  });

  const result = await service.executeConfirmedWrite({
    preview: {
      previewId: 'stock-preview-new-products',
      shopId: 'shop-1',
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      payload: { stocks: stockRows },
      diff: { after: { stocks: stockRows } },
    },
    input: {
      shopId: 'shop-1',
      action: 'product.updateStock',
      endpointKey: 'products.updateStocks',
      realWrite: true,
      dryRun: false,
      waitForResult: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'readback_merged');
  assert.equal(result.readBack.status, 'merged');
  assert.equal(writeCalls.length, 4);
  assert.deepEqual(writeCalls[0].params.stocks, stockRows);
  assert.deepEqual(writeCalls[1].params.stocks, [stockRows[1]]);
  assert.deepEqual(writeCalls[2].params.stocks, [stockRows[1]]);
  assert.deepEqual(writeCalls[3].params.stocks, [stockRows[1]]);
  assert.match(writeCalls[1].idempotencyKey, /stock-visibility-retry:1$/u);
  assert.match(writeCalls[2].idempotencyKey, /stock-visibility-retry:2$/u);
  assert.match(writeCalls[3].idempotencyKey, /stock-visibility-retry:3$/u);
});

test('product import acknowledgement is polled until Ozon import and real product readback are complete', async () => {
  const repository = createRepository();
  const readCalls = [];
  let importReadCount = 0;
  const scheduler = {
    async executeWrite() {
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'write-async-import',
        data: { result: { task_id: 7788 } },
      };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      if (input.endpointKey === 'products.importInfo') {
        importReadCount += 1;
        return {
          ok: true,
          status: 'success',
          data: {
            result: {
              items: [{
                offer_id: 'offer-101',
                product_id: importReadCount > 1 ? 101 : 0,
                status: importReadCount > 1 ? 'imported' : 'processing',
                errors: [],
              }],
            },
          },
        };
      }
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: { items: [{
            id: 101,
            product_id: 101,
            offer_id: 'offer-101',
            sku: 900101,
            statuses: { is_created: true },
            name: 'Updated product',
            weight: 250,
            weight_unit: 'g',
            depth: 200,
            width: 100,
            height: 80,
            dimension_unit: 'mm',
          }] },
        };
      }
      return {
        ok: true,
        status: 'success',
        data: { result: [{
          id: 101,
          product_id: 101,
          offer_id: 'offer-101',
          attributes: [{ id: 10, values: [{ value: 'Blue' }] }],
        }] },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0, 0, 0],
  });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'merged');
  assert.equal(result.writeStatus, 'readback_merged');
  assert.equal(result.readBack.importTask.taskId, 7788);
  assert.equal(result.readBack.importTask.attempts, 2);
  assert.deepEqual(readCalls.map((call) => call.endpointKey), [
    'products.importInfo',
    'products.importInfo',
    'products.infoList',
    'products.attributes',
  ]);
  assert.notEqual(readCalls[0].idempotencyKey, readCalls[1].idempotencyKey);
});

test('product import waits for a real Ozon SKU before allowing price or stock steps to continue', async () => {
  const repository = createRepository();
  const readCalls = [];
  let infoReads = 0;
  let writeCalls = 0;
  const scheduler = {
    async executeWrite() {
      writeCalls += 1;
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'write-sku-readiness',
        data: { result: { task_id: 7789 } },
      };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      if (input.endpointKey === 'products.importInfo') {
        return {
          ok: true,
          status: 'success',
          data: { result: { items: [{
            offer_id: 'offer-101',
            product_id: 101,
            status: 'imported',
            errors: [],
          }] } },
        };
      }
      if (input.endpointKey === 'products.infoList') {
        infoReads += 1;
        return {
          ok: true,
          status: 'success',
          data: { items: [{
            id: 101,
            product_id: 101,
            offer_id: 'offer-101',
            sku: infoReads > 1 ? 900101 : 0,
            statuses: { is_created: infoReads > 1 },
            name: 'Updated product',
          }] },
        };
      }
      return {
        ok: true,
        status: 'success',
        data: { result: [{
          id: 101,
          product_id: 101,
          offer_id: 'offer-101',
          name: 'Updated product',
          weight: 250,
          weight_unit: 'g',
          depth: 200,
          width: 100,
          height: 80,
          dimension_unit: 'mm',
          attributes: [{ id: 10, values: [{ value: 'Blue' }] }],
          complex_attributes: [],
        }] },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0, 0],
  });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'readback_merged');
  assert.equal(result.readBack.status, 'merged');
  assert.equal(result.readBack.importTask.attempts, 2);
  assert.equal(infoReads, 2);
  assert.equal(writeCalls, 1);
  assert.deepEqual(readCalls.map((call) => call.endpointKey), [
    'products.importInfo',
    'products.infoList',
    'products.attributes',
    'products.importInfo',
    'products.infoList',
    'products.attributes',
  ]);
});

test('product import remains pending when Ozon returns product ids but sku is still zero', async () => {
  const repository = createRepository();
  const scheduler = {
    async executeWrite() {
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'write-sku-still-pending',
        data: { result: { task_id: 7790 } },
      };
    },
    async executeReadOnly(input) {
      if (input.endpointKey === 'products.importInfo') {
        return {
          ok: true,
          status: 'success',
          data: { result: { items: [{
            offer_id: 'offer-101',
            product_id: 101,
            status: 'imported',
            errors: [],
          }] } },
        };
      }
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: { items: [{
            id: 101,
            product_id: 101,
            offer_id: 'offer-101',
            sku: 0,
            statuses: { is_created: false },
            name: 'Updated product',
          }] },
        };
      }
      return {
        ok: true,
        status: 'success',
        data: { result: [{
          id: 101,
          product_id: 101,
          offer_id: 'offer-101',
          name: 'Updated product',
          weight: 250,
          weight_unit: 'g',
          depth: 200,
          width: 100,
          height: 80,
          dimension_unit: 'mm',
          attributes: [{ id: 10, values: [{ value: 'Blue' }] }],
          complex_attributes: [],
        }] },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0],
  });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'submitted_waiting_readback');
  assert.equal(result.readBack.status, 'pending');
  assert.equal(result.readBack.verification.reason, 'product_sku_not_ready');
  assert.deepEqual(result.readBack.verification.missingOfferIds, ['offer-101']);
});

test('product import keeps polling when attributes are briefly unavailable and never submits the write twice', async () => {
  const repository = createRepository();
  const readCalls = [];
  let writeCalls = 0;
  let attributeReads = 0;
  const scheduler = {
    async executeWrite() {
      writeCalls += 1;
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'write-eventual-attributes',
        data: { result: { task_id: 7799 } },
      };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      if (input.endpointKey === 'products.importInfo') {
        return {
          ok: true,
          status: 'success',
          data: { result: { items: [{
            offer_id: 'offer-101',
            product_id: 101,
            status: 'imported',
            errors: [],
          }] } },
        };
      }
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: { items: [{
            id: 101,
            product_id: 101,
            offer_id: 'offer-101',
            sku: 900101,
            statuses: { is_created: true },
            name: 'Updated product',
          }] },
        };
      }
      attributeReads += 1;
      if (attributeReads === 1) {
        return {
          ok: false,
          status: 'failed',
          error: {
            code: 'OZON_HTTP_ERROR',
            message: 'Ozon read request failed with HTTP 404. item not found; Ozon code 5',
          },
        };
      }
      return {
        ok: true,
        status: 'success',
        data: { result: [{
          id: 101,
          product_id: 101,
          offer_id: 'offer-101',
          name: 'Updated product',
          weight: 250,
          weight_unit: 'g',
          depth: 200,
          width: 100,
          height: 80,
          dimension_unit: 'mm',
          attributes: [{ id: 10, values: [{ value: 'Blue' }] }],
          complex_attributes: [],
        }] },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0, 0, 0],
  });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'readback_merged');
  assert.equal(result.readBack.status, 'merged');
  assert.equal(result.readBack.importTask.attempts, 2);
  assert.equal(writeCalls, 1);
  assert.equal(attributeReads, 2);
  assert.deepEqual(readCalls.map((call) => call.endpointKey), [
    'products.importInfo',
    'products.infoList',
    'products.attributes',
    'products.importInfo',
    'products.infoList',
    'products.attributes',
  ]);
});

test('late Ozon moderation errors stop readback instead of remaining pending forever', async () => {
  const repository = createRepository();
  const readCalls = [];
  let importReads = 0;
  let writeCalls = 0;
  const scheduler = {
    async executeWrite() {
      writeCalls += 1;
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'write-late-moderation-error',
        data: { result: { task_id: 7800 } },
      };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      if (input.endpointKey === 'products.importInfo') {
        importReads += 1;
        return {
          ok: true,
          status: 'success',
          data: { result: { items: [{
            offer_id: 'offer-101',
            product_id: 101,
            status: 'imported',
            errors: importReads > 1
              ? [{
                  code: 'SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT',
                  message: 'Такой же товар уже есть в другом кабинете',
                }]
              : [],
          }] } },
        };
      }
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: { items: [{ id: 101, product_id: 101, offer_id: 'offer-101', name: 'Updated product' }] },
        };
      }
      return {
        ok: false,
        status: 'failed',
        error: { message: 'item not found' },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0, 0, 0],
  });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, false);
  assert.equal(result.writeStatus, 'write_failed_after_accept');
  assert.equal(result.error.code, 'OZON_PRODUCT_CARD_GROUP_CONFLICT');
  assert.match(result.error.message, /按目标店铺生成独立型号/u);
  assert.equal(writeCalls, 1);
  assert.deepEqual(readCalls.map((call) => call.endpointKey), [
    'products.importInfo',
    'products.infoList',
    'products.attributes',
    'products.importInfo',
  ]);
});

test('readback-only resume completes the accepted import without issuing another Ozon write', async () => {
  const repository = createRepository();
  let writeCalls = 0;
  const scheduler = createInfoScheduler();
  scheduler.executeWrite = async () => {
    writeCalls += 1;
    throw new Error('readback-only resume must not write');
  };
  const originalRead = scheduler.executeReadOnly;
  scheduler.executeReadOnly = async (input) => {
    if (input.endpointKey === 'products.importInfo') {
      scheduler.readCalls.push(input);
      return {
        ok: true,
        status: 'success',
        data: { result: { items: [{
          offer_id: 'offer-101',
          product_id: 101,
          status: 'imported',
          errors: [],
        }] } },
      };
    }
    return originalRead.call(scheduler, input);
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0, 0],
  });
  const request = createInfoInput();
  request.input.resumeReadBackOnly = true;
  request.input.readBackTaskId = 7799;
  request.input.readBackJobId = 'write-eventual-attributes';

  const result = await service.executeConfirmedWrite(request);

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'readback_merged');
  assert.equal(result.readBack.status, 'merged');
  assert.equal(result.readBack.importTask.taskId, 7799);
  assert.equal(writeCalls, 0);
  assert.deepEqual(scheduler.readCalls.map((call) => call.endpointKey), [
    'products.importInfo',
    'products.infoList',
    'products.attributes',
  ]);
});

test('terminal Ozon import errors stop before detail readback and remain a failed write', async () => {
  const repository = createRepository();
  const readCalls = [];
  const scheduler = {
    async executeWrite() {
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'write-import-rejected',
        data: { result: { task_id: 8899 } },
      };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      return {
        ok: true,
        status: 'success',
        data: {
          result: {
            items: [{
              offer_id: 'offer-101',
              status: 'failed',
              errors: [{ code: 'INVALID_ARGUMENT', message: '字段不符合要求' }],
            }],
          },
        },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0],
  });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, false);
  assert.equal(result.writeStatus, 'write_failed_after_accept');
  assert.equal(result.readBack.status, 'failed');
  assert.equal(result.error.code, 'PRODUCT_IMPORT_TASK_FAILED');
  assert.match(result.error.message, /offer-101.*字段不符合要求/u);
  assert.deepEqual(readCalls.map((call) => call.endpointKey), ['products.importInfo']);
  assert.deepEqual(repository.merges, []);
});

test('daily product creation quota errors are returned in concise Chinese without leaking raw Russian', async () => {
  const repository = createRepository();
  const readCalls = [];
  const scheduler = {
    async executeWrite() {
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'write-daily-creation-limit',
        data: { result: { task_id: 8900 } },
      };
    },
    async executeReadOnly(input) {
      readCalls.push(input);
      return {
        ok: true,
        status: 'success',
        data: {
          result: {
            items: [{
              offer_id: 'offer-101',
              status: 'failed',
              errors: [{
                code: 'periodic_limit_exceeded',
                message: 'Не получится загрузить товары: вы исчерпали суточный лимит на создание товаров.',
              }],
            }],
          },
        },
      };
    },
  };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0],
  });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, false);
  assert.equal(result.writeStatus, 'write_failed_after_accept');
  assert.equal(result.readBack.status, 'failed');
  assert.equal(result.error.code, 'OZON_PRODUCT_DAILY_CREATION_LIMIT_EXCEEDED');
  assert.equal(result.readBack.verification.reason, 'product_daily_creation_limit_exceeded');
  assert.match(result.error.message, /今日新建商品额度已用完/u);
  assert.match(result.error.message, /北京时间 08:00/u);
  assert.doesNotMatch(result.error.message, /Не получится/u);
  assert.deepEqual(readCalls.map((call) => call.endpointKey), ['products.importInfo']);
  assert.deepEqual(repository.merges, []);
});

test('an 80-SKU import is completed from the real split info/attribute response shapes', async () => {
  const repository = createRepository();
  const items = Array.from({ length: 80 }, (_, index) => ({
    offer_id: `offer-bulk-${index + 1}`,
    name: `Bulk product ${index + 1}`,
    weight: 250,
    depth: 200,
    width: 100,
    height: 80,
    attributes: [{ id: 10, values: [{ value: 'Blue' }] }],
  }));
  const productRows = items.map((item, index) => ({
    id: 10_000 + index,
    product_id: 10_000 + index,
    offer_id: item.offer_id,
    name: item.name,
    weight: 250,
    weight_unit: 'g',
    depth: 200,
    width: 100,
    height: 80,
    dimension_unit: 'mm',
  }));
  const scheduler = {
    async executeWrite() {
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: 'write-bulk-80',
        data: { result: { task_id: 9980 } },
      };
    },
    async executeReadOnly(input) {
      if (input.endpointKey === 'products.importInfo') {
        return {
          ok: true,
          status: 'success',
          data: { result: { items: productRows.map((row) => ({
            offer_id: row.offer_id,
            product_id: row.product_id,
            status: 'imported',
            errors: [],
          })) } },
        };
      }
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: {
            items: productRows.map((row) => ({
              id: row.product_id,
              product_id: row.product_id,
              sku: 90_000_000 + row.product_id,
              statuses: { is_created: true },
              name: row.name,
            })),
          },
        };
      }
      return {
        ok: true,
        status: 'success',
        data: { result: productRows.map((row) => ({
          id: row.product_id,
          product_id: row.product_id,
          offer_id: row.offer_id,
          name: row.name,
          weight: row.weight,
          weight_unit: row.weight_unit,
          depth: row.depth,
          width: row.width,
          height: row.height,
          dimension_unit: row.dimension_unit,
          attributes: [{ id: 10, values: [{ dictionary_value_id: 0, value: 'Blue' }] }],
        })) },
      };
    },
  };
  const base = createInfoInput();
  base.preview.payload = { items };
  base.preview.diff.after = { items };
  base.input.payload = { items };
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    waitForReadBack: async () => undefined,
    productInfoReadBackDelaysMs: [0],
  });

  const result = await service.executeConfirmedWrite(base);

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'merged');
  assert.equal(result.readBack.importTask.itemCount, 80);
  assert.equal(result.readBack.importTask.productIds.length, 80);
  assert.equal(result.readBack.rows, 80);
  assert.deepEqual(repository.merges.map((entry) => ({
    type: entry.type,
    rows: entry.rows.length,
  })), [
    { type: 'info', rows: 80 },
    { type: 'attributes', rows: 80 },
  ]);
});

test('normalizes every protobuf attribute value before writing regardless of source product', async () => {
  const repository = createRepository();
  const scheduler = createInfoScheduler({
    attributes: [
      { id: 9070, values: [{ value: 'false' }] },
      { id: 11650, values: [{ value: '1' }] },
    ],
  });
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(createInfoInput({
    attributes: [
      { id: 9070, values: [{ value: false }] },
      { id: 11650, values: [{ value: 1 }] },
    ],
  }));

  assert.equal(result.readBack.status, 'merged');
  assert.deepEqual(scheduler.writeCalls[0].params.items[0].attributes, [
    { id: 9070, values: [{ value: 'false' }] },
    { id: 11650, values: [{ value: '1' }] },
  ]);
});

test('normalizes Ozon-managed title, offer and type fields before write and verifies their top-level readback', async () => {
  const repository = createRepository();
  const safeName = 'Очки для зрения -2,50, поворот 360';
  const sourceName = 'Очки для зрения −2,50, поворот 360°';
  const scheduler = createInfoScheduler({
    name: safeName,
    typeId: 971081388,
    attributes: [
      { id: 4180, values: [{ dictionary_value_id: 0, value: safeName }] },
      { id: 9024, values: [{ dictionary_value_id: 0, value: 'offer-101' }] },
    ],
  });
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const request = createInfoInput({
    typeId: 971081388,
    attributes: [
      { id: 4180, values: [{ value: '旧标题' }] },
      { id: 9024, values: [{ value: '旧货号' }] },
      { id: 8229, values: [{ value: '971081388' }] },
    ],
  });
  request.preview.payload.items[0].name = sourceName;
  request.preview.diff.after.items[0].name = sourceName;
  request.input.payload.items[0].name = sourceName;

  const result = await service.executeConfirmedWrite(request);

  assert.equal(result.readBack.status, 'merged');
  const written = scheduler.writeCalls[0].params.items[0];
  assert.equal(written.name, safeName);
  assert.equal(written.name.includes('°'), false);
  assert.equal(written.attributes.find((attribute) => attribute.id === 4180).values[0].value, safeName);
  assert.equal(written.attributes.find((attribute) => attribute.id === 9024).values[0].value, 'offer-101');
});

test('scopes the Ozon card-group model name by target shop for every source product', async () => {
  const executeForShop = async (shopId, offerId = 'offer-101') => {
    const repository = createRepository();
    const writeCalls = [];
    const scheduler = {
      writeCalls,
      async executeWrite(input) {
        writeCalls.push(input);
        return { ok: true, status: 'success', realWrite: true, dryRun: false, jobId: 'write-model-scope' };
      },
      async executeReadOnly(input) {
        const written = writeCalls[0].params.items[0];
        if (input.endpointKey === 'products.infoList') {
          return {
            ok: true,
            status: 'success',
            data: { items: [{
              id: 101,
              product_id: 101,
              offer_id: written.offer_id,
              sku: 900101,
              statuses: { is_created: true },
              name: written.name,
            }] },
          };
        }
        return {
          ok: true,
          status: 'success',
          data: { result: [{
            id: 101,
            product_id: 101,
            offer_id: written.offer_id,
            name: written.name,
            weight: written.weight,
            weight_unit: written.weight_unit,
            depth: written.depth,
            width: written.width,
            height: written.height,
            dimension_unit: written.dimension_unit,
            attributes: written.attributes,
            complex_attributes: [],
          }] },
        };
      },
    };
    const service = createProductWriteService({ repository, ozonScheduler: scheduler });
    const request = createInfoInput({
      attributes: [{ id: 9048, values: [{ value: 'GB02' }] }],
    });
    for (const item of [
      request.preview.payload.items[0],
      request.preview.diff.after.items[0],
      request.input.payload.items[0],
    ]) item.offer_id = offerId;
    request.preview.diff.before.offerId = offerId;
    request.input.before.offerId = offerId;
    request.preview.shopId = shopId;
    request.preview.diff.shopId = shopId;
    request.input.shopId = shopId;

    const result = await service.executeConfirmedWrite(request);

    assert.equal(result.readBack.status, 'merged');
    return scheduler.writeCalls[0].params.items[0].attributes
      .find((attribute) => attribute.id === 9048).values[0].value;
  };

  const first = await executeForShop('ozon-shop-example-01', 'SPB-SOURCE-A-01');
  const second = await executeForShop('ozon-shop-example-03', 'SPB-SOURCE-A-01');
  const anotherProduct = await executeForShop('ozon-shop-example-01', 'SPB-SOURCE-B-01');
  assert.match(first, /^GB02-WZexample01-[A-Z0-9]{7}$/u);
  assert.match(second, /^GB02-WZexample03-[A-Z0-9]{7}$/u);
  assert.notEqual(first, second);
  assert.notEqual(first, anotherProduct);
});

test('keeps every variant in one source card on the same shop-and-product scoped model', async () => {
  const repository = createRepository();
  const writeCalls = [];
  const scheduler = {
    writeCalls,
    async executeWrite(input) {
      writeCalls.push(input);
      return { ok: true, status: 'success', realWrite: true, dryRun: false, jobId: 'write-card-variants' };
    },
    async executeReadOnly(input) {
      const writtenItems = writeCalls[0].params.items;
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: { items: writtenItems.map((item, index) => ({
            id: 101 + index,
            product_id: 101 + index,
            offer_id: item.offer_id,
            sku: 900101 + index,
            statuses: { is_created: true },
            name: item.name,
          })) },
        };
      }
      return {
        ok: true,
        status: 'success',
        data: { result: writtenItems.map((item, index) => ({
          ...item,
          id: 101 + index,
          product_id: 101 + index,
        })) },
      };
    },
  };
  const request = createInfoInput({
    attributes: [{ id: 9048, values: [{ value: 'GB02' }] }],
  });
  const firstItem = request.input.payload.items[0];
  const items = [
    { ...firstItem, offer_id: 'SPB-907805856885-RED-01', name: 'Красные очки' },
    { ...firstItem, offer_id: 'SPB-907805856885-BLUE-02', name: 'Синие очки' },
  ];
  request.input.payload = { items };
  request.preview.payload = { items };
  request.preview.diff.after = { items };
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(request);

  assert.equal(result.readBack.status, 'merged');
  const models = writeCalls[0].params.items.map((item) => (
    item.attributes.find((attribute) => attribute.id === 9048).values[0].value
  ));
  assert.equal(new Set(models).size, 1);
  assert.match(models[0], /^GB02-WZshop1-[A-Z0-9]{7}$/u);
});

test('reuses the existing card model when a previously partial import is completed', async () => {
  const repository = createRepository();
  repository.resolveProductModelNamesForOffers = ({ offerIds }) => (
    offerIds.includes('SPB-907805856885-RED-01')
      ? [{ offerId: 'SPB-907805856885-RED-01', modelName: 'GB02-WZshop1' }]
      : []
  );
  const writeCalls = [];
  const scheduler = {
    writeCalls,
    async executeWrite(input) {
      writeCalls.push(input);
      return { ok: true, status: 'success', realWrite: true, dryRun: false, jobId: 'write-partial-card-recovery' };
    },
    async executeReadOnly(input) {
      const writtenItems = writeCalls[0].params.items;
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: { items: writtenItems.map((item, index) => ({
            id: 201 + index,
            product_id: 201 + index,
            offer_id: item.offer_id,
            sku: 901001 + index,
            statuses: { is_created: true },
            name: item.name,
          })) },
        };
      }
      return {
        ok: true,
        status: 'success',
        data: { result: writtenItems.map((item, index) => ({
          ...item,
          id: 201 + index,
          product_id: 201 + index,
        })) },
      };
    },
  };
  const request = createInfoInput({
    attributes: [{ id: 9048, values: [{ value: 'GB02' }] }],
  });
  const firstItem = request.input.payload.items[0];
  const items = [
    { ...firstItem, offer_id: 'SPB-907805856885-RED-01', name: 'Красные очки' },
    { ...firstItem, offer_id: 'SPB-907805856885-BLUE-02', name: 'Синие очки' },
  ];
  request.input.payload = { items };
  request.preview.payload = { items };
  request.preview.diff.after = { items };
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(request);

  assert.equal(result.readBack.status, 'merged');
  assert.deepEqual(writeCalls[0].params.items.map((item) => (
    item.attributes.find((attribute) => attribute.id === 9048).values[0].value
  )), ['GB02-WZshop1', 'GB02-WZshop1']);
});

test('normalizes nested complex attributes for future categories without source-link rules', async () => {
  const repository = createRepository();
  const complexAttributes = [{
    attributes: [{
      id: 12001,
      complex_id: 7,
      values: [{ dictionary_value_id: 0, value: 'false' }],
    }],
  }];
  const scheduler = createInfoScheduler({ complexAttributes });
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(createInfoInput({
    complexAttributes: [{
      attributes: [{ id: 12001, complex_id: 7, values: [{ value: false }] }],
    }],
  }));

  assert.equal(result.readBack.status, 'merged');
  assert.deepEqual(
    scheduler.writeCalls[0].params.items[0].complex_attributes,
    [{ attributes: [{ id: 12001, complex_id: 7, values: [{ value: 'false' }] }] }],
  );
});

test('rejects malformed nested complex attributes before every Ozon write', async () => {
  const repository = createRepository();
  const scheduler = createInfoScheduler();
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(createInfoInput({
    complexAttributes: [{ attributes: [{ id: 12001, values: [{ value: {} }] }] }],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.writeStatus, 'write_payload_invalid');
  assert.equal(result.error.code, 'PRODUCT_ATTRIBUTE_VALUE_INVALID');
  assert.equal(scheduler.writeCalls.length, 0);
});

test('rejects invalid URL attributes before Ozon for every future source link', async () => {
  const repository = createRepository();
  const scheduler = createInfoScheduler();
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(createInfoInput({
    attributes: [{ id: 8790, values: [{ value: 'not-a-url' }] }],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.writeStatus, 'write_payload_invalid');
  assert.equal(result.error.code, 'PRODUCT_ATTRIBUTE_URL_INVALID');
  assert.equal(scheduler.writeCalls.length, 0);
});

test('rejects more than 29 additional images before Ozon for every future source link', async () => {
  const repository = createRepository();
  const scheduler = createInfoScheduler();
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });
  const images = Array.from({ length: 30 }, (_, index) => `https://img.example.com/${index}.jpg`);

  const result = await service.executeConfirmedWrite(createInfoInput({ images }));

  assert.equal(result.ok, false);
  assert.equal(result.writeStatus, 'write_payload_invalid');
  assert.equal(result.error.code, 'PRODUCT_IMAGE_LIMIT_EXCEEDED');
  assert.equal(scheduler.writeCalls.length, 0);
});

test('product image write stays pending when Ozon readback has not returned the submitted image count', async () => {
  const repository = createRepository();
  const submittedImages = ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'];
  const scheduler = createInfoScheduler({ images: ['https://cdn.ozon.ru/only-one.jpg'] });
  const publications = [];
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    productImageAssetRepository: { markPublishedByUrls: (input) => publications.push(input) },
  });

  const result = await service.executeConfirmedWrite(createInfoInput({ images: submittedImages }));

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'mismatch');
  assert.equal(result.writeStatus, 'readback_mismatch');
  assert.equal(publications.length, 0);
});

test('product image write accepts Ozon CDN URLs only after the full submitted image count is visible', async () => {
  const repository = createRepository();
  const submittedImages = ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'];
  const scheduler = createInfoScheduler({
    images: ['https://cdn.ozon.ru/copied-1.jpg', 'https://cdn.ozon.ru/copied-2.jpg'],
  });
  const publications = [];
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    productImageAssetRepository: {
      markPublishedByUrls(input) {
        publications.push(input);
        return { ok: true, changed: input.urls.length, assetIds: input.urls.map((_, index) => `asset-${index}`) };
      },
    },
  });

  const result = await service.executeConfirmedWrite(createInfoInput({ images: submittedImages }));

  assert.equal(result.readBack.status, 'merged');
  assert.equal(result.writeStatus, 'readback_merged');
  assert.equal(publications.length, 1);
  assert.deepEqual(publications[0].urls, submittedImages);
  assert.equal(publications[0].shopId, 'shop-1');
  assert.equal(result.imagePublication.changed, 2);
});

test('publishes all six submitted image assets only after complete Ozon readback', async () => {
  const repository = createRepository();
  const submittedImages = Array.from({ length: 6 }, (_, index) => `https://bucket.example/wangzai/assets/${index}.jpg?signature=x`);
  const scheduler = createInfoScheduler({
    images: Array.from({ length: 6 }, (_, index) => `https://cdn.ozon.ru/copied-${index}.jpg`),
  });
  const publications = [];
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    productImageAssetRepository: {
      markPublishedByUrls(input) { publications.push(input); return { ok: true, changed: input.urls.length, assetIds: [] }; },
    },
  });
  const result = await service.executeConfirmedWrite(createInfoInput({ images: submittedImages }));
  assert.equal(result.readBack.status, 'merged');
  assert.equal(publications.length, 1);
  assert.equal(publications[0].urls.length, 6);
});

test('product info write merges Ozon truth but never reports completion when values mismatch', async () => {
  const repository = createRepository();
  const scheduler = createInfoScheduler({ name: 'Ozon kept old name' });
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(createInfoInput());

  assert.equal(result.ok, true);
  assert.equal(result.readBack.status, 'mismatch');
  assert.equal(result.writeStatus, 'readback_mismatch');
  assert.equal(result.readBack.verification.reason, 'info_readback_mismatch');
  assert.deepEqual(repository.merges.map((entry) => entry.type), ['info', 'attributes']);
});

test('rich content JSON attributes read back equal despite whitespace and object-key order', async () => {
  const repository = createRepository();
  const submittedRichContent = '{"version":2,"content":[{"widgetName":"image","props":{"src":"https://cdn.example/new.jpg","alt":"商品"}}]}';
  const ozonRichContent = '{ "content": [ { "props": { "alt": "商品", "src": "https://cdn.example/new.jpg" }, "widgetName": "image" } ], "version": 2 }';
  const scheduler = createInfoScheduler({
    attributes: [{ id: 11254, values: [{ value: ozonRichContent }] }],
  });
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(createInfoInput({
    attributes: [{ id: 11254, values: [{ value: submittedRichContent }] }],
  }));

  assert.equal(result.readBack.status, 'merged');
  assert.equal(result.writeStatus, 'readback_merged');
});

test('rich content JSON attribute readback still fails when a value changes', async () => {
  const repository = createRepository();
  const scheduler = createInfoScheduler({
    attributes: [{ id: 11254, values: [{ value: '{"version":2,"content":[]}' }] }],
  });
  const service = createProductWriteService({ repository, ozonScheduler: scheduler });

  const result = await service.executeConfirmedWrite(createInfoInput({
    attributes: [{ id: 11254, values: [{ value: '{"version":2,"content":[{"widgetName":"image"}]}' }] }],
  }));

  assert.equal(result.readBack.status, 'mismatch');
  assert.equal(result.writeStatus, 'readback_mismatch');
});

test('refreshes tracked image signatures before the scheduler writes product info', async () => {
  const repository = createRepository();
  const oldUrl = 'https://bucket.example/wangzai/assets/detail.jpg?sig=old';
  const freshUrl = 'https://bucket.example/wangzai/assets/detail.jpg?sig=fresh';
  const freshRichContent = JSON.stringify({ version: 2, content: [{ widgetName: 'image', props: { src: freshUrl } }] });
  const scheduler = createInfoScheduler({ attributes: [{ id: 11254, values: [{ value: freshRichContent }] }] });
  const refreshCalls = [];
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    refreshProductImagePayloadUrls: async (payload, context) => {
      refreshCalls.push(context);
      return JSON.parse(JSON.stringify(payload).replace(oldUrl, freshUrl));
    },
  });
  const result = await service.executeConfirmedWrite(createInfoInput({
    attributes: [{ id: 11254, values: [{ value: JSON.stringify({ version: 2, content: [{ widgetName: 'image', props: { src: oldUrl } }] }) }] }],
  }));
  assert.equal(result.readBack.status, 'merged');
  assert.deepEqual(refreshCalls, [{ shopId: 'shop-1' }]);
  assert.match(scheduler.writeCalls[0].params.items[0].attributes[0].values[0].value, /sig=fresh/u);
  assert.doesNotMatch(scheduler.writeCalls[0].params.items[0].attributes[0].values[0].value, /sig=old/u);
});

test('publishes permanent detail image assets found inside Rich Content after exact readback', async () => {
  const repository = createRepository();
  const detailUrl = 'https://bucket.example/wangzai/assets/detail.jpg?signature=x';
  const richContent = JSON.stringify({ version: 2, content: [{ widgetName: 'image', props: { src: detailUrl, srcMobile: detailUrl } }] });
  const scheduler = createInfoScheduler({ attributes: [{ id: 11254, values: [{ value: richContent }] }] });
  const publications = [];
  const service = createProductWriteService({
    repository,
    ozonScheduler: scheduler,
    productImageAssetRepository: {
      markPublishedByUrls(input) { publications.push(input); return { ok: true, changed: input.urls.length, assetIds: [] }; },
    },
  });
  const result = await service.executeConfirmedWrite(createInfoInput({
    attributes: [{ id: 11254, values: [{ value: richContent }] }],
  }));
  assert.equal(result.readBack.status, 'merged');
  assert.deepEqual(publications[0].urls, [detailUrl]);
  assert.equal(result.imagePublication.changed, 1);
});
