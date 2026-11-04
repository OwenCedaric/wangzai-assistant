import assert from "node:assert/strict";
import test from "node:test";
import {
  createOzonPushDomainRefreshCoordinator,
  ozonPushDomainRefreshRoutes,
} from "./ozonPushDomainRefreshCoordinator.js";

function dormantTimers() {
  return {
    setTimeoutFn() {
      return { unref() {} };
    },
    clearTimeoutFn() {},
  };
}

test("the unified dispatcher covers all 22 configured Ozon push types", () => {
  const routes = [
    ...Object.keys(ozonPushDomainRefreshRoutes.orders),
    ...Object.keys(ozonPushDomainRefreshRoutes.products),
    ...ozonPushDomainRefreshRoutes.customer,
  ];
  assert.equal(routes.length, 22);
  assert.equal(new Set(routes).size, 22);
});

test("all useful push types route to exact order, product or chat refreshes", async () => {
  const calls = [];
  const invalidations = [];
  const refreshed = [];
  const coordinator = createOzonPushDomainRefreshCoordinator({
    ...dormantTimers(),
    debounceMs: 0,
    minBatchIntervalMs: 0,
    refreshOrders: async (input) => {
      calls.push(["orders", input]);
      return {
        ok: true,
        foundCount: input.postingNumbers.length,
        results: input.postingNumbers.map((postingNumber) => ({ postingNumber, found: true })),
      };
    },
    refreshProducts: async (input) => {
      calls.push(["products", input]);
      return { ok: true, failedRefKeys: [] };
    },
    refreshCustomerService: async (input) => {
      calls.push(["customerService", input]);
      return { ok: true, failedChatIds: [] };
    },
    invalidateDomainHotCache(domain, shopId) {
      invalidations.push(`${domain}:${shopId}`);
    },
    onDomainRefreshed(input) {
      refreshed.push(input);
    },
  });

  coordinator.enqueue({ shopId: "shop-a", messageType: "TYPE_DELIVERY_DATE_CHANGED", postingNumber: "ORDER-1" });
  coordinator.enqueue({
    shopId: "shop-a",
    messageType: "TYPE_STOCKS_CHANGED",
    productRefs: [{ productId: "7001", offerId: "SKU-1" }],
  });
  coordinator.enqueue({ shopId: "shop-a", messageType: "TYPE_NEW_MESSAGE", chatId: "CHAT-1" });
  const result = await coordinator.flushNow("shop-a");

  assert.deepEqual(result.map((row) => row.domain), ["orders", "products", "customerService"]);
  assert.deepEqual(calls[0][1].postingNumbers, ["ORDER-1"]);
  assert.equal(calls[0][1].sourceHints["ORDER-1"], "FBS");
  assert.deepEqual(calls[1][1].refs, [{ productId: "7001", offerId: "SKU-1", sku: "" }]);
  assert.deepEqual(calls[1][1].facets, ["stocks"]);
  assert.deepEqual(calls[2][1].chatIds, ["CHAT-1"]);
  assert.equal(calls[2][1].includeChatList, false);
  assert.deepEqual(invalidations, [
    "orders:shop-a",
    "profit:shop-a",
    "logistics:shop-a",
    "reports:shop-a",
    "dashboard-overview:shop-a",
    "products:shop-a",
    "marketing:shop-a",
    "dashboard-overview:shop-a",
    "customerService:shop-a",
  ]);
  assert.deepEqual(
    refreshed.map(({ domain, shopId, entries }) => ({
      domain,
      shopId,
      identities: entries.map((entry) => entry.identity || entry.key),
    })),
    [
      { domain: "orders", shopId: "shop-a", identities: ["ORDER-1"] },
      { domain: "products", shopId: "shop-a", identities: ["7001\u0000SKU-1\u0000"] },
      { domain: "customerService", shopId: "shop-a", identities: ["CHAT-1"] },
    ],
  );
});

