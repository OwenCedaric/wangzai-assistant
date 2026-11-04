import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryReconcileState } from "../src/backup/recoveryReconcileState.js";
import { createProductRepository } from "../src/db/repositories/productRepository.js";
import {
  PRODUCT_FULL_SYNC_VISIBILITIES,
  buildProductHydrationCacheKey,
  createProductsService,
} from "../src/domain/products/productsService.js";
import { createShopRepository } from "../src/db/repositories/shopRepository.js";
import { createApp } from "../src/app/createApp.js";
import { createOzonScheduler } from "../src/ozon/ozonScheduler.js";
import { createContinuousSyncService } from "../src/sync/continuousSyncService.js";
import {
  configureSoftwareCategoryNameService,
  resetSoftwareCategoryIndexForTests,
} from "../src/cache/catalog/softwareCategoryNameService.js";
import { createSharedCatalogService } from "../src/domain/catalog/sharedCatalogService.js";
import { createMigratedTestDb, saveUnitShop } from "./testDb.js";

function createFakeScheduler(responses = []) {
  const calls = [];
  return {
    calls,
    async executeReadOnly(input) {
      calls.push(input);
      const data = responses.shift() || { result: { items: [], last_id: "" } };
      return {
        ok: true,
        status: "success",
        data,
        jobId: `scheduler-${calls.length}`,
      };
    },
  };
}

async function waitForJobStatus(db, jobId, expectedStatus, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = db
      .prepare("SELECT status FROM ozon_request_jobs WHERE id = ?")
      .get(jobId);
    if (row?.status === expectedStatus) return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return db
    .prepare("SELECT status FROM ozon_request_jobs WHERE id = ?")
    .get(jobId);
}

test("product repository upserts by remote_hash and reads paged cache with counts", (context) => {
  const db = createMigratedTestDb();
  createSharedCatalogService(db).importCategoryTree({
    platform: "ozon",
    marketplace: "ozon",
    locale: "ZH_HANS",
    contractVersion: "ozon-description-category-v1",
    sourceKind: "test",
    sourceRef: "productsSync:software-category-fixture",
    treeData: {
      items: [{
        description_category_id: 17027465,
        category_name: "宠物用品",
        children: [{
          description_category_id: 17028669,
          category_name: "兽医药房（耗材）",
        }],
      }],
    },
  });
  configureSoftwareCategoryNameService({ db });
  context.after(() => resetSoftwareCategoryIndexForTests({ clearConfiguration: true }));
  const shopRepository = createShopRepository(db);
  saveUnitShop(shopRepository, "shop_products");
  const repository = createProductRepository(db);
  const first = repository.upsertProducts({
    shopId: "shop_products",
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 101,
        offer_id: "offer-101",
        sku: "sku-101",
        name: "商品 A",
        visibility: "IN_SALE",
        primary_image: "https://img/a.jpg",
        price: "12.50",
        stocks: { present: 8 },
      },
    ],
  });
  assert.equal(first.inserted, 1);
  const second = repository.upsertProducts({
    shopId: "shop_products",
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 101,
        offer_id: "offer-101",
        sku: "sku-101",
        name: "商品 A",
        visibility: "IN_SALE",
        primary_image: "https://img/a.jpg",
        price: "12.50",
        stocks: { present: 8 },
      },
    ],
  });
  assert.equal(second.unchanged, 1);
  const page = repository.listProducts({
    shopId: "shop_products",
    visibility: "IN_SALE",
    pageSize: 20,
  });
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].productId, "101");
  assert.equal(page.rows[0].stockValue, 8);
  assert.equal(page.counts.IN_SALE, 1);

  const categoryResult = repository.upsertProducts({
    shopId: "shop_products",
    visibility: "ALL",
    rows: [
      {
        product_id: 102,
        offer_id: "offer-102",
        name: "类目映射商品",
        description_category_id: 17028669,
      },
    ],
  });
  assert.equal(categoryResult.inserted, 1);
  const categoryPage = repository.listProducts({
    shopId: "shop_products",
    productIds: ["102"],
    pageSize: 20,
  });
  assert.equal(
    categoryPage.rows[0].categoryName,
    "宠物用品 > 兽医药房（耗材）",
  );
  assert.equal(categoryPage.rows[0].softwareCategoryName, "兽医药房（耗材）");
  assert.equal(categoryPage.rows[0].softwareCategoryRootName, "宠物用品");
});

test("product repository keeps all scope while using Ozon snapshot status evidence", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_scope");
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: "ARCHIVED",
    rows: [
      {
        product_id: 601,
        offer_id: "archived-601",
        name: "旧下架商品",
        visibility: "ARCHIVED",
        archived: true,
      },
    ],
  });
  repository.upsertProducts({
    shopId,
    visibility: "ALL",
    rows: [
      {
        product_id: 602,
        offer_id: "all-602",
        name: "全部快照商品",
        has_fbo_stocks: false,
        has_fbs_stocks: false,
      },
    ],
  });

  const allPage = repository.listProducts({
    shopId,
    visibility: "ALL",
    pageSize: 20,
  });
  assert.equal(allPage.total, 2);
  assert.equal(
    allPage.rows.some((row) => row.visibility === "ARCHIVED"),
    true,
  );
  const allScopeRow = allPage.rows.find((row) => row.productId === "602");
  assert.equal(allScopeRow.statusLabel, "未知状态");
  assert.deepEqual(allScopeRow.snapshotVisibilities, ["ALL"]);
  assert.equal(allPage.counts.ALL, 2);
  assert.equal(allPage.counts.TO_SUPPLY, 0);
  assert.equal(allPage.counts.ARCHIVED, 1);

  db.prepare(
    "UPDATE ozon_products SET status_label = '全部商品', visibility = 'ALL', stock_value = 0 WHERE product_id = '602'",
  ).run();
  const repairedPage = repository.listProducts({
    shopId,
    visibility: "ALL",
    pageSize: 20,
  });
  // Direct corruption of the retired compatibility row must not alter the
  // canonical DTO.  Normal writes re-project facts transactionally; ad-hoc
  // legacy SQL is deliberately invisible to the unique normalized read path.
  assert.equal(
    repairedPage.rows.find((row) => row.productId === "602").statusLabel,
    "未知状态",
  );
  assert.equal(repairedPage.counts.TO_SUPPLY, 0);

  db.prepare(
    `
    UPDATE ozon_products
    SET status_label = '', visibility = 'ALL', stock_value = NULL, snapshot_visibilities_json = '["ALL","TO_SUPPLY"]'
    WHERE product_id = '602'
  `,
  ).run();
  const snapshotMappedPage = repository.listProducts({
    shopId,
    visibility: "ALL",
    pageSize: 20,
  });
  const snapshotMappedRow = snapshotMappedPage.rows.find(
    (row) => row.productId === "602",
  );
  assert.equal(snapshotMappedRow.statusLabel, "未知状态");
  assert.equal(snapshotMappedRow.visibility, "ALL");
  assert.equal(snapshotMappedPage.counts.TO_SUPPLY, 0);

  const archivedPage = repository.listProducts({
    shopId,
    visibility: "ARCHIVED",
    pageSize: 20,
  });
  assert.equal(archivedPage.total, 1);
  assert.equal(archivedPage.rows[0].productId, "601");
});

test("product repository removes old archived snapshot when product returns to supply", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_archived_to_supply",
  );
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: "ARCHIVED",
    rows: [
      {
        product_id: 611,
        offer_id: "offer-611",
        name: "重新待销售",
        visibility: "ARCHIVED",
        archived: true,
      },
    ],
  });
  repository.upsertProducts({
    shopId,
    visibility: "TO_SUPPLY",
    rows: [
      {
        product_id: 611,
        offer_id: "offer-611",
        name: "重新待销售",
        visibility: "TO_SUPPLY",
      },
    ],
  });

  const page = repository.listProducts({
    shopId,
    visibility: "ALL",
    pageSize: 20,
  });
  const row = page.rows.find((item) => item.productId === "611");
  assert.equal(row.visibility, "TO_SUPPLY");
  assert.equal(row.statusLabel, "待销售");
  assert.equal(row.snapshotVisibilities.includes("ARCHIVED"), false);
  assert.equal(page.counts.TO_SUPPLY, 1);
  assert.equal(page.counts.ARCHIVED, 0);
});

test("product repository removes old archived snapshot when product returns in sale", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_archived_to_sale");
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: "ARCHIVED",
    rows: [
      {
        product_id: 612,
        offer_id: "offer-612",
        name: "重新出售中",
        visibility: "ARCHIVED",
        archived: true,
      },
    ],
  });
  repository.upsertProducts({
    shopId,
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 612,
        offer_id: "offer-612",
        name: "重新出售中",
        visibility: "IN_SALE",
      },
    ],
  });

  const page = repository.listProducts({
    shopId,
    visibility: "ALL",
    pageSize: 20,
  });
  const row = page.rows.find((item) => item.productId === "612");
  assert.equal(row.visibility, "IN_SALE");
  assert.equal(row.statusLabel, "出售中");
  assert.equal(row.snapshotVisibilities.includes("ARCHIVED"), false);
  assert.equal(page.counts.IN_SALE, 1);
  assert.equal(page.counts.ARCHIVED, 0);
});

test("product repository removes weak snapshots when strong status returns", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_sale_to_archived");
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 613,
        offer_id: "offer-613",
        name: "重新下架",
        visibility: "IN_SALE",
      },
    ],
  });
  repository.upsertProducts({
    shopId,
    visibility: "ARCHIVED",
    rows: [
      {
        product_id: 613,
        offer_id: "offer-613",
        name: "重新下架",
        visibility: "ARCHIVED",
        archived: true,
      },
    ],
  });

  const page = repository.listProducts({
    shopId,
    visibility: "ALL",
    pageSize: 20,
  });
  const row = page.rows.find((item) => item.productId === "613");
  assert.equal(row.visibility, "ARCHIVED");
  assert.equal(row.statusLabel, "已下架");
  assert.equal(row.snapshotVisibilities.includes("IN_SALE"), false);
  assert.equal(row.snapshotVisibilities.includes("TO_SUPPLY"), false);
  assert.equal(page.counts.ARCHIVED, 1);
  assert.equal(page.counts.IN_SALE, 0);
});

test("product repository trusts explicit Ozon visibility before stock heuristics", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_status_exact");
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: "STATE_FAILED",
    rows: [
      {
        product_id: 801,
        offer_id: "failed-801",
        name: "错误品",
        has_fbo_stocks: false,
        has_fbs_stocks: false,
      },
    ],
  });
  let failedPage = repository.listProducts({
    shopId,
    visibility: "STATE_FAILED",
    pageSize: 20,
  });
  assert.equal(failedPage.total, 1);
  assert.equal(failedPage.rows[0].statusLabel, "错误品");
  assert.equal(failedPage.counts.STATE_FAILED, 1);
  assert.equal(failedPage.counts.TO_SUPPLY, 0);

  repository.upsertProducts({
    shopId,
    visibility: "ALL",
    rows: [
      {
        product_id: 801,
        offer_id: "failed-801",
        name: "错误品",
        has_fbo_stocks: false,
        has_fbs_stocks: false,
      },
    ],
  });
  failedPage = repository.listProducts({
    shopId,
    visibility: "STATE_FAILED",
    pageSize: 20,
  });
  assert.equal(failedPage.total, 1);
  assert.equal(failedPage.rows[0].statusLabel, "错误品");
  assert.deepEqual(failedPage.rows[0].snapshotVisibilities, [
    "STATE_FAILED",
    "ALL",
  ]);
  assert.equal(failedPage.counts.STATE_FAILED, 1);
  assert.equal(failedPage.counts.TO_SUPPLY, 0);

  repository.upsertProducts({
    shopId,
    visibility: "VALIDATION_STATE_FAIL",
    rows: [
      {
        product_id: 801,
        offer_id: "failed-801",
        name: "错误品",
        has_fbo_stocks: false,
        has_fbs_stocks: false,
      },
    ],
  });
  const validationPage = repository.listProducts({
    shopId,
    visibility: "VALIDATION_STATE_FAIL",
    pageSize: 20,
  });
  assert.equal(validationPage.total, 1);
  assert.equal(validationPage.counts.STATE_FAILED, 0);
  assert.equal(validationPage.counts.VALIDATION_STATE_FAIL, 1);
});

