import assert from "node:assert/strict";
import test from "node:test";
import { createHotCacheService } from "../../cache/hotCacheService.js";
import { createProductCanonicalReadService } from "./productCanonicalReadService.js";

test("product summary hot cache is isolated by shop and invalidated with the product owner tag", () => {
  let reads = 0;
  const productHotCache = createHotCacheService({ ttlMs: 60_000 });
  const service = createProductCanonicalReadService({
    repository: {},
    summaryService: {
      readSummary(query) {
        reads += 1;
        return { ok: true, rows: [{ shopId: query.shopId, offerId: query.offerIds }] };
      },
    },
    productHotCache,
  });

  const query = { shopId: "shop-a", offerIds: "offer-1", pageSize: 100 };
  const first = service.readSummary(query);
  const second = service.readSummary(query);
  const otherShop = service.readSummary({ ...query, shopId: "shop-b" });

  assert.equal(reads, 2);
  assert.equal(first.source, undefined);
  assert.equal(second.source, "memory");
  assert.equal(otherShop.rows[0].shopId, "shop-b");
  assert.equal(service.countOwnerHotCache("shop-a"), 1);

  service.invalidateOwnerHotCache("shop-a");
  const afterInvalidation = service.readSummary(query);
  assert.equal(reads, 3);
  assert.equal(afterInvalidation.source, undefined);
});
