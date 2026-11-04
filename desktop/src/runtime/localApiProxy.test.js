import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createLocalApiProxy,
  maximumTimeoutMsForLocalApiRequest,
  requiredPermissionForLocalApi,
} from "./localApiProxy.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("keeps the local capability token in the main process", async () => {
  let observed;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view"] },
      }),
    },
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return jsonResponse({ ok: true, rows: [] });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/account-removal/preview",
    body: { page: 1 },
  });
  assert.equal(result.ok, true);
  assert.equal(
    observed.options.headers["x-wangzai-local-api-token"],
    "secret-capability",
  );
  assert.equal(JSON.parse(observed.options.body).page, 1);
});

test("V2 local cache requests carry only the cache capability and signed-in user scope", async () => {
  let observed;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-22" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
    },
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return jsonResponse({ ok: true, shops: [] });
    },
  });
  const result = await proxy({ method: "GET", path: "/api/shops" });
  assert.equal(result.ok, true);
  assert.equal(
    observed.options.headers["x-wangzai-cache-agent-token"],
    "cache-capability",
  );
  assert.match(
    observed.options.headers["x-wangzai-cache-scope"],
    /^[a-f0-9]{24}$/u,
  );
  assert.equal(
    Object.hasOwn(observed.options.headers, "x-wangzai-local-api-token"),
    false,
  );
  assert.equal(Object.hasOwn(observed.options.headers, "Authorization"), false);
});

test("V2 hybrid and remote routes go through the stateless management core", async () => {
  let observed;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-hybrid" },
        entitlement: { permissions: ["marketing.view"] },
      }),
      getUserAccessToken: async () => "user-access-token",
    },
    fetchImpl: async (url, options) => {
      observed = { url: String(url), options };
      return jsonResponse({
        ok: true,
        rows: [],
        operationId: "core-operation-1",
      });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/performance/overview",
    body: { shopId: "shop-1", period: "30d" },
  });
  assert.equal(result.ok, true);
  assert.equal(
    observed.url,
    "https://management.example.test/api/core-v2/legacy/api/performance/overview",
  );
  assert.equal(
    observed.options.headers.Authorization,
    "Bearer user-access-token",
  );
  assert.equal(
    observed.options.headers["x-wangzai-thin-profile-id"],
    "profile-v2",
  );
});

test("local smart reply notification polling trusts only server notifications", async () => {
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://core.example",
    authToken: "cache-token",
    profileId: "profile-1",
    localCacheAgent: true,
    remoteCore: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-smart-reply" },
        entitlement: { permissions: ["customer_service.view"] },
      }),
      getUserAccessToken: async () => "user-token",
    },
    fetchImpl: async (url, options = {}) => {
      const call = { url: String(url), options };
      observed.push(call);
      if (call.url === "http://127.0.0.1:3792/api/smart-reply/mode") {
        return jsonResponse({ ok: true, mode: "local" });
      }
      if (
        call.url ===
        "https://core.example/api/core-v2/legacy/api/ozon/notifications?read=unread&limit=100"
      ) {
        return jsonResponse({
          ok: true,
          rows: [
            {
              id: "trusted-order-event",
              domain: "orders",
              eventType: "order_status_changed",
              shopId: "shop-1",
              postingNumber: "POST-1",
              createdAt: "2026-08-24T08:00:00.000Z",
            },
            {
              id: "not-an-order-event",
              domain: "products",
              eventType: "product_price_changed",
              shopId: "shop-1",
              postingNumber: "POST-2",
            },
          ],
        });
      }
      if (
        call.url ===
        "http://127.0.0.1:3792/v1/internal/smart-reply/notification-hints"
      ) {
        return jsonResponse({ ok: true, accepted: 1 });
      }
      throw new Error(`unexpected URL: ${call.url}`);
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/smart-reply/local/notification-poll",
    body: {
      notifications: [
        {
          id: "forged-renderer-event",
          domain: "orders",
          eventType: "order_new",
          shopId: "forged-shop",
          postingNumber: "FORGED-POST",
        },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.accepted, 1);
  const coreCall = observed.find((call) => call.url.startsWith("https://core.example/"));
  assert.equal(coreCall.options.headers.Authorization, "Bearer user-token");
  const localCall = observed.find((call) =>
    call.url.endsWith("/v1/internal/smart-reply/notification-hints"),
  );
  assert.equal(
    localCall.options.headers["x-wangzai-cache-agent-token"],
    "cache-token",
  );
  assert.match(
    localCall.options.headers["x-wangzai-cache-scope"],
    /^[a-f0-9]{24}$/u,
  );
  assert.deepEqual(JSON.parse(localCall.options.body), {
    notifications: [
      {
        id: "trusted-order-event",
        domain: "orders",
        eventType: "order_status_changed",
        shopId: "shop-1",
        postingNumber: "POST-1",
        createdAt: "2026-08-24T08:00:00.000Z",
      },
    ],
  });
});

test("V2 GitHub Skill resolution executes on the management core", async () => {
  let observed;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-skill" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getUserAccessToken: async () => "user-access-token",
    },
    fetchImpl: async (url, options) => {
      observed = { url: String(url), options };
      return jsonResponse({
        ok: true,
        source: { markdown: "---\n---\n# Skill\n" },
      });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/prompt-library/skill-source/resolve",
    body: { url: "https://github.com/example/tools" },
  });
  assert.equal(result.ok, true);
  assert.equal(
    observed.url,
    "https://management.example.test/api/core-v2/legacy/api/prompt-library/skill-source/resolve",
  );
  assert.equal(
    observed.options.headers.Authorization,
    "Bearer user-access-token",
  );
  assert.deepEqual(JSON.parse(observed.options.body), {
    url: "https://github.com/example/tools",
  });
  assert.equal(
    requiredPermissionForLocalApi(
      "/api/prompt-library/skill-source/resolve",
      {},
      "POST",
    ),
    "dashboard.view",
  );
});

test("V2 legacy shop import stays customer-local after main-process entitlement checks", async () => {
  const calls = [];
  const entitled = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-23" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
      assertOzonShopEntitled: async (clientId) => {
        entitled.push(clientId);
        return { authorized: true, shopId: clientId };
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        importedCount: 2,
        scopeCount: 2,
        digest: "a".repeat(64),
      });
    },
  });
  const payload = {
    shops: [
      { id: "shop-1", name: "一店", clientId: "10001", apiKey: "key-1" },
      { id: "shop-2", name: "二店", clientId: "10002", apiKey: "key-2" },
    ],
    preferences: {
      version: 1,
      shops: [{ id: "shop-1" }, { id: "shop-2" }],
      activeShopId: "shop-1",
      defaultWarehouseIds: {},
    },
  };
  const result = await proxy({
    method: "POST",
    path: "/api/shops/legacy-import",
    body: payload,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(entitled, ["10001", "10002"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3792/api/shops/legacy-import");
  assert.equal(
    calls[0].options.headers["x-wangzai-cache-agent-token"],
    "cache-capability",
  );
  assert.equal(Object.hasOwn(calls[0].options.headers, "Authorization"), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test("V2 model relay account persistence never leaves the customer-local agent", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-24" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        created: true,
        account: { id: "model-a", hasApiKey: true },
      });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/model-api/accounts",
    body: { id: "model-a", apiAlias: "主中转", apiKey: "customer-only-secret" },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3792/api/model-api/accounts");
  assert.equal(
    calls[0].options.headers["x-wangzai-cache-agent-token"],
    "cache-capability",
  );
  assert.equal(Object.hasOwn(calls[0].options.headers, "Authorization"), false);
});

test("V2 new model relay account is discovered by Core V2 and then saved customer-local", async () => {
  const calls = [];
  const apiKey = "new-model-api-secret";
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-25" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/api/core-v2/model-api/discover")) {
        return jsonResponse({
          updates: {
            apiAlias: "主中转",
            provider: "relay.example",
            baseUrl: "https://relay.example/v1",
            defaultModel: "gpt-image-2",
            usageScene: "文本 / 生图",
            detectionStatus: "已自动识别接口，发现 2 个可用模型。",
            detectedSource: "https://relay.example/v1/models",
            detectedAt: "2026-08-20T00:00:00Z",
            availableModels: [
              { id: "gpt-image-2", capabilities: ["image-generation"] },
            ],
            capabilities: ["image-generation"],
            discoveryVerified: true,
            apiKey: "server-must-not-overwrite-local-secret",
            loginPassword: "server-must-not-inject-password",
          },
        });
      }
      const localBody = JSON.parse(options.body);
      return jsonResponse({
        ok: true,
        created: true,
        account: {
          id: localBody.id,
          apiAlias: localBody.apiAlias,
          hasApiKey: Boolean(localBody.apiKey),
          discoveryVerified: localBody.discoveryVerified,
          availableModels: localBody.availableModels,
        },
      });
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/model-api/accounts",
    body: {
      id: "model-new",
      apiAlias: "主中转",
      websiteUrl: "https://relay.example/dashboard",
      apiKey,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "https://management.example.test/api/core-v2/model-api/discover",
  );
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer short-lived-license-token",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    website_url: "https://relay.example/dashboard",
    api_key: apiKey,
    api_alias: "主中转",
  });
  assert.equal(calls[1].url, "http://127.0.0.1:3792/api/model-api/accounts");
  const localBody = JSON.parse(calls[1].options.body);
  assert.equal(localBody.apiKey, apiKey);
  assert.equal(localBody.discoveryVerified, true);
  assert.equal(localBody.defaultModel, "gpt-image-2");
  assert.equal(localBody.loginPassword, undefined);
  assert.equal(
    JSON.stringify(localBody).includes(
      "server-must-not-overwrite-local-secret",
    ),
    false,
  );
  assert.equal(Object.hasOwn(calls[1].options.headers, "Authorization"), false);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test("V2 existing model relay account reuses its main-process credential without exposing it to the renderer", async () => {
  const calls = [];
  const storedApiKey = "existing-model-api-secret";
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-26" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/v1/internal/model-api-credentials/get")) {
        return jsonResponse({
          ok: true,
          credentials: { apiKey: storedApiKey },
        });
      }
      if (String(url).includes("/api/core-v2/model-api/discover")) {
        return jsonResponse({
          updates: {
            baseUrl: "https://relay.example/v1",
            detectionStatus: "已自动识别接口，发现 1 个可用模型。",
            availableModels: [{ id: "gpt-5.6-terra", capabilities: ["text"] }],
            capabilities: ["text"],
            discoveryVerified: true,
          },
        });
      }
      return jsonResponse({
        ok: true,
        created: false,
        account: {
          id: "model-existing",
          hasApiKey: true,
          discoveryVerified: true,
        },
      });
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/model-api/accounts",
    body: {
      id: "model-existing",
      apiAlias: "现有中转已改名",
      websiteUrl: "https://relay.example/dashboard",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:3792/v1/internal/model-api-credentials/get",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    accountId: "model-existing",
  });
  assert.equal(JSON.parse(calls[1].options.body).api_key, storedApiKey);
  const localBody = JSON.parse(calls[2].options.body);
  assert.equal(Object.hasOwn(localBody, "apiKey"), false);
  assert.equal(Object.hasOwn(localBody, "api_key"), false);
  assert.equal(JSON.stringify(result).includes(storedApiKey), false);
});