test("products service accepts sync job and writes products through scheduler in background", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_sync");
  const scheduler = createFakeScheduler([
    {
      result: {
        items: [
          {
            product_id: 201,
            offer_id: "offer-201",
            name: "同步商品",
            visibility: "IN_SALE",
          },
        ],
        last_id: "",
      },
    },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 100,
    maxPages: 1,
    hydrate: false,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.domain, "products");
  await Promise.all(pending);

  const cache = service.readCache({
    shopId,
    visibility: "IN_SALE",
    pageSize: 20,
  });
  assert.equal(cache.rows.length, 1);
  assert.equal(cache.rows[0].offerId, "offer-201");
  assert.equal(scheduler.calls[0].endpointKey, "products.list");
  assert.equal(scheduler.calls[0].domain, "products");
});

test("recovery reconcile runs an Ozon products fixture through the normal scheduler merge and preserves manual material facts", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_recovery_products");
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: "IN_SALE",
      rows: [{
        product_id: 801,
        offer_id: "recovery-offer-801",
        name: "恢复前商品",
        visibility: "IN_SALE",
        price: "12.50",
        stocks: { present: 8 },
      }],
    });
    const scheduler = {
      calls: [],
      async executeReadOnly(input) {
        this.calls.push(input);
        if (input.endpointKey === "products.list") {
          const visibility = input.params?.filter?.visibility;
          const items = ["ALL", "IN_SALE"].includes(visibility)
            ? [{
                product_id: 801,
                offer_id: "recovery-offer-801",
                name: "Ozon 恢复后的商品",
                visibility: "IN_SALE",
                price: "13.75",
                stocks: { present: 6 },
              }]
            : [];
          return {
            ok: true,
            status: "success",
            jobId: `list-${visibility}`,
            data: { result: { items, last_id: "" } },
          };
        }
        const rowsByEndpoint = {
          "products.infoList": [{
            id: 801,
            offer_id: "recovery-offer-801",
            name: "Ozon 恢复后的商品",
          }],
          "products.pictures": [{
            product_id: 801,
            offer_id: "recovery-offer-801",
            primary_photo: ["https://img.example/recovery-801.jpg"],
          }],
          "products.prices": [{
            product_id: 801,
            offer_id: "recovery-offer-801",
            price: { price: "13.75", currency_code: "RUB" },
            commissions: { sales_percent_fbs: 12 },
          }],
          "products.stocks": [{
            product_id: 801,
            offer_id: "recovery-offer-801",
            stocks: [{ present: 6 }],
          }],
          "products.stocksByWarehouseFbs": [{
            product_id: 801,
            offer_id: "recovery-offer-801",
            stocks: [{ warehouse_id: 1, present: 6 }],
          }],
          "products.attributes": [{
            id: 801,
            offer_id: "recovery-offer-801",
            attributes: [],
          }],
        };
        return {
          ok: true,
          status: "success",
          jobId: `hydrate-${input.endpointKey}`,
          data:
            input.endpointKey === "products.stocksByWarehouseFbs"
              ? {
                  products: rowsByEndpoint[input.endpointKey] || [],
                  has_next: false,
                  cursor: "",
                }
              : { items: rowsByEndpoint[input.endpointKey] || [] },
        };
      },
    };
    const pending = [];
    const productsService = createProductsService({
      db,
      shopRepository,
      ozonScheduler: scheduler,
      backgroundRunner(task) {
        pending.push(task());
      },
    });
    productsService.saveMaterialProfile({
      shopId,
      productId: 801,
      offerId: "recovery-offer-801",
      source: "manual",
      weightKg: 0.77,
      widthCm: 11,
      heightCm: 12,
      depthCm: 13,
      isConfirmed: true,
    });
    const reconcile = createRecoveryReconcileState({
      db,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
    });
    reconcile.prepare({
      restoreId: "restore-products-fixture",
      generationId: "generation-products-fixture",
      shopId,
      overlapMinutes: 30,
    });
    const continuousSync = createContinuousSyncService({
      shopRepository,
      domainServices: new Map([["products", productsService]]),
      policies: [{
        id: "products:recovery-fixture",
        domain: "products",
        cadenceMs: 60_000,
        payload: {
          visibility: "IN_SALE",
          pageSize: 100,
          maxPages: 1,
          hydrate: false,
        },
      }],
      recoveryReconcileState: reconcile,
      getSyncJob: (jobId) => {
        const row = db
          .prepare("SELECT status, last_error FROM ozon_request_jobs WHERE id = ?")
          .get(jobId);
        return row ? { status: row.status, lastError: row.last_error } : null;
      },
      now: () => new Date("2026-07-11T12:00:00.000Z"),
    });

    const queued = continuousSync.runOnce({ force: true, startup: false });
    assert.equal(queued.recoveryQueued, 1);
    assert.equal(queued.results[0].accepted, true);
    assert.equal(scheduler.calls[0].requestedBy, "recovery-reconcile");
    assert.equal(scheduler.calls[0].source, "recovery-reconcile");
    assert.equal(scheduler.calls[0].syncMode, "recovery-reconcile");
    assert.equal(scheduler.calls[0].recoveryRestoreId, "restore-products-fixture");
    assert.equal(scheduler.calls[0].recoveryGenerationId, "generation-products-fixture");
    assert.equal(scheduler.calls[0].recoveryOverlapMinutes, 30);
    const job = await waitForJobStatus(
      db,
      queued.results[0].result.jobId,
      "success",
    );
    await Promise.all(pending);
    assert.equal(job?.status, "success");
    assert.deepEqual(
      [...new Set(
        scheduler.calls
          .filter((call) => call.endpointKey === "products.list")
          .map((call) => call.params.filter.visibility),
      )],
      PRODUCT_FULL_SYNC_VISIBILITIES,
    );
    const atomicRun = db.prepare(`
      SELECT mode, visibility, status, activated_snapshot_id
        FROM product_sync_runs WHERE shop_id = ?
       ORDER BY created_at DESC LIMIT 1
    `).get(shopId);
    assert.equal(atomicRun.mode, "reconcile");
    assert.equal(atomicRun.visibility, "FULL");
    assert.equal(atomicRun.status, "completed");
    assert.ok(atomicRun.activated_snapshot_id);
    const product = repository.listProducts({
      shopId,
      productIds: ["801"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.name, "Ozon 恢复后的商品");
    assert.equal(product.priceValue, 13.75);
    assert.equal(product.stockValue, 6);
    const manualMaterial = repository.listProductMaterialProfiles({
      shopId,
      productId: "801",
    })[0];
    assert.equal(manualMaterial?.source, "manual");
    assert.equal(manualMaterial?.weightKg, 0.77);
    assert.equal(manualMaterial?.isConfirmed, true);

    const queuedState = reconcile.get("restore-products-fixture", shopId);
    assert.equal(queuedState?.status, "queued");
    assert.equal(queuedState?.jobIds.length, 1);
    const finalized = continuousSync.runOnce();
    assert.equal(finalized.recoveryFinalized, 1);
    const completedState = reconcile.get("restore-products-fixture", shopId);
    assert.equal(completedState?.status, "completed");
    assert.equal(completedState?.completedPolicyCount, 1);
    assert.equal(completedState?.failedPolicyCount, 0);
  } finally {
    db.close();
  }
});

test("products service keeps active snapshots but leaves bell events to authoritative Ozon Push", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_snapshot_events");
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 204,
        offer_id: "offer-204",
        name: "后台变化商品",
        visibility: "IN_SALE",
        price: "100.00",
        stocks: { present: 12 },
      },
    ],
  });
  const scheduler = createFakeScheduler([
    {
      result: {
        items: [
          {
            product_id: 204,
            offer_id: "offer-204",
            name: "后台变化商品",
            visibility: "ARCHIVED",
            price: "88.50",
            stocks: { present: 3 },
            archived: true,
          },
        ],
        last_id: "",
      },
    },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "ARCHIVED",
    pageSize: 100,
    maxPages: 1,
    hydrate: false,
    profile: "background",
    source: "background-product-poller",
  });
  assert.equal(accepted.accepted, true);
  await Promise.all(pending);

  const job = db
    .prepare("SELECT * FROM ozon_request_jobs WHERE id = ?")
    .get(accepted.jobId);
  assert.equal(Boolean(job.snapshot_id), true);
  assert.equal(scheduler.calls[0].snapshotId, job.snapshot_id);
  const snapshot = db
    .prepare("SELECT * FROM ozon_sync_snapshots WHERE id = ?")
    .get(job.snapshot_id);
  assert.equal(snapshot.domain, "products");
  assert.equal(snapshot.shop_id, shopId);
  assert.equal(snapshot.source, "background-product-poller");
  assert.equal(snapshot.status, "success");
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.row_count, 1);

  const events = db
    .prepare(
      "SELECT * FROM ozon_notification_events WHERE snapshot_id = ? ORDER BY event_type",
    )
    .all(job.snapshot_id);
  assert.deepEqual(events, []);
});

test("products background polling does not duplicate Ozon Push stock notifications", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_stock_notification_threshold",
  );
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 205,
        offer_id: "offer-205",
        name: "普通库存变化",
        visibility: "IN_SALE",
        price: "10.00",
        stocks: { present: 12 },
      },
      {
        product_id: 206,
        offer_id: "offer-206",
        name: "库存等于五",
        visibility: "IN_SALE",
        price: "10.00",
        stocks: { present: 6 },
      },
      {
        product_id: 207,
        offer_id: "offer-207",
        name: "库存低于五",
        visibility: "IN_SALE",
        price: "10.00",
        stocks: { present: 6 },
      },
      {
        product_id: 208,
        offer_id: "offer-208",
        name: "库存归零",
        visibility: "IN_SALE",
        price: "10.00",
        stocks: { present: 6 },
      },
    ],
  });
  const scheduler = createFakeScheduler([
    {
      result: {
        items: [
          {
            product_id: 205,
            offer_id: "offer-205",
            name: "普通库存变化",
            visibility: "IN_SALE",
            price: "10.00",
            stocks: { present: 8 },
          },
          {
            product_id: 206,
            offer_id: "offer-206",
            name: "库存等于五",
            visibility: "IN_SALE",
            price: "10.00",
            stocks: { present: 5 },
          },
          {
            product_id: 207,
            offer_id: "offer-207",
            name: "库存低于五",
            visibility: "IN_SALE",
            price: "10.00",
            stocks: { present: 4 },
          },
          {
            product_id: 208,
            offer_id: "offer-208",
            name: "库存归零",
            visibility: "IN_SALE",
            price: "10.00",
            stocks: { present: 0 },
          },
        ],
        last_id: "",
      },
    },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 100,
    maxPages: 1,
    hydrate: false,
    profile: "background",
    source: "background-product-poller",
  });
  await Promise.all(pending);

  const job = db
    .prepare("SELECT * FROM ozon_request_jobs WHERE id = ?")
    .get(accepted.jobId);
  const events = db
    .prepare(
      "SELECT event_type, offer_id FROM ozon_notification_events WHERE snapshot_id = ? ORDER BY offer_id",
    )
    .all(job.snapshot_id);
  assert.deepEqual(events, []);
});

