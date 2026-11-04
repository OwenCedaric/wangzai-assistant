import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createProductsRoutes, productsRouteContract } from "./productsRoutes.js";

function createFixture() {
  const calls = [];
  const service = {
    readCache(query) {
      calls.push(["query", query]);
      return { ok: true, source: "sqlite-products", rows: [], query };
    },
    readSupport(query) {
      calls.push(["support", query]);
      return { ok: true, materialProfiles: [], query };
    },
    readSummary(query) {
      calls.push(["summary", query]);
      return { ok: true, summaryKind: "read_service", rows: [], query };
    },
    readSkuFamily(query) {
      calls.push(["sku-family", query]);
      return { ok: true, rows: [{ sku: query.sku }], total: 1, query };
    },
    hydrateSummary(body) {
      calls.push(["summary-hydrate", body]);
      return { ok: true, status: "hydrated", rows: [], shopId: body.shopId };
    },
    listMaterialProfiles(query) {
      calls.push(["material-read", query]);
      return { ok: true, profiles: [], query };
    },
    importLegacyMaterialProfiles(body) {
      calls.push(["material-legacy-import", body]);
      return { ok: true, imported: 1 };
    },
    saveMaterialProfile(body) {
      calls.push(["material-save", body]);
      return { ok: true, profile: body };
    },
    listSourceLinks(query) {
      calls.push(["source-links-read", query]);
      return { ok: true, records: [], query };
    },
    importLegacySourceLinks(body) {
      calls.push(["source-links-legacy-import", body]);
      return { ok: true, imported: 1 };
    },
    saveSourceLinks(body) {
      calls.push(["source-links-save", body]);
      return { ok: true, record: body };
    },
    saveImageHealth(body) {
      calls.push(["image-health-save", body]);
      return { ok: true, imageHealth: body };
    },
    startSync(body) {
      calls.push(["sync", body]);
      return { ok: true, accepted: true, jobId: "product-sync-job" };
    },
  };
  const writeGuardService = {
    previewWrite(domain, body) {
      calls.push(["write-preview", domain, body]);
      return { ok: true, domain, previewId: "product-preview" };
    },
    async confirmWrite(domain, body) {
      calls.push(["write-confirm", domain, body]);
      return {
        ok: true,
        domain,
        writeStatus: "completed",
        readBack: { status: "merged", snapshotId: "snapshot-after-write" },
      };
    },
    releasePreview(domain, body) {
      calls.push(["write-preview-release", domain, body]);
      return { ok: true, released: true, previewId: body.previewId };
    },
  };
  const historicalDimensionSyncService = {
    preview(body) {
      calls.push(["historical-dimension-preview", body]);
      return {
        ok: true,
        previewId: "historical-dimension-preview-1",
        previewFingerprint: "a".repeat(64),
        automatic: false,
        requiresConfirmation: true,
        targets: [],
      };
    },
    async confirm(body) {
      calls.push(["historical-dimension-confirm", body]);
      return {
        ok: true,
        completed: true,
        status: "completed",
        previewId: "historical-dimension-preview-1",
        readBack: { status: "merged", verified: true },
        targets: [],
      };
    },
  };
  return { calls, service, writeGuardService, historicalDimensionSyncService };
}

