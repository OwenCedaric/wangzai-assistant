import assert from 'node:assert/strict';
import test from 'node:test';

import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createProductRepository } from '../../db/repositories/productRepository.js';
import { createCrossBorderOrderRepository } from '../../db/repositories/crossBorderOrderRepository.js';
import { createWriteGuardService } from '../../security/writeGuardService.js';
import { createProductWriteService } from './productWriteService.js';
import {
  createHistoricalDimensionSyncService,
  HISTORICAL_DIMENSION_SYNC_IMPORT_ITEM_FIELDS,
} from './historicalDimensionSyncService.js';

const NOW = '2026-07-17T08:00:00.000Z';

function addCompleteProduct(repository, {
  shopId,
  productId = '8101',
  offerId = 'offer-8101',
  sku = '98101',
  vat = '0.2',
  dimensions = { weight: 130, length: 100, width: 110, height: 120 },
} = {}) {
  repository.upsertProducts({
    shopId,
    visibility: 'IN_SALE',
    endpointKey: 'products.list',
    rows: [{
      product_id: productId,
      offer_id: offerId,
      sku,
      name: `商品-${productId}`,
      visibility: 'IN_SALE',
      description_category_id: 17028669,
      type_id: 9001,
      vat,
    }],
  });
  repository.mergeProductInfoRows({
    shopId,
    rows: [{
      id: productId,
      offer_id: offerId,
      sku,
      name: `商品-${productId}`,
      description_category_id: 17028669,
      type_id: 9001,
      weight: dimensions.weight,
      weight_unit: 'g',
      depth: dimensions.length,
      width: dimensions.width,
      height: dimensions.height,
      dimension_unit: 'mm',
    }],
  });
  repository.mergeProductPictureRows({
    shopId,
    rows: [{
      product_id: productId,
      offer_id: offerId,
      images: [
        `https://img.example/${productId}-main.jpg`,
        `https://img.example/${productId}-second.jpg`,
      ],
    }],
  });
  repository.mergeProductAttributeRows({
    shopId,
    rows: [{
      id: productId,
      offer_id: offerId,
      attributes: [{ id: 10, values: [{ value: 'Blue' }] }],
    }],
  });
  repository.mergeProductPriceRows({
    shopId,
    rows: [{
      product_id: productId,
      offer_id: offerId,
      price: {
        price: '100.00',
        marketing_seller_price: '100.00',
        old_price: '120.00',
        currency_code: 'RUB',
      },
      commissions: { sales_percent_rfbs: 13 },
      acquiring: '1.23',
    }],
  });
  return repository.listProducts({ shopId, productIds: [productId], pageSize: 20 }).rows[0];
}

