import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductCanonicalFactRepository } from '../src/db/repositories/productCanonicalFactRepository.js';
import { createProductRepository } from '../src/db/repositories/productRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function createFixture(id) {
  const db = createMigratedTestDb();
  const shopId = saveUnitShop(createShopRepository(db), id);
  const products = createProductRepository(db);
  const facts = createProductCanonicalFactRepository(db);
  return { db, shopId, products, facts };
}

test('normalized product facts preserve units, per-mode fee evidence and explicit stock zero', () => {
  const { db, shopId, products } = createFixture('shop_product_facts_units');
  products.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: [{
      product_id: 601,
      offer_id: 'offer-601',
      sku: 'sku-601',
      name: '规范事实商品',
      visibility: 'ARCHIVED',
    }],
  });
  products.mergeProductInfoRows({
    shopId,
    expectedProductIds: ['601'],
    provenance: {
      operationId: 'op-info-601',
      contractVersion: 'products.infoList@3',
      mapperVersion: 'product-info-mapper-v3',
      responseHash: 'response-info-601',
      runId: 'run-601',
      snapshotId: 'snapshot-601',
    },
    rows: [{
      id: 601,
      offer_id: 'offer-601',
      name: '规范事实商品详情',
      weight: 200,
      weight_unit: 'g',
      width: 100,
      height: 200,
      depth: 300,
      dimension_unit: 'mm',
    }],
  });
  products.mergeProductPriceRows({
    shopId,
    expectedProductIds: ['601'],
    provenance: {
      operationId: 'op-price-601',
      contractVersion: 'products.prices@5',
      mapperVersion: 'product-price-mapper-v5',
      responseHash: 'response-price-601',
      runId: 'run-601',
      snapshotId: 'snapshot-601',
    },
    rows: [{
      product_id: 601,
      offer_id: 'offer-601',
      price: { marketing_seller_price: '20.50', currency_code: 'RUB' },
      commissions: {
        sales_percent_fbo: 12,
        sales_percent_fbs: 0,
        sales_percent_fbp: -1,
      },
      acquiring: 0,
    }],
  });
  products.mergeProductStockRows({
    shopId,
    expectedProductIds: ['601'],
    provenance: {
      operationId: 'op-stock-601',
      contractVersion: 'products.stocks@2',
      mapperVersion: 'product-stock-mapper-v2',
      responseHash: 'response-stock-601',
      runId: 'run-601',
      snapshotId: 'snapshot-601',
    },
    rows: [{ product_id: 601, offer_id: 'offer-601', stocks: [{ present: 0 }] }],
  });

  const identity = db.prepare('SELECT * FROM product_identities WHERE shop_id = ? AND product_id = ?').get(shopId, '601');
  assert.equal(identity.offer_id, 'offer-601');
  assert.equal(identity.run_id, 'run-601');

  const price = db.prepare('SELECT * FROM product_price_facts WHERE product_identity_id = ?').get(identity.product_identity_id);
  assert.equal(price.amount_minor, 2050);
  assert.equal(price.currency_code, 'CNY');
  assert.equal(price.operation_id, 'op-price-601');
  assert.equal(price.contract_version, 'products.prices@5');
  assert.equal(price.response_hash, 'response-price-601');

  const dimensions = db.prepare('SELECT * FROM product_dimension_facts WHERE product_identity_id = ? AND source_type = ?').get(identity.product_identity_id, 'ozon');
  assert.deepEqual(
    [dimensions.weight_g, dimensions.length_mm, dimensions.width_mm, dimensions.height_mm],
    [200, 300, 100, 200],
  );

  const commissions = db.prepare('SELECT fulfillment_type, rate_ppm, status FROM product_commission_facts WHERE product_identity_id = ? ORDER BY fulfillment_type').all(identity.product_identity_id).map((row) => ({ ...row }));
  assert.deepEqual(commissions, [
    { fulfillment_type: 'FBO', rate_ppm: 120000, status: 'returned' },
    { fulfillment_type: 'FBP', rate_ppm: null, status: 'contract_invalid' },
    { fulfillment_type: 'FBS', rate_ppm: null, status: 'unavailable' },
    { fulfillment_type: 'RFBS', rate_ppm: null, status: 'not_returned' },
  ]);

  const acquiring = db.prepare('SELECT * FROM product_acquiring_facts WHERE product_identity_id = ?').get(identity.product_identity_id);
  assert.equal(acquiring.fee_minor, null);
  assert.equal(acquiring.rate_ppm, null);
  assert.equal(acquiring.status, 'unavailable');

  const stock = db.prepare('SELECT * FROM product_stock_facts WHERE product_identity_id = ?').get(identity.product_identity_id);
  assert.equal(stock.present_quantity, 0);
  assert.equal(stock.status, 'returned');
  assert.equal(stock.source_reason, 'ozon-explicit-zero-stock');

  const observations = db.prepare('SELECT facet, status, operation_id, response_hash FROM product_facet_observations WHERE product_identity_id = ? AND facet IN (?, ?) ORDER BY facet').all(identity.product_identity_id, 'prices', 'stocks').map((row) => ({ ...row }));
  assert.deepEqual(observations, [
    { facet: 'prices', status: 'returned', operation_id: 'op-price-601', response_hash: 'response-price-601' },
    { facet: 'stocks', status: 'returned', operation_id: 'op-stock-601', response_hash: 'response-stock-601' },
  ]);
});

