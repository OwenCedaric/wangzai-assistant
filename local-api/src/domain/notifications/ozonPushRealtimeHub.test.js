import assert from "node:assert/strict";
import test from "node:test";
import { createOzonPushRealtimeHub } from "./ozonPushRealtimeHub.js";

test("Ozon push realtime hub separates accepted bell events from refreshed business events", async () => {
  const hub = createOzonPushRealtimeHub();
  const acceptedWait = hub.waitForEvent({ shopId: "shop-a", afterSequence: 0, timeoutMs: 2_000 });
  hub.publish({
    shopId: "shop-a",
    stage: "accepted",
    domain: "orders",
    remoteIds: ["remote-1"],
    messageTypes: ["TYPE_ORDER_NEW"],
    postingNumbers: ["ORDER-1"],
  });
  const accepted = await acceptedWait;
  assert.equal(accepted.event.stage, "accepted");
  assert.deepEqual(accepted.event.postingNumbers, ["ORDER-1"]);

  const refreshedWait = hub.waitForEvent({ shopId: "shop-a", afterSequence: accepted.sequence, timeoutMs: 2_000 });
  hub.publish({
    shopId: "shop-a",
    stage: "refreshed",
    domain: "orders",
    remoteIds: ["remote-1"],
    messageTypes: ["TYPE_ORDER_NEW"],
    postingNumbers: ["ORDER-1"],
    source: "orders-fast-refresh",
    requestedBy: "frontend-sales-orders-fast-refresh",
    jobId: "job-1",
    status: "page_merged",
    changedCount: 1,
  });
  const refreshed = await refreshedWait;
  assert.equal(refreshed.event.stage, "refreshed");
  assert.equal(refreshed.event.sequence, 2);
  assert.equal(refreshed.event.source, "orders-fast-refresh");
  assert.equal(refreshed.event.requestedBy, "frontend-sales-orders-fast-refresh");
  assert.equal(refreshed.event.jobId, "job-1");
  assert.equal(refreshed.event.status, "page_merged");
  assert.equal(refreshed.event.changedCount, 1);
  hub.close();
});

test("Ozon push realtime hub isolates shops and dedupes exact product references", async () => {
  const hub = createOzonPushRealtimeHub();
  const shopA = hub.waitForEvent({ shopId: "shop-a", afterSequence: 0, timeoutMs: 2_000 });
  const shopBController = new AbortController();
  const shopB = hub.waitForEvent({ shopId: "shop-b", afterSequence: 0, timeoutMs: 2_000, signal: shopBController.signal });
  hub.publish({
    shopId: "shop-a",
    stage: "refreshed",
    domain: "products",
    productRefs: [
      { productId: "7001", offerId: "SKU-1", sku: "9001" },
      { productId: "7001", offerId: "SKU-1", sku: "9001" },
    ],
  });
  assert.deepEqual((await shopA).event.productRefs, [{ productId: "7001", offerId: "SKU-1", sku: "9001" }]);
  shopBController.abort();
  await assert.rejects(shopB, { name: "AbortError", code: "OZON_PUSH_REALTIME_ABORTED" });
  hub.close();
});

