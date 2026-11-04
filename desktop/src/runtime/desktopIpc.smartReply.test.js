import assert from "node:assert/strict";
import test from "node:test";
import { syncSmartReplyShopFromLocalCache } from "./desktopIpc.js";

test("smart reply sync reads the bound local credential in Main and never returns its API key", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      credentials: { clientId: "4067587", apiKey: "private-local-ozon-key" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const requests = [];
  try {
    const result = await syncSmartReplyShopFromLocalCache({
      runtimeInfo: {
        localApi: {
          localCacheAgent: true,
          baseUrl: "http://127.0.0.1:3792",
          authToken: "cache-agent-token",
          profile: { profileId: "profile-a" },
        },
      },
      licenseRuntime: {
        getSession: async () => ({ user: { id: "user-a" } }),
        request: async (input) => {
          requests.push(input);
          return { ok: true, status: 200, data: { client_id: "4067587", configured: true } };
        },
      },
      input: { shopId: "local-shop-a", clientId: "4067587" },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:3792/v1/internal/shop-credentials/get");
    assert.equal(calls[0].options.headers["x-wangzai-cache-agent-token"], "cache-agent-token");
    assert.equal(calls[0].options.headers["x-wangzai-cache-scope"].length, 24);
    assert.deepEqual(requests, [{
      method: "POST",
      path: "/api/smart-reply/credentials",
      body: { client_id: "4067587", api_key: "private-local-ozon-key" },
    }]);
    assert.deepEqual(result, { ok: true, status: 200, data: { client_id: "4067587", configured: true } });
    assert.equal(JSON.stringify(result).includes("private-local-ozon-key"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("smart reply sync refuses a changed local shop identity before posting a credential", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    credentials: { clientId: "changed-client", apiKey: "private-local-ozon-key" },
  }), { status: 200, headers: { "content-type": "application/json" } });
  let posted = false;
  try {
    const result = await syncSmartReplyShopFromLocalCache({
      runtimeInfo: {
        localApi: {
          localCacheAgent: true,
          baseUrl: "http://127.0.0.1:3792",
          authToken: "cache-agent-token",
          profile: { profileId: "profile-a" },
        },
      },
      licenseRuntime: {
        getSession: async () => ({ user: { id: "user-a" } }),
        request: async () => {
          posted = true;
          return { ok: true };
        },
      },
      input: { shopId: "local-shop-a", clientId: "4067587" },
    });

    assert.equal(result.status, 409);
    assert.equal(posted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