test('weak fee and stock observations retain prior strong values as stale_previous', () => {
  const { db, shopId, products } = createFixture('shop_product_facts_weak');
  products.upsertProducts({
    shopId,
    rows: [{ product_id: 602, offer_id: 'offer-602', name: '弱覆盖保护' }],
  });
  products.mergeProductPriceRows({
    shopId,
    expectedProductIds: ['602'],
    rows: [{
      product_id: 602,
      offer_id: 'offer-602',
      price: '31.00',
      commissions: { sales_percent_rfbs: 13 },
      acquiring: 0.6,
    }],
  });
  products.mergeProductStockRows({
    shopId,
    expectedProductIds: ['602'],
    rows: [{ product_id: 602, offer_id: 'offer-602', stocks: [{ present: 9 }] }],
  });
  products.mergeProductPriceRows({
    shopId,
    expectedProductIds: ['602'],
    rows: [{
      product_id: 602,
      offer_id: 'offer-602',
      price: '31.00',
      commissions: { sales_percent_rfbs: 0 },
      acquiring: 0,
    }],
  });
  products.recordProductHydrationFacetObservations({
    shopId,
    productIds: ['602'],
    facet: 'stocks',
    status: 'not_returned',
    endpointKey: 'products.stocks',
    sourceReason: 'ozon-expected-entity-not-returned',
  });

  const identityId = db.prepare('SELECT product_identity_id FROM product_identities WHERE shop_id = ? AND product_id = ?').get(shopId, '602').product_identity_id;
  const commission = { ...db.prepare("SELECT rate_ppm, status FROM product_commission_facts WHERE product_identity_id = ? AND fulfillment_type = 'RFBS'").get(identityId) };
  assert.deepEqual(commission, { rate_ppm: 130000, status: 'stale_previous' });
  const acquiring = { ...db.prepare('SELECT fee_minor, status FROM product_acquiring_facts WHERE product_identity_id = ?').get(identityId) };
  assert.deepEqual(acquiring, { fee_minor: 60, status: 'stale_previous' });
  const stock = { ...db.prepare('SELECT present_quantity, status FROM product_stock_facts WHERE product_identity_id = ?').get(identityId) };
  assert.deepEqual(stock, { present_quantity: 9, status: 'stale_previous' });
});

test('confirmed manual or supplier material wins over Ozon dimensions', () => {
  const { shopId, products, facts } = createFixture('shop_product_facts_priority');
  const insert = products.upsertProducts({
    shopId,
    rows: [{ product_id: 603, offer_id: 'offer-603', name: '材积优先级' }],
  });
  products.mergeProductInfoRows({
    shopId,
    rows: [{
      id: 603,
      offer_id: 'offer-603',
      weight: 1,
      weight_unit: 'kg',
      width: 10,
      height: 20,
      depth: 30,
      dimension_unit: 'cm',
    }],
  });
  products.upsertProductMaterialProfile({
    shopId,
    productKey: insert.productKeys[0],
    productId: '603',
    offerId: 'offer-603',
    source: 'supplier-confirmed',
    isConfirmed: true,
    weightKg: 2.5,
    widthCm: 40,
    heightCm: 50,
    depthCm: 60,
  });

  const effective = facts.getEffectiveDimensions({ shopId, productId: '603' });
  assert.equal(effective.sourceType, 'supplier-confirmed');
  assert.deepEqual(
    [effective.weight_g, effective.length_mm, effective.width_mm, effective.height_mm],
    [2500, 600, 400, 500],
  );
  assert.deepEqual(facts.projectRows({ shopId }), { projected: 0, productIdentityIds: [] });
});

