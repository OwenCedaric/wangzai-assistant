import test from "node:test";
import assert from "node:assert/strict";

import { createProductRepository } from "../src/db/repositories/productRepository.js";
import { createShopRepository } from "../src/db/repositories/shopRepository.js";
import {
  PRODUCT_FULL_SYNC_VISIBILITIES,
  createProductsService,
} from "../src/domain/products/productsService.js";
import { getOzonEndpoint } from "../src/ozon/ozonEndpointRegistry.js";
import { createMigratedTestDb, saveUnitShop } from "./testDb.js";

function successfulScheduler(handler) {
  const calls = [];
  return {
    calls,
    async executeReadOnly(input) {
      calls.push(input);
      return handler(input, calls.length);
    },
  };
}

function schedulerSuccess(data, jobId) {
  return {
    ok: true,
    status: "success",
    jobId,
    results: [{ remoteHash: `${jobId}`.padEnd(64, "0").slice(0, 64) }],
    data,
  };
}

test("product full-sync pagination, cursor, short-page, identity, and batch rules come from Contract Registry", () => {
  const list = getOzonEndpoint("products.list");
  assert.deepEqual(
    {
      mode: list.planning.mode,
      limitParam: list.planning.limitParam,
      lastIdParam: list.planning.lastIdParam,
      nextLastIdPath: list.planning.nextLastIdPath,
      defaultLimit: list.planning.defaultLimit,
      maxLimit: list.planning.maxLimit,
      maxPages: list.planning.maxPages,
      stopOnShortPage: list.planning.stopOnShortPage,
      identity: list.entityIdentity,
    },
    {
      mode: "last_id",
      limitParam: "limit",
      lastIdParam: "last_id",
      nextLastIdPath: "result.last_id",
      defaultLimit: 1000,
      maxLimit: 1000,
      maxPages: 20,
      stopOnShortPage: true,
      identity: {
        scopeField: "shop_id",
        primaryField: "product_id",
        alternateField: "offer_id",
      },
    },
  );
  for (const endpointKey of [
    "products.infoList",
    "products.pictures",
    "products.prices",
    "products.stocks",
    "products.stocksByWarehouseFbs",
    "products.attributes",
  ]) {
    const endpoint = getOzonEndpoint(endpointKey);
    assert.equal(endpoint.planning.mode, "ids", endpointKey);
    assert.equal(endpoint.planning.batchSize, 100, endpointKey);
    assert.equal(endpoint.planning.maxBatches, 100, endpointKey);
  }
});

