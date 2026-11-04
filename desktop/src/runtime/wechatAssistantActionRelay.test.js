import assert from "node:assert/strict";
import test from "node:test";

import { createWechatAssistantActionRelay } from "./wechatAssistantActionRelay.js";

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer action-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

test("action relay blocks every operation while the selected mode is read-only", async () => {
  let calls = 0;
  const relay = createWechatAssistantActionRelay({
    token: "action-secret",
    getSettings: () => ({ toolAccessMode: "read-only" }),
    executeBusinessRequest: async () => { calls += 1; return { ok: true }; },
  });
  const { baseUrl } = await relay.start();
  try {
    const result = await post(baseUrl, "/actions/preview", {
      domain: "products",
      action: "product.updateStock",
      shopId: "shop-1",
      payload: { offer_id: "SKU-1", stock: 8 },
    });
    assert.equal(result.status, 403);
    assert.equal(result.payload.error.code, "WECHAT_ACTIONS_READ_ONLY");
    assert.equal(calls, 0);
  } finally {
    await relay.stop();
  }
});

test("action relay freezes a preview and directly submits an authorized operation only once", async () => {
  let timestamp = 1000;
  const calls = [];
  const relay = createWechatAssistantActionRelay({
    token: "action-secret",
    now: () => timestamp,
    getSettings: () => ({
      toolAccessMode: "direct-write",
      allowedOperationActions: ["products:product.updateStock"],
    }),
    executeBusinessRequest: async (request) => {
      calls.push(request);
      if (request.path.endsWith("/preview")) {
        return { ok: true, data: { ok: true, previewId: "write_preview_1", diffHash: "hash", expiresAt: new Date(31 * 60 * 1000).toISOString() } };
      }
      return { ok: true, data: { ok: true, realWrite: true, readBack: { stock: 8 } } };
    },
  });
  const { baseUrl } = await relay.start();
  try {
    const preview = await post(baseUrl, "/actions/preview", {
      domain: "products",
      action: "product.updateStock",
      shopId: "shop-1",
      endpointKey: "products.updateStock",
      before: { stock: 3 },
      after: { stock: 8 },
      payload: { offer_id: "SKU-1", stock: 8 },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.requiresConfirmation, false);
    assert.equal(preview.payload.writeExecuted, true);
    assert.equal(Object.hasOwn(preview.payload, "confirmationPhrase"), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, "/api/write/products/preview");
    assert.equal(calls[1].path, "/api/write/products/confirm");
    assert.equal(calls[1].body.realWrite, true);
    assert.equal(calls[1].body.dryRun, false);
    assert.equal(calls[1].body.payload.stock, 8);

    timestamp = 1002;
    const confirmation = await post(baseUrl, "/actions/confirm", { previewId: "write_preview_1" });
    assert.equal(confirmation.status, 200);
    assert.equal(confirmation.payload.result.readBack.stock, 8);
    assert.equal(calls.length, 2);

    const duplicate = await post(baseUrl, "/actions/confirm", { previewId: "write_preview_1" });
    assert.equal(duplicate.status, 200);
    assert.equal(calls.length, 2);
  } finally {
    await relay.stop();
  }
});

test("action relay rejects unregistered actions before creating a local write preview", async () => {
  let calls = 0;
  const relay = createWechatAssistantActionRelay({
    token: "action-secret",
    getSettings: () => ({ toolAccessMode: "direct-write", allowedOperationActions: [] }),
    executeBusinessRequest: async () => { calls += 1; return { ok: true }; },
  });
  const { baseUrl } = await relay.start();
  try {
    const result = await post(baseUrl, "/actions/preview", {
      domain: "products",
      action: "database.execute",
      shopId: "shop-1",
      payload: { sql: "UPDATE products" },
    });
    assert.equal(result.status, 400);
    assert.equal(result.payload.error.code, "WECHAT_ACTION_NOT_ALLOWED");
    assert.equal(calls, 0);
  } finally {
    await relay.stop();
  }
});

test("action relay blocks a registered action that the user did not individually authorize", async () => {
  let calls = 0;
  const relay = createWechatAssistantActionRelay({
    token: "action-secret",
    getSettings: () => ({
      toolAccessMode: "direct-write",
      allowedOperationActions: ["products:product.updatePrice"],
    }),
    executeBusinessRequest: async () => { calls += 1; return { ok: true }; },
  });
  const { baseUrl } = await relay.start();
  try {
    const result = await post(baseUrl, "/actions/preview", {
      domain: "products",
      action: "product.updateStock",
      shopId: "shop-1",
      payload: { offer_id: "SKU-1", stock: 8 },
    });
    assert.equal(result.status, 403);
    assert.equal(result.payload.error.code, "WECHAT_ACTION_PERMISSION_NOT_GRANTED");
    assert.equal(calls, 0);
  } finally {
    await relay.stop();
  }
});

test("action relay rechecks permission after preview and honors revocation before direct submit", async () => {
  let allowedOperationActions = ["products:product.updatePrice"];
  let calls = 0;
  const relay = createWechatAssistantActionRelay({
    token: "action-secret",
    getSettings: () => ({ toolAccessMode: "direct-write", allowedOperationActions }),
    executeBusinessRequest: async (request) => {
      calls += 1;
      if (request.path.endsWith("/preview")) {
        allowedOperationActions = [];
        return { ok: true, data: { ok: true, previewId: "write_preview_revoke" } };
      }
      return { ok: true, data: { ok: true, realWrite: true } };
    },
  });
  const { baseUrl } = await relay.start();
  try {
    const result = await post(baseUrl, "/actions/preview", {
      domain: "products",
      action: "product.updatePrice",
      shopId: "shop-1",
      payload: { offer_id: "SKU-1", price: "99.00" },
    });
    assert.equal(result.status, 403);
    assert.equal(result.payload.error.code, "WECHAT_ACTION_PERMISSION_REVOKED");
    assert.equal(calls, 1);
  } finally {
    await relay.stop();
  }
});
