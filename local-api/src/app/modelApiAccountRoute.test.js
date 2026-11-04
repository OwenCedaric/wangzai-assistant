import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./createApp.js";
import { createMigratedTestDb } from "../../test/testDb.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("model API account list responses expose login accounts and mask API keys and passwords", async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      modelApiDiscoveryService: {
        discover: async () => ({
          updates: {
            apiAlias: "image2 主接口",
            provider: "relay",
            baseUrl: "https://relay.example/v1",
            defaultModel: "gpt-image-2",
            availableModels: [
              { id: "gpt-image-2", capabilities: ["image-edit"] },
            ],
            capabilities: ["image-edit"],
            detectionStatus: "已自动识别",
            detectedSource: "https://relay.example/v1/models",
            discoveryVerified: true,
          },
        }),
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saveResponse = await fetch(`${baseUrl}/api/model-api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "model-a",
        apiAlias: "image2 主接口",
        loginAccount: "model-user",
        websiteUrl: "https://relay.example/dashboard",
        loginPassword: "model-route-login-secret",
        apiKey: "model-route-api-secret",
        isDefault: true,
      }),
    });
    const saved = await saveResponse.json();
    assert.equal(saveResponse.status, 200);
    assert.equal(saved.account.hasLoginPassword, true);
    assert.equal(saved.account.hasApiKey, true);
    assert.equal(saved.account.baseUrl, "https://relay.example/v1");
    assert.equal(saved.account.discoveryVerified, true);
    assert.equal(saved.account.availableModels[0].id, "gpt-image-2");
    assert.equal(JSON.stringify(saved).includes("model-route-"), false);

    const listResponse = await fetch(`${baseUrl}/api/model-api/accounts`);
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(list.total, 1);
    assert.equal(JSON.stringify(list).includes("model-route-"), false);

    assert.equal(list.accounts[0].loginAccount, "model-user");
    assert.equal(list.accounts[0].loginPasswordHint, "••••••••••");
    assert.equal(list.accounts[0].apiKeyHint, "••••••••••");

    const deleteResponse = await fetch(
      `${baseUrl}/api/model-api/accounts/model-a`,
      { method: "DELETE" },
    );
    assert.equal(deleteResponse.status, 409);
    const rejectedDelete = await deleteResponse.json();
    assert.equal(rejectedDelete.completed, false);
    assert.equal(
      rejectedDelete.error.code,
      "ACCOUNT_REMOVAL_LEGACY_ROUTE_PREVIEW_REQUIRED",
    );
    const afterLegacyDelete = await (
      await fetch(`${baseUrl}/api/model-api/accounts`)
    ).json();
    assert.ok(
      afterLegacyDelete.accounts.some((account) => account.id === "model-a"),
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("model API account is saved when automatic discovery fails", async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      modelApiDiscoveryService: {
        discover: async () => {
          throw new Error("temporary network failure");
        },
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = "http://127.0.0.1:" + port;
    const response = await fetch(baseUrl + "/api/model-api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "model-discovery-failed",
        loginAccount: "model-user",
        websiteUrl: "https://relay.example/dashboard",
        loginPassword: "failure-login-secret",
        apiKey: "failure-api-secret",
        isDefault: true,
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.account.hasLoginPassword, true);
    assert.equal(payload.account.hasApiKey, true);
    assert.equal(payload.account.discoveryVerified, false);
    assert.match(payload.account.detectionStatus, /已保存账号/u);
    assert.equal(
      JSON.stringify(payload).includes("failure-login-secret"),
      false,
    );
    assert.equal(JSON.stringify(payload).includes("failure-api-secret"), false);

    const list = await (
      await fetch(baseUrl + "/api/model-api/accounts")
    ).json();
    assert.equal(list.total, 1);
    assert.equal(list.accounts[0].id, "model-discovery-failed");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("model API no longer exposes the retired browser-migration import route", async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const response = await fetch(
      `http://127.0.0.1:${port}/api/model-api/accounts/legacy-import`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts: [{ id: "retired-route", apiAlias: "must not import" }],
        }),
      },
    );
    assert.equal(response.status, 404);
    const accounts = await (
      await fetch(`http://127.0.0.1:${port}/api/model-api/accounts`)
    ).json();
    assert.equal(accounts.total, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("model API credentials are available only through the authenticated main-process route", async () => {
  const db = createMigratedTestDb();
  const authToken = "local-model-account-test-token-1234567890";
  const authorizedHeaders = {
    "Content-Type": "application/json",
    "x-wangzai-local-api-token": authToken,
  };
  let server;
  try {
    server = createApp({
      db,
      config: { security: { authToken }, sync: {}, ozon: {} },
      modelApiDiscoveryService: {
        discover: async () => ({
          updates: {
            apiAlias: "自有文本接口",
            provider: "relay",
            baseUrl: "https://relay.example/v1",
            defaultModel: "gpt-text",
            availableModels: [
              { id: "gpt-text", capabilities: ["text-generation"] },
            ],
            capabilities: ["text-generation"],
            discoveryVerified: true,
            detectionStatus: "已自动识别",
          },
        }),
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saveResponse = await fetch(`${baseUrl}/api/model-api/accounts`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify({
        id: "model-private",
        apiAlias: "自有文本接口",
        loginAccount: "private-user",
        loginPassword: "private-login-secret",
        websiteUrl: "https://relay.example/dashboard",
        apiKey: "private-api-secret",
        isDefault: true,
      }),
    });
    assert.equal(saveResponse.status, 200);

    const unauthorized = await fetch(
      `${baseUrl}/api/internal/model-api-credentials/get`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "model-private" }),
      },
    );
    assert.equal(unauthorized.status, 401);

    const internalResponse = await fetch(
      `${baseUrl}/api/internal/model-api-credentials/get`,
      {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify({ accountId: "model-private" }),
      },
    );
    const internal = await internalResponse.json();
    assert.equal(internalResponse.status, 200);
    assert.equal(internal.account.baseUrl, "https://relay.example/v1");
    assert.equal(internal.credentials.loginAccount, "private-user");
    assert.equal(internal.credentials.loginPassword, "private-login-secret");
    assert.equal(internal.credentials.apiKey, "private-api-secret");
    assert.equal(Object.hasOwn(internal.account, "apiKey"), false);
    assert.equal(Object.hasOwn(internal.account, "loginPassword"), false);

    const publicResponse = await fetch(`${baseUrl}/api/model-api/accounts`, {
      headers: { "x-wangzai-local-api-token": authToken },
    });
    const publicPayload = await publicResponse.json();
    assert.equal(publicResponse.status, 200);
    assert.equal(
      JSON.stringify(publicPayload).includes("private-api-secret"),
      false,
    );
    assert.equal(
      JSON.stringify(publicPayload).includes("private-login-secret"),
      false,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