test("V2 model relay account is still saved locally when Core V2 discovery is offline", async () => {
  const calls = [];
  const apiKey = "offline-model-api-secret";
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-27" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/api/core-v2/model-api/discover")) {
        throw new Error(`network error must stay private: ${apiKey}`);
      }
      const body = JSON.parse(options.body);
      return jsonResponse({
        ok: true,
        created: true,
        account: {
          id: body.id,
          hasApiKey: Boolean(body.apiKey),
          discoveryVerified: body.discoveryVerified,
          detectionStatus: body.detectionStatus,
        },
      });
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/model-api/accounts",
    body: {
      id: "model-offline",
      apiAlias: "离线保存",
      websiteUrl: "https://relay.example/dashboard",
      apiKey,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "http://127.0.0.1:3792/api/model-api/accounts");
  const localBody = JSON.parse(calls[1].options.body);
  assert.equal(localBody.apiKey, apiKey);
  assert.equal(localBody.discoveryVerified, false);
  assert.match(localBody.detectionStatus, /稍后重试/u);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test("V2 model discovery failure text cannot leak credentials into public account DTOs", async () => {
  const apiKey = "error-echo-model-api-secret";
  let localBody;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-28" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      if (String(url).includes("/api/core-v2/model-api/discover")) {
        return jsonResponse(
          { detail: { message: `upstream rejected ${apiKey}` } },
          502,
        );
      }
      localBody = JSON.parse(options.body);
      return jsonResponse({
        ok: true,
        created: true,
        account: {
          id: localBody.id,
          hasApiKey: true,
          discoveryVerified: localBody.discoveryVerified,
          detectionStatus: localBody.detectionStatus,
        },
      });
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/model-api/accounts",
    body: {
      id: "model-error",
      apiAlias: "错误回显测试",
      websiteUrl: "https://relay.example/dashboard",
      apiKey,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(localBody.discoveryVerified, false);
  assert.equal(
    localBody.detectionStatus,
    "已保存账号，接口识别暂未完成，稍后重试。",
  );
  assert.equal(localBody.detectionStatus.includes(apiKey), false);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test("V2 text model routes read BYOK locally and execute only through stateless Core V2", async () => {
  const calls = [];
  const apiKey = "local-byok-text-secret";
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-29" },
        entitlement: { permissions: ["products.view", "dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/v1/internal/model-api-credentials/get")) {
        return jsonResponse({
          ok: true,
          account: {
            id: "model-text",
            baseUrl: "https://relay.example/v1",
            discoveryVerified: true,
          },
          credentials: { apiKey },
        });
      }
      return jsonResponse({
        ok: true,
        text: "俄语商品描述",
        model: "gpt-5.6-terra",
        account_id: "model-text",
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        billing: null,
        reference_image_count: 0,
      });
    },
  });

  const result = await proxy({
    requestId: "text-request-12345678",
    method: "POST",
    path: "/api/product-descriptions/generate",
    body: {
      accountId: "model-text",
      model: "gpt-5.6-terra",
      templateId: "product-description.v1",
      templateInput: { product: { title: "保温杯" } },
      apiKey: "renderer-forged-secret",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.description, "俄语商品描述");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:3792/v1/internal/model-api-credentials/get",
  );
  assert.equal(
    calls[1].url,
    "https://management.example.test/api/core-v2/text-model/execute",
  );
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer short-lived-license-token",
  );
  const coreBody = JSON.parse(calls[1].options.body);
  assert.equal(coreBody.capability, "text.product-description");
  assert.equal(coreBody.request_id, "text-request-12345678");
  assert.equal(coreBody.template_id, "product-description.v1");
  assert.deepEqual(coreBody.byok, {
    account_id: "model-text",
    base_url: "https://relay.example/v1",
    api_key: apiKey,
    model: "gpt-5.6-terra",
  });
  assert.equal(coreBody.model, "gpt-5.6-terra");
  assert.equal(coreBody.reasoning_effort, "medium");
  assert.equal(
    JSON.stringify(coreBody).includes("renderer-forged-secret"),
    false,
  );
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test("V2 generic Skill text prompts stay on the management system with paid fallback", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-30" },
        entitlement: { permissions: ["prompt_library.view", "dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => ({
        ok: true,
        data: { balance_points: 100, reserved_points: 0, available_points: 100 },
      }),
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        text: "经营分析报告",
        model: "builtin-points",
        account_id: "",
        usage: null,
        billing: { chargedPoints: 12, source: "paid-cloud" },
        reference_image_count: 0,
      });
    },
  });

  const result = await proxy({
    requestId: "analysis-request-12345678",
    method: "POST",
    path: "/api/integrations/analyze",
    body: {
      templateId: "generic-skill-runtime.v1",
      templateInput: {
        skill: {
          title: "商品内容整理",
          workflowSteps: ["读取事实", "生成草稿"],
        },
        context: { product: { title: "保温杯" } },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.reportText, "经营分析报告");
  assert.deepEqual(result.data.billing, {
    chargedPoints: 12,
    source: "paid-cloud",
  });
  assert.equal(calls.length, 1);
  const coreBody = JSON.parse(calls[0].options.body);
  assert.equal(coreBody.capability, "text.external-insight");
  assert.equal(coreBody.template_id, "generic-skill-runtime.v1");
  assert.equal(coreBody.model, "gpt-5.6-terra");
  assert.equal(coreBody.reasoning_effort, "medium");
  assert.equal(coreBody.byok, null);
});

test("managed text and the approved managed image model stop on exhausted points", async () => {
  let relayCalls = 0;
  let walletChecks = 0;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-no-points" },
        entitlement: {
          permissions: ["prompt_library.view", "products.view", "dashboard.view"],
        },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => {
        walletChecks += 1;
        return {
          ok: true,
          data: { balance_points: 0, reserved_points: 0, available_points: 0 },
        };
      },
    },
    fetchImpl: async () => {
      relayCalls += 1;
      return jsonResponse({ ok: true });
    },
  });

  const textResult = await proxy({
    requestId: "managed-text-no-points",
    method: "POST",
    path: "/api/integrations/analyze",
    body: {
      accountId: "builtin-points",
      model: "builtin-points-text",
      templateId: "generic-skill-runtime.v1",
      templateInput: { skill: { title: "经营分析" }, context: {} },
    },
  });
  const imageResult = await proxy({
    requestId: "managed-image-no-points",
    method: "POST",
    path: "/api/product-images/generate",
    body: {
      shopId: "shop-1",
      promptTemplateId: "product-image-generation.v1",
      promptTemplateInput: { product: { title: "保温杯" } },
      modelSelection: {
        candidates: [{ accountId: "builtin-points", model: "gpt-image-2" }],
      },
    },
  });

  assert.equal(textResult.ok, false);
  assert.equal(textResult.status, 402);
  assert.equal(textResult.data.error.code, "POINT_BALANCE_INSUFFICIENT");
  assert.match(textResult.data.error.message, /积分/u);
  assert.equal(imageResult.ok, false);
  assert.equal(imageResult.status, 402);
  assert.equal(imageResult.data.error.code, "POINT_BALANCE_INSUFFICIENT");
  assert.match(imageResult.data.error.message, /积分/u);
  assert.equal(walletChecks, 2);
  assert.equal(relayCalls, 0);
});

test("managed text model accepts only Terra or Sol with low, medium, or high reasoning", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-policy" },
        entitlement: { permissions: ["prompt_library.view", "dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => ({
        ok: true,
        data: { balance_points: 100, reserved_points: 0, available_points: 100 },
      }),
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        text: "高强度结果",
        model: "gpt-5.6-sol",
        account_id: "",
      });
    },
  });

  const allowed = await proxy({
    requestId: "allowed-text-policy",
    method: "POST",
    path: "/api/integrations/analyze",
    body: {
      accountId: "builtin-points",
      model: "builtin-points-text",
      providerModel: "gpt-5.6-sol",
      reasoningEffort: "low",
      templateId: "generic-skill-runtime.v1",
      templateInput: { skill: { title: "经营分析" }, context: {} },
    },
  });
  assert.equal(allowed.ok, true);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.reasoning_effort, "low");

  const blockedModel = await proxy({
    requestId: "blocked-text-model",
    method: "POST",
    path: "/api/integrations/analyze",
    body: {
      providerModel: "gpt-5.6-luna",
      templateId: "generic-skill-runtime.v1",
      templateInput: { skill: { title: "经营分析" }, context: {} },
    },
  });
  assert.equal(blockedModel.ok, false);
  assert.equal(blockedModel.data.error.code, "TEXT_MODEL_FORBIDDEN");

  const blockedEffort = await proxy({
    requestId: "blocked-reasoning-effort",
    method: "POST",
    path: "/api/integrations/analyze",
    body: {
      reasoningEffort: "minimal",
      templateId: "generic-skill-runtime.v1",
      templateInput: { skill: { title: "经营分析" }, context: {} },
    },
  });
  assert.equal(blockedEffort.ok, false);
  assert.equal(
    blockedEffort.data.error.code,
    "TEXT_REASONING_EFFORT_FORBIDDEN",
  );
  assert.equal(calls.length, 1);
});

test("full local desktop sends server-template Skill requests to managed Core V2", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    coreServiceUrl: "https://management.example.test",
    authToken: "full-local-capability",
    profileId: "profile-full-local",
    localCacheAgent: false,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-full-local" },
        entitlement: { permissions: ["prompt_library.view", "dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => ({
        ok: true,
        data: { balance_points: 100, reserved_points: 0, available_points: 100 },
      }),
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        text: "服务器 Skill 结果",
        model: "builtin-points",
        account_id: "",
        usage: null,
        billing: { chargedPoints: 4, source: "paid-cloud" },
      });
    },
  });

  const result = await proxy({
    requestId: "full-local-managed-skill",
    method: "POST",
    path: "/api/integrations/analyze",
    body: {
      accountId: "builtin-points",
      model: "builtin-points-text",
      templateId: "generic-skill-runtime.v1",
      templateInput: {
        skill: { title: "商品卡优化", workflowSteps: ["读取商品", "生成方案"] },
        context: { product: { title: "保温杯" } },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.reportText, "服务器 Skill 结果");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://management.example.test/api/core-v2/text-model/execute",
  );
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer short-lived-license-token",
  );
  const coreBody = JSON.parse(calls[0].options.body);
  assert.equal(coreBody.template_id, "generic-skill-runtime.v1");
  assert.equal(coreBody.byok, null);
});