function insertHistory(db, {
  shopId,
  productIdentityId,
  productId = '8101',
  offerId = 'offer-8101',
  sku = '98101',
  postingNumber = 'posting-8101-1',
  lengthMm = null,
  widthMm = null,
  heightMm = null,
  weightG = null,
  updatedAt = NOW,
} = {}) {
  const resolvedProductIdentityId = productIdentityId || db.prepare(`
    SELECT product_identity_id FROM product_identities
    WHERE shop_id = ? AND product_id = ? LIMIT 1
  `).get(shopId, productId)?.product_identity_id;
  db.prepare(`
    INSERT INTO historical_order_facts (
      id, shop_id, posting_number, order_id, product_identity_id,
      product_id, offer_id, sku, product_name, source_type,
      length_mm, width_mm, height_mm, weight_g,
      origin_import_id, row_hash, observed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'historical_order_import', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `history:${shopId}:${postingNumber}`,
    shopId,
    postingNumber,
    `order-${postingNumber}`,
    resolvedProductIdentityId,
    productId,
    offerId,
    sku,
    `历史商品-${productId}`,
    lengthMm,
    widthMm,
    heightMm,
    weightG,
    'history-import-1',
    'history-row-hash',
    updatedAt,
    updatedAt,
    updatedAt,
  );
}

function getIdentityId(db, shopId, productId) {
  return db.prepare(`
    SELECT product_identity_id FROM product_identities
    WHERE shop_id = ? AND product_id = ? LIMIT 1
  `).get(shopId, String(productId))?.product_identity_id;
}

function insertCompletedImportSelection(db, {
  shopId,
  importId = 'history-import-1',
  rowIndex = 0,
  postingNumber = 'posting-8101-1',
  productIdentityId,
  productId = '8101',
  offerId = 'offer-8101',
  sku = '98101',
} = {}) {
  const shopIncarnation = db.prepare('SELECT shop_incarnation FROM shops WHERE id = ?').get(shopId).shop_incarnation;
  db.prepare(`
    INSERT INTO historical_order_import_runs (
      import_id, shop_id, shop_incarnation, source_hash, columns_json, status,
      preview_fingerprint, row_count, committed_count, result_summary_json,
      created_at, confirmed_at, completed_at, updated_at
    ) VALUES (?, ?, ?, 'source-hash', '[]', 'completed', 'fingerprint', 1, 1,
      '{"verified":true}', ?, ?, ?, ?)
  `).run(importId, shopId, shopIncarnation, NOW, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO historical_order_import_rows (
      import_id, row_index, shop_id, preview_status, posting_number,
      product_identity_id, product_id, offer_id, sku, product_name, match_mode,
      candidates_json, normalized_patch_json, applied_patch_json, before_json,
      before_hash, after_json, result_hash, committed, created_at, updated_at
    ) VALUES (?, ?, ?, 'ready_insert', ?, ?, ?, ?, ?, ?, 'automatic',
      '[]', '{}', '{}', '{}', 'before-hash', '{}', 'result-hash', 1, ?, ?)
  `).run(
    importId,
    rowIndex,
    shopId,
    postingNumber,
    productIdentityId,
    productId,
    offerId,
    sku,
    `历史商品-${productId}`,
    NOW,
    NOW,
  );
}

function createScheduler({ productIdByOffer = {}, readback = 'match' } = {}) {
  const writes = [];
  const reads = [];
  let submittedItems = [];
  return {
    writes,
    reads,
    async executeWrite(input) {
      writes.push(structuredClone(input));
      submittedItems = structuredClone(input.params?.items || []);
      return {
        ok: true,
        status: 'success',
        realWrite: true,
        dryRun: false,
        jobId: `dimension-write-${writes.length}`,
      };
    },
    async executeReadOnly(input) {
      reads.push(structuredClone(input));
      if (input.endpointKey === 'products.infoList') {
        return {
          ok: true,
          status: 'success',
          data: {
            items: submittedItems.map((item) => ({
              id: productIdByOffer[item.offer_id],
              product_id: productIdByOffer[item.offer_id],
              offer_id: item.offer_id,
              name: item.name,
              weight: item.weight,
              weight_unit: item.weight_unit,
              depth: readback === 'mismatch' ? item.depth + 1 : item.depth,
              width: item.width,
              height: item.height,
              dimension_unit: item.dimension_unit,
              primary_image: item.primary_image,
              images: item.images,
              description_category_id: item.description_category_id,
              type_id: item.type_id,
            })),
          },
        };
      }
      if (input.endpointKey === 'products.attributes') {
        return {
          ok: true,
          status: 'success',
          data: {
            result: submittedItems.map((item) => ({
              id: productIdByOffer[item.offer_id],
              product_id: productIdByOffer[item.offer_id],
              offer_id: item.offer_id,
              attributes: item.attributes,
            })),
          },
        };
      }
      throw new Error(`unexpected read endpoint ${input.endpointKey}`);
    },
  };
}

function createFixture({ readback = 'match' } = {}) {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_historical_dimension_sync');
  const repository = createProductRepository(db);
  const scheduler = createScheduler({
    readback,
    productIdByOffer: { 'offer-8101': '8101', 'offer-8102': '8102' },
  });
  const productWriteService = createProductWriteService({ repository, ozonScheduler: scheduler });
  const writeGuardService = createWriteGuardService(db, {
    realWritePolicy: { enabled: true },
    executors: { products: productWriteService.executeConfirmedWrite },
  });
  const service = createHistoricalDimensionSyncService({
    db,
    writeGuardService,
    now: () => new Date(NOW),
  });
  return { db, shopId, repository, scheduler, writeGuardService, service };
}

function exactConfirm(preview, shopId) {
  return {
    shopId,
    previewId: preview.previewId,
    previewFingerprint: preview.previewFingerprint,
    confirm: true,
  };
}