test("product repository merges hydrated detail, pictures, prices, stocks and attributes without rewriting unchanged hashes", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_hydrate");
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 301,
        offer_id: "offer-301",
        name: "未返回",
        visibility: "IN_SALE",
      },
    ],
  });

  assert.equal(
    repository.mergeProductInfoRows({
      shopId,
      rows: [
        {
          id: 301,
          offer_id: "offer-301",
          name: "详情商品",
          primary_image: "https://img/main.jpg",
          images: ["https://img/main.jpg", "https://img/2.jpg"],
          price: "19.90",
          currency_code: "RUB",
          weight: 200,
          weight_unit: "g",
          width: 100,
          height: 200,
          depth: 300,
          dimension_unit: "mm",
          description_category_id: 11,
          type_id: 9001,
          category_name: "类目 A",
        },
      ],
    }).changed,
    1,
  );
  const detailOnlyPage = repository.listProducts({
    shopId,
    productIds: ["301"],
    pageSize: 20,
  });
  assert.equal(detailOnlyPage.rows[0].hydratedAt, null);
  assert.equal(detailOnlyPage.rows[0].hydrationComplete, false);
  assert.deepEqual(detailOnlyPage.rows[0].hydrationCoverage, {
    detail: true,
    pictures: false,
    prices: false,
    stocks: false,
    attributes: false,
  });
  const detailMaterial = db
    .prepare(
      "SELECT source, weight_kg, width_cm, height_cm, depth_cm FROM product_material_profiles WHERE shop_id = ? AND product_key = ? AND source = 'ozon-product-list-read'",
    )
    .get(shopId, detailOnlyPage.rows[0].productKey);
  assert.equal(detailMaterial.source, "ozon-product-list-read");
  assert.equal(detailMaterial.weight_kg, 0.2);
  assert.equal(detailMaterial.width_cm, 10);
  assert.equal(detailMaterial.height_cm, 20);
  assert.equal(detailMaterial.depth_cm, 30);
  assert.equal(
    repository.mergeProductPictureRows({
      shopId,
      rows: [
        {
          product_id: 301,
          offer_id: "offer-301",
          images: ["https://img/main.jpg", "https://img/2.jpg"],
        },
      ],
    }).changed,
    1,
  );
  assert.equal(
    repository.mergeProductPriceRows({
      shopId,
      rows: [
        {
          product_id: 301,
          offer_id: "offer-301",
          price: { marketing_seller_price: "20.50", currency_code: "RUB" },
          commissions: { sales_percent_rfbs: 13 },
        },
      ],
    }).changed,
    1,
  );
  assert.equal(
    repository.mergeProductStockRows({
      shopId,
      rows: [
        { product_id: 301, offer_id: "offer-301", stocks: [{ present: 7 }] },
      ],
    }).changed,
    1,
  );
  assert.equal(
    repository.mergeProductStockRows({
      shopId,
      rows: [
        { product_id: 301, offer_id: "offer-301", stocks: { present: 8 } },
      ],
    }).changed,
    1,
  );
  const stockObjectPage = repository.listProducts({
    shopId,
    productIds: ["301"],
    pageSize: 20,
  });
  assert.equal(stockObjectPage.rows[0].stockValue, 8);
  assert.equal(
    repository.mergeProductStockRows({
      shopId,
      rows: [
        {
          product_id: 301,
          offer_id: "offer-301",
          warehouse_id: 1001,
          present: 4,
        },
        {
          product_id: 301,
          offer_id: "offer-301",
          warehouse_id: 1002,
          present: 5,
        },
      ],
    }).changed,
    1,
  );
  assert.equal(
    repository.mergeProductAttributeRows({
      shopId,
      rows: [
        {
          id: 301,
          offer_id: "offer-301",
          attributes: [{ id: 1, name: "Brand", values: [{ value: "ACME" }] }],
          type_id: 9001,
          width: 100,
          height: 200,
          depth: 300,
          dimension_unit: "mm",
        },
      ],
    }).changed,
    1,
  );
  assert.equal(
    repository.mergeProductAttributeRows({
      shopId,
      rows: [
        {
          id: 301,
          offer_id: "offer-301",
          attributes: [{ id: 1, name: "Brand", values: [{ value: "ACME" }] }],
          type_id: 9001,
          width: 100,
          height: 200,
          depth: 300,
          dimension_unit: "mm",
        },
      ],
    }).unchanged,
    1,
  );

  const page = repository.listProducts({ shopId, pageSize: 20 });
  assert.equal(page.rows[0].name, "详情商品");
  assert.equal(page.rows[0].primaryImageUrl, "https://img/main.jpg");
  assert.deepEqual(page.rows[0].images, [
    "https://img/main.jpg",
    "https://img/2.jpg",
  ]);
  assert.equal(page.rows[0].priceValue, 20.5);
  assert.equal(page.rows[0].currencyCode, "CNY");
  assert.equal(page.rows[0].typeId, "9001");
  assert.equal(page.rows[0].stockValue, 9);
  assert.equal(page.rows[0].commissionPercent, 13);
  assert.equal(page.rows[0].weightKg, 0.2);
  assert.equal(page.rows[0].widthCm, 10);
  assert.equal(page.rows[0].attributes[0].name, "Brand");
  assert.ok(page.rows[0].hydratedAt);
  assert.equal(page.rows[0].hydrationComplete, true);
  assert.deepEqual(page.rows[0].hydrationCoverage, {
    detail: true,
    pictures: true,
    prices: true,
    stocks: true,
    attributes: true,
  });

  db.prepare(
    "UPDATE ozon_products SET currency_code = 'RUB' WHERE shop_id = ? AND product_id = '301'",
  ).run(shopId);
  const repairedCurrencyPage = repository.listProducts({
    shopId,
    productIds: ["301"],
    pageSize: 20,
  });
  assert.equal(repairedCurrencyPage.rows[0].currencyCode, "CNY");

  repository.upsertProducts({
    shopId,
    visibility: "ARCHIVED",
    rows: [
      {
        product_id: 302,
        offer_id: "offer-302",
        name: "旧商品",
        visibility: "ARCHIVED",
        archived: true,
      },
    ],
  });
  repository.mergeProductStockRows({
    shopId,
    rows: [
      { product_id: 302, offer_id: "offer-302", stocks: [{ present: 0 }] },
    ],
  });
  const archivedPage = repository.listProducts({
    shopId,
    visibility: "ARCHIVED",
    pageSize: 20,
  });
  const archivedRow = archivedPage.rows.find((row) => row.productId === "302");
  assert.equal(archivedRow.statusLabel, "已下架");
  assert.equal(archivedRow.visibility, "ARCHIVED");
});

test("product repository records per-entity facet outcomes and never completes a missing archived product", () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_products_empty_facets");
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: "ARCHIVED",
      rows: [
        {
          product_id: 305,
          offer_id: "offer-305",
          name: "mzr-20260520-638834907-9348",
          visibility: "ARCHIVED",
        },
        {
          product_id: 306,
          offer_id: "offer-306",
          name: "接口漏行商品",
          visibility: "ARCHIVED",
        },
      ],
    });

    const provenance = {
      operationId: "operation-305",
      contractVersion: "ozon-products-prices-v5",
      mapperVersion: "product-price-fee-mapper-v2",
      responseHash: "a".repeat(64),
      runId: "run-305",
      snapshotId: "snapshot-305",
      expectedAt: "2026-07-16T00:00:00.000Z",
    };
    repository.mergeProductInfoRows({
      shopId,
      rows: [{ id: 305, offer_id: "offer-305", name: "下架商品详情" }],
      expectedProductIds: ["305", "306"],
      provenance,
    });
    repository.mergeProductPictureRows({
      shopId,
      rows: [{ product_id: 305, offer_id: "offer-305", images: [] }],
      expectedProductIds: ["305", "306"],
      provenance,
    });
    repository.mergeProductPriceRows({
      shopId,
      rows: [
        {
          product_id: 305,
          offer_id: "offer-305",
          price: {
            marketing_price: "0",
            marketing_seller_price: "0",
            price: "55.16",
            currency_code: "RUB",
          },
          commissions: {
            sales_percent_fbo: 0,
            sales_percent_fbs: 0,
            sales_percent_rfbs: 0,
            sales_percent_fbp: 0,
          },
          acquiring: 0,
        },
      ],
      expectedProductIds: ["305", "306"],
      provenance,
    });
    repository.mergeProductStockRows({
      shopId,
      rows: [
        {
          product_id: 305,
          offer_id: "offer-305",
          stocks: [{ present: 0 }],
        },
      ],
      expectedProductIds: ["305", "306"],
      provenance,
    });
    repository.mergeProductAttributeRows({
      shopId,
      rows: [{ id: 305, offer_id: "offer-305", attributes: [] }],
      expectedOfferIds: ["offer-305", "offer-306"],
      provenance,
    });

    const coverage = repository.getProductHydrationCoverage({
      shopId,
      productIds: ["305", "306"],
      offerIds: ["offer-305", "offer-306"],
    });
    assert.equal(coverage.total, 2);
    assert.equal(coverage.complete, 1);
    assert.equal(coverage.incomplete, 1);

    const rows = repository.listProducts({
      shopId,
      productIds: ["305", "306"],
      pageSize: 20,
    }).rows;
    const complete = rows.find((row) => row.productId === "305");
    const missing = rows.find((row) => row.productId === "306");
    assert.equal(complete.hydrationComplete, true);
    assert.ok(complete.hydratedAt);
    assert.equal(complete.priceValue, 55.16);
    assert.equal(complete.stockValue, 0);
    assert.equal(complete.commissionPercent, null);
    assert.deepEqual(complete.commissionPercents, {
      fbo: null,
      fbs: null,
      rfbs: null,
      fbp: null,
    });
    assert.equal(complete.commissionStatus, "unavailable");
    assert.equal(complete.commissionProvenance.sourceReason, "ozon-zero-commission-sentinel");
    assert.deepEqual(complete.commissionProvenance.rawFulfillmentPercents, {
      fbo: 0,
      fbs: 0,
      rfbs: 0,
      fbp: 0,
    });
    assert.equal(complete.acquiringFeeValue, null);
    assert.equal(complete.acquiringStatus, "unavailable");
    assert.equal(complete.facetObservations.pictures.status, "returned_empty");
    assert.equal(complete.facetObservations.attributes.status, "returned_empty");
    assert.equal(complete.facetObservations.stocks.sourceReason, "ozon-explicit-zero-stock");
    assert.equal(complete.facetObservations.prices.responseHash, "a".repeat(64));

    assert.equal(missing.hydrationComplete, false);
    assert.equal(missing.hydratedAt, null);
    assert.equal(missing.facetObservations.detail.status, "not_returned");
    assert.equal(missing.facetObservations.prices.status, "not_returned");
    assert.equal(missing.facetObservations.attributes.status, "not_returned");
  } finally {
    db.close();
  }
});

test("product repository preserves a previously proven commission when a later Ozon row only returns zero sentinels", () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_products_commission_strength");
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: "ARCHIVED",
      rows: [
        {
          product_id: 307,
          offer_id: "offer-307",
          name: "佣金强来源商品",
          visibility: "ARCHIVED",
        },
      ],
    });

    repository.mergeProductPriceRows({
      shopId,
      rows: [
        {
          product_id: 307,
          offer_id: "offer-307",
          price: { price: 60, currency_code: "RUB" },
          commissions: { sales_percent_fbp: 11 },
          acquiring: 0.6,
        },
      ],
      expectedProductIds: ["307"],
      provenance: {
        responseHash: "b".repeat(64),
        contractVersion: "ozon-products-prices-v5",
        mapperVersion: "product-price-fee-mapper-v2",
      },
    });
    repository.mergeProductPriceRows({
      shopId,
      rows: [
        {
          product_id: 307,
          offer_id: "offer-307",
          price: { price: 61, currency_code: "RUB" },
          commissions: {
            sales_percent_fbo: 0,
            sales_percent_fbs: 0,
            sales_percent_rfbs: 0,
            sales_percent_fbp: 0,
          },
          acquiring: 0,
        },
      ],
      expectedProductIds: ["307"],
      provenance: {
        responseHash: "c".repeat(64),
        contractVersion: "ozon-products-prices-v5",
        mapperVersion: "product-price-fee-mapper-v2",
      },
    });

    const product = repository.listProducts({
      shopId,
      productIds: ["307"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.priceValue, 61);
    assert.equal(product.commissionPercent, 11);
    assert.equal(product.commissionPercents.fbp, 11);
    assert.equal(product.commissionStatus, "stale_previous");
    assert.equal(product.commissionProvenance.currentStatus, "unavailable");
    assert.equal(product.commissionProvenance.retainedPrevious, true);
    assert.equal(product.commissionProvenance.responseHash, "c".repeat(64));
    assert.equal(product.acquiringFeeValue, 0.6);
    assert.equal(product.acquiringStatus, "stale_previous");
    assert.equal(product.acquiringProvenance.currentStatus, "unavailable");
    assert.equal(product.priceJson.commissions.sales_percent_fbp, 0);
  } finally {
    db.close();
  }
});

