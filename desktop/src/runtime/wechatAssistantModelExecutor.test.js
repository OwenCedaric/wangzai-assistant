import assert from "node:assert/strict";
import test from "node:test";

import { createWechatAssistantModelExecutor } from "./wechatAssistantModelExecutor.js";

test('authorization changed during token preflight cannot dispatch a paid model request for the new owner', async () => {
  let valid = true, tokenStarted, finishToken;
  const started = new Promise(resolve => { tokenStarted = resolve; });
  const token = new Promise(resolve => { finishToken = resolve; });
  let requests = 0;
  const execute = createWechatAssistantModelExecutor({ runtimeInfo: { localApi: { coreServiceUrl: 'https://core.example' } },
    licenseRuntime: { getProtectedComputeAccessToken: () => { tokenStarted(); return token; } },
    getPointsWallet: async () => ({ balancePoints: 100, reservedPoints: 0, availablePoints: 100 }),
    fetchImpl: async () => { requests += 1; throw new Error('must not dispatch'); } });
  const pending = execute({ requestId: 'fixture-same-id', settings: { modelSource: 'builtin-points', modelName: 'gpt-5.6-terra' },
    payload: {}, assertAuthorizationCurrent: () => {
      if (!valid) throw Object.assign(new Error('authorization changed'), { code: 'WECHAT_AUTHORIZATION_CHANGED' });
    } });
  await started;
  valid = false; finishToken('fixture-new-owner-token');
  await assert.rejects(pending, { code: 'WECHAT_AUTHORIZATION_CHANGED', outcome: 'not-dispatched' });
  assert.equal(requests, 0);
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("built-in model uses protected token and sends no pricing formula or provider key", async () => {
  const requests = [];
  const execute = createWechatAssistantModelExecutor({
    runtimeInfo: { localApi: { coreServiceUrl: "https://core.example", baseUrl: "http://127.0.0.1:1" } },
    licenseRuntime: { getProtectedComputeAccessToken: async () => "device-token" },
    getPointsWallet: async () => ({ balancePoints: 10, reservedPoints: 0, availablePoints: 10 }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ ok: true, response: { choices: [{ message: { content: "ok" } }] }, billing: { chargedPoints: 2 } });
    },
  });
  const result = await execute({
    requestId: "wechat-request-1",
    settings: { modelSource: "builtin-points", modelName: "gpt-5.6-terra" },
    payload: { model: "gpt-5.6-terra", messages: [{ role: "user", content: "你好" }], stream: false },
  });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].options.headers.Authorization, "Bearer device-token");
  assert.equal(body.byok, null);
  assert.equal(body.request_id, "wechat-request-1");
  assert.equal(JSON.stringify(body).includes("points_per_cny"), false);
  assert.equal(result.billing.chargedPoints, 2);
  assert.equal(result.billing.pointsRemaining, 10);
  assert.deepEqual(result.channel, {
    source: "builtin-points",
    model: "gpt-5.6-terra",
    strategy: "managed-safe-failover",
  });
});

test("built-in model stops before the paid request when available points are exhausted", async () => {
  let requests = 0;
  const execute = createWechatAssistantModelExecutor({
    runtimeInfo: { localApi: { coreServiceUrl: "https://core.example" } },
    licenseRuntime: { getProtectedComputeAccessToken: async () => "device-token" },
    getPointsWallet: async () => ({ balancePoints: 0, reservedPoints: 0, availablePoints: 0 }),
    fetchImpl: async () => { requests += 1; return jsonResponse({ ok: true }); },
  });
  await assert.rejects(
    execute({
      requestId: "wechat-no-points",
      settings: { modelSource: "builtin-points", modelName: "gpt-5.6-terra" },
      payload: { model: "gpt-5.6-terra", messages: [{ role: "user", content: "你好" }] },
    }),
    (error) => error.code === "POINT_BALANCE_INSUFFICIENT"
      && error.status === 402
      && error.retrySafe === true
      && error.outcome === "not-dispatched",
  );
  assert.equal(requests, 0);
});

test("saved API credential stays in main-process request and does not fall back to points", async () => {
  const requests = [];
  const execute = createWechatAssistantModelExecutor({
    runtimeInfo: {
      localApi: {
        coreServiceUrl: "https://core.example",
        baseUrl: "http://127.0.0.1:9876",
        authToken: "cache-token",
        localCacheAgent: true,
        profile: { profileId: "profile-1" },
      },
    },
    licenseRuntime: {
      getSession: async () => ({ user: { id: 7 } }),
      getProtectedComputeAccessToken: async () => "device-token",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("model-api-credentials")) return jsonResponse({
        account: {
          baseUrl: "https://byok.example/v1",
          discoveryVerified: true,
          availableModels: [{ id: "custom-model", capabilities: ["text-generation"] }],
        },
        credentials: { apiKey: "byok-secret" },
      });
      return jsonResponse({ ok: true, response: { choices: [{ message: { content: "ok" } }] }, billing: null });
    },
  });
  await execute({
    requestId: "wechat-request-2",
    settings: { modelSource: "saved-api", modelAccountId: "account-1", modelName: "custom-model" },
    payload: { model: "custom-model", messages: [{ role: "user", content: "你好" }], stream: false },
  });
  const coreBody = JSON.parse(requests[1].options.body);
  assert.equal(coreBody.byok.account_id, "account-1");
  assert.equal(coreBody.byok.api_key, "byok-secret");
  assert.equal(requests[1].url, "https://core.example/api/core-v2/openclaw/chat/completions");
});