test('historical dimension sync resolves each field by bus > history > manual > Ozon and completes only after readback', async () => {
  const fixture = createFixture();
  const { db, shopId, repository, scheduler, service } = fixture;
  try {
    const product = addCompleteProduct(repository, { shopId });
    repository.upsertProductMaterialProfile({
      shopId,
      productKey: product.productKey,
      productId: product.productId,
      offerId: product.offerId,
      sku: product.sku,
      source: 'manual-confirmed',
      isConfirmed: true,
      widthCm: 22,
    });
    insertHistory(db, {
      shopId,
      productIdentityId: product.productIdentityId,
      lengthMm: 300,
      heightMm: 330,
      weightG: 340,
    });
    createCrossBorderOrderRepository(db).upsertRecord({
      shopId,
      orderId: 'bus-8101',
      platformOrder: 'posting-8101-1',
      offerId: product.offerId,
      packageWeightKg: 0.45,
      lengthCm: 40,
    });
    createCrossBorderOrderRepository(db).upsertRecord({
      shopId,
      orderId: 'bus-other-order',
      platformOrder: 'posting-other-order',
      offerId: product.offerId,
      packageWeightKg: 9,
      lengthCm: 900,
    });

    const preview = service.preview({ shopId, productId: product.productId });
    assert.equal(preview.ok, true);
    assert.equal(preview.automatic, false);
    assert.equal(preview.requiresConfirmation, true);
    assert.equal(preview.operationId, preview.previewId);
    assert.equal(preview.items[0].productName, `商品-${product.productId}`);
    assert.deepEqual(preview.items[0].currentValues, {
      lengthCm: 10,
      widthCm: 11,
      heightCm: 12,
      weightKg: 0.13,
    });
    assert.deepEqual(preview.items[0].proposedValues, {
      lengthCm: 40,
      widthCm: 22,
      heightCm: 33,
      weightKg: 0.45,
    });
    assert.equal(scheduler.writes.length, 0, 'preview must never write Ozon');
    assert.equal(scheduler.reads.length, 0, 'preview must never read Ozon as a hidden write step');
    assert.deepEqual(preview.targets[0].before, {
      lengthMm: 100,
      widthMm: 110,
      heightMm: 120,
      weightG: 130,
    });
    assert.deepEqual(preview.targets[0].after, {
      lengthMm: 400,
      widthMm: 220,
      heightMm: 330,
      weightG: 450,
    });
    assert.deepEqual(
      Object.fromEntries(preview.targets[0].changes.map((change) => [change.field, change.sourceType])),
      {
        length: 'cross_border_bus',
        width: 'manual',
        height: 'historical_order_import',
        weight: 'cross_border_bus',
      },
    );

    const confirmed = await service.confirm(exactConfirm(preview, shopId));
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.completed, true);
    assert.equal(confirmed.status, 'completed');
    assert.equal(confirmed.readBack.verified, true);
    assert.equal(confirmed.requiresRefresh, true);
    assert.equal(confirmed.operationId, preview.previewId);
    assert.equal(confirmed.verified, true);
    assert.equal(confirmed.items[0].readbackStatus, 'verified');
    assert.deepEqual(confirmed.items[0].readbackValues, confirmed.items[0].proposedValues);
    assert.equal(scheduler.writes.length, 1);
    assert.deepEqual(scheduler.reads.map((call) => call.endpointKey), [
      'products.infoList',
      'products.attributes',
    ]);

    const item = scheduler.writes[0].params.items[0];
    assert.deepEqual(Object.keys(item).sort(), [...HISTORICAL_DIMENSION_SYNC_IMPORT_ITEM_FIELDS].sort());
    assert.deepEqual(
      { weight: item.weight, length: item.depth, width: item.width, height: item.height },
      { weight: 450, length: 400, width: 220, height: 330 },
    );
    assert.equal(item.price, '100.00');
    assert.equal(item.old_price, '120.00');
    assert.equal(item.vat, '0.2');
    assert.doesNotMatch(JSON.stringify(item), /commission|acquiring|fee|cost|profit|stock/iu);

    const readback = db.prepare(`
      SELECT weight_g, length_mm, width_mm, height_mm
      FROM product_dimension_facts
      WHERE product_identity_id = ? AND source_type = 'ozon'
    `).get(getIdentityId(db, shopId, product.productId));
    assert.deepEqual({ ...readback }, {
      weight_g: 450,
      length_mm: 400,
      width_mm: 220,
      height_mm: 330,
    });
  } finally {
    db.close();
  }
});