test("full local desktop explains managed model billing reconciliation in Chinese", async () => {
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    coreServiceUrl: "https://management.example.test",
    authToken: "full-local-capability",
    profileId: "profile-full-local",
    localCacheAgent: false,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-full-local" },
        entitlement: { permissions: ["prompt_library.view", "dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => ({
        ok: true,
        data: { balance_points: 100, reserved_points: 0, available_points: 100 },
      }),
    },
    fetchImpl: async () =>
      jsonResponse(
        {
          detail: {
            code: "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
            message: "Provider outcome requires billing reconciliation",
          },
        },
        503,
      ),
  });

  const result = await proxy({
    requestId: "managed-skill-reconciliation",
    method: "POST",
    path: "/api/integrations/analyze",
    body: {
      accountId: "builtin-points",
      model: "builtin-points-text",
      templateId: "generic-skill-runtime.v1",
      templateInput: { skill: { title: "商品卡优化" }, context: {} },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.data.error.message,
    "本次模型调用没有完成，积分正在安全核对；系统不会自动重复调用或重复扣费，请稍后重试。",
  );
});

test("full local desktop accepts a discovered BYOK text model through its main-only credential route", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    coreServiceUrl: "https://management.example.test",
    authToken: "full-local-capability",
    profileId: "profile-full-local",
    localCacheAgent: false,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-full-local" },
        entitlement: { permissions: ["prompt_library.view", "dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/api/internal/model-api-credentials/get")) {
        return jsonResponse({
          ok: true,
          account: {
            id: "model-local",
            baseUrl: "https://relay.example/v1",
            discoveryVerified: true,
            availableModels: [
              { id: "gpt-5.4", capabilities: ["text-generation"] },
            ],
          },
          credentials: { apiKey: "full-local-byok-secret" },
        });
      }
      return jsonResponse({
        ok: true,
        text: "自有接口 Skill 结果",
        model: "gpt-5.4",
        account_id: "model-local",
        usage: { prompt_tokens: 10, completion_tokens: 12 },
        billing: null,
      });
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/integrations/analyze",
    body: {
      accountId: "model-local",
      model: "gpt-5.4",
      templateId: "generic-skill-runtime.v1",
      templateInput: { skill: { title: "商品卡优化" }, context: {} },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.reportText, "自有接口 Skill 结果");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:3790/api/internal/model-api-credentials/get",
  );
  assert.equal(
    calls[0].options.headers["x-wangzai-local-api-token"],
    "full-local-capability",
  );
  assert.equal(
    Object.hasOwn(calls[0].options.headers, "x-wangzai-cache-agent-token"),
    false,
  );
  const coreBody = JSON.parse(calls[1].options.body);
  assert.deepEqual(coreBody.byok, {
    account_id: "model-local",
    base_url: "https://relay.example/v1",
    api_key: "full-local-byok-secret",
    model: "gpt-5.4",
  });
  assert.equal(
    JSON.stringify(result).includes("full-local-byok-secret"),
    false,
  );
});

test("V2 image prompt planning preserves reference-image response compatibility", async () => {
  let coreBody;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-31" },
        entitlement: { permissions: ["products.view", "dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => ({
        ok: true,
        data: { balance_points: 100, reserved_points: 0, available_points: 100 },
      }),
    },
    fetchImpl: async (_url, options) => {
      coreBody = JSON.parse(options.body);
      return jsonResponse({
        ok: true,
        text: "三张商品图方案",
        model: "builtin-points",
        account_id: "",
        usage: null,
        billing: { chargedPoints: 8, source: "paid-cloud" },
        reference_image_count: 1,
      });
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/image-prompt-plans/generate",
    body: {
      templateId: "image-plan.v1",
      templateInput: { product: { title: "水杯" }, requestedCount: 3 },
      referenceImageUrls: ["https://assets.example/a.webp"],
      referenceImages: [
        { url: "https://assets.example/a.webp" },
        { dataUrl: "data:image/png;base64,AAAA" },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.planText, "三张商品图方案");
  assert.equal(result.data.referenceImageCount, 1);
  assert.equal(result.data.requestedReferenceImageCount, 2);
  assert.equal(result.data.referenceImagePolicy, "vision-planner");
  assert.deepEqual(coreBody.reference_images, [
    "https://assets.example/a.webp",
    "data:image/png;base64,AAAA",
  ]);
});

test("V2 product image generation keeps prompt assembly on Core V2 and BYOK in main-process transit", async () => {
  const calls = [];
  const apiKey = "local-byok-image-secret";
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-image" },
        entitlement: { permissions: ["products.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/v1/internal/model-api-credentials/get")) {
        return jsonResponse({
          ok: true,
          account: {
            id: "model-image",
            baseUrl: "https://images.example.invalid/v1",
            discoveryVerified: true,
            availableModels: [
              {
                id: "gpt-image-2",
                capabilities: ["image-generation", "image-edit"],
              },
            ],
          },
          credentials: { apiKey },
        });
      }
      return jsonResponse({
        ok: true,
        images: [{ url: "https://images.example/result.webp", b64_json: "" }],
        model: "gpt-image-2",
        account_id: "model-image",
        billing: null,
      });
    },
  });

  const result = await proxy({
    requestId: "image-request-12345678",
    method: "POST",
    path: "/api/product-images/generate",
    body: {
      shopId: "shop-1",
      promptTemplateId: "product-image-generation.v1",
      promptTemplateInput: {
        product: { title: "黑色保温杯", skuFacts: "黑色，500ml" },
        image: { group: "main", sourceIndex: 0 },
      },
      accountId: "model-image",
      model: "gpt-image-2",
      prompt: "renderer forged prompt",
      apiKey: "renderer-forged-secret",
      size: "1008x1344",
      quality: "2k",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.data.asset.previewUrl,
    "https://images.example/result.webp",
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].url,
    "https://management.example.test/api/core-v2/image-model/execute",
  );
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer short-lived-license-token",
  );
  const coreBody = JSON.parse(calls[1].options.body);
  assert.equal(coreBody.capability, "image.generate");
  assert.equal(coreBody.template_id, "product-image-generation.v1");
  assert.equal(coreBody.template_input.product.title, "黑色保温杯");
  assert.equal(Object.hasOwn(coreBody, "prompt"), false);
  assert.deepEqual(coreBody.byok, {
    account_id: "model-image",
    base_url: "https://images.example.invalid/v1",
    api_key: apiKey,
    model: "gpt-image-2",
  });
  assert.equal(
    JSON.stringify(coreBody).includes("renderer forged prompt"),
    false,
  );
  assert.equal(
    JSON.stringify(coreBody).includes("renderer-forged-secret"),
    false,
  );
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test("V2 managed image generation uses the server-enforced gpt-image-2 route without a local relay", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-image-managed" },
        entitlement: { permissions: ["products.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => ({
        ok: true,
        data: { balance_points: 100, reserved_points: 0, available_points: 100 },
      }),
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        images: [{ url: "https://images.example/managed-result.webp", b64_json: "" }],
        model: "gpt-image-2",
        account_id: "",
        billing: { chargedPoints: 8, source: "paid-cloud" },
      });
    },
  });

  const result = await proxy({
    requestId: "managed-image-request-12345678",
    method: "POST",
    path: "/api/product-images/generate",
    body: {
      shopId: "shop-1",
      promptTemplateId: "product-image-generation.v1",
      promptTemplateInput: { product: { title: "保温杯" } },
      accountId: "builtin-points",
      model: "gpt-image-2",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.model, "gpt-image-2");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://management.example.test/api/core-v2/image-model/execute",
  );
  const coreBody = JSON.parse(calls[0].options.body);
  assert.equal(coreBody.byok, null);
  assert.equal(coreBody.capability, "image.generate");
});

test("collection V2 image generation persists the returned provider image in the local asset store", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    coreServiceUrl: "https://management.example.test",
    authToken: "local-api-capability",
    profileId: "profile-v2",
    stageImageModelSources: async () => ({
      sourceImages: ["https://images.example/staged-source.webp"],
      cleanup: async () => {},
    }),
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-image-persistence" },
        entitlement: { permissions: ["products.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => ({
        ok: true,
        data: { balance_points: 100, reserved_points: 0, available_points: 100 },
      }),
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/api/product-images/import")) {
        return jsonResponse({
          ok: true,
          asset: {
            id: "pimg_collection_1",
            localUrl: "/api/product-images/preview/pimg_collection_1?shopId=shop-storage",
            previewUrl: "https://oss.example/pimg_collection_1.png",
            storageScope: "temporary",
          },
        });
      }
      return jsonResponse({
        ok: true,
        images: [{ url: "https://images.example/collection-result.webp", b64_json: "" }],
        model: "gpt-image-2",
        account_id: "",
        billing: { chargedPoints: 8, source: "paid-cloud" },
      });
    },
  });

  const result = await proxy({
    requestId: "collection-image-persist-12345678",
    method: "POST",
    path: "/api/product-images/edit",
    body: {
      shopId: "shop-storage",
      promptTemplateId: "product-image-generation.v1",
      promptTemplateInput: {
        product: { title: "汽车脚垫", productId: "1688:1001", offerId: "1001" },
        image: { group: "main", sourceIndex: 0 },
      },
      sourceUrl: "https://images.example/source.webp",
      accountId: "builtin-points",
      model: "gpt-image-2",
      sourceType: "collection-generated-main",
      persistGeneratedAsset: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.asset.id, "pimg_collection_1");
  assert.equal(result.data.asset.previewUrl, "https://oss.example/pimg_collection_1.png");
  assert.equal(result.data.persistenceStatus, "completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://management.example.test/api/core-v2/image-model/execute");
  assert.equal(calls[1].url, "http://127.0.0.1:3790/api/product-images/import");
  assert.equal(calls[1].options.headers["x-wangzai-local-api-token"], "local-api-capability");
  const importBody = JSON.parse(calls[1].options.body);
  assert.deepEqual(importBody, {
    shopId: "shop-storage",
    productId: "1688:1001",
    offerId: "1001",
    sourceType: "collection-generated-main",
    storageScope: "temporary",
    variant: "collection-edited",
    sourceUrl: "https://images.example/collection-result.webp",
  });
});