test("product repository reads Ozon picture endpoint photo fields", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_picture_fields");
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 901,
        offer_id: "offer-901",
        name: "图片字段商品",
        visibility: "IN_SALE",
      },
    ],
  });
  repository.mergeProductPictureRows({
    shopId,
    rows: [
      {
        product_id: 901,
        primary_photo: ["https://ir.ozone.ru/main.jpg"],
        photo: [
          "https://ir.ozone.ru/main.jpg",
          "https://ir.ozone.ru/second.jpg",
        ],
        color_photo: ["https://ir.ozone.ru/color.jpg"],
      },
    ],
  });

  const page = repository.listProducts({
    shopId,
    productIds: ["901"],
    pageSize: 20,
  });
  assert.equal(page.rows[0].primaryImageUrl, "https://ir.ozone.ru/main.jpg");
  assert.deepEqual(page.rows[0].images, [
    "https://ir.ozone.ru/main.jpg",
    "https://ir.ozone.ru/second.jpg",
    "https://ir.ozone.ru/color.jpg",
  ]);
});

test("product repository stores authoritative warehouse stock zero as zero", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_empty_stock");
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: "TO_SUPPLY",
    rows: [
      {
        product_id: 303,
        offer_id: "offer-303",
        name: "待补库存商品",
        visibility: "TO_SUPPLY",
      },
    ],
  });

  assert.equal(
    repository.mergeProductStockRows({
      shopId,
      rows: [
        {
          product_id: 303,
          offer_id: "offer-303",
          stocks: [
            { warehouse_id: 1001, present: 0 },
            { warehouse_id: 1002, present: 0 },
          ],
        },
      ],
    }).changed,
    1,
  );

  const page = repository.listProducts({
    shopId,
    productIds: ["303"],
    pageSize: 20,
  });

  assert.equal(page.rows[0].stockValue, 0);
  assert.equal(page.rows[0].stockJson.present, 0);

  db.close();
});

test("product stock mapper distinguishes explicit empty entities, unknown rows, and missing rows", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_stock_evidence_matrix",
  );
  const repository = createProductRepository(db);
  const productRows = [
    { product_id: 3101, offer_id: "offer-3101", name: "旧正库存后归零" },
    { product_id: 3102, offer_id: "offer-3102", name: "数值零库存" },
    { product_id: 3103, offer_id: "offer-3103", name: "直接无库存标志" },
    { product_id: 3104, offer_id: "offer-3104", name: "双履约无库存标志" },
    { product_id: 3105, offer_id: "offer-3105", name: "库存字段未知" },
    {
      product_id: 3106,
      offer_id: "offer-3106",
      name: "正向库存标志优先",
      has_fbo_stocks: false,
      has_fbs_stocks: true,
    },
    { product_id: 3107, offer_id: "offer-3107", name: "接口缺行" },
    { product_id: 3108, offer_id: "offer-3108", name: "仅仓库空数组" },
  ];
  repository.upsertProducts({
    shopId,
    visibility: "TO_SUPPLY",
    rows: productRows,
  });
  repository.mergeProductStockRows({
    shopId,
    rows: [
      {
        product_id: 3101,
        offer_id: "offer-3101",
        stocks: [{ warehouse_id: 1, present: 11 }],
      },
    ],
  });

  const provenance = {
    operationId: "operation-stock-matrix",
    contractVersion: "ozon-products-stocks-v4",
    mapperVersion: "product-stock-mapper-v2",
    responseHash: "b".repeat(64),
    runId: "run-stock-matrix",
  };
  repository.mergeProductStockRows({
    shopId,
    rows: [
      { product_id: 3101, offer_id: "offer-3101", stocks: [] },
      {
        product_id: 3102,
        offer_id: "offer-3102",
        stocks: [{ warehouse_id: 2, present: 0 }],
      },
      { product_id: 3103, offer_id: "offer-3103", has_stock: false },
      {
        product_id: 3104,
        offer_id: "offer-3104",
        has_fbo_stocks: false,
        has_fbs_stocks: false,
      },
      { product_id: 3105, offer_id: "offer-3105" },
      { product_id: 3106, offer_id: "offer-3106", stocks: [] },
      { product_id: 3108, offer_id: "offer-3108", warehouse_stocks: [] },
    ],
    expectedProductIds: productRows.map((row) => String(row.product_id)),
    provenance,
  });

  const rows = repository.listProducts({
    shopId,
    productIds: productRows.map((row) => String(row.product_id)),
    pageSize: 20,
  }).rows;
  const byId = new Map(rows.map((row) => [row.productId, row]));

  assert.equal(byId.get("3101").stockValue, 0);
  assert.equal(byId.get("3101").stockJson.present, 0);
  assert.deepEqual(byId.get("3101").stockJson.stocks, []);
  assert.equal(byId.get("3101").facetObservations.stocks.status, "returned");
  assert.equal(
    byId.get("3101").facetObservations.stocks.sourceReason,
    "ozon-explicit-empty-stocks-zero",
  );

  assert.equal(byId.get("3102").stockValue, 0);
  assert.equal(
    byId.get("3102").facetObservations.stocks.sourceReason,
    "ozon-explicit-zero-stock",
  );
  assert.equal(byId.get("3103").stockValue, 0);
  assert.equal(byId.get("3104").stockValue, 0);
  assert.equal(
    byId.get("3103").facetObservations.stocks.sourceReason,
    "ozon-explicit-no-stock-flags",
  );

  assert.equal(byId.get("3105").stockValue, null);
  assert.equal(byId.get("3105").stockJson.stocks, undefined);
  assert.equal(byId.get("3105").facetObservations.stocks.status, "unavailable");
  assert.equal(byId.get("3106").stockValue, null);
  assert.deepEqual(byId.get("3106").stockJson.stocks, []);
  assert.equal(
    byId.get("3106").facetObservations.stocks.status,
    "returned_empty",
  );
  assert.equal(byId.get("3107").stockValue, null);
  assert.equal(
    byId.get("3107").facetObservations.stocks.status,
    "not_returned",
  );
  assert.equal(byId.get("3108").stockValue, null);
  assert.equal(
    byId.get("3108").facetObservations.stocks.status,
    "returned_empty",
  );
  db.close();
});

test("product list stock flags refresh raw evidence even when scalar stock is unchanged", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_stock_flag_hash",
  );
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    rows: [
      {
        product_id: 3150,
        offer_id: "offer-3150",
        name: "库存标志变化商品",
        has_fbo_stocks: false,
        has_fbs_stocks: true,
      },
    ],
  });
  const before = db
    .prepare(
      "SELECT remote_hash FROM ozon_products WHERE shop_id = ? AND product_id = '3150'",
    )
    .get(shopId);
  const refreshed = repository.upsertProducts({
    shopId,
    rows: [
      {
        product_id: 3150,
        offer_id: "offer-3150",
        name: "库存标志变化商品",
        has_fbo_stocks: false,
        has_fbs_stocks: false,
      },
    ],
  });
  const after = db
    .prepare(
      "SELECT remote_hash, raw_json FROM ozon_products WHERE shop_id = ? AND product_id = '3150'",
    )
    .get(shopId);
  assert.equal(refreshed.updated, 1);
  assert.notEqual(after.remote_hash, before.remote_hash);
  assert.equal(JSON.parse(after.raw_json).has_fbs_stocks, false);

  repository.mergeProductStockRows({
    shopId,
    rows: [{ product_id: 3150, offer_id: "offer-3150", stocks: [] }],
  });
  const product = repository.listProducts({
    shopId,
    productIds: ["3150"],
    pageSize: 20,
  }).rows[0];
  assert.equal(product.stockValue, 0);
  db.close();
});

test("warehouse FBS detail is stored separately and never overwrites comprehensive stock", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_warehouse_subset_guard",
  );
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    rows: [
      {
        product_id: 3201,
        offer_id: "offer-3201",
        name: "综合库存不能被 FBS 空集覆盖",
      },
    ],
  });
  repository.mergeProductStockRows({
    shopId,
    rows: [
      {
        product_id: 3201,
        offer_id: "offer-3201",
        stocks: [{ warehouse_id: 1, present: 12 }],
      },
    ],
    provenance: {
      contractVersion: "ozon-products-stocks-v4",
      responseHash: "c".repeat(64),
    },
  });
  const before = db
    .prepare(
      "SELECT stocks_hash, facet_observations_json FROM ozon_products WHERE shop_id = ? AND product_id = '3201'",
    )
    .get(shopId);

  const warehouseMerge = repository.mergeProductStockRows({
    shopId,
    rows: [
      { product_id: 3201, offer_id: "offer-3201", stocks: [] },
      {
        product_id: 3201,
        offer_id: "offer-3201",
        stocks: [{ warehouse_id: 2, present: 0 }],
      },
      {
        product_id: 3201,
        offer_id: "offer-3201",
        stocks: [{ warehouse_id: 3, present: 5 }],
      },
    ],
    expectedOfferIds: ["offer-3201"],
    provenance: {
      contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
      responseHash: "d".repeat(64),
    },
  });

  const product = repository.listProducts({
    shopId,
    productIds: ["3201"],
    pageSize: 20,
  }).rows[0];
  const after = db
    .prepare(
      "SELECT stocks_hash, facet_observations_json FROM ozon_products WHERE shop_id = ? AND product_id = '3201'",
    )
    .get(shopId);
  assert.equal(warehouseMerge.changed, 1);
  assert.equal(warehouseMerge.rows, 3);
  assert.equal(product.stockValue, 12);
  assert.equal(product.stockJson.present, 12);
  assert.equal(product.sellerWarehouseStockTotal, 5);
  assert.equal(product.warehouseStockTotal, 5);
  assert.equal(product.warehouseStockCount, 2);
  assert.equal(product.warehouseStockComplete, true);
  assert.deepEqual(
    product.warehouseStocks.map((stock) => [
      stock.warehouseId,
      stock.presentQuantity,
    ]),
    [["2", 0], ["3", 5]],
  );
  assert.equal(product.facetObservations.stocks.endpointKey, "products.stocks");
  assert.equal(
    product.facetObservations.warehouse_stocks.endpointKey,
    "products.stocksByWarehouseFbs",
  );
  assert.equal(after.stocks_hash, before.stocks_hash);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM product_warehouse_stock_facts WHERE shop_id = ?",
    ).get(shopId).count,
    2,
  );
  db.close();
});