test("customer realtime notification is emitted only after a successful cache refresh", async () => {
  const refreshed = [];
  let attempts = 0;
  const coordinator = createOzonPushDomainRefreshCoordinator({
    ...dormantTimers(),
    debounceMs: 0,
    minBatchIntervalMs: 0,
    maxAttempts: 2,
    retryDelaysMs: [0],
    refreshCustomerService: async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, failedChatIds: ["CHAT-1"] }
        : { ok: true, failedChatIds: [] };
    },
    onDomainRefreshed(input) {
      refreshed.push(input);
    },
  });
  coordinator.enqueue({ shopId: "shop-a", messageType: "TYPE_NEW_MESSAGE", chatId: "CHAT-1" });
  const result = await coordinator.flushNow("shop-a");

  assert.equal(result[0].ok, true);
  assert.equal(attempts, 2);
  assert.equal(refreshed.length, 1);
  assert.deepEqual(refreshed[0].entries.map((entry) => entry.chatId), ["CHAT-1"]);
});

test("same shop and identity are deduped while product facets are merged", async () => {
  const productCalls = [];
  const coordinator = createOzonPushDomainRefreshCoordinator({
    ...dormantTimers(),
    debounceMs: 0,
    minBatchIntervalMs: 0,
    refreshProducts: async (input) => {
      productCalls.push(input);
      return { ok: true, failedRefKeys: [] };
    },
  });
  const common = { shopId: "shop-a", productRefs: [{ productId: "7001" }] };
  assert.equal(coordinator.enqueue({ ...common, messageType: "TYPE_UPDATE_ITEM" }).queued, true);
  assert.equal(coordinator.enqueue({ ...common, messageType: "TYPE_STOCKS_CHANGED" }).deduped, true);
  await coordinator.flushNow("shop-a");
  assert.equal(productCalls.length, 1);
  assert.deepEqual(productCalls[0].facets, ["detail", "pictures", "attributes", "stocks"]);
});

test("a later distinct state push for the same order is never hidden by entity dedupe", async () => {
  let calls = 0;
  const coordinator = createOzonPushDomainRefreshCoordinator({
    ...dormantTimers(),
    debounceMs: 0,
    minBatchIntervalMs: 0,
    refreshOrders: async ({ postingNumbers }) => {
      calls += 1;
      return {
        ok: true,
        results: postingNumbers.map((postingNumber) => ({ postingNumber, found: true })),
      };
    },
  });
  coordinator.enqueue({
    remoteId: "state-1",
    shopId: "shop-a",
    messageType: "TYPE_ORDER_STATE_CHANGED",
    postingNumber: "ORDER-1",
  });
  await coordinator.flushNow("shop-a");
  const later = coordinator.enqueue({
    remoteId: "state-2",
    shopId: "shop-a",
    messageType: "TYPE_ORDER_STATE_CHANGED",
    postingNumber: "ORDER-1",
  });
  await coordinator.flushNow("shop-a");
  assert.equal(later.queued, true);
  assert.equal(calls, 2);
});

test("failed propagation retries only within a bounded backoff window", async () => {
  const waits = [];
  let calls = 0;
  const coordinator = createOzonPushDomainRefreshCoordinator({
    ...dormantTimers(),
    debounceMs: 0,
    minBatchIntervalMs: 0,
    retryDelaysMs: [2, 5],
    sleepFn: async (ms) => waits.push(ms),
    refreshOrders: async ({ postingNumbers }) => {
      calls += 1;
      return calls < 3
        ? { ok: true, results: postingNumbers.map((postingNumber) => ({ postingNumber, found: false })) }
        : { ok: true, results: postingNumbers.map((postingNumber) => ({ postingNumber, found: true })) };
    },
  });
  coordinator.enqueue({ shopId: "shop-a", messageType: "TYPE_ORDER_STATE_CHANGED", postingNumber: "ORDER-1" });
  const result = await coordinator.flushNow("shop-a");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2, 5]);
  assert.equal(result[0].ok, true);
});

test("unsupported push types never trigger a broad fallback scan", () => {
  const coordinator = createOzonPushDomainRefreshCoordinator({ ...dormantTimers() });
  assert.deepEqual(
    coordinator.enqueue({ shopId: "shop-a", messageType: "TYPE_UNKNOWN", postingNumber: "ORDER-1" }),
    { queued: false, ignored: true, reason: "push_type_has_no_refresh_route" },
  );
});