test("full local desktop sends built-in points image edits to managed Core V2", async () => {
  const calls = [];
  const stagedCalls = [];
  let cleaned = false;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    coreServiceUrl: "https://management.example.test",
    authToken: "full-local-capability",
    profileId: "profile-full-local",
    localCacheAgent: false,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-full-local-image" },
        entitlement: { permissions: ["products.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
      request: async () => ({
        ok: true,
        data: { balance_points: 100, reserved_points: 0, available_points: 100 },
      }),
    },
    stageImageModelSources: async (input) => {
      stagedCalls.push(input);
      return {
        sourceImages: ["data:image/png;base64,aW1hZ2U="],
        cleanup: async () => {
          cleaned = true;
        },
      };
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        images: [{ url: "https://images.example/full-local-edit.webp", b64_json: "" }],
        model: "gpt-image-2",
        account_id: "",
        billing: { chargedPoints: 8, source: "paid-cloud" },
      });
    },
  });

  const result = await proxy({
    requestId: "full-local-managed-image-edit-12345678",
    method: "POST",
    path: "/api/product-images/edit",
    body: {
      shopId: "shop-1",
      promptTemplateId: "product-image-generation.v1",
      promptTemplateInput: {
        product: { title: "保温杯", skuFacts: "黑色，500ml" },
        image: { group: "main", sourceIndex: 0 },
      },
      sourceUrl: "https://images.example/source.webp",
      accountId: "builtin-points",
      model: "gpt-image-2",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.asset.previewUrl, "https://images.example/full-local-edit.webp");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://management.example.test/api/core-v2/image-model/execute",
  );
  const coreBody = JSON.parse(calls[0].options.body);
  assert.equal(coreBody.byok, null);
  assert.equal(coreBody.capability, "image.edit");
  assert.deepEqual(coreBody.source_images, [
    "data:image/png;base64,aW1hZ2U=",
  ]);
  assert.equal(stagedCalls.length, 1);
  assert.equal(stagedCalls[0].shopId, "shop-1");
  assert.deepEqual(stagedCalls[0].sourceImages, ["https://images.example/source.webp"]);
  assert.equal(cleaned, true);
});

test("full local desktop keeps explicit BYOK image edits on the local service", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    coreServiceUrl: "https://management.example.test",
    authToken: "full-local-capability",
    profileId: "profile-full-local",
    localCacheAgent: false,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-full-local-image" },
        entitlement: { permissions: ["products.view"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        ok: true,
        asset: {
          id: "local-image-asset",
          previewUrl: "https://images.example/local-byok-edit.webp",
        },
      });
    },
  });

  const result = await proxy({
    requestId: "full-local-byok-image-edit-12345678",
    method: "POST",
    path: "/api/product-images/edit",
    body: {
      shopId: "shop-1",
      promptTemplateId: "product-image-generation.v1",
      promptTemplateInput: { product: { title: "保温杯" } },
      sourceUrl: "https://images.example/source.webp",
      accountId: "image-account",
      model: "gpt-image-2",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3790/api/product-images/edit");
});

test("V2 shop connection test reads credentials locally and sends them once to the stateless core", async () => {
  const calls = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    coreServiceUrl: "https://management.example.test",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "user-33" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getOzonShopEntitlementGrants: async () => [{
        clientId: "10001",
        expireAt: "2099-01-01T00:00:00.000Z",
      }],
      assertOzonShopEntitled: async (clientId) => ({
        authorized: true,
        clientId,
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-token",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/v1/internal/smart-reply/shop-entitlements")) {
        return jsonResponse({ ok: true, activeGrantCount: 1 });
      }
      if (String(url).endsWith("/api/shops")) {
        return jsonResponse({
          ok: true,
          shops: [{ id: "shop-1", clientId: "10001" }],
        });
      }
      if (String(url).endsWith("/v1/internal/shop-credentials/get")) {
        return jsonResponse({
          ok: true,
          credentials: { clientId: "10001", apiKey: "local-only-api-key" },
          shop: { id: "shop-1", name: "一店", hasApiKey: true },
        });
      }
      return jsonResponse({
        ok: true,
        connected: true,
        message: "Ozon 店铺连接正常。",
        checks: {},
        roles: {},
        seller_info: { name: "一店" },
      });
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/shops/shop-1/test",
    body: { apiKey: "renderer-forgery" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.shop.id, "shop-1");
  assert.equal(result.data.sellerInfo.name, "一店");
  assert.equal(JSON.stringify(result).includes("local-only-api-key"), false);
  const credentialCall = calls.find((call) => (
    call.url === "http://127.0.0.1:3792/v1/internal/shop-credentials/get"
  ));
  const coreCall = calls.find((call) => (
    call.url === "https://management.example.test/api/core-v2/ozon/shop-connection-test"
  ));
  assert.ok(credentialCall);
  assert.ok(coreCall);
  assert.equal(
    calls.filter((call) => call.url === coreCall.url).length,
    1,
  );
  assert.deepEqual(JSON.parse(credentialCall.options.body), { shopId: "shop-1" });
  assert.deepEqual(JSON.parse(coreCall.options.body), {
    client_id: "10001",
    api_key: "local-only-api-key",
  });
  assert.equal(
    coreCall.options.headers.Authorization,
    "Bearer short-lived-license-token",
  );
  assert.equal(JSON.stringify(coreCall).includes("renderer-forgery"), false);
});

test("requires a main-process License Center entitlement before saving an Ozon shop", async () => {
  const verified = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view"] },
      }),
      assertOzonShopEntitled: async (clientId) => {
        verified.push(clientId);
        return { authorized: true };
      },
    },
    fetchImpl: async () =>
      jsonResponse({ ok: true, shop: { id: "shop-1" } }, 201),
  });
  const result = await proxy({
    method: "POST",
    path: "/api/shops",
    body: {
      id: "shop-1",
      name: "第一店",
      clientId: "client-1",
      apiKey: "secret",
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(verified, ["client-1"]);
});

test("forces a fresh local grant snapshot when saving a newly-bound Ozon shop", async () => {
  const observed = [];
  let grantReadCount = 0;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view", "orders.view"] },
      }),
      getOzonShopEntitlementGrants: async () => {
        grantReadCount += 1;
        return grantReadCount === 1
          ? [{ clientId: "existing-client", expireAt: "2099-08-05T00:00:00.000Z" }]
          : [{ clientId: "new-client", expireAt: "2099-08-05T00:00:00.000Z" }];
      },
      assertOzonShopEntitled: async () => ({ authorized: true }),
    },
    fetchImpl: async (url, options = {}) => {
      observed.push({ url: String(url), options });
      return jsonResponse({ ok: true, shop: { id: "shop-new" } }, 201);
    },
  });

  // Seed the proxy with the snapshot that existed before the card was bound.
  assert.equal((await proxy({ method: "GET", path: "/api/shops" })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));

  const saved = await proxy({
    method: "POST",
    path: "/api/shops",
    body: {
      id: "shop-new",
      name: "新增店铺",
      clientId: "new-client",
      apiKey: "secret",
    },
  });

  assert.equal(saved.ok, true);
  assert.equal(grantReadCount, 2);
  const grantWrites = observed.filter((item) => (
    item.url === "http://127.0.0.1:3790/api/internal/shop-license-grants"
  ));
  assert.equal(grantWrites.length, 2);
  assert.deepEqual(JSON.parse(grantWrites[1].options.body), {
    grants: [
      { clientId: "new-client", expireAt: "2099-08-05T00:00:00.000Z" },
    ],
  });
});

test("fails closed before local persistence when the Ozon shop card is missing or expired", async () => {
  let forwarded = false;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view"] },
      }),
      assertOzonShopEntitled: async () => {
        throw new Error("当前 Ozon 店铺未绑定有效卡密或授权已到期");
      },
    },
    fetchImpl: async () => {
      forwarded = true;
      return jsonResponse({ ok: true });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/shops",
    body: {
      id: "shop-2",
      name: "第二店",
      clientId: "client-2",
      apiKey: "secret",
    },
  });
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: "当前 Ozon 店铺未绑定有效卡密或授权已到期",
  });
  assert.equal(forwarded, false);
});

test("blocks the Ozon connection test before transport when the selected shop has no exact card binding", async () => {
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    authToken: "cache-capability",
    localCacheAgent: true,
    coreServiceUrl: "https://management.example.test",
    profileId: "profile-shop-license-gate",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user" },
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getOzonShopEntitlementGrants: async () => [],
      assertOzonShopEntitled: async () => {
        throw new Error("当前 Ozon 店铺未绑定有效卡密或授权已到期");
      },
      getProtectedComputeAccessToken: async () => "should-not-be-used",
    },
    fetchImpl: async (url, options = {}) => {
      observed.push({ url: String(url), options });
      if (String(url).endsWith("/v1/internal/smart-reply/shop-entitlements")) {
        return jsonResponse({ ok: true, activeGrantCount: 0 });
      }
      if (String(url).endsWith("/api/shops")) {
        return jsonResponse({
          ok: true,
          shops: [{ id: "shop-1", clientId: "4616153" }],
        });
      }
      throw new Error(`Unexpected transport: ${url}`);
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/shops/shop-1/test",
    body: {},
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: "当前 Ozon 店铺未绑定有效卡密或授权已到期",
  });
  assert.equal(
    observed.some((call) => call.url.includes("/api/core-v2/ozon/shop-connection-test")),
    false,
  );
});

test("blocks cached order reads for a shop without an exact card binding", async () => {
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    profileId: "profile-order-license-gate",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user" },
        entitlement: { permissions: ["orders.view"] },
      }),
      getOzonShopEntitlementGrants: async () => [],
      assertOzonShopEntitled: async () => {
        throw new Error("当前 Ozon 店铺未绑定有效卡密或授权已到期");
      },
    },
    fetchImpl: async (url, options = {}) => {
      observed.push({ url: String(url), options });
      if (String(url).endsWith("/api/internal/shop-license-grants")) {
        return jsonResponse({ ok: true, activeGrantCount: 0 });
      }
      if (String(url).endsWith("/api/shops")) {
        return jsonResponse({
          ok: true,
          shops: [{ id: "shop-1", clientId: "4616153" }],
        });
      }
      throw new Error(`Unexpected transport: ${url}`);
    },
  });

  const result = await proxy({
    method: "GET",
    path: "/api/cache/orders?shopId=shop-1&page=1&pageSize=20",
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: "当前 Ozon 店铺未绑定有效卡密或授权已到期",
  });
  assert.equal(
    observed.some((call) => call.url.includes("/api/cache/orders")),
    false,
  );
});