test("multi-warehouse flat rows survive both primary-secondary merge orders without source mixing", () => {
  for (const order of ["primary-first", "warehouse-first"]) {
    const db = createMigratedTestDb();
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      `shop_products_multi_warehouse_${order}`,
    );
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      rows: [{ product_id: 3301, offer_id: "offer-3301", sku: "sku-3301" }],
    });
    const mergePrimary = () => repository.mergeProductStockRows({
      shopId,
      endpointKey: "products.stocks",
      rows: [{
        product_id: 3301,
        offer_id: "offer-3301",
        stocks: [
          { type: "FBO", present: 4 },
          { type: "FBS", present: 6 },
        ],
      }],
      provenance: {
        contractVersion: "ozon-products-stocks-v4",
        responseHash: "e".repeat(64),
      },
    });
    const mergeWarehouses = () => repository.mergeProductWarehouseStockRows({
      shopId,
      rows: [
        {
          product_id: 3301,
          offer_id: "offer-3301",
          sku: "sku-3301",
          warehouse_id: 1001,
          warehouse_name: "仓库一",
          present: 2,
          reserved: 1,
          free_stock: 1,
        },
        {
          product_id: 3301,
          offer_id: "offer-3301",
          sku: "sku-3301",
          warehouse_id: 1002,
          warehouse_name: "仓库二",
          present: 4,
          reserved: 0,
          free_stock: 4,
        },
        // Exact duplicate rows are idempotent; they must not be double-counted.
        {
          product_id: 3301,
          offer_id: "offer-3301",
          sku: "sku-3301",
          warehouse_id: 1002,
          warehouse_name: "仓库二",
          present: 4,
          reserved: 0,
          free_stock: 4,
        },
      ],
      expectedOfferIds: ["offer-3301"],
      provenance: {
        contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
        responseHash: "f".repeat(64),
      },
    });
    if (order === "primary-first") {
      mergePrimary();
      mergeWarehouses();
    } else {
      mergeWarehouses();
      mergePrimary();
    }

    let product = repository.listProducts({
      shopId,
      productIds: ["3301"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.stockValue, 10, order);
    assert.equal(product.stockJson.present, 10, order);
    assert.equal(product.sellerWarehouseStockTotal, 6, order);
    assert.equal(product.warehouseStockCount, 2, order);
    assert.deepEqual(
      product.warehouseStocks.map((stock) => ({
        id: stock.warehouseId,
        name: stock.warehouseName,
        sku: stock.sku,
        present: stock.presentQuantity,
        free: stock.freeQuantity,
        type: stock.fulfillmentType,
      })),
      [
        { id: "1001", name: "仓库一", sku: "sku-3301", present: 2, free: 1, type: "SELLER" },
        { id: "1002", name: "仓库二", sku: "sku-3301", present: 4, free: 4, type: "SELLER" },
      ],
      order,
    );

    // A missing entity in a later v2 response must keep the last exact facts,
    // but it must no longer claim that this run is complete.
    repository.mergeProductWarehouseStockRows({
      shopId,
      rows: [],
      expectedOfferIds: ["offer-3301"],
      provenance: {
        contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
        responseHash: "a".repeat(64),
      },
    });
    product = repository.listProducts({
      shopId,
      productIds: ["3301"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.stockValue, 10, order);
    assert.equal(product.sellerWarehouseStockTotal, 6, order);
    assert.equal(product.warehouseStockComplete, false, order);
    assert.equal(product.warehouseStockObservation.status, "stale_previous", order);
    assert.equal(product.warehouseStockObservation.sourceReason,
      "ozon-expected-warehouse-stock-entity-not-returned", order);
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM product_warehouse_stock_facts WHERE shop_id = ?",
      ).get(shopId).count,
      2,
      order,
    );

    // A later complete response is a full set replacement, not an append.
    repository.mergeProductWarehouseStockRows({
      shopId,
      rows: [{
        product_id: 3301,
        offer_id: "offer-3301",
        sku: "sku-3301",
        warehouse_id: 1001,
        warehouse_name: "仓库一",
        present: 7,
        free_stock: 7,
      }],
      expectedOfferIds: ["offer-3301"],
      provenance: {
        contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
        responseHash: "b".repeat(64),
      },
    });
    product = repository.listProducts({
      shopId,
      productIds: ["3301"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.stockValue, 10, order);
    assert.equal(product.sellerWarehouseStockTotal, 7, order);
    assert.deepEqual(
      product.warehouseStocks.map((stock) => stock.warehouseId),
      ["1001"],
      order,
    );

    // Conflicting duplicates make the entire response invalid and roll back;
    // they are never summed, first-row-wins, or partially persisted.
    assert.throws(
      () => repository.mergeProductWarehouseStockRows({
        shopId,
        rows: [
          {
            product_id: 3301,
            offer_id: "offer-3301",
            warehouse_id: 1001,
            present: 8,
          },
          {
            product_id: 3301,
            offer_id: "offer-3301",
            warehouse_id: 1001,
            present: 9,
          },
        ],
        provenance: {
          contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
        },
      }),
      /PRODUCT_WAREHOUSE_STOCK_CONTRACT_INVALID/u,
      order,
    );
    product = repository.listProducts({
      shopId,
      productIds: ["3301"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.sellerWarehouseStockTotal, 7, order);
    assert.equal(product.warehouseStockCount, 1, order);

    assert.throws(
      () => repository.mergeProductWarehouseStockRows({
        shopId,
        rows: [{
          product_id: 3301,
          offer_id: "offer-3301",
          warehouse_id: 1001,
          present: 99,
        }],
        expectedOfferIds: ["offer-3301"],
        responseLimit: 1,
        provenance: {
          contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
        },
      }),
      /PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE/u,
      order,
    );
    product = repository.listProducts({
      shopId,
      productIds: ["3301"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.sellerWarehouseStockTotal, 7, order);
    assert.equal(product.warehouseStockObservation.status, "stale_previous", order);
    assert.equal(
      product.warehouseStockObservation.currentStatus,
      "contract_invalid",
      order,
    );

    // SKU alone may locate an already canonical product for a secondary
    // warehouse response, but it must never create a second formal identity.
    repository.mergeProductWarehouseStockRows({
      shopId,
      rows: [{
        sku: "sku-3301",
        warehouse_id: 1003,
        warehouse_name: "仓库三",
        present: 5,
        free_stock: 5,
      }],
      provenance: {
        contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
      },
    });
    product = repository.listProducts({
      shopId,
      productIds: ["3301"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.sellerWarehouseStockTotal, 5, order);
    assert.deepEqual(
      product.warehouseStocks.map((stock) => stock.warehouseId),
      ["1003"],
      order,
    );
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM ozon_products WHERE shop_id = ?",
      ).get(shopId).count,
      1,
      order,
    );
    db.close();
  }
});

test("product stock readback keeps value 20 when later products.list returns empty quants", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_stock_list_empty_quants",
  );
  const repository = createProductRepository(db);

  repository.mergeProductStockRows({
    shopId,
    rows: [
      {
        product_id: 4392243976,
        offer_id: "mz-26050109-135366",
        stocks: [
          { warehouse_id: 1020005014175280, present: 0 },
          { warehouse_id: 1020005020379050, present: 20 },
        ],
      },
    ],
  });
  let page = repository.listProducts({
    shopId,
    productIds: ["4392243976"],
    pageSize: 20,
  });
  assert.equal(page.rows[0].stockValue, 20);

  repository.upsertProducts({
    shopId,
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 4392243976,
        offer_id: "mz-26050109-135366",
        name: "库存 20 商品",
        visibility: "IN_SALE",
        has_fbo_stocks: false,
        has_fbs_stocks: true,
        quants: [],
      },
    ],
  });

  page = repository.listProducts({
    shopId,
    productIds: ["4392243976"],
    pageSize: 20,
  });
  const stockJsonTotal = page.rows[0].stockJson.stocks.reduce(
    (sum, item) => sum + Number(item.present || 0),
    0,
  );
  assert.equal(page.rows[0].stockValue, 20);
  assert.equal(page.rows[0].stockJson.present, 20);
  assert.equal(stockJsonTotal, 20);
  db.close();
});

test("product stock readback repairs stale stock_value when stock_json already has 20", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_stock_repair_value",
  );
  const repository = createProductRepository(db);
  const stockRows = [
    {
      product_id: 3020,
      offer_id: "offer-3020",
      stocks: [
        { warehouse_id: 1, present: 0 },
        { warehouse_id: 2, present: 20 },
      ],
    },
  ];

  repository.mergeProductStockRows({ shopId, rows: stockRows });
  db.prepare(
    "UPDATE ozon_products SET stock_value = 0 WHERE shop_id = ? AND product_id = '3020'",
  ).run(shopId);
  const merge = repository.mergeProductStockRows({ shopId, rows: stockRows });
  const row = repository.listProducts({
    shopId,
    productIds: ["3020"],
    pageSize: 20,
  }).rows[0];

  assert.equal(merge.unchanged, 1);
  assert.equal(row.stockValue, 20);
  assert.equal(row.stockJson.present, 20);
  db.close();
});

test("product stock json present is recomputed from warehouse stocks", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_stock_present_sum",
  );
  const repository = createProductRepository(db);

  repository.mergeProductStockRows({
    shopId,
    rows: [
      {
        product_id: 3021,
        offer_id: "offer-3021",
        present: 0,
        stocks: [
          { warehouse_id: 1, present: 0 },
          { warehouse_id: 2, present: 20 },
        ],
      },
    ],
  });

  const row = repository.listProducts({
    shopId,
    productIds: ["3021"],
    pageSize: 20,
  }).rows[0];
  assert.equal(row.stockValue, 20);
  assert.equal(row.stockJson.present, 20);
  db.close();
});

test("product stock repair persists stock_json present even when stock_value already matches warehouse total", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_stock_json_present_repair",
  );
  const repository = createProductRepository(db);
  const rows = [
    {
      product_id: 3022,
      offer_id: "offer-3022",
      present: 0,
      stocks: [
        { warehouse_id: 1, present: 0 },
        { warehouse_id: 2, present: 20 },
      ],
    },
  ];

  repository.mergeProductStockRows({ shopId, rows });
  db.prepare(
    "UPDATE ozon_products SET stock_value = 20, stock_json = json_set(stock_json, '$.present', 0) WHERE shop_id = ? AND product_id = '3022'",
  ).run(shopId);

  const merge = repository.mergeProductStockRows({ shopId, rows });
  const raw = db
    .prepare(
      "SELECT stock_value, stock_json FROM ozon_products WHERE shop_id = ? AND product_id = '3022'",
    )
    .get(shopId);
  const stockJson = JSON.parse(raw.stock_json);

  assert.equal(merge.unchanged, 1);
  assert.equal(raw.stock_value, 20);
  assert.equal(stockJson.present, 20);
  assert.equal(
    stockJson.stocks.reduce((sum, item) => sum + Number(item.present || 0), 0),
    20,
  );

  db.prepare(
    "UPDATE ozon_products SET stock_value = 20, stock_json = json_set(stock_json, '$.present', 0) WHERE shop_id = ? AND product_id = '3022'",
  ).run(shopId);
  createProductRepository(db);
  const repairedOnStartup = JSON.parse(
    db
      .prepare(
        "SELECT stock_json FROM ozon_products WHERE shop_id = ? AND product_id = '3022'",
      )
      .get(shopId).stock_json,
  );
  assert.equal(repairedOnStartup.present, 20);
  db.close();
});

test("products service syncs list and hydrates via info, pictures, prices, stocks and offer_id attributes", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_sync_hydrate");
  const scheduler = createFakeScheduler([
    {
      result: {
        items: [
          { product_id: 401, offer_id: "offer-401", visibility: "IN_SALE" },
        ],
        last_id: "",
      },
    },
    {
      items: [
        {
          id: 401,
          offer_id: "offer-401",
          name: "补水商品",
          primary_image: "https://img/main.jpg",
          images: ["https://img/main.jpg"],
          price: "33.3",
           currency_code: "RUB",
           type_id: 9002,
           weight: 250,
           weight_unit: "g",
           width: 120,
           height: 80,
           depth: 300,
           dimension_unit: "mm",
        },
      ],
    },
    {
      items: [
        {
          product_id: 401,
          offer_id: "offer-401",
          images: ["https://img/main.jpg", "https://img/2.jpg"],
        },
      ],
    },
    {
      items: [
        {
          product_id: 401,
          offer_id: "offer-401",
          price: { marketing_seller_price: "34.4", currency_code: "RUB" },
          commissions: { sales_percent_rfbs: 14 },
          acquiring: "0.34",
        },
      ],
    },
    {
      items: [
        { product_id: 401, offer_id: "offer-401", stocks: [{ present: 6 }] },
      ],
    },
    {
      products: [
        {
          product_id: 401,
          offer_id: "offer-401",
          warehouse_id: 1001,
          warehouse_name: "仓库一",
          present: 4,
          free_stock: 4,
        },
      ],
      has_next: true,
      cursor: "warehouse-page-2",
    },
    {
      products: [
        {
          product_id: 401,
          offer_id: "offer-401",
          warehouse_id: 1002,
          warehouse_name: "仓库二",
          present: 5,
          free_stock: 5,
        },
      ],
      has_next: false,
      cursor: "",
    },
    {
      result: [
        {
          id: 401,
          offer_id: "offer-401",
          attributes: [{ id: 7, name: "Color", values: [{ value: "Red" }] }],
          type_id: 9002,
        },
      ],
    },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 100,
    maxPages: 1,
    hydrate: true,
    hydrationConcurrency: 1,
  });
  assert.equal(accepted.accepted, true);
  await Promise.all(pending);

  assert.deepEqual(
    scheduler.calls.map((call) => call.endpointKey),
    [
      "products.list",
      "products.infoList",
      "products.pictures",
      "products.prices",
      "products.stocks",
      "products.stocksByWarehouseFbs",
      "products.stocksByWarehouseFbs",
      "products.attributes",
    ],
  );
  const warehouseStockCall = scheduler.calls.find(
    (call) => call.endpointKey === "products.stocksByWarehouseFbs",
  );
  assert.deepEqual(warehouseStockCall.params.offer_id, ["offer-401"]);
  assert.equal(warehouseStockCall.params.filter, undefined);
  const warehouseStockCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.stocksByWarehouseFbs",
  );
  assert.equal(warehouseStockCalls.length, 2);
  assert.equal(warehouseStockCalls[1].params.cursor, "warehouse-page-2");
  assert.deepEqual(scheduler.calls.at(-1).params.filter.offer_id, [
    "offer-401",
  ]);
  assert.equal(scheduler.calls.at(-1).params.filter.product_id, undefined);

  const cache = service.readCache({
    shopId,
    visibility: "IN_SALE",
    pageSize: 20,
  });
  assert.equal(cache.rows[0].name, "补水商品");
  assert.equal(cache.rows[0].images.length, 2);
  assert.equal(cache.rows[0].priceValue, 34.4);
  assert.equal(cache.rows[0].acquiringFeeValue, 0.34);
  assert.equal(cache.rows[0].feeJson.acquiring_fee_value, 0.34);
  assert.equal(cache.rows[0].stockValue, 6);
  assert.equal(cache.rows[0].sellerWarehouseStockTotal, 9);
  assert.equal(cache.rows[0].warehouseStockCount, 2);
  assert.equal(
    cache.rows[0].facetObservations.stocks.endpointKey,
    "products.stocks",
  );
  assert.equal(cache.rows[0].typeId, "9002");
  assert.equal(cache.rows[0].attributes[0].name, "Color");
  assert.equal(cache.rows[0].hydrationComplete, true);
  assert.ok(cache.rows[0].hydratedAt);
  assert.deepEqual(cache.rows[0].hydrationCoverage, {
    detail: true,
    pictures: true,
    prices: true,
    stocks: true,
    attributes: true,
  });
  const material = db
    .prepare(
      "SELECT source, weight_kg, width_cm, height_cm, depth_cm FROM product_material_profiles WHERE shop_id = ? AND product_id = '401' AND source = 'ozon-product-list-read'",
    )
    .get(shopId);
  assert.equal(material.source, "ozon-product-list-read");
  assert.equal(material.weight_kg, 0.25);
  assert.equal(material.width_cm, 12);
  assert.equal(material.height_cm, 8);
  assert.equal(material.depth_cm, 30);
});

