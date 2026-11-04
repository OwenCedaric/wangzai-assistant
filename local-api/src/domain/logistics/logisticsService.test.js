import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLogisticsRequestFingerprint,
  createLogisticsService,
  listLogisticsWriteActions,
  normalizeLogisticsParams,
} from './logisticsService.js';

test('logistics params canonicalize empty delivery filters and default limits', () => {
  assert.deepEqual(normalizeLogisticsParams('deliveryMethod.list', {}), { limit: 100 });
  assert.deepEqual(normalizeLogisticsParams('deliveryMethod.list', { limit: 100, filter: {} }), { limit: 100 });
  assert.deepEqual(normalizeLogisticsParams('warehouse.list', {}), { limit: 100, cursor: '' });
  assert.deepEqual(normalizeLogisticsParams('warehouse.list', { limit: 100, cursor: '' }), {
    limit: 100,
    cursor: '',
  });
});

test('equivalent startup and manual logistics reads share one request fingerprint', () => {
  const startupWarehouse = buildLogisticsRequestFingerprint({
    shopId: 'shop-a',
    endpointKey: 'warehouse.list',
    forceRefresh: true,
    syncMode: 'bootstrap',
    requestedBy: 'continuous-sync',
  });
  const manualWarehouse = buildLogisticsRequestFingerprint({
    shopId: 'shop-a',
    endpointKey: 'warehouse.list',
    params: { limit: 100, cursor: '' },
    forceRefresh: true,
    requestedBy: 'frontend-logistics-legacy-adapter',
  });
  assert.equal(startupWarehouse, manualWarehouse);

  const startupDelivery = buildLogisticsRequestFingerprint({
    shopId: 'shop-a',
    endpointKey: 'deliveryMethod.list',
    forceRefresh: true,
    syncMode: 'steady',
    requestedBy: 'continuous-sync',
  });
  const manualDelivery = buildLogisticsRequestFingerprint({
    shopId: 'shop-a',
    endpointKey: 'deliveryMethod.list',
    params: { limit: 100, filter: {} },
    forceRefresh: true,
    requestedBy: 'frontend-logistics-legacy-adapter',
  });
  assert.equal(startupDelivery, manualDelivery);
});

test('different shops, endpoints, filters, and refresh semantics remain isolated', () => {
  const base = buildLogisticsRequestFingerprint({
    shopId: 'shop-a',
    endpointKey: 'deliveryMethod.list',
    params: { limit: 100 },
    forceRefresh: true,
  });
  assert.notEqual(
    base,
    buildLogisticsRequestFingerprint({
      shopId: 'shop-b',
      endpointKey: 'deliveryMethod.list',
      params: { limit: 100 },
      forceRefresh: true,
    })
  );
  assert.notEqual(
    base,
    buildLogisticsRequestFingerprint({
      shopId: 'shop-a',
      endpointKey: 'warehouse.list',
      params: { limit: 100 },
      forceRefresh: true,
    })
  );
  assert.notEqual(
    base,
    buildLogisticsRequestFingerprint({
      shopId: 'shop-a',
      endpointKey: 'deliveryMethod.list',
      params: { limit: 50 },
      forceRefresh: true,
    })
  );
  assert.notEqual(
    base,
    buildLogisticsRequestFingerprint({
      shopId: 'shop-a',
      endpointKey: 'deliveryMethod.list',
      params: { limit: 100 },
      forceRefresh: false,
    })
  );
});

test('warehouse writes use the registered rFBS endpoint and complete operation plus cache readback', async () => {
  const writes = [];
  const reads = [];
  const service = createLogisticsService({
    ozonScheduler: {
      async executeWrite(input) {
        writes.push(input);
        return { ok: true, realWrite: true, dryRun: false, data: { operation_id: 'operation-1' } };
      },
      async executeReadOnly(input) {
        reads.push(input);
        if (input.endpointKey === 'warehouse.operationStatus') {
          return { ok: true, data: { status: 'SUCCESS', result: { warehouse_id: 1020005007227510 } } };
        }
        return { ok: true, status: 'success', data: { result: [] } };
      },
    },
  });

  const result = await service.executeConfirmedWrite({
    preview: { previewId: 'preview-1', action: 'warehouse.rfbs.pause', endpointKey: 'warehouse.rfbsPause' },
    input: {
      shopId: 'shop-a',
      action: 'warehouse.rfbs.pause',
      endpointKey: 'warehouse.rfbsPause',
      payload: { warehouse_id: 1020005007227510 },
      realWrite: true,
      dryRun: false,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'readback_merged');
  assert.equal(writes[0].endpointKey, 'warehouse.rfbsPause');
  assert.deepEqual(writes[0].params, { warehouse_id: 1020005007227510 });
  assert.deepEqual(reads.map((item) => item.endpointKey), [
    'warehouse.operationStatus',
    'warehouse.list',
    'deliveryMethod.list',
  ]);
});

test('warehouse write endpoint and scope cannot be replaced by the caller', async () => {
  const service = createLogisticsService({ ozonScheduler: { executeWrite: async () => ({ ok: true }) } });
  const mismatch = await service.executeConfirmedWrite({
    preview: { action: 'warehouse.rfbs.pause' },
    input: {
      shopId: 'shop-a',
      action: 'warehouse.rfbs.pause',
      endpointKey: 'warehouse.fbsUpdate',
      payload: { warehouse_id: 1 },
      realWrite: true,
      dryRun: false,
    },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'LOGISTICS_WRITE_ENDPOINT_MISMATCH');
  assert.ok(listLogisticsWriteActions().some((item) => item.action === 'delivery-method.update'));
});

test('warehouse creation accepts no prior warehouse id and reads back the created entity id', async () => {
  const writes = [];
  const service = createLogisticsService({
    ozonScheduler: {
      async executeWrite(input) {
        writes.push(input);
        return { ok: true, dryRun: false, data: { operation_id: 'create-operation' } };
      },
      async executeReadOnly(input) {
        if (input.endpointKey === 'warehouse.operationStatus') {
          return { ok: true, data: { status: 'SUCCESS', result: { warehouse_id: 9001 } } };
        }
        return { ok: true, status: 'success', data: { result: [] } };
      },
    },
  });
  const result = await service.executeConfirmedWrite({
    preview: { previewId: 'preview-create' },
    input: {
      shopId: 'shop-a',
      action: 'warehouse.create.erfbs-aggregator',
      endpointKey: 'warehouse.erfbsAggregatorCreate',
      payload: { name: '新仓', delivery_method: { name: '新配送' } },
      realWrite: true,
      dryRun: false,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.writeStatus, 'readback_merged');
  assert.equal(writes[0].endpointKey, 'warehouse.erfbsAggregatorCreate');
});

test('delivery polygon creation returns its id without requiring an existing warehouse', async () => {
  let reads = 0;
  const service = createLogisticsService({
    ozonScheduler: {
      async executeWrite() {
        return { ok: true, dryRun: false, data: { polygon_id: 7001 } };
      },
      async executeReadOnly() {
        reads += 1;
        return { ok: true };
      },
    },
  });
  const result = await service.executeConfirmedWrite({
    preview: { previewId: 'preview-polygon' },
    input: {
      shopId: 'shop-a',
      action: 'delivery-polygon.create',
      endpointKey: 'warehouse.polygonCreate',
      payload: { coordinates: '[[[29.3,120.1],[29.4,120.1],[29.3,120.1]]]' },
      realWrite: true,
      dryRun: false,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.polygon_id, 7001);
  assert.equal(reads, 0);
});