test("blocks aggregate order reads that omit an exact licensed shop scope", async () => {
  let forwardedOrderRead = false;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    profileId: "profile-order-scope-gate",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user" },
        entitlement: { permissions: ["orders.view"] },
      }),
      getOzonShopEntitlementGrants: async () => [],
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/orders")) forwardedOrderRead = true;
      return jsonResponse({ ok: true, rows: [] });
    },
  });

  const result = await proxy({ method: "GET", path: "/api/orders" });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: "读取 Ozon 店铺数据前必须指定已绑定卡密的店铺",
  });
  assert.equal(forwardedOrderRead, false);
});

test("refreshes authoritative shop grants without blocking local SQLite reads", async () => {
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getOzonShopEntitlementGrants: async () => [
        {
          clientId: "active-client",
          expireAt: "2099-08-05T00:00:00.000Z",
        },
      ],
    },
    fetchImpl: async (url, options) => {
      observed.push({ url: String(url), options });
      return jsonResponse({ ok: true, rows: [] });
    },
  });

  assert.equal((await proxy({ method: "GET", path: "/api/shops" })).ok, true);
  assert.equal((await proxy({ method: "GET", path: "/api/shops" })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.length, 3);
  const grantRequest = observed.find(
    (item) =>
      item.url === "http://127.0.0.1:3790/api/internal/shop-license-grants",
  );
  assert.ok(grantRequest);
  assert.deepEqual(JSON.parse(grantRequest.options.body), {
    grants: [
      { clientId: "active-client", expireAt: "2099-08-05T00:00:00.000Z" },
    ],
  });
  assert.equal(
    grantRequest.options.headers["x-wangzai-local-api-token"],
    "secret-capability",
  );
});

test("V2 smart reply syncs per-shop entitlements into the scoped cache agent", async () => {
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3792",
    authToken: "cache-capability",
    profileId: "profile-v2",
    localCacheAgent: true,
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-smart-reply-grants" },
        entitlement: { permissions: ["customer_service.view"] },
      }),
      getOzonShopEntitlementGrants: async () => [
        { clientId: "active-client", expireAt: "2099-08-05T00:00:00.000Z" },
      ],
    },
    fetchImpl: async (url, options = {}) => {
      observed.push({ url: String(url), options });
      if (String(url).endsWith("/v1/internal/smart-reply/shop-entitlements")) {
        return jsonResponse({ ok: true, count: 1 });
      }
      return jsonResponse([]);
    },
  });

  const result = await proxy({
    method: "GET",
    path: "/api/smart-reply/local/credentials",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    observed.map((call) => call.url),
    [
      "http://127.0.0.1:3792/v1/internal/smart-reply/shop-entitlements",
      "http://127.0.0.1:3792/api/smart-reply/local/credentials",
    ],
  );
  const grantRequest = observed[0];
  assert.deepEqual(JSON.parse(grantRequest.options.body), {
    grants: [
      { clientId: "active-client", expireAt: "2099-08-05T00:00:00.000Z" },
    ],
  });
  assert.equal(
    grantRequest.options.headers["x-wangzai-cache-agent-token"],
    "cache-capability",
  );
  assert.match(
    grantRequest.options.headers["x-wangzai-cache-scope"],
    /^[a-f0-9]{24}$/u,
  );
  assert.equal(
    Object.hasOwn(grantRequest.options.headers, "x-wangzai-local-api-token"),
    false,
  );
});

test("full-source runtime can switch to local smart reply even when License Center refresh fails", async () => {
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "legacy-local-capability",
    profileId: "profile-full-source",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-full-source" },
        entitlement: { permissions: ["customer_service.view"] },
      }),
      getOzonShopEntitlementGrants: async () => {
        throw new Error("License Center 返回了无效响应");
      },
    },
    fetchImpl: async (url, options = {}) => {
      observed.push({ url: String(url), options });
      if (String(url).endsWith("/api/internal/shop-license-grants")) {
        return jsonResponse({ ok: true, activeGrantCount: 0 });
      }
      if (String(url).endsWith("/api/smart-reply/mode")) {
        return jsonResponse({ ok: true, mode: "local" });
      }
      return jsonResponse({ ok: false }, 404);
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/smart-reply/mode",
    body: { mode: "local" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.mode, "local");
  assert.deepEqual(observed.map((call) => call.url), [
    "http://127.0.0.1:3790/api/internal/shop-license-grants",
    "http://127.0.0.1:3790/api/smart-reply/mode",
  ]);
  assert.match(
    observed[0].options.headers["x-wangzai-cache-scope"],
    /^[a-f0-9]{24}$/u,
  );
  assert.equal(
    observed[1].options.headers["x-wangzai-cache-scope"],
    observed[0].options.headers["x-wangzai-cache-scope"],
  );
  assert.equal(
    observed[1].options.headers["x-wangzai-local-api-token"],
    "legacy-local-capability",
  );
});

test("only exact per-shop grants are synchronized into the local runtime", async () => {
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "legacy-account-capability",
    profileId: "profile-legacy-account",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        user: { id: "license-user-legacy-account" },
        entitlement: { permissions: ["customer_service.view"] },
      }),
      getOzonShopEntitlementGrants: async () => [{
        clientId: "4097603",
        expireAt: "2027-08-24T10:12:22.224Z",
      }],
    },
    fetchImpl: async (url, options = {}) => {
      observed.push({ url: String(url), options });
      if (String(url).endsWith("/api/internal/shop-license-grants")) {
        return jsonResponse({ ok: true, activeGrantCount: 1 });
      }
      if (String(url).endsWith("/api/smart-reply/mode")) {
        return jsonResponse({ ok: true, mode: "local" });
      }
      return jsonResponse({ ok: false }, 404);
    },
  });

  const result = await proxy({
    method: "POST",
    path: "/api/smart-reply/mode",
    body: { mode: "local" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(observed.map((call) => call.url), [
    "http://127.0.0.1:3790/api/internal/shop-license-grants",
    "http://127.0.0.1:3790/api/smart-reply/mode",
  ]);
  assert.deepEqual(JSON.parse(observed[0].options.body), {
    grants: [
      { clientId: "4097603", expireAt: "2027-08-24T10:12:22.224Z" },
    ],
  });
});

test("a slow License Center grant refresh cannot stall local account and cache reads", async () => {
  let releaseGrantRefresh;
  const grantRefresh = new Promise((resolve) => {
    releaseGrantRefresh = resolve;
  });
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view"] },
      }),
      getOzonShopEntitlementGrants: async () => grantRefresh,
    },
    fetchImpl: async (url) => {
      observed.push(String(url));
      return jsonResponse({ ok: true, shops: [] });
    },
  });

  const localRead = await Promise.race([
    proxy({ method: "GET", path: "/api/shops" }),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 50)),
  ]);

  assert.equal(localRead.timedOut, undefined);
  assert.equal(localRead.ok, true);
  assert.ok(observed.includes("http://127.0.0.1:3790/api/shops"));
  releaseGrantRefresh([]);
  await new Promise((resolve) => setImmediate(resolve));
});

test("the first Ozon sync still waits for the authoritative shop grants", async () => {
  let releaseGrantRefresh;
  const grantRefresh = new Promise((resolve) => {
    releaseGrantRefresh = resolve;
  });
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["marketing.view"] },
      }),
      getOzonShopEntitlementGrants: async () => grantRefresh,
      assertOzonShopEntitled: async (clientId) => ({
        authorized: true,
        clientId,
      }),
    },
    fetchImpl: async (url) => {
      observed.push(String(url));
      if (String(url).endsWith("/api/shops")) {
        return jsonResponse({
          ok: true,
          shops: [{ id: "shop-1", clientId: "active-client" }],
        });
      }
      return jsonResponse({ ok: true, jobId: "marketing-job-1" });
    },
  });

  const syncPromise = proxy({
    method: "POST",
    path: "/api/sync/marketing",
    body: { shopId: "shop-1", action: "sync-marketing-activities" },
  });
  const early = await Promise.race([
    syncPromise,
    new Promise((resolve) => setTimeout(() => resolve({ waiting: true }), 30)),
  ]);
  assert.equal(early.waiting, true);

  releaseGrantRefresh([
    { clientId: "active-client", expireAt: "2099-08-05T00:00:00.000Z" },
  ]);
  assert.equal((await syncPromise).ok, true);
  assert.deepEqual(observed, [
    "http://127.0.0.1:3790/api/internal/shop-license-grants",
    "http://127.0.0.1:3790/api/shops",
    "http://127.0.0.1:3790/api/sync/marketing",
  ]);
});

test("never lets the renderer replace the main-process shop grant list", async () => {
  let forwarded = false;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async () => {
      forwarded = true;
      return jsonResponse({ ok: true });
    },
  });

  assert.deepEqual(
    await proxy({
      method: "POST",
      path: "/api/internal/shop-license-grants",
      body: {
        grants: [{ clientId: "forged", expireAt: "2099-01-01T00:00:00.000Z" }],
      },
    }),
    {
      ok: false,
      status: 403,
      error: "店铺授权清单仅供桌面端主进程维护",
    },
  );
  assert.equal(forwarded, false);
});

test("strips a renderer-forged paid token and injects the authenticated main-process token", async () => {
  let observed;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "local-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["products.view"] },
      }),
      getProtectedComputeAccessToken: async () => "main-process-license-token",
    },
    fetchImpl: async (_url, options) => {
      observed = options;
      return jsonResponse({ ok: true });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/product-descriptions/generate",
    requestId: "paid-request-1",
    headers: {
      "x-wangzai-paid-capability-access-token": "renderer-forged-token",
      "x-request-id": "renderer-forged-request-id",
    },
    body: { title: "商品" },
  });
  assert.equal(result.ok, true);
  assert.equal(
    observed.headers["x-wangzai-paid-capability-access-token"],
    "main-process-license-token",
  );
  assert.equal(observed.headers["x-request-id"], "paid-request-1");
  assert.equal(
    observed.headers["x-wangzai-protected-compute-access-token"],
    undefined,
  );
});

test("never attaches the paid token to an adjacent or non-billable local route", async () => {
  const observed = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "local-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["products.view", "dashboard.view"] },
      }),
      getProtectedComputeAccessToken: async () => "main-process-license-token",
    },
    fetchImpl: async (url, options) => {
      observed.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });
  await proxy({ method: "GET", path: "/api/products" });
  await proxy({
    method: "POST",
    path: "/api/product-descriptions/generate-adjacent",
  });
  assert.equal(observed.length, 1);
  assert.equal(
    observed[0].options.headers["x-wangzai-paid-capability-access-token"],
    undefined,
  );
});