test("warehouse stock hydration rejects broken cursor continuation and retains prior complete facts", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      "shop_products_warehouse_cursor_incomplete",
    );
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: "IN_SALE",
      rows: [{
        product_id: 1401,
        offer_id: "offer-1401",
        sku: "sku-1401",
        name: "cursor guard",
        visibility: "IN_SALE",
      }],
    });
    repository.mergeProductWarehouseStockRows({
      shopId,
      rows: [{
        product_id: 1401,
        offer_id: "offer-1401",
        sku: "sku-1401",
        warehouse_id: 1,
        warehouse_name: "原完整仓",
        present: 7,
        free_stock: 7,
      }],
      provenance: {
        contractVersion: "ozon-products-stocks-by-warehouse-fbs-v2",
      },
    });

    const calls = [];
    const scheduler = {
      async executeReadOnly(input) {
        calls.push(input);
        if (input.endpointKey === "products.list") {
          return {
            ok: true,
            status: "success",
            jobId: `cursor-list-${calls.length}`,
            data: {
              result: {
                items: [{
                  product_id: 1401,
                  offer_id: "offer-1401",
                  visibility: "IN_SALE",
                }],
                last_id: "",
              },
            },
          };
        }
        if (input.endpointKey === "products.stocksByWarehouseFbs") {
          const page = input.params.cursor ? 2 : 1;
          return {
            ok: true,
            status: "success",
            jobId: `cursor-warehouse-${page}`,
            data: {
              products: [{
                product_id: 1401,
                offer_id: "offer-1401",
                sku: "sku-1401",
                warehouse_id: page === 1 ? 2 : 3,
                warehouse_name: `不完整仓${page}`,
                present: page === 1 ? 70 : 80,
                free_stock: page === 1 ? 70 : 80,
              }],
              has_next: true,
              cursor: "duplicate-cursor",
            },
          };
        }
        const rowsByEndpoint = {
          "products.infoList": [{
            id: 1401,
            offer_id: "offer-1401",
            name: "cursor guard",
          }],
          "products.pictures": [{
            product_id: 1401,
            offer_id: "offer-1401",
            images: [],
          }],
          "products.prices": [{
            product_id: 1401,
            offer_id: "offer-1401",
            price: { price: "10", currency_code: "RUB" },
          }],
          "products.stocks": [{
            product_id: 1401,
            offer_id: "offer-1401",
            stocks: [{ type: "FBS", present: 7 }],
          }],
          "products.attributes": [{
            id: 1401,
            offer_id: "offer-1401",
            attributes: [],
          }],
        };
        return {
          ok: true,
          status: "success",
          jobId: `cursor-${input.endpointKey}-${calls.length}`,
          data: { items: rowsByEndpoint[input.endpointKey] || [] },
        };
      },
    };
    const pending = [];
    const service = createProductsService({
      db,
      shopRepository,
      ozonScheduler: scheduler,
      backgroundRunner(task) {
        pending.push(task());
      },
    });
    service.startSync({
      shopId,
      visibility: "IN_SALE",
      pageSize: 100,
      maxPages: 1,
      hydrate: true,
      hydrationConcurrency: 1,
    });
    await Promise.all(pending);

    const product = repository.listProducts({
      shopId,
      productIds: ["1401"],
      pageSize: 20,
    }).rows[0];
    assert.equal(product.sellerWarehouseStockTotal, 7);
    assert.equal(product.warehouseStockCount, 1);
    assert.equal(product.warehouseStocks[0].warehouseId, "1");
    assert.equal(product.warehouseStockObservation.status, "stale_previous");
    assert.equal(
      product.warehouseStockObservation.currentStatus,
      "contract_invalid",
    );
    assert.equal(
      calls.filter(
        (call) => call.endpointKey === "products.stocksByWarehouseFbs",
      ).length,
      2,
    );
  } finally {
    db.close();
  }
});

test("products service supports all-page list sync until Ozon last_id ends", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_sync_all_pages");
  const scheduler = createFakeScheduler([
    {
      result: {
        items: [
          { product_id: 701, offer_id: "offer-701", visibility: "IN_SALE" },
        ],
        last_id: "cursor-701",
      },
    },
    {
      result: {
        items: [
          { product_id: 702, offer_id: "offer-702", visibility: "IN_SALE" },
        ],
        last_id: "",
      },
    },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 1,
    maxPages: "all",
    hydrate: false,
  });
  assert.equal(accepted.accepted, true);
  await Promise.all(pending);

  const listCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.list",
  );
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[0].params.last_id, "");
  assert.equal(listCalls[1].params.last_id, "cursor-701");
  const cache = service.readCache({
    shopId,
    visibility: "IN_SALE",
    pageSize: 20,
  });
  assert.equal(cache.total, 2);
});

test("products service stops product list paging when a page is shorter than limit", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_sync_short_page_stop",
  );
  const scheduler = createFakeScheduler([
    {
      result: {
        items: [
          { product_id: 703, offer_id: "offer-703", visibility: "IN_SALE" },
        ],
        last_id: "cursor-should-not-be-used",
      },
    },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 1000,
    maxPages: "all",
    hydrate: false,
  });
  assert.equal(accepted.accepted, true);
  await Promise.all(pending);

  const listCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.list",
  );
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].params.last_id, "");
  const cache = service.readCache({
    shopId,
    visibility: "IN_SALE",
    pageSize: 20,
  });
  assert.equal(cache.total, 1);
});

test("unified full products service hydrates 5001 collected products without a fixed cap", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_sync_no_fixed_hydrate_cap",
  );
  const items = Array.from({ length: 5001 }, (_, index) => ({
    product_id: index + 1,
    offer_id: `offer-${index + 1}`,
    visibility: "IN_SALE",
  }));
  const scheduler = createFakeScheduler([
    { result: { items: items.slice(0, 1000), last_id: "full-page-2" } },
    { result: { items: items.slice(1000, 2000), last_id: "full-page-3" } },
    { result: { items: items.slice(2000, 3000), last_id: "full-page-4" } },
    { result: { items: items.slice(3000, 4000), last_id: "full-page-5" } },
    { result: { items: items.slice(4000, 5000), last_id: "full-page-6" } },
    { result: { items: items.slice(5000), last_id: "" } },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    allStatuses: true,
    pageSize: 1000,
    maxPages: 1,
    hydrate: true,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.unifiedFullRun, true);
  assert.equal(pending.length, 1);
  await Promise.all(pending);

  const listCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.list",
  );
  assert.equal(listCalls.length, 12);
  assert.deepEqual(
    [...new Set(listCalls.map((call) => call.params.filter.visibility))],
    PRODUCT_FULL_SYNC_VISIBILITIES,
  );
  const infoCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.infoList",
  );
  const attributeCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.attributes",
  );
  assert.equal(infoCalls.length, 51);
  assert.equal(attributeCalls.length, 51);
  assert.equal(infoCalls.at(-1).params.product_id.length, 1);
  assert.deepEqual(attributeCalls.at(-1).params.filter.offer_id, [
    "offer-5001",
  ]);
});

test("products service core hydration skips heavy product-card endpoints for fast list refresh", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_sync_core_hydration",
  );
  const items = Array.from({ length: 2501 }, (_, index) => ({
    product_id: index + 1,
    offer_id: `offer-${index + 1}`,
    visibility: "IN_SALE",
  }));
  const scheduler = createFakeScheduler([
    { result: { items: items.slice(0, 1000), last_id: "core-page-2" } },
    { result: { items: items.slice(1000, 2000), last_id: "core-page-3" } },
    { result: { items: items.slice(2000), last_id: "" } },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 1000,
    maxPages: "all",
    hydrate: true,
    hydrationMode: "core",
    hydrationBatchSize: 1000,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.hydrationMode, "core");
  await Promise.all(pending);

  const endpointCounts = scheduler.calls.reduce((counts, call) => {
    counts[call.endpointKey] = (counts[call.endpointKey] || 0) + 1;
    return counts;
  }, {});
  assert.equal(endpointCounts["products.list"], 3);
  assert.equal(endpointCounts["products.infoList"], 26);
  assert.equal(endpointCounts["products.prices"], 26);
  assert.equal(endpointCounts["products.stocks"], 26);
  assert.equal(endpointCounts["products.pictures"] || 0, 0);
  assert.equal(endpointCounts["products.attributes"] || 0, 0);
  assert.equal(endpointCounts["products.stocksByWarehouseFbs"] || 0, 0);

  const infoCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.infoList",
  );
  assert.equal(infoCalls[0].params.product_id.length, 100);
  assert.equal(infoCalls[1].params.product_id.length, 100);
  assert.equal(infoCalls.at(-1).params.product_id.length, 1);
});

test("products service detail hydration reads product cards in API-safe batches without price or stock fan-out", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_sync_detail_hydration");
  const items = Array.from({ length: 201 }, (_, index) => ({
    product_id: index + 1,
    offer_id: `offer-${index + 1}`,
    visibility: "ARCHIVED",
  }));
  const scheduler = createFakeScheduler([{ result: { items, last_id: "" } }]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "ARCHIVED",
    pageSize: 1000,
    maxPages: 1,
    hydrate: true,
    hydrationMode: "details",
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.hydrationMode, "details");
  await Promise.all(pending);

  const endpointCounts = scheduler.calls.reduce((counts, call) => {
    counts[call.endpointKey] = (counts[call.endpointKey] || 0) + 1;
    return counts;
  }, {});
  assert.equal(endpointCounts["products.list"], 1);
  assert.equal(endpointCounts["products.infoList"], 3);
  assert.equal(endpointCounts["products.pictures"] || 0, 0);
  assert.equal(endpointCounts["products.prices"] || 0, 0);
  assert.equal(endpointCounts["products.stocks"] || 0, 0);
  assert.equal(endpointCounts["products.attributes"] || 0, 0);
  const infoCalls = scheduler.calls.filter((call) => call.endpointKey === "products.infoList");
  assert.equal(infoCalls[0].params.product_id.length, 100);
  assert.equal(infoCalls.at(-1).params.product_id.length, 1);
});