async function withRouteServer(routes, run) {
  const server = createServer((req, res) => {
    const requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "127.0.0.1"}`,
    );
    const handled = routes.handleRequest({
      req,
      res,
      requestUrl,
      query: Object.fromEntries(requestUrl.searchParams.entries()),
      corsHeaders: { "x-products-route": "domain" },
    });
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(baseUrl, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    routeHeader: response.headers.get("x-products-route"),
    payload: await response.json(),
  };
}

test("products route owns SQLite Query and all product support HTTP contracts", async () => {
  const fixture = createFixture();
  const routes = createProductsRoutes(fixture);

  await withRouteServer(routes, async (baseUrl) => {
    const canonicalQuery = new URLSearchParams({
      shopIds: "shop-a,shop-b",
      materialSources: "supplier-confirmed,cross-border-bus",
      warehouseFilters: "warehouse-a,warehouse-b",
      defaultWarehouseId: "warehouse-a",
      stockFilters: "in_stock,out_of_stock",
      productStatuses: "IN_SALE,ARCHIVED",
      sourceStatuses: "returned,unavailable",
      pageSize: "20",
    });
    const readCases = [
      [`/api/cache/products?${canonicalQuery}`, "sqlite-products"],
      ["/api/products/support?shopId=shop-a&productId=42", undefined],
      ["/api/products/summary?shopId=shop-a&offerIds=offer-42", undefined],
      ["/api/products/sku-family?shopId=shop-a&sku=sku-42", undefined],
      ["/api/products/material?shopId=shop-a", undefined],
      ["/api/products/source-links?shopId=shop-a", undefined],
    ];
    for (const [path, source] of readCases) {
      const result = await requestJson(baseUrl, path);
      assert.equal(result.status, 200, path);
      assert.equal(result.routeHeader, "domain", path);
      assert.equal(result.payload.ok, true, path);
      if (source) assert.equal(result.payload.source, source, path);
    }

    const postCases = [
      ["/api/products/summary/hydrate", { shopId: "shop-a", refs: [{ offerId: "offer-42" }] }],
      ["/api/products/material/legacy-import", { entries: [{ shopId: "shop-a" }] }],
      ["/api/products/material", { shopId: "shop-a", offerId: "offer-42" }],
      ["/api/products/source-links/legacy-import", { entries: [{ shopId: "shop-a" }] }],
      ["/api/products/source-links", { shopId: "shop-a", offerId: "offer-42" }],
      ["/api/products/image-health", { shopId: "shop-a", productId: "42" }],
    ];
    for (const [path, body] of postCases) {
      const result = await requestJson(baseUrl, path, { method: "POST", body });
      assert.equal(result.status, 200, path);
      assert.equal(result.routeHeader, "domain", path);
      assert.equal(result.payload.ok, true, path);
    }
  });

  assert.deepEqual(
    fixture.calls.map(([kind]) => kind),
    [
      "query",
      "support",
      "summary",
      "sku-family",
      "material-read",
      "source-links-read",
      "summary-hydrate",
      "material-legacy-import",
      "material-save",
      "source-links-legacy-import",
      "source-links-save",
      "image-health-save",
    ],
  );
  assert.deepEqual(fixture.calls[0][1], {
    shopIds: "shop-a,shop-b",
    materialSources: "supplier-confirmed,cross-border-bus",
    warehouseFilters: "warehouse-a,warehouse-b",
    defaultWarehouseId: "warehouse-a",
    stockFilters: "in_stock,out_of_stock",
    productStatuses: "IN_SALE,ARCHIVED",
    sourceStatuses: "returned,unavailable",
    pageSize: "20",
  });
});

test("warehouse picker projection removes heavy product facts before the HTTP response", async () => {
  const fixture = createFixture();
  fixture.service.readCache = (query) => ({
    ok: true,
    source: "sqlite-products",
    total: 1,
    rows: [{
      id: "identity-1",
      shopId: "shop-a",
      productId: "101",
      offerId: "offer-101",
      sku: "sku-101",
      name: "仓储商品",
      visibility: "IN_SALE",
      statusLabel: "出售中",
      primaryImageUrl: "https://img.example/101-main.jpg",
      images: ["https://img.example/101-main.jpg", "https://img.example/101-extra.jpg"],
      stockValue: 8,
      warehouseStocks: [{
        warehouseId: "warehouse-1",
        warehouseName: "一号仓",
        presentQuantity: 8,
        operationId: "large-operation-evidence",
        responseHash: "large-response-evidence",
      }],
      attributes: [{ id: 1, values: [{ value: "large-heavy-attribute" }] }],
      facetObservations: { attributes: { operationId: "large-facet-evidence" } },
      materialCandidates: [{ source: "large-material-evidence" }],
    }],
    query,
  });
  const routes = createProductsRoutes(fixture);

  await withRouteServer(routes, async (baseUrl) => {
    const result = await requestJson(
      baseUrl,
      "/api/cache/products?shopId=shop-a&pageSize=1000&projection=warehouse-picker",
    );
    assert.equal(result.status, 200);
    assert.equal(result.payload.projection, "warehouse-picker");
    assert.equal(result.payload.rows.length, 1);
    assert.deepEqual(result.payload.rows[0].images, ["https://img.example/101-main.jpg"]);
    assert.deepEqual(result.payload.rows[0].warehouseStocks, [{
      warehouseId: "warehouse-1",
      warehouseName: "一号仓",
      warehouseKey: "",
      sku: "",
      fulfillmentType: "",
      presentQuantity: 8,
      reservedQuantity: null,
      freeQuantity: null,
    }]);
    assert.equal("attributes" in result.payload.rows[0], false);
    assert.equal("facetObservations" in result.payload.rows[0], false);
    assert.equal("materialCandidates" in result.payload.rows[0], false);
    assert.equal(JSON.stringify(result.payload).includes("large-response-evidence"), false);
  });
});

test("products route keeps Sync separate and preserves write preview/confirm readback", async () => {
  const fixture = createFixture();
  const routes = createProductsRoutes(fixture);

  await withRouteServer(routes, async (baseUrl) => {
    const sync = await requestJson(baseUrl, "/api/sync/products", {
      method: "POST",
      body: { shopId: "shop-a", mode: "full" },
    });
    assert.equal(sync.status, 202);
    assert.equal(sync.payload.jobId, "product-sync-job");

    const preview = await requestJson(baseUrl, "/api/write/products/preview", {
      method: "POST",
      body: { shopId: "shop-a", action: "product.updatePrice" },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.previewId, "product-preview");

    const confirm = await requestJson(baseUrl, "/api/write/products/confirm", {
      method: "POST",
      body: { shopId: "shop-a", previewId: "product-preview", confirm: true },
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.payload.writeStatus, "completed");
    assert.deepEqual(confirm.payload.readBack, {
      status: "merged",
      snapshotId: "snapshot-after-write",
    });
  });

  assert.deepEqual(
    fixture.calls.map(([kind]) => kind),
    ["sync", "write-preview", "write-confirm"],
  );
  assert.equal(fixture.calls[1][1], "products");
  assert.equal(fixture.calls[2][1], "products");
});

test("products write preview accepts an 80-SKU-sized payload above the old 64 KiB ceiling", async () => {
  const fixture = createFixture();
  const routes = createProductsRoutes(fixture);
  const largeAttributeSnapshot = "x".repeat(700 * 1024);

  await withRouteServer(routes, async (baseUrl) => {
    const preview = await requestJson(baseUrl, "/api/write/products/preview", {
      method: "POST",
      body: {
        shopId: "shop-a",
        action: "product.updateInfo",
        endpointKey: "products.import",
        after: { items: [{ offer_id: "sku-1", snapshot: largeAttributeSnapshot }] },
      },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.previewId, "product-preview");
  });

  assert.equal(fixture.calls[0][0], "write-preview");
  assert.equal(fixture.calls[0][2].after.items[0].snapshot.length, 700 * 1024);
});

test("products write preview returns a readable 413 instead of destroying the connection", async () => {
  const fixture = createFixture();
  const routes = createProductsRoutes(fixture);
  const oversizedSnapshot = "x".repeat(2 * 1024 * 1024 + 64 * 1024);

  await withRouteServer(routes, async (baseUrl) => {
    const result = await requestJson(baseUrl, "/api/write/products/preview", {
      method: "POST",
      body: {
        shopId: "shop-a",
        action: "product.updateInfo",
        after: { items: [{ offer_id: "too-large", snapshot: oversizedSnapshot }] },
      },
    });
    assert.equal(result.status, 413);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error.code, "REQUEST_BODY_TOO_LARGE");
    assert.equal(result.payload.error.maxBytes, 2 * 1024 * 1024);
  });

  assert.equal(fixture.calls.length, 0);
});

test("products route releases one abandoned write preview without invalidating the shop", async () => {
  const fixture = createFixture();
  const routes = createProductsRoutes(fixture);

  await withRouteServer(routes, async (baseUrl) => {
    const result = await requestJson(baseUrl, "/api/write/products/preview/release", {
      method: "POST",
      body: { shopId: "shop-a", previewId: "product-preview" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.released, true);
  });

  assert.deepEqual(fixture.calls[0], [
    "write-preview-release",
    "products",
    { shopId: "shop-a", previewId: "product-preview" },
  ]);
});

test("products route owns the explicit historical dimension preview and confirm boundary", async () => {
  const fixture = createFixture();
  const routes = createProductsRoutes(fixture);

  await withRouteServer(routes, async (baseUrl) => {
    const preview = await requestJson(
      baseUrl,
      "/api/products/historical-dimension-sync/preview",
      { method: "POST", body: { shopId: "shop-a", productId: "42" } },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.automatic, false);
    assert.equal(preview.payload.requiresConfirmation, true);

    const confirm = await requestJson(
      baseUrl,
      "/api/products/historical-dimension-sync/confirm",
      {
        method: "POST",
        body: {
          shopId: "shop-a",
          previewId: preview.payload.previewId,
          previewFingerprint: preview.payload.previewFingerprint,
          confirm: true,
        },
      },
    );
    assert.equal(confirm.status, 200);
    assert.equal(confirm.payload.completed, true);
    assert.equal(confirm.payload.readBack.verified, true);
  });

  assert.deepEqual(
    fixture.calls.map(([kind]) => kind),
    ["historical-dimension-preview", "historical-dimension-confirm"],
  );
});

test("products route returns controlled legacy errors and does not claim unrelated routes", async () => {
  const fixture = createFixture();
  fixture.service.saveMaterialProfile = () => {
    throw new Error("material-invalid");
  };
  const routes = createProductsRoutes(fixture);

  await withRouteServer(routes, async (baseUrl) => {
    const failed = await requestJson(baseUrl, "/api/products/material", {
      method: "POST",
      body: { shopId: "shop-a" },
    });
    assert.equal(failed.status, 400);
    assert.equal(failed.payload.error.code, "PRODUCT_MATERIAL_SAVE_FAILED");

    const unknown = await requestJson(baseUrl, "/api/orders");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error.code, "NOT_FOUND");
  });
});

test("createApp only assembles and calls the products domain route", async () => {
  const source = await readFile(new URL("../../app/createApp.js", import.meta.url), "utf8");
  for (const route of Object.values(productsRouteContract.routes)) {
    assert.equal(
      source.includes(route),
      false,
      `createApp must not own product endpoint literal ${route}`,
    );
  }
  for (const responseCode of [
    "PRODUCT_QUERY_NOT_CONNECTED",
    "PRODUCT_SUPPORT_NOT_CONNECTED",
    "PRODUCT_SUMMARY_NOT_CONNECTED",
    "PRODUCT_MATERIAL_READ_FAILED",
    "PRODUCT_SOURCE_LINK_SAVE_FAILED",
    "PRODUCT_IMAGE_HEALTH_SAVE_FAILED",
  ]) {
    assert.equal(
      source.includes(responseCode),
      false,
      `createApp must not assemble product response ${responseCode}`,
    );
  }
  assert.match(source, /import \{ createProductsRoutes \} from "\.\.\/domain\/products\/productsRoutes\.js";/u);
  assert.match(source, /const productsRoutes = createProductsRoutes\(\{/u);
  assert.match(source, /productsRoutes\.handleRequest\(\{ req, res, requestUrl, query, corsHeaders \}\)/u);
});