test("keeps valid BYOK local calls usable when a paid token cannot be obtained", async () => {
  let observed;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "local-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["products.view"] },
      }),
      getProtectedComputeAccessToken: async () => {
        throw new Error("offline");
      },
    },
    fetchImpl: async (_url, options) => {
      observed = options;
      return jsonResponse({ ok: true });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/product-descriptions/generate",
    body: { modelAccountId: "user-byok" },
  });
  assert.equal(result.ok, true);
  assert.equal(
    observed.headers["x-wangzai-paid-capability-access-token"],
    undefined,
  );
});

test("cancels an in-flight renderer request by opaque request id", async () => {
  let observedSignal;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    },
  });

  const pending = proxy({
    method: "GET",
    path: "/api/cache/data-analysis?shopId=shop-a",
    requestId: "renderer-read-1",
    timeoutMs: 60_000,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(proxy.pendingCount(), 1);
  assert.deepEqual(proxy.cancel("renderer-read-1"), {
    ok: true,
    canceled: true,
    requestId: "renderer-read-1",
  });
  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(await pending, {
    ok: false,
    status: 0,
    error: "本地 API 请求超时",
  });
  assert.equal(proxy.pendingCount(), 0);
});

test("allows only the real advertising and analysis routes to run longer", () => {
  for (const pathname of [
    "/api/account-removal/confirm",
    "/api/account-removal/client-verify",
    "/api/account-removal/recover",
    "/api/account-removal/recover-direct",
  ]) {
    assert.equal(
      maximumTimeoutMsForLocalApiRequest("POST", pathname),
      180_000,
    );
  }
  assert.equal(
    maximumTimeoutMsForLocalApiRequest(
      "POST",
      "/api/follow-seller-defense/prepare-quick",
    ),
    300_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest(
      "POST",
      "/api/follow-seller-defense/submission-result",
    ),
    180_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("POST", "/api/performance/overview"),
    300_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("POST", "/api/integrations/analyze"),
    420_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("POST", "/api/data-analysis/insights"),
    300_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest(
      "POST",
      "/api/product-descriptions/generate",
    ),
    180_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest(
      "POST",
      "/api/image-prompt-plans/generate",
    ),
    180_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("POST", "/api/integrations/read"),
    120_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("GET", "/api/performance/overview"),
    120_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("GET", "/api/integrations/analyze"),
    120_000,
  );
});

test("blocks local business APIs when enforce mode is not authorized", async () => {
  let called = false;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({ authorized: false }),
    },
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ ok: true });
    },
  });
  assert.deepEqual(await proxy({ path: "/api/app/status" }), {
    ok: false,
    status: 403,
    error: "请先完成软件授权",
  });
  assert.equal(called, false);
});

test("rejects absolute foreign URLs before fetch", async () => {
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "observe" }),
      getSession: async () => ({ authorized: false }),
    },
    fetchImpl: async () => jsonResponse({ ok: true }),
  });
  const result = await proxy({ path: "https://example.test/api/private" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("allows a 2-8 MiB marketing legacy import only on its exact POST route", async () => {
  const forwarded = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "local" }),
    },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });
  const betweenTwoAndEightMiB = { payload: "x".repeat(3 * 1024 * 1024) };

  const accepted = await proxy({
    method: "POST",
    path: "/api/cache/marketing/legacy-import",
    body: betweenTwoAndEightMiB,
  });
  assert.equal(accepted.ok, true);
  assert.equal(forwarded.length, 1);
  assert.ok(
    Buffer.byteLength(forwarded[0].options.body, "utf8") > 2 * 1024 * 1024,
  );
  assert.ok(
    Buffer.byteLength(forwarded[0].options.body, "utf8") <= 8 * 1024 * 1024,
  );

  const ordinaryRoute = await proxy({
    method: "POST",
    path: "/api/cache/marketing/view-state",
    body: betweenTwoAndEightMiB,
  });
  assert.deepEqual(ordinaryRoute, {
    ok: false,
    status: 400,
    error: "本地 API 请求体过大",
  });
  assert.equal(forwarded.length, 1);

  const wrongMethod = await proxy({
    method: "PUT",
    path: "/api/cache/marketing/legacy-import",
    body: betweenTwoAndEightMiB,
  });
  assert.deepEqual(wrongMethod, {
    ok: false,
    status: 400,
    error: "本地 API 请求体过大",
  });
  assert.equal(forwarded.length, 1);

  const overEightMiB = await proxy({
    method: "POST",
    path: "/api/cache/marketing/legacy-import",
    body: { payload: "x".repeat(8 * 1024 * 1024) },
  });
  assert.deepEqual(overEightMiB, {
    ok: false,
    status: 400,
    error: "本地 API 请求体过大",
  });
  assert.equal(forwarded.length, 1);
});

test("allows a compact 2-16 MiB canonical profit ledger only on its exact PUT route", async () => {
  const forwarded = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return jsonResponse({ ok: true, source: "sqlite" });
    },
  });
  const canonicalSnapshot = {
    snapshotKey: "ozon-profit-ledger-v1:shop-a:range:current",
    snapshot: { rows: [{ payload: "x".repeat(9 * 1024 * 1024) }] },
  };

  const accepted = await proxy({
    method: "PUT",
    path: "/api/profit/ledger-snapshot",
    body: canonicalSnapshot,
  });
  assert.equal(accepted.ok, true);
  assert.equal(forwarded.length, 1);
  assert.ok(
    Buffer.byteLength(forwarded[0].options.body, "utf8") > 8 * 1024 * 1024,
  );
  assert.ok(
    Buffer.byteLength(forwarded[0].options.body, "utf8") <= 16 * 1024 * 1024,
  );

  for (const input of [
    { method: "POST", path: "/api/profit/ledger-snapshot" },
    { method: "PUT", path: "/api/profit/ledger-snapshot-adjacent" },
  ]) {
    assert.deepEqual(await proxy({ ...input, body: canonicalSnapshot }), {
      ok: false,
      status: 400,
      error: "本地 API 请求体过大",
    });
  }
  assert.equal(forwarded.length, 1);

  assert.deepEqual(
    await proxy({
      method: "PUT",
      path: "/api/profit/ledger-snapshot",
      body: { snapshot: { payload: "x".repeat(16 * 1024 * 1024) } },
    }),
    { ok: false, status: 400, error: "本地 API 请求体过大" },
  );
  assert.equal(forwarded.length, 1);
});

test("allows a large market snapshot only on the exact data-analysis snapshot POST route", async () => {
  const forwarded = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return jsonResponse({
        ok: true,
        row: { analysisType: "ozon-browser-market" },
      });
    },
  });
  const snapshot = {
    payload: { marketData: { records: "x".repeat(5 * 1024 * 1024) } },
  };

  assert.equal(
    (
      await proxy({
        method: "POST",
        path: "/api/cache/data-analysis/snapshot",
        body: snapshot,
      })
    ).ok,
    true,
  );
  assert.equal(forwarded.length, 1);

  for (const input of [
    { method: "PUT", path: "/api/cache/data-analysis/snapshot" },
    { method: "POST", path: "/api/cache/data-analysis/snapshot-adjacent" },
  ]) {
    assert.deepEqual(await proxy({ ...input, body: snapshot }), {
      ok: false,
      status: 400,
      error: "本地 API 请求体过大",
    });
  }
  assert.equal(forwarded.length, 1);
});

test("keeps backup packages on local staging while large historical imports stay on exact typed POST routes", async () => {
  const forwarded = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });
  const payload = { contentB64u: "x".repeat(3 * 1024 * 1024) };
  const stagingControl = {
    command: "preflight",
    stagingFileName: `data-backup-import-${"ab".repeat(32)}.wzb`,
    packageSha256: "c".repeat(64),
    packageBytes: 3 * 1024 * 1024,
  };
  assert.equal(
    (
      await proxy({
        method: "POST",
        path: "/api/app/data-backup-import",
        body: stagingControl,
      })
    ).ok,
    true,
  );
  assert.deepEqual(
    await proxy({
      method: "POST",
      path: "/api/app/data-backup-import",
      body: payload,
    }),
    { ok: false, status: 400, error: "本地 API 请求体过大" },
  );
  assert.equal(
    (
      await proxy({
        method: "POST",
        path: "/api/app/historical-product-import/preflight",
        body: payload,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await proxy({
        method: "POST",
        path: "/api/app/historical-order-import/preflight",
        body: payload,
      })
    ).ok,
    true,
  );
  assert.equal(forwarded.length, 3);
  assert.deepEqual(
    await proxy({
      method: "PUT",
      path: "/api/app/data-backup-import",
      body: payload,
    }),
    { ok: false, status: 400, error: "本地 API 请求体过大" },
  );
  assert.deepEqual(
    await proxy({
      method: "POST",
      path: "/api/app/historical-product-import/confirm",
      body: payload,
    }),
    { ok: false, status: 400, error: "本地 API 请求体过大" },
  );
  assert.deepEqual(
    await proxy({
      method: "PUT",
      path: "/api/app/historical-order-import/preflight",
      body: payload,
    }),
    { ok: false, status: 400, error: "本地 API 请求体过大" },
  );
  assert.deepEqual(
    await proxy({
      method: "POST",
      path: "/api/app/historical-order-import/confirm",
      body: payload,
    }),
    { ok: false, status: 400, error: "本地 API 请求体过大" },
  );
  assert.equal(forwarded.length, 3);
});

test("rejects retired model, purchase, and platform browser-migration routes before they reach local-api", async () => {
  const forwarded = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "local" }),
    },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });
  const betweenTwoAndEightMiB = {
    accounts: [{ payload: "x".repeat(3 * 1024 * 1024) }],
  };

  for (const path of [
    "/api/model-api/accounts/legacy-import",
    "/api/purchase/accounts/legacy-import",
    "/api/integrations/profiles/legacy-import",
    "/api/performance/accounts/legacy-import",
  ]) {
    const rejected = await proxy({
      method: "POST",
      path,
      body: betweenTwoAndEightMiB,
    });
    assert.deepEqual(
      rejected,
      {
        ok: false,
        status: 400,
        error: "本地 API 请求体过大",
      },
      path,
    );
  }
  assert.equal(forwarded.length, 0);
});