test('blank historical fields preserve current Ozon dimensions and only selected changed fields enter the diff', () => {
  const { db, shopId, repository, scheduler, service } = createFixture();
  try {
    const product = addCompleteProduct(repository, { shopId });
    insertHistory(db, {
      shopId,
      productIdentityId: product.productIdentityId,
      lengthMm: 250,
      widthMm: null,
      heightMm: null,
      weightG: null,
    });
    const preview = service.preview({ shopId, offerId: product.offerId });
    assert.deepEqual(preview.targets[0].after, {
      lengthMm: 250,
      widthMm: 110,
      heightMm: 120,
      weightG: 130,
    });
    assert.deepEqual(preview.targets[0].changes.map((change) => change.field), ['length']);
    assert.equal(scheduler.writes.length, 0);
  } finally {
    db.close();
  }
});

test('historical dimension sync rejects request-supplied values and ambiguous product identities before write guard preview', () => {
  const { db, shopId, repository, scheduler, writeGuardService, service } = createFixture();
  try {
    const first = addCompleteProduct(repository, { shopId, productId: '8101', offerId: 'offer-8101', sku: 'same-sku' });
    addCompleteProduct(repository, { shopId, productId: '8102', offerId: 'offer-8102', sku: 'same-sku' });
    insertHistory(db, { shopId, productIdentityId: first.productIdentityId, lengthMm: 260 });

    assert.throws(
      () => service.preview({ shopId, productId: '8101', lengthMm: 999 }),
      (error) => error.code === 'HISTORICAL_DIMENSION_SYNC_EXTERNAL_VALUE_FORBIDDEN',
    );
    assert.throws(
      () => service.preview({ shopId, sku: 'same-sku' }),
      (error) => error.code === 'HISTORICAL_DIMENSION_SYNC_PRODUCT_AMBIGUOUS',
    );
    assert.equal(writeGuardService.countOwnerPreviews(shopId), 0);
    assert.equal(scheduler.writes.length, 0);
  } finally {
    db.close();
  }
});

test('preview fails closed when current Ozon facts cannot construct a complete product item', () => {
  const { db, shopId, repository, scheduler, writeGuardService, service } = createFixture();
  try {
    const product = addCompleteProduct(repository, { shopId, vat: '' });
    insertHistory(db, { shopId, productIdentityId: product.productIdentityId, lengthMm: 260 });
    assert.throws(
      () => service.preview({ shopId, productId: product.productId }),
      (error) => (
        error.code === 'HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING'
        && error.details?.field === 'vat'
      ),
    );
    assert.equal(writeGuardService.countOwnerPreviews(shopId), 0);
    assert.equal(scheduler.writes.length, 0);
  } finally {
    db.close();
  }
});

test('confirm rejects stale source facts and payload/real-write overrides without submitting Ozon', async () => {
  const { db, shopId, repository, scheduler, service } = createFixture();
  try {
    const product = addCompleteProduct(repository, { shopId });
    insertHistory(db, { shopId, productIdentityId: product.productIdentityId, lengthMm: 260 });
    const overridePreview = service.preview({ shopId, productId: product.productId });
    await assert.rejects(
      () => service.confirm({ ...exactConfirm(overridePreview, shopId), realWrite: false }),
      (error) => error.code === 'HISTORICAL_DIMENSION_SYNC_CONFIRM_OVERRIDE_FORBIDDEN',
    );
    assert.equal(scheduler.writes.length, 0);

    const stalePreview = service.preview({ shopId, productId: product.productId });
    db.prepare(`
      UPDATE historical_order_facts
      SET length_mm = 270, row_hash = 'changed', updated_at = '2026-07-17T09:00:00.000Z'
      WHERE shop_id = ? AND product_identity_id = ?
    `).run(shopId, getIdentityId(db, shopId, product.productId));
    await assert.rejects(
      () => service.confirm(exactConfirm(stalePreview, shopId)),
      (error) => error.code === 'HISTORICAL_DIMENSION_SYNC_PREVIEW_STALE',
    );
    assert.equal(scheduler.writes.length, 0);
  } finally {
    db.close();
  }
});