test("products service picture hydration reads only the canonical picture endpoint", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_sync_picture_hydration",
  );
  const items = Array.from({ length: 201 }, (_, index) => ({
    product_id: index + 1,
    offer_id: `offer-${index + 1}`,
    visibility: "IN_SALE",
  }));
  const scheduler = createFakeScheduler([{ result: { items, last_id: "" } }]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 1000,
    maxPages: 1,
    hydrate: true,
    hydrationMode: "pictures",
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.hydrationMode, "pictures");
  await Promise.all(pending);

  const endpointCounts = scheduler.calls.reduce((counts, call) => {
    counts[call.endpointKey] = (counts[call.endpointKey] || 0) + 1;
    return counts;
  }, {});
  assert.equal(endpointCounts["products.list"], 1);
  assert.equal(endpointCounts["products.pictures"], 3);
  assert.equal(endpointCounts["products.infoList"] || 0, 0);
  assert.equal(endpointCounts["products.prices"] || 0, 0);
  assert.equal(endpointCounts["products.stocks"] || 0, 0);
  assert.equal(endpointCounts["products.attributes"] || 0, 0);
  assert.equal(endpointCounts["products.stocksByWarehouseFbs"] || 0, 0);
  const pictureCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.pictures",
  );
  assert.equal(pictureCalls[0].params.product_id.length, 100);
  assert.equal(pictureCalls.at(-1).params.product_id.length, 1);
});

test("product hydration cache keys are stable for the same request and isolated by product IDs", () => {
  const shared = {
    shopId: "shop-cache-scope",
    endpointKey: "products.infoList",
  };
  const first = buildProductHydrationCacheKey({
    ...shared,
    params: { product_id: [1, 2, 3] },
  });
  const repeated = buildProductHydrationCacheKey({
    ...shared,
    params: { product_id: [1, 2, 3] },
  });
  const different = buildProductHydrationCacheKey({
    ...shared,
    params: { product_id: [101, 102, 103] },
  });

  assert.equal(first, repeated);
  assert.notEqual(first, different);
  assert.equal(first.includes(":product:1"), false);
});

test("products service marks incomplete info hydration partial instead of silently succeeding", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      "shop_products_sync_incomplete_detail",
    );
    const scheduler = createFakeScheduler([
      {
        result: {
          items: [
            { product_id: 91001, offer_id: "offer-91001", visibility: "ARCHIVED" },
            { product_id: 91002, offer_id: "offer-91002", visibility: "ARCHIVED" },
          ],
          last_id: "",
        },
      },
      {
        items: [
          { id: 91001, offer_id: "offer-91001", name: "已返回商品" },
        ],
      },
    ]);
    const pending = [];
    const service = createProductsService({
      db,
      shopRepository,
      ozonScheduler: scheduler,
      backgroundRunner(task) {
        pending.push(task());
      },
    });

    const accepted = service.startSync({
      shopId,
      visibility: "ARCHIVED",
      pageSize: 1000,
      maxPages: 1,
      hydrate: true,
      hydrationMode: "details",
    });
    await Promise.all(pending);

    const job = db
      .prepare("SELECT status, failed_count, last_error FROM ozon_request_jobs WHERE id = ?")
      .get(accepted.jobId);
    assert.equal(job.status, "partial");
    assert.equal(job.failed_count, 0);
    assert.match(job.last_error, /91002/u);
    const rows = db
      .prepare(
        "SELECT product_id, detail_synced_at FROM ozon_products WHERE shop_id = ? ORDER BY product_id",
      )
      .all(shopId);
    assert.equal(rows[0].detail_synced_at !== null, true);
    assert.equal(rows[1].detail_synced_at, null);
  } finally {
    db.close();
  }
});

test("products service records a missing archived price row as not_returned instead of stamping the whole batch complete", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      "shop_products_sync_incomplete_prices",
    );
    const calls = [];
    const scheduler = {
      calls,
      async executeReadOnly(input) {
        calls.push(input);
        if (input.endpointKey === "products.list") {
          return {
            ok: true,
            status: "success",
            jobId: "list-operation",
            data: {
              result: {
                items: [
                  {
                    product_id: 91101,
                    offer_id: "offer-91101",
                    visibility: "ARCHIVED",
                  },
                  {
                    product_id: 91102,
                    offer_id: "offer-91102",
                    visibility: "ARCHIVED",
                  },
                ],
                last_id: "",
              },
            },
          };
        }
        if (input.endpointKey === "products.prices") {
          return {
            ok: true,
            status: "success",
            jobId: "price-operation",
            results: [{ remoteHash: "d".repeat(64) }],
            data: {
              items: [
                {
                  product_id: 91101,
                  offer_id: "offer-91101",
                  price: { price: 55.16, currency_code: "RUB" },
                  commissions: {
                    sales_percent_fbo: 0,
                    sales_percent_fbs: 0,
                    sales_percent_rfbs: 0,
                    sales_percent_fbp: 0,
                  },
                },
              ],
            },
          };
        }
        if (input.endpointKey === "products.stocks") {
          return {
            ok: true,
            status: "success",
            jobId: "stock-operation",
            results: [{ remoteHash: "e".repeat(64) }],
            data: {
              items: [
                {
                  product_id: 91101,
                  offer_id: "offer-91101",
                  stocks: [{ present: 0 }],
                },
                {
                  product_id: 91102,
                  offer_id: "offer-91102",
                  stocks: [{ present: 0 }],
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected endpoint ${input.endpointKey}`);
      },
    };
    const pending = [];
    const service = createProductsService({
      db,
      shopRepository,
      ozonScheduler: scheduler,
      backgroundRunner(task) {
        pending.push(task());
      },
    });

    const accepted = service.startSync({
      shopId,
      visibility: "ARCHIVED",
      pageSize: 1000,
      maxPages: 1,
      hydrate: true,
      hydrationMode: "fast",
    });
    await Promise.all(pending);

    const job = db
      .prepare(
        "SELECT status, failed_count, last_error FROM ozon_request_jobs WHERE id = ?",
      )
      .get(accepted.jobId);
    assert.equal(job.status, "partial");
    assert.equal(job.failed_count, 0);
    assert.match(job.last_error, /prices=1/u);

    const rows = service.readCache({
      shopId,
      visibility: "ARCHIVED",
      pageSize: 20,
    }).rows;
    const returned = rows.find((row) => row.productId === "91101");
    const missing = rows.find((row) => row.productId === "91102");
    assert.equal(returned.priceValue, 55.16);
    assert.equal(returned.commissionPercent, null);
    assert.equal(returned.commissionStatus, "unavailable");
    assert.equal(returned.facetObservations.prices.status, "returned");
    assert.equal(returned.facetObservations.prices.responseHash, "d".repeat(64));
    assert.equal(missing.pricesSyncedAt, null);
    assert.equal(missing.facetObservations.prices.status, "not_returned");
    assert.equal(missing.facetObservations.stocks.status, "returned");
  } finally {
    db.close();
  }
});

test("concurrent ALL enrichment and 1293 archived details hydrate every archived batch", async () => {
  const db = createMigratedTestDb();
  let releaseActiveInfo;
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(
      shopRepository,
      "shop_products_concurrent_archived_details",
    );
    const activeProductId = 9000001;
    const archivedItems = Array.from({ length: 1293 }, (_, index) => ({
      product_id: 9200000 + index,
      offer_id: `archived-offer-${index}`,
      visibility: "ARCHIVED",
    }));
    let markActiveInfoStarted;
    const activeInfoStarted = new Promise((resolve) => {
      markActiveInfoStarted = resolve;
    });
    const activeInfoGate = new Promise((resolve) => {
      releaseActiveInfo = resolve;
    });
    const infoCalls = [];
    let activeInfoWaiting = false;
    const scheduler = createOzonScheduler({
      db,
      shopRepository,
      queueOptions: {
        shopConcurrency: 24,
        endpointConcurrency: 24,
      },
      ozonClient: {
        async requestReadOnly({ endpointKey, payload }) {
          if (endpointKey === "products.list") {
            const visibility = payload?.filter?.visibility;
            const cursor = payload?.last_id || "";
            const archivedOffset = cursor === "archived-page-2" ? 1000 : 0;
            const items = visibility === "ARCHIVED"
              ? archivedItems.slice(archivedOffset, archivedOffset + 1000)
              : [
                    {
                      product_id: activeProductId,
                      offer_id: "active-offer",
                      visibility: "ALL",
                    },
                  ];
            return {
              ok: true,
              status: 200,
              data: {
                result: {
                  items,
                  last_id:
                    visibility === "ARCHIVED" && archivedOffset === 0
                      ? "archived-page-2"
                      : "",
                },
              },
            };
          }
          if (endpointKey === "products.infoList") {
            const productIds = (payload?.product_id || []).map(Number);
            infoCalls.push(productIds);
            if (productIds.includes(activeProductId)) {
              activeInfoWaiting = true;
              markActiveInfoStarted();
              await activeInfoGate;
            } else if (activeInfoWaiting) {
              releaseActiveInfo();
              activeInfoWaiting = false;
            }
            return {
              ok: true,
              status: 200,
              data: {
                items: productIds.map((productId) => ({
                  id: productId,
                  name: `商品-${productId}`,
                  primary_image: `https://img.example/${productId}.jpg`,
                  price: "10.00",
                  description_category_id: 17028669,
                })),
              },
            };
          }
          throw new Error(`Unexpected endpoint: ${endpointKey}`);
        },
      },
    });
    const pending = [];
    const service = createProductsService({
      db,
      shopRepository,
      ozonScheduler: scheduler,
      backgroundRunner(task) {
        pending.push(task());
      },
    });

    const activeAccepted = service.startSync({
      shopId,
      visibility: "ALL",
      pageSize: 1000,
      maxPages: 1,
      hydrate: true,
      hydrationMode: "details",
      hydrationConcurrency: 2,
      forceRefresh: true,
    });
    await activeInfoStarted;
    const archivedAccepted = service.startSync({
      shopId,
      visibility: "ARCHIVED",
      pageSize: 1000,
      maxPages: "all",
      hydrate: true,
      hydrationMode: "details",
      hydrationBatchSize: 100,
      hydrationConcurrency: 2,
      forceRefresh: true,
    });
    await Promise.all(pending);

    const parentJobs = db
      .prepare("SELECT id, status, failed_count FROM ozon_request_jobs WHERE id IN (?, ?)")
      .all(activeAccepted.jobId, archivedAccepted.jobId);
    assert.equal(parentJobs.every((job) => job.status === "success"), true);
    assert.equal(parentJobs.every((job) => job.failed_count === 0), true);
    assert.equal(infoCalls.length, 14);
    assert.equal(
      infoCalls.filter((productIds) => !productIds.includes(activeProductId)).length,
      13,
    );

    const archivedCoverage = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN detail_synced_at IS NULL THEN 1 ELSE 0 END) AS missing_detail,
           SUM(CASE WHEN name IS NULL OR name = '' OR name = '未返回' THEN 1 ELSE 0 END) AS missing_name
         FROM ozon_products
         WHERE shop_id = ? AND visibility = 'ARCHIVED'`,
      )
      .get(shopId);
    assert.equal(archivedCoverage.total, 1293);
    assert.equal(archivedCoverage.missing_detail, 0);
    assert.equal(archivedCoverage.missing_name, 0);

    const hydrationJobs = db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT cache_key) AS distinct_keys
         FROM ozon_request_jobs
         WHERE shop_id = ? AND endpoint_key = 'products.infoList'`,
      )
      .get(shopId);
    assert.equal(hydrationJobs.total, 14);
    assert.equal(hydrationJobs.distinct_keys, 14);
  } finally {
    releaseActiveInfo?.();
    db.close();
  }
});