test("allows every active typed legacy import path but no adjacent route or method", async () => {
  const forwarded = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return jsonResponse({ ok: true, importedCount: 1 });
    },
  });
  const payload = { records: [{ payload: "x".repeat(3 * 1024 * 1024) }] };
  const paths = [
    "/api/shops/legacy-import",
    "/api/products/material/legacy-import",
    "/api/products/source-links/legacy-import",
    "/api/purchase/source-links/legacy-import",
    "/api/sales/source-links/legacy-import",
    "/api/purchase/orders/overrides/legacy-import",
  ];
  for (const path of paths) {
    assert.equal(
      (await proxy({ method: "POST", path, body: payload })).ok,
      true,
      path,
    );
    assert.deepEqual(
      await proxy({ method: "PUT", path, body: payload }),
      { ok: false, status: 400, error: "本地 API 请求体过大" },
      path,
    );
  }
  assert.equal(forwarded.length, paths.length);
  assert.deepEqual(
    await proxy({
      method: "POST",
      path: "/api/products/material/legacy-import-adjacent",
      body: payload,
    }),
    { ok: false, status: 400, error: "本地 API 请求体过大" },
  );
  assert.equal(forwarded.length, paths.length);
});

test("enforces server-issued module permissions at the local API boundary", async () => {
  let called = false;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "secret-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view"] },
      }),
    },
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ ok: true });
    },
  });
  const result = await proxy({ path: "/api/cache/products?page=1" });
  assert.equal(result.status, 403);
  assert.match(result.error, /products\.view/);
  assert.equal(called, false);
});

test("follow-seller routes use the product permission and reject unrelated licenses", async () => {
  const routes = [
    ["GET", "/api/follow-seller-defense/overview"],
    ["POST", "/api/follow-seller-defense/resolve"],
    ["POST", "/api/follow-seller-defense/patrols"],
    ["POST", "/api/follow-seller-defense/capture"],
    ["POST", "/api/follow-seller-defense/prepare"],
    ["POST", "/api/follow-seller-defense/confirm"],
    ["POST", "/api/follow-seller-defense/readback"],
    ["POST", "/api/follow-seller-defense/verify"],
  ];
  routes.forEach(([method, pathname]) => {
    assert.equal(
      requiredPermissionForLocalApi(pathname, {}, method),
      "products.view",
      pathname,
    );
  });

  const forwarded = [];
  const allowedProxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "follow-seller-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["products.view"] },
      }),
    },
    fetchImpl: async (url) => {
      forwarded.push(String(url));
      return jsonResponse({ ok: true });
    },
  });
  for (const [method, routePath] of routes) {
    const result = await allowedProxy({
      method,
      path: routePath,
      ...(method === "POST" ? { body: { shopId: "shop-1" } } : {}),
    });
    assert.equal(result.ok, true, routePath);
  }
  assert.equal(forwarded.length, routes.length);

  let deniedForwarded = false;
  const deniedProxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "follow-seller-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view"] },
      }),
    },
    fetchImpl: async () => {
      deniedForwarded = true;
      return jsonResponse({ ok: true });
    },
  });
  const denied = await deniedProxy({
    method: "POST",
    path: "/api/follow-seller-defense/patrols",
    body: { shopId: "shop-1" },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.error, /products\.view/);
  assert.equal(deniedForwarded, false);
  assert.equal(
    requiredPermissionForLocalApi("/api/follow-seller-defense-adjacent"),
    null,
  );
});

test("sync job control and domain state have explicit permissions", () => {
  assert.equal(
    requiredPermissionForLocalApi("/api/cache/dashboard-business-share"),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/cache/dashboard-overview"),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/sync/jobs/order-job/cancel"),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/sync/state/orders"),
    "orders.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/sync/images"),
    "products.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/sync/reports"),
    "analytics.view",
  );
  assert.equal(requiredPermissionForLocalApi("/api/sync/state/unknown"), null);
  assert.equal(
    requiredPermissionForLocalApi("/api/app/recovery-backup-preview"),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/app/recovery/command"),
    "dashboard.view",
  );
});

test("maintenance, source-link, and profit-ledger routes stay inside their owning permissions", () => {
  assert.equal(
    requiredPermissionForLocalApi("/api/smart-reply/local/rules"),
    "customer_service.view",
  );
  assert.equal(
    requiredPermissionForLocalApi(
      "/api/smart-reply/local/notification-poll",
    ),
    "customer_service.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/app/data-consistency-audit"),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/app/database-compaction/confirm"),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi(
      "/api/app/shop-scope-manual-resolution/confirm",
    ),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/sales/source-links"),
    "orders.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/profit/ledger-snapshot"),
    "profit.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/catalog/shared/tree"),
    "products.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/integrations/read"),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/integrations/analyze"),
    "dashboard.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/data-analysis/insights"),
    "analytics.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/product-descriptions/generate"),
    "products.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/image-prompt-plans/generate"),
    "products.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/protected-compute/execute", {
      capability: "collection-pricing.quote",
    }),
    "collection_pricing.use",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/protected-compute/execute", {
      capability: "profitability.quote",
    }),
    "profit.view",
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/protected-compute/execute", {
      capability: "unknown.quote",
    }),
    null,
  );
  assert.equal(
    requiredPermissionForLocalApi("/api/protected-compute/status"),
    "",
  );
});

test("product attribute and image prompt model routes pass the licensed desktop boundary", async () => {
  const requested = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "product-model-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["products.view"] },
      }),
    },
    fetchImpl: async (url) => {
      requested.push(String(url));
      return jsonResponse({ ok: true });
    },
  });

  for (const path of [
    "/api/product-descriptions/generate",
    "/api/image-prompt-plans/generate",
  ]) {
    const result = await proxy({
      method: "POST",
      path,
      body: { model: "configured-model" },
    });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(requested, [
    "http://127.0.0.1:3790/api/product-descriptions/generate",
    "http://127.0.0.1:3790/api/image-prompt-plans/generate",
  ]);
});

test("all product image asset routes use product permission and long model calls keep their timeout", () => {
  const paths = [
    "/api/product-images/import",
    "/api/product-images/edit",
    "/api/product-images/generate",
    "/api/product-images/promote",
    "/api/product-images/release",
    "/api/product-images/status",
    "/api/product-images/usage",
    "/api/product-images/preview/pimg_123",
  ];
  paths.forEach((pathname) =>
    assert.equal(requiredPermissionForLocalApi(pathname), "products.view"),
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("POST", "/api/product-images/edit"),
    180_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("POST", "/api/product-images/generate"),
    180_000,
  );
  assert.equal(
    maximumTimeoutMsForLocalApiRequest("POST", "/api/product-images/import"),
    120_000,
  );
});

test("image provenance shadow routes stay behind product permission", () => {
  for (const path of [
    "/api/image-provenance/status",
    "/api/image-provenance/jobs",
    "/api/image-provenance/jobs/ipj_123",
  ]) {
    assert.equal(requiredPermissionForLocalApi(path), "products.view");
  }
});

test("account-removal canonical routes have exact packaged-mode permissions", async () => {
  const fixedCanonicalRoutes = [
    ["POST", "/api/account-removal/preview"],
    ["POST", "/api/account-removal/prepare-preview"],
    ["POST", "/api/account-removal/release-preview"],
    ["POST", "/api/account-removal/confirm"],
    ["POST", "/api/account-removal/client-verify"],
    ["POST", "/api/account-removal/client-failure"],
    ["POST", "/api/account-removal/recover"],
    ["POST", "/api/account-removal/recover-direct"],
    ["GET", "/api/account-removal/pending"],
  ];
  const fixedCanonicalPaths = fixedCanonicalRoutes.map(
    ([, pathname]) => pathname,
  );
  const accountRemovalRouteSource = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "..",
      "local-api",
      "src",
      "app",
      "accountRemovalRoute.js",
    ),
    "utf8",
  );
  const registeredFixedPaths = Array.from(
    new Set(
      Array.from(
        accountRemovalRouteSource.matchAll(/pathname\s*===\s*["']([^"']+)/g),
        (match) => match[1],
      ).filter((pathname) => pathname.startsWith("/api/account-removal/")),
    ),
  );
  assert.deepEqual(
    registeredFixedPaths.sort(),
    [...fixedCanonicalPaths].sort(),
  );
  const registeredFixedRoutes = Array.from(
    accountRemovalRouteSource.matchAll(
      /req\.method\s*===\s*["']([^"']+)["']\s*&&\s*pathname\s*===\s*["']([^"']+)["']/gu,
    ),
    (match) => [match[1], match[2]],
  ).filter(([, pathname]) => pathname.startsWith("/api/account-removal/"));
  assert.deepEqual(
    registeredFixedRoutes
      .map(([method, pathname]) => `${method} ${pathname}`)
      .sort(),
    fixedCanonicalRoutes
      .map(([method, pathname]) => `${method} ${pathname}`)
      .sort(),
  );

  const canonicalRoutes = [
    ...fixedCanonicalRoutes,
    ["GET", "/api/account-removal/operations/account_removal_1234"],
    ["POST", "/api/account-removal/operations/account_removal_1234/resume"],
  ];
  for (const [method, pathname] of canonicalRoutes) {
    assert.equal(
      requiredPermissionForLocalApi(pathname, {}, method),
      "dashboard.view",
    );
    assert.equal(requiredPermissionForLocalApi(pathname), "dashboard.view");
  }
  for (const pathname of [
    "/api/account-removal",
    "/api/account-removal/preview/",
    "/api/account-removal/preview-adjacent",
    "/api/account-removal/prepare-preview-adjacent",
    "/api/account-removal/release-preview-adjacent",
    "/api/account-removal/client-failure-adjacent",
    "/api/account-removal/recover-direct-adjacent",
    "/api/account-removal/operations/account_removal_1234/unknown",
    "/api/account-removal/operations/account_removal_1234/resume/again",
  ]) {
    assert.equal(requiredPermissionForLocalApi(pathname), null);
  }

  const forwarded = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "account-removal-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["dashboard.view"] },
      }),
    },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });
  for (const [method, routePath] of canonicalRoutes) {
    assert.equal(
      (
        await proxy({
          method,
          path: routePath,
          body:
            method === "POST"
              ? { owner: { ownerType: "ozon_shop", ownerId: "shop-a" } }
              : undefined,
        })
      ).ok,
      true,
    );
  }
  assert.deepEqual(
    await proxy({
      method: "POST",
      path: "/api/account-removal/preview-adjacent",
    }),
    {
      ok: false,
      status: 403,
      error: "本地 API 缺少明确的授权策略",
      data: {
        ok: false,
        error: {
          code: "LOCAL_API_AUTH_POLICY_MISSING",
          message: "本地 API 缺少明确的授权策略",
        },
        method: "POST",
        path: "/api/account-removal/preview-adjacent",
      },
    },
  );
  assert.deepEqual(
    await proxy({
      method: "GET",
      path: "/api/account-removal/confirm",
    }),
    {
      ok: false,
      status: 403,
      error: "本地 API 缺少明确的授权策略",
      data: {
        ok: false,
        error: {
          code: "LOCAL_API_AUTH_POLICY_MISSING",
          message: "本地 API 缺少明确的授权策略",
        },
        method: "GET",
        path: "/api/account-removal/confirm",
      },
    },
  );
  assert.equal(forwarded.length, canonicalRoutes.length);
});

