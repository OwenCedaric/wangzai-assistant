import test from "node:test";
import assert from "node:assert/strict";

import { createProductRepository } from "../src/db/repositories/productRepository.js";
import { createShopRepository } from "../src/db/repositories/shopRepository.js";
import { createProductsService } from "../src/domain/products/productsService.js";
import { createMigratedTestDb, saveUnitShop } from "./testDb.js";

function seedProduct(repository, {
  shopId,
  productId,
  offerId,
  visibility = "IN_SALE",
  stocks,
  material,
  source,
}) {
  repository.upsertProducts({
    shopId,
    visibility,
    rows: [{
      product_id: productId,
      offer_id: offerId,
      name: `product-${productId}`,
      visibility,
      archived: visibility === "ARCHIVED",
    }],
  });
  if (stocks !== undefined) {
    repository.mergeProductStockRows({
      shopId,
      expectedProductIds: [String(productId)],
      rows: [{ product_id: productId, offer_id: offerId, stocks }],
    });
    repository.mergeProductWarehouseStockRows({
      shopId,
      expectedOfferIds: [offerId],
      rows: [{ product_id: productId, offer_id: offerId, stocks }],
      provenance: {
        contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
      },
    });
  }
  if (material) {
    repository.upsertProductMaterialProfile({
      shopId,
      productId: String(productId),
      offerId,
      source: material,
      weightKg: 1,
      widthCm: 10,
      heightCm: 10,
      depthCm: 10,
    });
  }
  if (source) {
    repository.upsertProductSourceLinks({
      shopId,
      productId: String(productId),
      offerId,
      links: [{ slotIndex: 0, isPrimary: true, ...source }],
    });
  }
}

test("warehouse picker projection reads one compact 5000-row SQLite page", () => {
  const db = createMigratedTestDb();
  const shops = createShopRepository(db);
  const shopId = saveUnitShop(shops, "shop_warehouse_picker");
  const products = createProductRepository(db);
  seedProduct(products, {
    shopId,
    productId: 101,
    offerId: "offer-101",
    stocks: [{ warehouse_id: "warehouse-1", present: 8 }],
    material: "supplier-confirmed",
    source: { platform: "1688", url: "https://detail.1688.com/offer/101.html" },
  });

  const service = createProductsService({ db, shopRepository: shops });
  const page = service.readCache({
    shopId,
    visibility: "ALL",
    projection: "warehouse-picker",
    pageSize: 5000,
  });

  assert.equal(page.ok, true);
  assert.equal(page.projection, "warehouse-picker");
  assert.equal(page.pageSize, 5000);
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].productId, "101");
  assert.equal(page.rows[0].warehouseStocks[0].warehouseId, "warehouse-1");
  assert.equal("attributes" in page.rows[0], false);
  assert.equal("facetObservations" in page.rows[0], false);
  assert.equal("materialCandidates" in page.rows[0], false);
  assert.equal("sourceLinks" in page.rows[0], false);
  db.close();
});