test("products service fast hydration only refreshes price and stock for foreground product list", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_sync_fast_hydration",
  );
  const items = Array.from({ length: 2501 }, (_, index) => ({
    product_id: index + 1,
    offer_id: `offer-${index + 1}`,
    visibility: "IN_SALE",
  }));
  const scheduler = createFakeScheduler([
    { result: { items: items.slice(0, 1000), last_id: "fast-page-2" } },
    { result: { items: items.slice(1000, 2000), last_id: "fast-page-3" } },
    { result: { items: items.slice(2000), last_id: "" } },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 1000,
    maxPages: "all",
    hydrate: true,
    hydrationMode: "fast",
    hydrationBatchSize: 1000,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.hydrationMode, "fast");
  await Promise.all(pending);

  const endpointCounts = scheduler.calls.reduce((counts, call) => {
    counts[call.endpointKey] = (counts[call.endpointKey] || 0) + 1;
    return counts;
  }, {});
  assert.equal(endpointCounts["products.list"], 3);
  assert.equal(endpointCounts["products.infoList"] || 0, 0);
  assert.equal(endpointCounts["products.prices"], 26);
  assert.equal(endpointCounts["products.stocks"], 26);
  assert.equal(endpointCounts["products.pictures"] || 0, 0);
  assert.equal(endpointCounts["products.attributes"] || 0, 0);
  assert.equal(endpointCounts["products.stocksByWarehouseFbs"] || 0, 0);

  const priceCalls = scheduler.calls.filter(
    (call) => call.endpointKey === "products.prices",
  );
  assert.equal(priceCalls[0].params.filter.product_id.length, 100);
  assert.equal(priceCalls[1].params.filter.product_id.length, 100);
  assert.equal(priceCalls.at(-1).params.filter.product_id.length, 1);
});

test("products service hydrates product batches concurrently through scheduler", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_sync_concurrent_hydration",
  );
  const items = Array.from({ length: 300 }, (_, index) => ({
    product_id: index + 1,
    offer_id: `offer-${index + 1}`,
    visibility: "IN_SALE",
  }));
  const calls = [];
  let activeHydration = 0;
  let maxActiveHydration = 0;
  const scheduler = {
    calls,
    async executeReadOnly(input) {
      calls.push(input);
      if (input.endpointKey === "products.list") {
        return {
          ok: true,
          status: "success",
          data: { result: { items, last_id: "" } },
          jobId: `scheduler-${calls.length}`,
        };
      }

      activeHydration += 1;
      maxActiveHydration = Math.max(maxActiveHydration, activeHydration);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeHydration -= 1;
      return {
        ok: true,
        status: "success",
        data: { items: [] },
        jobId: `scheduler-${calls.length}`,
      };
    },
  };
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    pageSize: 1000,
    maxPages: 1,
    hydrate: true,
    hydrationConcurrency: 6,
  });
  assert.equal(accepted.accepted, true);
  await Promise.all(pending);

  const hydrateCalls = calls.filter(
    (call) => call.endpointKey !== "products.list",
  );
  assert.equal(hydrateCalls.length, 18);
  assert.equal(maxActiveHydration, 6);
});

test("products service defaults remote product list fetch to 1000 rows", async () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(
    shopRepository,
    "shop_products_sync_default_list_limit",
  );
  const scheduler = createFakeScheduler([
    { result: { items: [], last_id: "" } },
  ]);
  const pending = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      pending.push(task());
    },
  });

  const accepted = service.startSync({
    shopId,
    visibility: "IN_SALE",
    maxPages: 1,
    hydrate: false,
  });
  assert.equal(accepted.accepted, true);
  await Promise.all(pending);

  assert.equal(scheduler.calls[0].params.limit, 1000);
});

async function withProductsServer({ db, ozonScheduler }, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonScheduler,
    ozonClient: {
      async requestReadOnly() {
        throw new Error("products route test uses fake scheduler");
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("products HTTP route accepts hydrate sync and exposes hydrated cache rows", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_products_http");
    const scheduler = createFakeScheduler([
      {
        result: {
          items: [
            { product_id: 501, offer_id: "offer-501", visibility: "IN_SALE" },
          ],
          last_id: "",
        },
      },
      {
        items: [
          {
            id: 501,
            offer_id: "offer-501",
            name: "HTTP 补水商品",
            primary_image: "https://img/http.jpg",
          },
        ],
      },
      {
        items: [
          {
            product_id: 501,
            offer_id: "offer-501",
            images: ["https://img/http.jpg"],
          },
        ],
      },
      {
        items: [
          {
            product_id: 501,
            offer_id: "offer-501",
            price: { marketing_seller_price: "55", currency_code: "RUB" },
          },
        ],
      },
      {
        items: [
          { product_id: 501, offer_id: "offer-501", stocks: [{ present: 5 }] },
        ],
      },
      {
        products: [
          {
            product_id: 501,
            offer_id: "offer-501",
            warehouse_id: 1001,
            warehouse_name: "仓库一",
            present: 3,
            free_stock: 3,
          },
          {
            product_id: 501,
            offer_id: "offer-501",
            warehouse_id: 1002,
            warehouse_name: "仓库二",
            present: 4,
            free_stock: 4,
          },
        ],
        has_next: false,
        cursor: "",
      },
      {
        result: [
          {
            id: 501,
            offer_id: "offer-501",
            attributes: [{ id: 9, name: "Size", values: [{ value: "L" }] }],
          },
        ],
      },
    ]);
    await withProductsServer({ db, ozonScheduler: scheduler }, async (base) => {
      const accepted = await (
        await fetch(`${base}/api/sync/products`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shopId,
            visibility: "IN_SALE",
            pageSize: 100,
            maxPages: 1,
            hydrate: true,
          }),
        })
      ).json();
      assert.equal(accepted.accepted, true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cache = await (
        await fetch(
          `${base}/api/cache/products?shopId=${encodeURIComponent(shopId)}&pageSize=20`,
        )
      ).json();
      assert.equal(cache.rows[0].name, "HTTP 补水商品");
      assert.equal(cache.rows[0].primaryImageUrl, "https://img/http.jpg");
      assert.equal(cache.rows[0].stockValue, 5);
      assert.equal(
        cache.rows[0].facetObservations.stocks.endpointKey,
        "products.stocks",
      );
      assert.equal(cache.rows[0].attributes[0].name, "Size");
    });
  } finally {
    db.close();
  }
});

test("products HTTP cache treats software ALL as every non-stale product status", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_products_http_all_scope");
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: "ARCHIVED",
      rows: [
        {
          product_id: 591,
          offer_id: "archived-591",
          name: "HTTP 归档商品",
          visibility: "ARCHIVED",
          archived: true,
        },
      ],
    });
    repository.upsertProducts({
      shopId,
      visibility: "ALL",
      rows: [{ product_id: 592, offer_id: "all-592", name: "HTTP 全部商品" }],
    });

    await withProductsServer(
      { db, ozonScheduler: createFakeScheduler([]) },
      async (base) => {
        const cache = await (
          await fetch(
            `${base}/api/cache/products?shopId=${encodeURIComponent(shopId)}&visibility=ALL&pageSize=20`,
          )
        ).json();
        assert.equal(cache.total, 2);
        assert.equal(cache.rows.length, 2);
        assert.equal(
          cache.rows.some((row) => row.offerId === "all-592"),
          true,
        );
        assert.equal(
          cache.rows.some((row) => row.visibility === "ARCHIVED"),
          true,
        );
        assert.equal(cache.counts.ALL, 2);
        assert.equal(cache.counts.ARCHIVED, 1);
      },
    );
  } finally {
    db.close();
  }
});

test("product repository reconciles full visibility snapshots after all-page sync", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_reconcile");
  const repository = createProductRepository(db);
  const first = repository.upsertProducts({
    shopId,
    visibility: "IN_SALE",
    rows: [
      {
        product_id: 801,
        offer_id: "offer-801",
        name: "仍在售",
        visibility: "IN_SALE",
      },
      {
        product_id: 802,
        offer_id: "offer-802",
        name: "已不在售",
        visibility: "IN_SALE",
      },
    ],
  });
  assert.equal(repository.listProducts({ shopId }).counts.IN_SALE, 2);

  const reconciled = repository.reconcileVisibilitySnapshot({
    shopId,
    visibility: "IN_SALE",
    seenProductKeys: [first.productKeys[0]],
  });

  assert.equal(reconciled.stale, 1);
  const page = repository.listProducts({
    shopId,
    visibility: "IN_SALE",
    pageSize: 20,
  });
  assert.equal(page.total, 1);
  assert.equal(page.counts.IN_SALE, 1);
  assert.equal(page.rows[0].offerId, "offer-801");
});

test("product repository does not infer real status from ALL snapshot stock fallback", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_all_scope");
  const repository = createProductRepository(db);

  repository.upsertProducts({
    shopId,
    visibility: "ALL",
    rows: [
      {
        product_id: 811,
        offer_id: "offer-811",
        name: "ALL 范围商品",
        stocks: { present: 9 },
        has_price: true,
      },
    ],
  });

  const page = repository.listProducts({ shopId, pageSize: 20 });
  assert.equal(page.total, 1);
  assert.equal(page.counts.ALL, 1);
  assert.equal(page.counts.IN_SALE, 0);
  assert.equal(page.rows[0].visibility, "ALL");
});

test("products service creates one unified all-status run per shop without shop cap", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  saveUnitShop(shopRepository, "shop_products_multi_1");
  saveUnitShop(shopRepository, "shop_products_multi_2");
  const scheduler = createFakeScheduler([]);
  const queuedTasks = [];
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: scheduler,
    backgroundRunner(task) {
      queuedTasks.push(task);
    },
  });

  const accepted = service.startSync({
    shopId: "all",
    allStatuses: true,
    maxPages: "all",
    pageSize: 1000,
    hydrate: true,
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.batch, true);
  assert.deepEqual(accepted.visibilities, PRODUCT_FULL_SYNC_VISIBILITIES);
  assert.equal(accepted.shopIds.length, 2);
  assert.equal(
    accepted.jobIds.length,
    2,
  );
  assert.equal(queuedTasks.length, 2);
  for (const job of accepted.jobs) {
    assert.equal(job.visibility, "FULL");
    assert.equal(job.hydrate, true);
    assert.deepEqual(job.visibilities, PRODUCT_FULL_SYNC_VISIBILITIES);
  }
});

test("products service reads product cache from memory after first SQLite page read", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, "shop_products_hot_cache");
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId,
    visibility: "ARCHIVED",
    rows: [
      {
        product_id: 9011,
        offer_id: "offer-9011",
        name: "热缓存商品",
        visibility: "ARCHIVED",
        archived: true,
      },
    ],
  });
  const service = createProductsService({
    db,
    shopRepository,
    ozonScheduler: createFakeScheduler([]),
    backgroundRunner() {},
  });

  const first = service.readCache({
    shopId,
    visibility: "ARCHIVED",
    pageSize: 20,
    page: 1,
  });
  const second = service.readCache({
    shopId,
    visibility: "ARCHIVED",
    pageSize: 20,
    page: 1,
  });

  assert.equal(first.source, "sqlite");
  assert.equal(second.source, "memory");
  assert.equal(second.rows[0].offerId, "offer-9011");
  assert.equal(second.counts.ARCHIVED, 1);
});

test("product repository treats shopId all as aggregated SQLite product cache scope", () => {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopA = saveUnitShop(shopRepository, "shop_products_all_scope_a");
  const shopB = saveUnitShop(shopRepository, "shop_products_all_scope_b");
  const repository = createProductRepository(db);
  repository.upsertProducts({
    shopId: shopA,
    visibility: "ARCHIVED",
    rows: [
      {
        product_id: 9101,
        offer_id: "offer-9101",
        name: "聚合 A",
        visibility: "ARCHIVED",
        archived: true,
      },
    ],
  });
  repository.upsertProducts({
    shopId: shopB,
    visibility: "ARCHIVED",
    rows: [
      {
        product_id: 9102,
        offer_id: "offer-9102",
        name: "聚合 B",
        visibility: "ARCHIVED",
        archived: true,
      },
    ],
  });

  const page = repository.listProducts({
    shopId: "all",
    visibility: "ARCHIVED",
    keyword: "聚合",
    pageSize: 20,
  });

  assert.equal(page.total, 2);
  assert.equal(page.counts.ARCHIVED, 2);
  assert.deepEqual(page.rows.map((row) => row.offerId).sort(), [
    "offer-9101",
    "offer-9102",
  ]);
});

