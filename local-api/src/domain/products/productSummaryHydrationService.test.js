import assert from "node:assert/strict";
import test from "node:test";
import { createHotCacheService } from "../../cache/hotCacheService.js";
import { createProductSummaryHydrationService } from "./productSummaryHydrationService.js";

function createFixture() {
  const schedulerCalls = [];
  const mergeInfoCalls = [];
  const mergePictureCalls = [];
  let rows = [];
  let invalidations = 0;
  const repository = {
    mergeProductInfoRows(input) {
      mergeInfoCalls.push(input);
      rows = input.rows.map((row) => ({
        shopId: input.shopId,
        productId: String(row.id ?? row.product_id),
        offerId: row.offer_id,
        sku: String(row.sku),
        name: row.name,
        images: [],
        primaryImageUrl: "",
      }));
      return { changed: rows.length, unchanged: 0 };
    },
    mergeProductPictureRows(input) {
      mergePictureCalls.push(input);
      const pictureByProduct = new Map(input.rows.map((row) => [
        String(row.product_id ?? row.id),
        Array.isArray(row.pictures) ? row.pictures : row.images || [],
      ]));
      rows = rows.map((row) => {
        const images = pictureByProduct.get(row.productId) || row.images;
        return { ...row, images, primaryImageUrl: images[0] || "" };
      });
      return { changed: input.rows.length, unchanged: 0 };
    },
  };
  const ozonScheduler = {
    async executeReadOnly(input) {
      schedulerCalls.push(input);
      if (input.endpointKey === "products.infoList") {
        return {
          ok: true,
          status: "success",
          jobId: "info-job",
          results: [{ remoteHash: "info-remote-hash" }],
          data: {
            items: [{
              id: 5359748272,
              offer_id: "SKU-202608060418-11-01",
              sku: 5359748272,
              name: "电磁商品",
            }],
          },
        };
      }
      return {
        ok: true,
        status: "success",
        jobId: "pictures-job",
        results: [{ remoteHash: "pictures-remote-hash" }],
        data: {
          items: [{
            product_id: 5359748272,
            pictures: ["https://cdn.example/5359748272.jpg"],
          }],
        },
      };
    },
  };
  const readSummary = (query = {}) => {
    const candidates = new Set([
      ...String(query.offerIds || "").split(","),
      ...String(query.productIds || "").split(","),
      String(query.keyword || ""),
    ].filter(Boolean));
    return {
      ok: true,
      rows: rows.filter((row) => [row.productId, row.offerId, row.sku].some((value) => candidates.has(value))),
    };
  };
  const service = createProductSummaryHydrationService({
    repository,
    ozonScheduler,
    readSummary,
    productHotCache: createHotCacheService({ ttlMs: 60_000 }),
    clearProductReadCache() {
      invalidations += 1;
    },
  });
  return {
    service,
    schedulerCalls,
    mergeInfoCalls,
    mergePictureCalls,
    getInvalidations: () => invalidations,
  };
}

test("targeted product summary hydration reads Ozon once, persists pictures and caches duplicate order misses", async () => {
  const fixture = createFixture();
  const input = {
    shopId: "ozon-shop-2",
    refs: [
      { offerId: "SKU-202608060418-11-01", sku: "5359748272" },
      { offerId: "SKU-202608060418-11-01", sku: "5359748272" },
    ],
    requireImages: true,
  };
  const first = await fixture.service.hydrateSummary(input);
  const second = await fixture.service.hydrateSummary(input);

  assert.equal(first.status, "hydrated");
  assert.equal(first.requestedCount, 1);
  assert.equal(first.rows[0].primaryImageUrl, "https://cdn.example/5359748272.jpg");
  assert.equal(second.source, "memory");
  assert.equal(fixture.schedulerCalls.length, 2);
  assert.deepEqual(fixture.schedulerCalls[0].params, {
    offer_id: ["SKU-202608060418-11-01"],
  });
  assert.equal(fixture.schedulerCalls[0].shopId, "ozon-shop-2");
  assert.equal(fixture.schedulerCalls[1].endpointKey, "products.pictures");
  assert.equal(fixture.mergeInfoCalls.length, 1);
  assert.equal(fixture.mergePictureCalls.length, 1);
  assert.equal(fixture.getInvalidations(), 2);
});

test("targeted product hydration refuses an aggregate shop scope", async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.service.hydrateSummary({ shopId: "all", refs: [{ sku: "5359748272" }] }),
    (error) => error?.code === "PRODUCT_SUMMARY_HYDRATE_SHOP_REQUIRED",
  );
  assert.equal(fixture.schedulerCalls.length, 0);
});