test("unified full product run proves every visibility, deduplicates identities, and hydrates once", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_product_unified_full");
    const listPages = new Map([
      ["ALL:", {
        items: [
          { product_id: 1001, offer_id: "offer-1001", visibility: "IN_SALE" },
          { product_id: 1002, offer_id: "offer-1002", visibility: "TO_SUPPLY" },
        ],
        lastId: "all-page-2",
      }],
      ["ALL:all-page-2", {
        items: [
          { product_id: 1003, offer_id: "offer-1003", visibility: "ARCHIVED" },
        ],
        // A short page is terminal by the products.list Contract Registry even
        // when Ozon includes a cursor that must not be followed.
        lastId: "must-not-be-followed",
      }],
      ["IN_SALE:", {
        items: [
          { product_id: 1001, offer_id: "offer-1001", visibility: "IN_SALE" },
        ],
        lastId: "",
      }],
      ["TO_SUPPLY:", {
        items: [
          { product_id: 1002, offer_id: "offer-1002", visibility: "TO_SUPPLY" },
        ],
        lastId: "",
      }],
      ["ARCHIVED:", {
        items: [
          { product_id: 1003, offer_id: "offer-1003", visibility: "ARCHIVED" },
        ],
        lastId: "",
      }],
    ]);
    const scheduler = successfulScheduler((input, callNumber) => {
      if (input.endpointKey === "products.list") {
        const visibility = input.params.filter.visibility;
        const cursor = input.params.last_id || "";
        const page = listPages.get(`${visibility}:${cursor}`) || {
          items: [],
          lastId: "",
        };
        return schedulerSuccess(
          { result: { items: page.items, last_id: page.lastId } },
          `list-${callNumber}`,
        );
      }
      const productIds = (
        input.params.product_id ||
        input.params.filter?.product_id ||
        []
      ).map(String);
      const offerIds = (
        input.params.offer_id ||
        input.params.filter?.offer_id ||
        []
      ).map(String);
      const expectedProductIds = ["1001", "1002", "1003"];
      const expectedOfferIds = ["offer-1001", "offer-1002", "offer-1003"];
      if (productIds.length) assert.deepEqual(productIds, expectedProductIds);
      if (offerIds.length) assert.deepEqual(offerIds, expectedOfferIds);
      const rowsByEndpoint = {
        "products.infoList": expectedProductIds.map((productId) => ({
          id: productId,
          offer_id: `offer-${productId}`,
          name: `商品-${productId}`,
        })),
        "products.pictures": expectedProductIds.map((productId) => ({
          product_id: productId,
          offer_id: `offer-${productId}`,
          primary_photo: [`https://img.example/${productId}.jpg`],
        })),
        "products.prices": expectedProductIds.map((productId) => ({
          product_id: productId,
          offer_id: `offer-${productId}`,
          price: { price: "10.00", currency_code: "RUB" },
          commissions: { sales_percent_fbs: 12 },
        })),
        "products.stocks": expectedProductIds.map((productId) => ({
          product_id: productId,
          offer_id: `offer-${productId}`,
          stocks: [{ present: 1 }],
        })),
        "products.stocksByWarehouseFbs": expectedOfferIds.flatMap((offerId, index) => ([
          {
            product_id: expectedProductIds[index],
            offer_id: offerId,
            sku: `sku-${expectedProductIds[index]}`,
            warehouse_id: 1,
            warehouse_name: "仓库一",
            present: 1,
            free_stock: 1,
          },
          {
            product_id: expectedProductIds[index],
            offer_id: offerId,
            sku: `sku-${expectedProductIds[index]}`,
            warehouse_id: 2,
            warehouse_name: "仓库二",
            present: 2,
            free_stock: 2,
          },
        ])),
        "products.attributes": expectedOfferIds.map((offerId, index) => ({
          id: expectedProductIds[index],
          offer_id: offerId,
          attributes: [],
        })),
      };
      assert.ok(rowsByEndpoint[input.endpointKey], input.endpointKey);
      if (input.endpointKey === "products.stocksByWarehouseFbs") {
        return schedulerSuccess(
          {
            products: rowsByEndpoint[input.endpointKey],
            has_next: false,
            cursor: "",
          },
          `hydrate-${callNumber}`,
        );
      }
      return schedulerSuccess(
        { items: rowsByEndpoint[input.endpointKey] },
        `hydrate-${callNumber}`,
      );
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

    const accepted = service.startSync({
      shopId,
      allStatuses: true,
      pageSize: 2,
      // A bounded caller hint must not turn a full run into seven partial jobs.
      maxPages: 1,
      hydrate: true,
      hydrationMode: "details",
      maxHydrateProducts: 1,
    });

    assert.equal(accepted.accepted, true);
    assert.equal(accepted.unifiedFullRun, true);
    assert.equal(accepted.hydrationMode, "full");
    assert.equal(accepted.visibility, "FULL");
    assert.deepEqual(accepted.visibilities, PRODUCT_FULL_SYNC_VISIBILITIES);
    assert.equal(pending.length, 1);
    await Promise.all(pending);

    const listCalls = scheduler.calls.filter(
      (call) => call.endpointKey === "products.list",
    );
    assert.equal(listCalls.length, PRODUCT_FULL_SYNC_VISIBILITIES.length + 1);
    assert.deepEqual(
      [...new Set(listCalls.map((call) => call.params.filter.visibility))],
      PRODUCT_FULL_SYNC_VISIBILITIES,
    );
    assert.equal(
      listCalls.some((call) => call.params.last_id === "must-not-be-followed"),
      false,
    );
    const hydrationEndpointKeys = [
      "products.infoList",
      "products.pictures",
      "products.prices",
      "products.stocks",
      "products.stocksByWarehouseFbs",
      "products.attributes",
    ];
    for (const endpointKey of hydrationEndpointKeys) {
      assert.equal(
        scheduler.calls.filter((call) => call.endpointKey === endpointKey).length,
        1,
        endpointKey,
      );
    }

    const run = db.prepare(`
      SELECT id, mode, visibility, status, activated_snapshot_id, proof_json
        FROM product_sync_runs WHERE shop_id = ?
    `).get(shopId);
    assert.equal(run.mode, "full");
    assert.equal(run.visibility, "FULL");
    assert.equal(run.status, "completed");
    assert.ok(run.activated_snapshot_id);
    const proof = JSON.parse(run.proof_json);
    assert.equal(proof.schemaVersion, 2);
    assert.deepEqual(
      [...proof.requiredVisibilities].sort(),
      [...PRODUCT_FULL_SYNC_VISIBILITIES].sort(),
    );
    assert.equal(Object.keys(proof.committedCursors).length, 7);

    const pageProofs = db.prepare(`
      SELECT visibility, COUNT(*) AS page_count,
             SUM(is_terminal) AS terminal_count
        FROM product_sync_page_proofs WHERE run_id = ?
       GROUP BY visibility ORDER BY visibility
    `).all(run.id);
    assert.equal(pageProofs.length, 7);
    assert.equal(pageProofs.every((row) => Number(row.terminal_count) === 1), true);
    assert.equal(
      pageProofs.find((row) => row.visibility === "ALL").page_count,
      2,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM product_sync_stage_batches
         WHERE run_id = ? AND stage_kind = 'facet'
      `).get(run.id).count,
      6,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM product_sync_outbox WHERE run_id = ?")
        .get(run.id).count,
      1,
    );

    const page = service.readCache({ shopId, pageSize: 20 });
    assert.equal(page.total, 3);
    assert.deepEqual(
      page.rows.map((row) => row.productId).sort(),
      ["1001", "1002", "1003"],
    );
    assert.equal(page.rows.every((row) => row.detailSyncedAt), true);
    assert.equal(page.rows.every((row) => row.hydrationComplete), true);
    assert.equal(page.rows.every((row) => row.stockValue === 1), true);
    assert.equal(
      page.rows.every(
        (row) =>
          row.warehouseStockComplete &&
          row.warehouseStockCount === 2 &&
          row.sellerWarehouseStockTotal === 3,
      ),
      true,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count FROM product_warehouse_stock_facts
         WHERE shop_id = ?
      `).get(shopId).count,
      6,
    );
    assert.equal(proof.coverage.facets.warehouse_stocks.expected, 3);
    assert.equal(proof.coverage.facets.warehouse_stocks.returned, 3);
  } finally {
    db.close();
  }
});

