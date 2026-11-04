import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import { createHistoricalProductImportService } from '../../backup/historicalProductImportService.js';
import { createProductRepository } from '../../db/repositories/productRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createProductSummaryService } from './productSummaryService.js';

test('product support exposes user cost fallback without overwriting official Ozon fields or a higher source-link cost', () => {
  const db = createMigratedTestDb();
  try {
    saveUnitShop(createShopRepository(db), 'shop-cost-support');
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId: 'shop-cost-support',
      rows: [{
        product_id: '8101',
        offer_id: 'cost-offer-1',
        sku: '98101',
        name: 'Official product',
        price: '99',
        stocks: [{ present: 7 }],
      }],
    });
    const identity = db.prepare(`
      SELECT product_key, product_id, offer_id, sku
      FROM ozon_products WHERE shop_id = ? AND product_id = ?
    `).get('shop-cost-support', '8101');
    const historical = createHistoricalProductImportService({ db });
    const preview = historical.preflight({
      shopId: 'shop-cost-support',
      conflictMode: 'preserve',
      rows: [{
        productId: '8101',
        purchaseCostCny: '10',
        crossBorderCostCny: '2',
        domesticFreightCny: '3',
        otherCostCny: '4',
      }],
    });
    historical.confirm({
      shopId: 'shop-cost-support',
      importId: preview.importId,
      previewFingerprint: preview.previewFingerprint,
      conflictMode: 'preserve',
    });

    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO product_manual_cost_profiles (
        id, shop_id, product_key, product_id, offer_id, sku, source_type,
        purchase_cost_minor, packaging_cost_minor, currency_code, note,
        row_hash, observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 3000, 100, 'CNY', ?, ?, ?, ?, ?)
    `).run(
      'manual-cost-support-1',
      'shop-cost-support',
      identity.product_key,
      identity.product_id,
      identity.offer_id,
      identity.sku,
      'manual value',
      'manual-cost-support-hash',
      timestamp,
      timestamp,
      timestamp,
    );
    repository.upsertProductSourceLinks({
      shopId: 'shop-cost-support',
      productKey: identity.product_key,
      productId: identity.product_id,
      offerId: identity.offer_id,
      sku: identity.sku,
      primaryIndex: 0,
      links: [{
        url: 'https://supplier.example/product/8101',
        platform: 'supplier',
        priceValue: 55,
        currencyCode: 'CNY',
      }],
    });

    const product = repository.listProducts({
      shopId: 'shop-cost-support',
      scope: 'software_all',
      pageSize: 10,
    }).rows[0];
    assert.equal(product.priceValue, 99);
    assert.equal(product.stockValue, 7);
    assert.equal(product.sourcePurchaseCostCny, 55);
    assert.equal(product.purchasePriceValue, 55);
    assert.equal(product.purchaseCostCny, 55);
    assert.equal(product.manualCostProfile.purchaseCostCny, 30);
    assert.equal(product.manualCostProfile.crossBorderCostCny, 2);
    assert.equal(product.manualCostProfile.domesticFreightCny, 3);
    assert.equal(product.manualCostProfile.packagingCostCny, 1);
    assert.equal(product.manualCostProfile.otherCostCny, 4);
    assert.equal(product.manualCostProfile.fieldSources.purchaseCostCny, 'manual');
    assert.equal(product.manualCostProfile.fieldSources.crossBorderCostCny, 'historical_import');
    assert.equal(product.manualCostProfiles.length, 2);

    const summary = createProductSummaryService(db).readSummary({
      shopId: 'shop-cost-support',
      scope: 'software_all',
      pageSize: 10,
    }).rows[0];
    assert.equal(summary.priceValue, 99);
    assert.equal(summary.sourcePurchaseCostCny, 55);
    assert.equal(summary.purchasePriceValue, 55);
    assert.equal(summary.manualCostProfile.purchaseCostCny, 30);
    assert.equal(summary.crossBorderCostCny, 2);
    assert.equal(summary.domesticFreightCny, 3);
    assert.equal(summary.packagingCostCny, 1);
    assert.equal(summary.otherCostCny, 4);
  } finally {
    db.close();
  }
});