test('private profit batches use the same exact profit permission and main-process token', async () => {
  let forwarded;
  const proxy = createLocalApiProxy({ baseUrl: 'http://127.0.0.1:3790', authToken: 'local-capability',
    licenseRuntime: { getRuntime: async () => ({ mode: 'enforce' }),
      getSession: async () => ({ authorized: true, entitlement: { permissions: ['profit.view'] } }),
      getProtectedComputeAccessToken: async () => 'main-only-fixture-token',
    }, fetchImpl: async (_url, options) => { forwarded = options; return jsonResponse({ ok: true }); },
  });
  const body = { capability: 'profit.ledger-batch', version: 1, input: { callsJson: 'x'.repeat(70 * 1024) } };
  assert.equal(requiredPermissionForLocalApi('/api/protected-compute/execute', body), 'profit.view');
  const result = await proxy({ method: 'POST', path: '/api/protected-compute/execute', body });
  assert.equal(result.ok, true);
  assert.equal(forwarded.headers['x-wangzai-protected-compute-access-token'], 'main-only-fixture-token');
  assert.doesNotMatch(forwarded.body, /main-only-fixture-token/);
});

test("protected compute gets a main-process-only short-lived token", async () => {
  let forwarded;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "local-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["collection_pricing.use"] },
      }),
      getProtectedComputeAccessToken: async () => "short-lived-license-access",
    },
    fetchImpl: async (url, options) => {
      forwarded = { url, options };
      return jsonResponse({ ok: true, signatureVerified: true });
    },
  });
  const body = {
    capability: "collection-pricing.quote",
    version: 1,
    input: {
      commissionBasisPoints: 1_700,
      currency: "CNY",
      currentPriceMinor: 5_516,
      extraCostMinor: 100,
      firstMileCostMinor: 600,
      purchaseCostMinor: 2_500,
      targetMarginBasisPoints: 2_000,
    },
  };
  const result = await proxy({
    method: "POST",
    path: "/api/protected-compute/execute",
    body,
    headers: {
      // Renderer-supplied copies are stripped; only main-process context wins.
      "x-wangzai-protected-compute-access-token": "renderer-token",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(
    forwarded.options.headers["x-wangzai-protected-compute-access-token"],
    "short-lived-license-access",
  );
  assert.equal(
    JSON.stringify(JSON.parse(forwarded.options.body)),
    JSON.stringify(body),
  );
  assert.doesNotMatch(forwarded.options.body, /short-lived-license-access/u);
});

test("protected compute denies a capability when the license has only another capability permission", async () => {
  let called = false;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "local-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["collection_pricing.use"] },
      }),
      getProtectedComputeAccessToken: async () => {
        called = true;
        return "must-not-be-requested";
      },
    },
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ ok: true });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/protected-compute/execute",
    body: { capability: "profitability.quote", version: 1, input: {} },
  });
  assert.equal(result.status, 403);
  assert.match(result.error, /profit\.view/u);
  assert.equal(called, false);
});

test("protected compute refreshes once after 401 and retries with the replacement access token", async () => {
  const tokenRequests = [];
  const forwardedTokens = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "local-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "observe" }),
      getProtectedComputeAccessToken: async (options) => {
        tokenRequests.push(options);
        return options.forceRefresh
          ? "replacement-user-access"
          : "expired-user-access";
      },
    },
    fetchImpl: async (_url, options) => {
      forwardedTokens.push(
        options.headers["x-wangzai-protected-compute-access-token"],
      );
      assert.doesNotMatch(options.body, /(?:expired|replacement)-user-access/u);
      return forwardedTokens.length === 1
        ? jsonResponse(
            { ok: false, error: { code: "PROTECTED_COMPUTE_REMOTE_REJECTED" } },
            401,
          )
        : jsonResponse({ ok: true, signatureVerified: true });
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/protected-compute/execute",
    body: {
      capability: "profitability.quote",
      version: 1,
      input: { salePriceMinor: 100 },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(forwardedTokens, [
    "expired-user-access",
    "replacement-user-access",
  ]);
  assert.deepEqual(tokenRequests, [
    { forceRefresh: false, rejectedAccessToken: "" },
    { forceRefresh: true, rejectedAccessToken: "expired-user-access" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /(?:expired|replacement)-user-access/u,
  );
});

test("protected compute fails closed without retry or token leakage when refresh fails", async () => {
  let forwarded = 0;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "local-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "observe" }),
      getProtectedComputeAccessToken: async ({ forceRefresh }) => {
        if (forceRefresh)
          throw new Error(
            "refresh rejected expired-user-access refresh-secret",
          );
        return "expired-user-access";
      },
    },
    fetchImpl: async () => {
      forwarded += 1;
      return jsonResponse({ ok: false }, 401);
    },
  });
  const result = await proxy({
    method: "POST",
    path: "/api/protected-compute/execute",
    body: {
      capability: "profitability.quote",
      version: 1,
      input: { salePriceMinor: 100 },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    status: 401,
    error: "登录会话刷新失败，请重新登录后再使用受保护计算。",
  });
  assert.equal(forwarded, 1);
  assert.doesNotMatch(
    JSON.stringify(result),
    /expired-user-access|refresh-secret/u,
  );
});

test("protected compute fails before local-api when no short-lived login token exists", async () => {
  let called = false;
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "local-capability",
    licenseRuntime: {
      getRuntime: async () => ({ mode: "enforce" }),
      getSession: async () => ({
        authorized: true,
        entitlement: { permissions: ["collection_pricing.use"] },
      }),
      getProtectedComputeAccessToken: async () => {
        throw new Error("not logged in");
      },
    },
    fetchImpl: async () => {
      called = true;
      return jsonResponse({ ok: true });
    },
  });
  assert.deepEqual(
    await proxy({
      method: "POST",
      path: "/api/protected-compute/execute",
      body: { capability: "collection-pricing.quote", version: 1, input: {} },
    }),
    { ok: false, status: 401, error: "请先登录授权账号后再使用受保护计算。" },
  );
  assert.equal(called, false);
});

test("desktop renderer cannot proxy the internal local-api shutdown route", async () => {
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "x".repeat(32),
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async () => assert.fail("internal shutdown must not be proxied"),
  });
  const result = await proxy({
    method: "POST",
    path: "/api/internal/shutdown",
  });
  assert.equal(result.status, 403);
});

test("desktop renderer cannot proxy internal purchase-browser control routes", async () => {
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "x".repeat(32),
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async () =>
      assert.fail("internal purchase-browser control must not be proxied"),
  });
  for (const path of [
    "/api/internal/purchase-browser/plugin-state",
    "/api/internal/purchase-browser/account-binding",
    "/api/internal/purchase-browser/account-removal/prepare",
    "/api/internal/purchase-browser/account-removal/receipt",
    "/api/internal/purchase-browser/tasks/task-1/claim",
  ]) {
    const result = await proxy({ method: "POST", path });
    assert.equal(result.status, 403);
  }
});

test("recovery shell exposes only shops, status, and explicit recovery commands", async () => {
  const requested = [];
  const proxy = createLocalApiProxy({
    baseUrl: "http://127.0.0.1:3790",
    authToken: "x".repeat(32),
    recoveryMode: true,
    licenseRuntime: { getRuntime: async () => ({ mode: "local" }) },
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse({ ok: true });
    },
  });

  const blocked = await proxy({ path: "/api/cache/products?page=1" });
  assert.deepEqual(blocked, {
    ok: false,
    status: 423,
    error: "当前资料等待恢复，仅可使用恢复入口。",
  });
  assert.equal(requested.length, 0);

  assert.equal((await proxy({ path: "/api/shops" })).ok, true);
  assert.equal(
    (
      await proxy({
        method: "POST",
        path: "/api/app/recovery/command",
        body: { command: "status" },
      })
    ).ok,
    true,
  );
  assert.equal(requested.length, 2);
});

test("every concrete local-api route has an explicit authorization policy", () => {
  const source = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "..",
      "local-api",
      "src",
      "app",
      "createApp.js",
    ),
    "utf8",
  );
  const routes = new Set(
    Array.from(
      source.matchAll(/requestUrl\.pathname\s*===\s*["']([^"']+)/g),
      (match) => match[1],
    ).filter((pathname) => pathname.startsWith("/api/")),
  );
  for (const pathname of routes) {
    const body =
      pathname === "/api/ozon/request" ? { endpointKey: "products.list" } : {};
    assert.notEqual(
      requiredPermissionForLocalApi(pathname, body),
      null,
      `Missing policy for ${pathname}`,
    );
  }
  assert.equal(
    requiredPermissionForLocalApi("/api/unmapped-business-route"),
    null,
  );
});

test("every registered dynamic business domain has an explicit authorization policy", () => {
  const source = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "..",
      "local-api",
      "src",
      "domain",
      "domainRegistry.js",
    ),
    "utf8",
  );
  const registeredDomains = Array.from(
    source.matchAll(/^\s*\[\s*["']([^"']+)["']\s*,/gmu),
    (match) => match[1],
  );
  const expectedPermissions = new Map([
    ["products", "products.view"],
    ["orders", "orders.view"],
    ["profit", "profit.view"],
    ["finance", "profit.view"],
    ["profit-report", "profit.view"],
    ["returns", "orders.view"],
    ["logistics", "warehouse.view"],
    ["marketing", "marketing.view"],
    ["customerService", "customer_service.view"],
    ["images", "products.view"],
    ["reports", "analytics.view"],
    ["data-analysis", "analytics.view"],
    ["dashboard-business-share", "dashboard.view"],
    ["dashboard-overview", "dashboard.view"],
  ]);
  assert.deepEqual(
    [...registeredDomains].sort(),
    [...expectedPermissions.keys()].sort(),
  );
  for (const [domain, permission] of expectedPermissions) {
    assert.equal(
      requiredPermissionForLocalApi(`/api/cache/${domain}`),
      permission,
      `${domain} cache`,
    );
    assert.equal(
      requiredPermissionForLocalApi(`/api/sync/${domain}`),
      permission,
      `${domain} sync`,
    );
    assert.equal(
      requiredPermissionForLocalApi(`/api/sync/state/${domain}`),
      permission,
      `${domain} state`,
    );
  }
});