test("a failed visibility keeps the prior canonical snapshot and never starts hydration or activation", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_product_unified_failure");
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: "IN_SALE",
      rows: [{
        product_id: 9001,
        offer_id: "old-offer-9001",
        name: "旧快照商品",
        visibility: "IN_SALE",
      }],
    });
    const scheduler = successfulScheduler((input, callNumber) => {
      assert.equal(input.endpointKey, "products.list");
      const visibility = input.params.filter.visibility;
      if (visibility === "TO_SUPPLY") {
        return {
          ok: true,
          status: "partial",
          error: { message: "fixture network failure" },
        };
      }
      return schedulerSuccess(
        {
          result: {
            items: visibility === "ALL"
              ? [{
                  product_id: 9002,
                  offer_id: "new-offer-9002",
                  name: "不得激活的新商品",
                }]
              : [],
            last_id: "",
          },
        },
        `list-${callNumber}`,
      );
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

    const accepted = service.startSync({
      shopId,
      syncMode: "reconcile",
      pageSize: 1000,
      hydrate: true,
      hydrationMode: "details",
    });
    await Promise.all(pending);

    const run = db.prepare(`
      SELECT id, status, activated_snapshot_id FROM product_sync_runs
       WHERE shop_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(shopId);
    assert.equal(run.status, "interrupted");
    assert.equal(run.activated_snapshot_id, null);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM product_sync_outbox WHERE run_id = ?")
        .get(run.id).count,
      0,
    );
    assert.equal(
      scheduler.calls.some((call) => call.endpointKey !== "products.list"),
      false,
    );
    const rows = service.readCache({ shopId, pageSize: 20 }).rows;
    assert.deepEqual(rows.map((row) => row.productId), ["9001"]);
    assert.equal(rows[0].name, "旧快照商品");
    const job = db.prepare(`
      SELECT status, failed_count FROM ozon_request_jobs WHERE id = ?
    `).get(accepted.jobId);
    assert.equal(job.status, "partial");
    assert.equal(job.failed_count, 1);
  } finally {
    db.close();
  }
});

test("bootstrap mode is a single seven-visibility atomic run rather than seven independent jobs", async () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_product_unified_bootstrap");
    const scheduler = successfulScheduler((input, callNumber) => {
      assert.equal(input.endpointKey, "products.list");
      return schedulerSuccess(
        { result: { items: [], last_id: "" } },
        `bootstrap-list-${callNumber}`,
      );
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

    const accepted = service.startSync({
      shopId,
      syncMode: "bootstrap",
      visibility: "IN_SALE",
      hydrate: false,
      pageSize: 1000,
      maxPages: 1,
    });
    assert.equal(accepted.unifiedFullRun, true);
    assert.equal(accepted.hydrate, true);
    assert.equal(pending.length, 1);
    await Promise.all(pending);

    assert.equal(scheduler.calls.length, 7);
    assert.deepEqual(
      scheduler.calls.map((call) => call.params.filter.visibility),
      PRODUCT_FULL_SYNC_VISIBILITIES,
    );
    const run = db.prepare(`
      SELECT mode, visibility, status, activated_snapshot_id
        FROM product_sync_runs WHERE shop_id = ?
    `).get(shopId);
    assert.deepEqual(
      {
        mode: run.mode,
        visibility: run.visibility,
        status: run.status,
        activated: Boolean(run.activated_snapshot_id),
      },
      {
        mode: "bootstrap",
        visibility: "FULL",
        status: "completed",
        activated: true,
      },
    );
  } finally {
    db.close();
  }
});

test("a partial explicit visibility list is not mislabeled as a full run", () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, "shop_product_partial_visibility_plan");
    const queuedTasks = [];
    const service = createProductsService({
      db,
      shopRepository,
      ozonScheduler: successfulScheduler(() => {
        throw new Error("queued fixture must not execute");
      }),
      backgroundRunner(task) {
        queuedTasks.push(task);
      },
    });

    const accepted = service.startSync({
      shopId,
      visibilities: ["IN_SALE", "ARCHIVED"],
      hydrate: false,
    });
    assert.equal(accepted.batch, true);
    assert.equal(accepted.unifiedFullRun, false);
    assert.equal(accepted.jobIds.length, 2);
    assert.equal(queuedTasks.length, 2);
    assert.deepEqual(
      accepted.jobs.map((job) => job.visibility),
      ["IN_SALE", "ARCHIVED"],
    );
  } finally {
    db.close();
  }
});
