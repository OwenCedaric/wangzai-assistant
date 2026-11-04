import assert from "node:assert/strict";
import test from "node:test";
import { createProductPushRefreshService } from "./productPushRefreshService.js";

test("push product refresh reads only pushed ids, merges canonical facets and invalidates nested cache", async () => {
  const schedulerCalls = [];
  const merges = [];
  let invalidations = 0;
  const repository = Object.fromEntries(
    ["Info", "Picture", "Attribute", "Price", "Stock"].map((name) => [
      `mergeProduct${name}Rows`,
      (input) => {
        merges.push({ name, input });
        return { changed: input.rows.length, unchanged: 0 };
      },
    ]),
  );
  const service = createProductPushRefreshService({
    repository,
    clearProductReadCache() {
      invalidations += 1;
    },
    ozonScheduler: {
      async executeReadOnly(input) {
        schedulerCalls.push(input);
        const rows = input.endpointKey === "products.infoList"
          ? [{ id: "7001", offer_id: "SKU-1", sku: "9001" }]
          : input.endpointKey === "products.pictures"
            ? [{ product_id: "7001", pictures: ["https://cdn.example/1.jpg"] }]
            : [{ product_id: "7001", offer_id: "SKU-1" }];
        return { ok: true, status: "success", jobId: `${input.endpointKey}-job`, data: { items: rows } };
      },
    },
  });

  const result = await service.refreshProductsByRefs({
    shopId: "shop-a",
    refs: [{ offerId: "SKU-1" }],
    facets: ["detail", "pictures", "attributes", "prices", "stocks"],
    requestCycle: "cycle-1",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(schedulerCalls.map((call) => call.endpointKey), [
    "products.infoList",
    "products.pictures",
    "products.attributes",
    "products.prices",
    "products.stocks",
  ]);
  assert.deepEqual(schedulerCalls[0].params, { offer_id: ["SKU-1"] });
  assert.deepEqual(schedulerCalls[3].params, { filter: { product_id: ["7001"] }, limit: 1000 });
  assert.ok(schedulerCalls.every((call) => call.forceRefresh === true && call.allowStale === false));
  assert.deepEqual(merges.map((call) => call.name), ["Info", "Picture", "Attribute", "Price", "Stock"]);
  assert.equal(invalidations, 1);
});

test("push product refresh returns failed ref keys for bounded coordinator retry", async () => {
  const service = createProductPushRefreshService({
    repository: {
      mergeProductStockRows() {
        assert.fail("failed endpoint must not merge");
      },
    },
    ozonScheduler: {
      async executeReadOnly() {
        return { ok: false, error: { message: "限流" } };
      },
    },
  });
  const result = await service.refreshProductsByRefs({
    shopId: "shop-a",
    refs: [{ productId: "7001" }],
    facets: ["stocks"],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failedRefKeys, ["7001\u0000\u0000"]);
  assert.match(result.errors[0], /限流/);
});
