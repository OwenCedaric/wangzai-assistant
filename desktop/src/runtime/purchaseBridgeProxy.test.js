import assert from "node:assert/strict";
import test from "node:test";
import { createPurchaseBridgeProxy } from "./purchaseBridgeProxy.js";

function runtime({ mode = "enforce", authorized = true, permissions = ["purchase.manage"] } = {}) {
  return {
    getRuntime: async () => ({ mode }),
    getSession: async () => ({ authorized, entitlement: { permissions } }),
  };
}

test("purchase bridge proxy adds its capability token", async () => {
  let captured;
  const proxy = createPurchaseBridgeProxy({
    baseUrl: "http://127.0.0.1:3788",
    authToken: "test-capability",
    licenseRuntime: runtime(),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ ok: true, results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/purchase/image-search",
    body: { imageUrl: "https://example.test/image.jpg" },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.options.headers["X-Wangzai-Purchase-Token"], "test-capability");
  assert.equal(captured.url, "http://127.0.0.1:3788/api/purchase/image-search");
});

test("purchase bridge proxy allows the exact purchase-account cleanup endpoint", async () => {
  let captured;
  const proxy = createPurchaseBridgeProxy({
    baseUrl: "http://127.0.0.1:3788",
    authToken: "test-capability",
    licenseRuntime: runtime(),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ ok: true, verified: true, remaining: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/purchase/account-removal/purchase-account",
    body: { ownerId: "purchase-a" },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url, "http://127.0.0.1:3788/api/purchase/account-removal/purchase-account");
  assert.deepEqual(JSON.parse(captured.options.body), { ownerId: "purchase-a" });
});

test("purchase bridge proxy denies missing entitlement permission", async () => {
  const proxy = createPurchaseBridgeProxy({
    baseUrl: "http://127.0.0.1:3788",
    authToken: "test-capability",
    licenseRuntime: runtime({ permissions: [] }),
    fetchImpl: async () => assert.fail("must not reach bridge"),
  });
  const result = await proxy({ method: "POST", path: "/api/purchase/image-search" });
  assert.equal(result.status, 403);
});

test("purchase bridge proxy rejects unknown and cross-origin paths", async () => {
  const proxy = createPurchaseBridgeProxy({
    baseUrl: "http://127.0.0.1:3788",
    authToken: "test-capability",
    licenseRuntime: runtime(),
  });
  assert.equal((await proxy({ path: "/health" })).status, 400);
  assert.equal((await proxy({ path: "https://example.test/api/purchase/image-search" })).status, 400);
});