test("canonical product query applies advanced filters before total, counts and pagination", () => {
  const db = createMigratedTestDb();
  const shops = createShopRepository(db);
  const shopA = saveUnitShop(shops, "shop_query_filter_a");
  const shopB = saveUnitShop(shops, "shop_query_filter_b");
  const products = createProductRepository(db);

  seedProduct(products, {
    shopId: shopA,
    productId: 101,
    offerId: "offer-101",
    stocks: [
      { warehouse_id: "default-warehouse", present: 2 },
      { warehouse_id: "overflow-warehouse", present: 3 },
    ],
    material: "cross-border-bus",
    source: { platform: "pdd", url: "https://mobile.yangkeduo.com/goods.html?id=101" },
  });
  seedProduct(products, {
    shopId: shopA,
    productId: 102,
    offerId: "offer-102",
    visibility: "ARCHIVED",
    stocks: [{ warehouse_id: "default-warehouse", present: 0 }],
    material: "supplier-confirmed",
  });
  seedProduct(products, {
    shopId: shopB,
    productId: 201,
    offerId: "offer-201",
    source: { platform: "1688", url: "https://detail.1688.com/offer/201.html" },
  });
  seedProduct(products, {
    shopId: shopB,
    productId: 202,
    offerId: "offer-202",
    stocks: [],
  });

  // Compatibility rows once derived from v4 fulfillment aggregates are not
  // exact seller warehouses. They must not affect any warehouse filter before
  // a later product projection has had a chance to clean them up.
  const legacyIdentity = db.prepare(`
    SELECT product_identity_id FROM product_identities
     WHERE shop_id = ? AND product_id = '201'
  `).get(shopB).product_identity_id;
  const insertLegacyWarehouse = db.prepare(`
    INSERT INTO product_warehouse_stock_facts (
      product_identity_id, shop_id, warehouse_key, warehouse_id,
      fulfillment_type, present_quantity, reserved_quantity,
      contract_version, mapper_version, observed_at, row_hash, updated_at
    ) VALUES (?, ?, ?, ?, 'RFBS', ?, NULL,
              'ozon-products-stocks-v4', 'legacy-aggregate-v1',
              '2026-07-17T00:00:00.000Z', ?, '2026-07-17T00:00:00.000Z')
  `);
  insertLegacyWarehouse.run(
    legacyIdentity,
    shopB,
    "legacy-a",
    "legacy-a",
    2,
    "legacy-a-hash",
  );
  insertLegacyWarehouse.run(
    legacyIdentity,
    shopB,
    "legacy-b",
    "legacy-b",
    3,
    "legacy-b-hash",
  );

  const crossShopPage = products.listProducts({
    shopIds: [shopA, shopB],
    pageSize: 2,
    page: 1,
    sort: "identity",
  });
  assert.equal(crossShopPage.total, 4);
  assert.equal(crossShopPage.rows.length, 2);
  assert.deepEqual(crossShopPage.rows.map((row) => row.productId), ["101", "102"]);
  assert.equal(crossShopPage.counts.ALL, 4);

  const pddCrossBorder = products.listProducts({
    shopIds: [shopA, shopB],
    materialSources: ["cross-border"],
    sourceStatuses: ["pdd"],
    warehouseFilters: ["default", "multi"],
    defaultWarehouseId: "default-warehouse",
    stockFilters: ["positive"],
    productStatuses: ["出售中"],
    pageSize: 20,
  });
  assert.equal(pddCrossBorder.total, 1);
  assert.equal(pddCrossBorder.counts.ALL, 1);
  assert.equal(pddCrossBorder.counts.IN_SALE, 1);
  assert.deepEqual(pddCrossBorder.rows.map((row) => row.productId), ["101"]);

  const zeroSupplier = products.listProducts({
    shopId: shopA,
    materialSources: ["supplier"],
    stockFilters: ["zero"],
    warehouseIds: ["default-warehouse"],
    sourceStatuses: ["missing"],
    pageSize: 20,
  });
  assert.equal(zeroSupplier.total, 1);
  assert.equal(zeroSupplier.counts.ALL, 1);
  assert.equal(zeroSupplier.counts.ARCHIVED, 1);
  assert.equal(zeroSupplier.rows[0].productId, "102");

  const missingFacts = products.listProducts({
    shopIds: [shopA, shopB],
    materialSources: ["missing"],
    warehouseFilters: ["missing"],
    stockFilters: ["missing"],
    sourceStatuses: ["1688"],
    pageSize: 20,
  });
  assert.equal(missingFacts.total, 1);
  assert.equal(missingFacts.counts.ALL, 1);
  assert.equal(missingFacts.rows[0].productId, "201");

  const legacyWarehouseIdMustNotMatch = products.listProducts({
    shopId: shopB,
    warehouseIds: ["legacy-a"],
    pageSize: 20,
  });
  assert.equal(legacyWarehouseIdMustNotMatch.total, 0);
  const legacyMultiMustNotMatch = products.listProducts({
    shopId: shopB,
    stockFilters: ["multi"],
    pageSize: 20,
  });
  assert.equal(legacyMultiMustNotMatch.total, 0);

  const explicitEmptyStock = products.listProducts({
    shopId: shopB,
    stockFilters: ["zero"],
    pageSize: 20,
  });
  assert.equal(explicitEmptyStock.total, 1);
  assert.equal(explicitEmptyStock.rows[0].productId, "202");
  assert.equal(explicitEmptyStock.rows[0].stockValue, 0);

  db.close();
});

test("product hot cache stores only exact single-shop reads and never mixed aggregates", () => {
  const db = createMigratedTestDb();
  const shops = createShopRepository(db);
  const shopA = saveUnitShop(shops, "shop_query_cache_a");
  const shopB = saveUnitShop(shops, "shop_query_cache_b");
  const repository = createProductRepository(db);
  seedProduct(repository, { shopId: shopA, productId: 301, offerId: "offer-301" });
  seedProduct(repository, { shopId: shopB, productId: 302, offerId: "offer-302" });

  const service = createProductsService({ db });
  service.readCache({ shopIds: [shopA, shopB], pageSize: 20 });
  service.readCache({ shopIds: [shopA, shopB], pageSize: 20 });
  assert.equal(service.countOwnerHotCache(shopA), 0);
  assert.equal(service.countOwnerHotCache(shopB), 0);

  service.readCache({ shopId: "all", pageSize: 20 });
  service.readCache({ shopId: "all", pageSize: 20 });
  assert.equal(service.countOwnerHotCache(shopA), 0);
  assert.equal(service.countOwnerHotCache(shopB), 0);

  service.readCache({ shopId: shopA, pageSize: 20 });
  service.readCache({ shopId: shopA, pageSize: 20 });
  assert.equal(service.countOwnerHotCache(shopA), 1);
  assert.equal(service.countOwnerHotCache(shopB), 0);
  assert.equal(service.invalidateOwnerHotCache(shopA).removed, 1);
  db.close();
});