test("network loss after dispatch is outcome-unknown and is never retried by the desktop", async () => {
  let requests = 0;
  const execute = createWechatAssistantModelExecutor({
    runtimeInfo: { localApi: { coreServiceUrl: "https://core.example" } },
    licenseRuntime: { getProtectedComputeAccessToken: async () => "device-token" },
    getPointsWallet: async () => ({ balancePoints: 10, reservedPoints: 0, availablePoints: 10 }),
    fetchImpl: async () => {
      requests += 1;
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    execute({
      requestId: "wechat-outcome-unknown",
      settings: { modelSource: "builtin-points", modelName: "gpt-5.6-terra" },
      payload: { model: "gpt-5.6-terra", messages: [{ role: "user", content: "你好" }] },
    }),
    (error) => error.code === "MODEL_CHANNEL_OUTCOME_UNKNOWN"
      && error.retrySafe === false
      && error.outcome === "unknown"
      && /不会自动重发/u.test(error.publicMessage),
  );
  assert.equal(requests, 1);
});

test("a missing OpenClaw core route is reported as a safe no-charge service notice", async () => {
  let requests = 0;
  const execute = createWechatAssistantModelExecutor({
    runtimeInfo: { localApi: { coreServiceUrl: "https://core.example" } },
    licenseRuntime: { getProtectedComputeAccessToken: async () => "device-token" },
    getPointsWallet: async () => ({ balancePoints: 10, reservedPoints: 0, availablePoints: 10 }),
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse({ detail: "Not Found" }, 404);
    },
  });
  await assert.rejects(
    execute({
      requestId: "wechat-route-missing",
      settings: { modelSource: "builtin-points", modelName: "gpt-5.6-terra" },
      payload: { model: "gpt-5.6-terra", messages: [{ role: "user", content: "汇总今日销售数据" }] },
    }),
    (error) => error.code === "OPENCLAW_CORE_ROUTE_UNAVAILABLE"
      && error.status === 409
      && error.retrySafe === true
      && error.outcome === "not-dispatched"
      && error.deliverAsAssistantNotice === true
      && /不会扣积分/u.test(error.publicMessage),
  );
  assert.equal(requests, 1);
});

test("an inactive points price is returned as a Chinese no-charge service notice", async () => {
  const execute = createWechatAssistantModelExecutor({
    runtimeInfo: { localApi: { coreServiceUrl: "https://core.example" } },
    licenseRuntime: { getProtectedComputeAccessToken: async () => "device-token" },
    getPointsWallet: async () => ({ balancePoints: 10, reservedPoints: 0, availablePoints: 10 }),
    fetchImpl: async () => jsonResponse({
      detail: {
        code: "MODEL_PRESET_RATE_UNAVAILABLE",
        message: "所选模型没有当前功能的有效积分价格",
      },
    }, 503),
  });
  await assert.rejects(
    execute({
      requestId: "wechat-rate-missing",
      settings: { modelSource: "builtin-points", modelName: "gpt-5.6-terra" },
      payload: { model: "gpt-5.6-terra", messages: [{ role: "user", content: "汇总今日销售数据" }] },
    }),
    (error) => error.code === "MODEL_POINTS_PRICE_UNAVAILABLE"
      && error.status === 409
      && error.retrySafe === true
      && error.outcome === "not-dispatched"
      && error.deliverAsAssistantNotice === true
      && /暂未启用积分价格/u.test(error.publicMessage)
      && /不会扣积分/u.test(error.publicMessage),
  );
});

test("a missing local saved-api credential is marked safe before model dispatch", async () => {
  const execute = createWechatAssistantModelExecutor({
    runtimeInfo: {
      localApi: {
        coreServiceUrl: "https://core.example",
        baseUrl: "http://127.0.0.1:9876",
        authToken: "cache-token",
        localCacheAgent: true,
        profile: { profileId: "profile-1" },
      },
    },
    licenseRuntime: {
      getSession: async () => ({ user: { id: 7 } }),
      getProtectedComputeAccessToken: async () => "device-token",
    },
    fetchImpl: async () => { throw new TypeError("local service unavailable"); },
  });
  await assert.rejects(
    execute({
      requestId: "wechat-byok-not-dispatched",
      settings: { modelSource: "saved-api", modelAccountId: "account-1", modelName: "custom-model" },
      payload: { model: "custom-model", messages: [{ role: "user", content: "你好" }] },
    }),
    (error) => error.code === "MODEL_API_CREDENTIAL_READ_FAILED"
      && error.retrySafe === true
      && error.outcome === "not-dispatched",
  );
});