test('a submitted write with mismatching Ozon dimensions is never marked completed', async () => {
  const { db, shopId, repository, scheduler, service } = createFixture({ readback: 'mismatch' });
  try {
    const product = addCompleteProduct(repository, { shopId });
    insertHistory(db, { shopId, productIdentityId: product.productIdentityId, lengthMm: 260 });
    const preview = service.preview({ shopId, productId: product.productId, fields: ['length'] });
    const result = await service.confirm(exactConfirm(preview, shopId));

    assert.equal(scheduler.writes.length, 1);
    assert.equal(result.ok, true, 'the remote write happened, but completion is a separate readback verdict');
    assert.equal(result.completed, false);
    assert.equal(result.status, 'readback_mismatch');
    assert.equal(result.readBack.verified, false);
    assert.equal(result.verified, false);
    assert.equal(result.items[0].readbackStatus, 'mismatch');
    assert.equal(result.items[0].readbackVerified, false);
    assert.equal(result.items[0].readbackValues.lengthCm, 26.1);
    assert.equal(result.requiresRefresh, false);
    assert.equal(result.completedAt, null);
    assert.doesNotMatch(result.message, /回传完成/u);
  } finally {
    db.close();
  }
});

test('frontend import selection is bound to a completed committed row and operationId alias', async () => {
  const { db, shopId, repository, scheduler, service } = createFixture();
  try {
    const product = addCompleteProduct(repository, { shopId });
    const productIdentityId = getIdentityId(db, shopId, product.productId);
    insertHistory(db, { shopId, productIdentityId, lengthMm: 260 });
    insertCompletedImportSelection(db, { shopId, productIdentityId });

    const preview = service.preview({
      shopId,
      importId: 'history-import-1',
      items: [{
        rowIndex: 0,
        orderNumber: 'posting-8101-1',
        productIdentityId,
        productId: product.productId,
      }],
    });
    assert.equal(preview.items[0].source.importId, 'history-import-1');
    assert.equal(preview.items[0].source.orderNumber, 'posting-8101-1');
    assert.equal(preview.items[0].selectionKey, `0:${productIdentityId}`);

    await assert.rejects(
      () => service.confirm({
        shopId,
        operationId: preview.operationId,
        previewFingerprint: preview.previewFingerprint,
      }),
      (error) => error.code === 'HISTORICAL_DIMENSION_SYNC_CONFIRMATION_REQUIRED',
    );
    assert.equal(scheduler.writes.length, 0);

    const result = await service.confirm({
      shopId,
      operationId: preview.operationId,
      previewFingerprint: preview.previewFingerprint,
      confirm: true,
    });
    assert.equal(result.completed, true);
    assert.equal(result.operationId, preview.operationId);
    assert.equal(scheduler.writes.length, 1);
  } finally {
    db.close();
  }
});

test('frontend import selection fails closed when row identity does not match', () => {
  const { db, shopId, repository, scheduler, writeGuardService, service } = createFixture();
  try {
    const product = addCompleteProduct(repository, { shopId });
    const other = addCompleteProduct(repository, {
      shopId,
      productId: '8102',
      offerId: 'offer-8102',
      sku: '98102',
    });
    const productIdentityId = getIdentityId(db, shopId, product.productId);
    insertHistory(db, { shopId, productIdentityId, lengthMm: 260 });
    insertCompletedImportSelection(db, {
      shopId,
      productIdentityId: getIdentityId(db, shopId, other.productId),
      productId: other.productId,
      offerId: other.offerId,
      sku: other.sku,
    });
    assert.throws(
      () => service.preview({
        shopId,
        importId: 'history-import-1',
        items: [{
          rowIndex: 0,
          orderNumber: 'posting-8101-1',
          productIdentityId,
          productId: product.productId,
        }],
      }),
      (error) => error.code === 'HISTORICAL_DIMENSION_SYNC_IMPORT_SELECTION_MISMATCH',
    );
    assert.equal(writeGuardService.countOwnerPreviews(shopId), 0);
    assert.equal(scheduler.writes.length, 0);
  } finally {
    db.close();
  }
});