test('product list and edit DTO read normalized facts instead of a corrupted legacy compatibility row', () => {
  const { db, shopId, products } = createFixture('shop_product_facts_read_path');
  products.upsertProducts({
    shopId,
    visibility: 'IN_SALE',
    rows: [{ product_id: 604, offer_id: 'offer-604', name: '列表基础名', visibility: 'IN_SALE' }],
  });
  products.mergeProductInfoRows({
    shopId,
    rows: [{
      id: 604,
      offer_id: 'offer-604',
      name: '规范详情名',
      weight: 200,
      weight_unit: 'g',
      width: 100,
      height: 200,
      depth: 300,
      dimension_unit: 'mm',
    }],
  });
  products.mergeProductPriceRows({
    shopId,
    rows: [{
      product_id: 604,
      offer_id: 'offer-604',
      price: '20.50',
      commissions: { sales_percent_fbo: 12, sales_percent_fbs: 0 },
      acquiring: 0,
    }],
  });
  products.mergeProductStockRows({
    shopId,
    rows: [{ product_id: 604, offer_id: 'offer-604', stocks: [{ present: 0 }] }],
  });
  products.mergeProductPictureRows({
    shopId,
    rows: [{ product_id: 604, offer_id: 'offer-604', images: ['https://img/canonical-604.jpg'] }],
  });
  products.mergeProductAttributeRows({
    shopId,
    rows: [{
      id: 604,
      offer_id: 'offer-604',
      attributes: [{ id: 1, name: 'Brand', values: [{ value: 'Canonical' }] }],
    }],
  });
  products.upsertProducts({
    shopId,
    visibility: 'ARCHIVED',
    rows: [{
      product_id: 605,
      offer_id: 'offer-605',
      name: '第二个规范商品',
      visibility: 'ARCHIVED',
      archived: true,
    }],
  });
  products.mergeProductPriceRows({
    shopId,
    rows: [{ product_id: 605, offer_id: 'offer-605', price: '1.00' }],
  });

  db.prepare(`
    UPDATE ozon_products
       SET name = '损坏的旧读模型', visibility = 'ARCHIVED', status_label = '已下架',
           price_value = 999, stock_value = 999,
           commission_percent = 99, commission_percent_fbo = 99,
           commission_status = 'returned', acquiring_fee_value = 99,
           weight_kg = 99, width_cm = 99, height_cm = 99, depth_cm = 99,
           images_json = '["https://img/legacy-corrupt.jpg"]',
           attributes_json = '[{"name":"LegacyCorrupt"}]'
     WHERE shop_id = ? AND product_id = ?
  `).run(shopId, '604');
  db.prepare(`
    UPDATE ozon_products
       SET name = '规范详情名', visibility = 'IN_SALE', status_label = '出售中',
           price_value = 9999
     WHERE shop_id = ? AND product_id = ?
  `).run(shopId, '605');

  const row = products.listProducts({ shopId, productIds: ['604'], pageSize: 20 }).rows[0];
  assert.equal(row.factSource, 'normalized-product-facts-v1');
  assert.equal(row.name, '规范详情名');
  assert.equal(row.priceValue, 20.5);
  assert.equal(row.stockValue, 0);
  assert.equal(row.weightKg, 0.2);
  assert.equal(row.widthCm, 10);
  assert.deepEqual(row.images, ['https://img/canonical-604.jpg']);
  assert.equal(row.attributes[0].name, 'Brand');
  assert.equal(row.commissionPercents.fbo, 12);
  assert.equal(row.commissionStatuses.fbo, 'returned');
  assert.equal(row.commissionStatuses.fbs, 'unavailable');
  assert.equal(row.commissionStatuses.rfbs, 'not_returned');
  assert.equal(row.acquiringFeeValue, null);
  assert.equal(row.acquiringStatus, 'unavailable');
  assert.equal(row.facetObservations.prices.status, 'returned');

  const canonicalVisibility = products.listProducts({
    shopId,
    visibility: 'IN_SALE',
    pageSize: 20,
  });
  assert.deepEqual(canonicalVisibility.rows.map((item) => item.productId), ['604']);
  assert.equal(canonicalVisibility.counts.IN_SALE, 1);
  assert.equal(canonicalVisibility.counts.ARCHIVED, 1);
  assert.deepEqual(
    products.listProducts({ shopId, keyword: '规范详情名', pageSize: 20 }).rows
      .map((item) => item.productId),
    ['604'],
  );
  assert.deepEqual(
    products.listProducts({ shopId, sort: 'price_asc', pageSize: 1, page: 1 }).rows
      .map((item) => item.productId),
    ['605'],
  );
  assert.deepEqual(
    products.listProducts({ shopId, sort: 'price_desc', pageSize: 1, page: 1 }).rows
      .map((item) => item.productId),
    ['604'],
  );
});
