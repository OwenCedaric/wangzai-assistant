import assert from "node:assert/strict";
import test from "node:test";
import { createProductRepository } from "../db/repositories/productRepository.js";
import { createShopRepository } from "../db/repositories/shopRepository.js";
import { createApp } from "./createApp.js";
import { createMigratedTestDb, saveUnitShop } from "../../test/testDb.js";

function createWriteScheduler() {
  const writeCalls = [];
  return {
    writeCalls,
    readCache() {
      return { ok: true, rows: [] };
    },
    getJob() {
      return null;
    },
    cancelJob() {
      return { ok: true };
    },
    listSyncState() {
      return [];
    },
    listEndpoints() {
      return [];
    },
    getSchedulerStatus() {
      return { ok: true };
    },
    pauseShop() {
      return { ok: true };
    },
    resumeShop() {
      return { ok: true };
    },
    pauseEndpoint() {
      return { ok: true };
    },
    resumeEndpoint() {
      return { ok: true };
    },
    getRateLimitStatus() {
      return { ok: true };
    },
    listErrors() {
      return [];
    },
    async executeReadOnly() {
      return { ok: true, status: "success", data: { result: { items: [] } } };
    },
    async executeWrite(input) {
      writeCalls.push(input);
      return {
        ok: true,
        status: "success",
        jobId: "product-route-write-1",
        readBackRows: [
          { id: 7001, offer_id: "offer-7001", name: "new route title" },
        ],
      };
    },
  };
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

test("createApp delegates product preview/confirm/readback to productsRoutes", async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    const shopId = saveUnitShop(
      createShopRepository(db),
      "shop_product_route_write",
    );
    const repository = createProductRepository(db);
    repository.upsertProducts({
      shopId,
      visibility: "IN_SALE",
      rows: [
        {
          product_id: 7001,
          offer_id: "offer-7001",
          name: "old route title",
          visibility: "IN_SALE",
        },
      ],
    });
    const scheduler = createWriteScheduler();
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: new Date().toISOString(),
      ozonScheduler: scheduler,
      ozonClient: { async requestReadOnly() { return {}; } },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const preview = await postJson(baseUrl, "/api/write/products/preview", {
      shopId,
      action: "product.updateInfo",
      endpointKey: "products.import",
      payload: { product_id: 7001, name: "new route title" },
      after: { name: "new route title" },
      idempotencyKey: "product-route-write-1",
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.ok, true);
    assert.equal(preview.payload.requiresConfirmation, true);
    assert.equal(scheduler.writeCalls.length, 0);

    const confirm = await postJson(baseUrl, "/api/write/products/confirm", {
      shopId,
      previewId: preview.payload.previewId,
      confirm: true,
      action: "product.updateInfo",
      idempotencyKey: "product-route-write-1",
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.payload.ok, true);
    assert.equal(confirm.payload.confirmed, true);
    assert.equal(scheduler.writeCalls.length, 1);
    assert.equal(confirm.payload.writeStatus, "readback_mismatch");
    assert.equal(confirm.payload.readBack?.status, "mismatch");
    assert.equal(confirm.payload.readBack?.rows, 1);
    assert.equal(
      repository.listProducts({ shopId, productIds: ["7001"], pageSize: 20 })
        .rows[0].name,
      "new route title",
    );
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    db.close();
  }
});
