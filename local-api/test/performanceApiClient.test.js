import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlatformIntegrationTestErrorPayload,
  executePerformanceWriteAction,
  readPerformanceAdvancedReport,
  readPerformanceProductCandidates,
  readPerformanceRealtimeOverview,
  testPlatformIntegrationConnection,
} from "../src/integrations/performanceApiClient.js";

function createJsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: { "content-type": "application/json" },
  });
}

function createTextResponse(text, init = {}) {
  return new Response(text, {
    status: init.status || 200,
    headers: { "content-type": init.contentType || "text/csv; charset=utf-8" },
  });
}

test("Ozon Performance integration test requires credentials", async () => {
  await assert.rejects(
    () =>
      testPlatformIntegrationConnection(
        { type: "ozon-performance", values: {} },
        { fetchImpl: async () => createJsonResponse({}) },
      ),
    (error) => {
      assert.equal(error.code, "PERFORMANCE_CREDENTIALS_REQUIRED");
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test("Ozon Performance integration test runs token and read-only checks", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method,
      body: options.body,
      authorization: options.headers?.authorization,
    });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({ list: [{ id: "campaign-1" }], total: 1 });
    }
    if (url.endsWith("/api/client/statistics/list")) {
      return createJsonResponse({ items: [], total: 0 });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await testPlatformIntegrationConnection(
    {
      type: "ozon-performance",
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.auth.tokenType, "Bearer");
  assert.equal(payload.summary.campaignCount, 1);
  assert.equal(payload.summary.statisticsTaskCount, 0);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "GET", "GET"],
  );
  assert.equal(calls[1].authorization, "Bearer dummy-token-placeholder");
  assert.equal(calls[2].authorization, "Bearer dummy-token-placeholder");
});

test("Ozon Performance keeps one serial queue per account while different accounts run in parallel", async () => {
  const tokenClients = new Set();
  const activeByAccount = new Map();
  const maxActiveByAccount = new Map();
  let totalActive = 0;
  let maxTotalActive = 0;
  let releaseTokenBarrier;
  const tokenBarrier = new Promise((resolve) => {
    releaseTokenBarrier = resolve;
  });
  const fetchImpl = async (url, options = {}) => {
    const tokenBody = url.endsWith("/api/client/token")
      ? JSON.parse(options.body)
      : null;
    const account =
      tokenBody?.client_id ||
      String(options.headers?.authorization || "").replace(
        /^Bearer token-/u,
        "",
      );
    totalActive += 1;
    maxTotalActive = Math.max(maxTotalActive, totalActive);
    activeByAccount.set(account, (activeByAccount.get(account) || 0) + 1);
    maxActiveByAccount.set(
      account,
      Math.max(
        maxActiveByAccount.get(account) || 0,
        activeByAccount.get(account),
      ),
    );
    try {
      if (tokenBody) {
        tokenClients.add(tokenBody.client_id);
        if (tokenClients.size === 2) releaseTokenBarrier();
        await tokenBarrier;
        return createJsonResponse({
          access_token: `token-${tokenBody.client_id}`,
          token_type: "Bearer",
          expires_in: 1800,
        });
      }
      if (url.endsWith("/api/client/campaign"))
        return createJsonResponse({ list: [], total: 0 });
      if (url.endsWith("/api/client/statistics/list"))
        return createJsonResponse({ items: [], total: 0 });
      return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
    } finally {
      totalActive -= 1;
      activeByAccount.set(
        account,
        Math.max(0, (activeByAccount.get(account) || 0) - 1),
      );
    }
  };
  const connect = (accountId, clientId) =>
    testPlatformIntegrationConnection(
      {
        type: "ozon-performance",
        values: {
          accountId,
          performanceClientId: clientId,
          performanceClientSecret: `secret-${clientId}`,
        },
      },
      { fetchImpl },
    );

  const both = Promise.all([
    connect("account-a", "client-a"),
    connect("account-b", "client-b"),
  ]);
  await Promise.race([
    tokenBarrier,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "Performance accounts were serialized through one shared queue",
            ),
          ),
        120,
      ),
    ),
  ]);
  const results = await both;
  assert.equal(
    results.every((result) => result.ok),
    true,
  );
  assert.equal(maxTotalActive >= 2, true);
  assert.deepEqual(Object.fromEntries(maxActiveByAccount), {
    "client-a": 1,
    "client-b": 1,
  });
});

test("Ozon Performance integration error payload never exposes token or secret", async () => {
  const error = new Error("Performance Token 获取失败：invalid_client");
  error.code = "PERFORMANCE_TOKEN_FAILED";
  error.statusCode = 400;
  error.remoteStatus = 401;
  const payload = createPlatformIntegrationTestErrorPayload(error);
  const text = JSON.stringify(payload);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "PERFORMANCE_TOKEN_FAILED");
  assert.equal(text.includes("dummy-secret-placeholder"), false);
  assert.equal(text.includes("dummy-token-placeholder"), false);
});

test("Ozon Performance product candidates read direct pool and bid suggestions", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign/search_promo/v2/products")) {
      return createJsonResponse({
        products: [
          {
            sku: "111",
            title: "可投放商品",
            imageUrl: "https://example.test/111.jpg",
            price: "99.50",
            bid: "7000000",
            isSearchPromoAvailable: true,
          },
          {
            sku: "222",
            title: "不可投放商品",
            price: "10",
            isSearchPromoAvailable: false,
          },
        ],
        total: 2,
      });
    }
    if (url.endsWith("/api/client/search_promo/bids/recommendation")) {
      assert.deepEqual(JSON.parse(options.body), { skus: ["111", "222"] });
      return createJsonResponse({ bids: { 111: "12.5", 222: "9" } });
    }
    if (
      url.includes("/api/client/campaign/campaign-1/products/bids/competitive")
    ) {
      return createJsonResponse({ products: [{ sku: "111", bid: "15" }] });
    }
    if (url.endsWith("/api/client/search_promo/get_cpo_min_bids")) {
      assert.deepEqual(JSON.parse(options.body), { skus: ["111", "222"] });
      return createJsonResponse({ bids: { 111: "8.5", 222: "7" } });
    }
    if (url.endsWith("/api/client/min/sku")) {
      assert.deepEqual(JSON.parse(options.body), {
        marketplaceId: "RU",
        paymentType: "CPC",
        sku: ["111", "222"],
      });
      return createJsonResponse({ minBids: [{ sku: "111", bid: 6.5 }] });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await readPerformanceProductCandidates(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        campaignId: "campaign-1",
        page: 1,
        pageSize: 80,
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.cache.enabled, false);
  assert.equal(payload.cache.fallback, false);
  assert.equal(payload.total, 2);
  assert.equal(payload.hasNext, false);
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.rows[0].sku, "111");
  assert.equal(payload.rows[0].title, "可投放商品");
  assert.equal(payload.rows[0].bid, 7);
  assert.equal(payload.rows[0].recommendedBid, "12.5");
  assert.equal(payload.rows[0].competitiveBid, 15);
  assert.equal(payload.rows[0].minCpoBid, "8.5");
  assert.equal(payload.rows[0].minimumCpcBid, 6.5);
  assert.equal(payload.rows[1].available, false);
  assert.equal(payload.rows[1].statusLabel, "不可投放");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "POST", "POST", "GET", "POST", "POST"],
  );
  assert.deepEqual(JSON.parse(calls[1].body), { page: 1, pageSize: 80 });
});

test("Ozon Performance exposes every current advanced report through its official endpoint", async () => {
  const cases = [
    ["allSkuOrders", "/api/client/statistics/all_sku_promo/orders/generate/json", "GET"],
    ["allSkuProducts", "/api/client/statistics/all_sku_promo/products/generate/json", "GET"],
    ["phrases", "/api/client/statistics/phrases/json", "POST"],
    ["attribution", "/api/client/statistics/attribution/json", "POST"],
    ["video", "/api/client/statistics/video/json", "POST"],
    ["vendorTraffic", "/api/client/vendors/statistics", "POST"],
    ["vendorOrders", "/api/client/vendors/statistics", "POST"],
  ];
  for (const [reportKind, expectedPath, expectedMethod] of cases) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({
        path: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams.entries()),
        method: String(options.method || "GET").toUpperCase(),
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      if (parsed.pathname === "/api/client/token") {
        return createJsonResponse({ access_token: `token-${reportKind}`, expires_in: 1800 });
      }
      if (parsed.pathname === "/api/client/campaign") {
        const campaign = reportKind === "phrases"
          ? {
              id: "campaign-1",
              advObjectType: "SKU",
              paymentType: "CPC",
              placement: "PLACEMENT_TOP_PROMOTION",
            }
          : reportKind === "attribution"
            ? { id: "campaign-1", advObjectType: "BANNER" }
            : { id: "campaign-1", advObjectType: "VIDEO_BANNER" };
        return createJsonResponse({ list: [campaign], total: 1 });
      }
      if (parsed.pathname === expectedPath) return createJsonResponse({ rows: [{ reportKind, value: 1 }] });
      return createJsonResponse({ error: "unexpected endpoint" }, { status: 404 });
    };
    const result = await readPerformanceAdvancedReport(
      {
        values: {
          accountId: `advanced-${reportKind}`,
          performanceClientId: `client-${reportKind}`,
          performanceClientSecret: "secret",
          reportKind,
          campaignIds: ["campaign-1"],
          dateFrom: "2026-08-01",
          dateTo: "2026-08-24",
        },
      },
      { fetchImpl },
    );
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1);
    const reportCall = calls.find((call) => call.path === expectedPath);
    assert.ok(reportCall);
    assert.equal(reportCall.method, expectedMethod);
    if (["allSkuOrders", "allSkuProducts"].includes(reportKind)) {
      assert.equal(reportCall.query["timeBounds.from"], "2026-08-01T00:00:00Z");
      assert.equal(reportCall.query["timeBounds.to"], "2026-08-24T23:59:59Z");
    }
    if (reportKind === "vendorTraffic") assert.equal(reportCall.body.type, "TRAFFIC_SOURCES");
    if (reportKind === "vendorOrders") assert.equal(reportCall.body.type, "ORDERS");
  }
});

test("advanced campaign reports filter campaign types and split Ozon's ten-campaign limit", async () => {
  const calls = [];
  const campaigns = Array.from({ length: 25 }, (_, index) => ({
    id: `campaign-${index + 1}`,
    advObjectType: "SKU",
    paymentType: "CPC",
    placement: "PLACEMENT_TOP_PROMOTION",
  }));
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: parsed.pathname, body });
    if (parsed.pathname === "/api/client/token") {
      return createJsonResponse({ access_token: "batch-token", expires_in: 1800 });
    }
    if (parsed.pathname === "/api/client/campaign") {
      return createJsonResponse({ list: campaigns, total: campaigns.length });
    }
    if (parsed.pathname === "/api/client/statistics/phrases/json") {
      return createJsonResponse({
        rows: body.campaigns.map((campaignId) => ({ campaignId, phrase: `词-${campaignId}` })),
      });
    }
    return createJsonResponse({ error: "unexpected endpoint" }, { status: 404 });
  };
  const result = await readPerformanceAdvancedReport(
    {
      values: {
        accountId: "advanced-batches",
        performanceClientId: "client-batches",
        performanceClientSecret: "secret",
        reportKind: "phrases",
        campaignIds: campaigns.map((campaign) => campaign.id),
        dateFrom: "2026-08-18",
        dateTo: "2026-08-24",
      },
    },
    { fetchImpl },
  );
  const reportCalls = calls.filter((call) => call.path === "/api/client/statistics/phrases/json");
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 25);
  assert.equal(result.batchCount, 3);
  assert.deepEqual(reportCalls.map((call) => call.body.campaigns.length), [10, 10, 5]);
});

test("advanced campaign reports return a clear empty result when the account has no applicable campaign", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname === "/api/client/token") {
      return createJsonResponse({ access_token: "empty-token", expires_in: 1800 });
    }
    if (parsed.pathname === "/api/client/campaign") {
      return createJsonResponse({
        list: [{ id: "sku-campaign", advObjectType: "SKU", placement: "PLACEMENT_SEARCH_AND_CATEGORY" }],
        total: 1,
      });
    }
    return createJsonResponse({ error: "report endpoint must not be called" }, { status: 500 });
  };
  const result = await readPerformanceAdvancedReport(
    {
      values: {
        accountId: "advanced-empty",
        performanceClientId: "client-empty",
        performanceClientSecret: "secret",
        reportKind: "video",
        campaignIds: ["sku-campaign"],
        dateFrom: "2026-08-18",
        dateTo: "2026-08-24",
      },
    },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, []);
  assert.match(result.message, /没有视频广告计划/u);
  assert.deepEqual(calls, ["/api/client/token", "/api/client/campaign"]);
});

test("vendor reports poll the vendor task endpoint and parse the official CSV", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      method: String(options.method || "GET").toUpperCase(),
    });
    if (parsed.pathname === "/api/client/token") {
      return createJsonResponse({ access_token: "vendor-token", expires_in: 1800 });
    }
    if (parsed.pathname === "/api/client/vendors/statistics") {
      return createJsonResponse({ UUID: "vendor-task-1" });
    }
    if (parsed.pathname === "/api/client/vendors/statistics/vendor-task-1") {
      return createJsonResponse({ state: "OK", link: "/reports/vendor-task-1.csv" });
    }
    if (parsed.pathname === "/reports/vendor-task-1.csv") {
      return createTextResponse("来源;访问量;订单\r\n站外广告;12;3\r\n");
    }
    return createJsonResponse({ error: "unexpected endpoint" }, { status: 404 });
  };
  const result = await readPerformanceAdvancedReport(
    {
      values: {
        accountId: "advanced-vendor",
        performanceClientId: "client-vendor",
        performanceClientSecret: "secret",
        reportKind: "vendorTraffic",
        dateFrom: "2026-08-18",
        dateTo: "2026-08-24",
      },
    },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [{ 来源: "站外广告", 访问量: "12", 订单: "3" }]);
  const statusCall = calls.find((call) => call.path === "/api/client/vendors/statistics/vendor-task-1");
  assert.deepEqual(statusCall.query, { vendor: "true" });
});

test("advanced report generation keeps the complete Ozon task lifecycle serial per account", async () => {
  const calls = [];
  let activeTask = "";
  let taskSequence = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname === "/api/client/token") {
      return createJsonResponse({ access_token: "lifecycle-token", expires_in: 1800 });
    }
    if (parsed.pathname.includes("/generate/json")) {
      if (activeTask) {
        return createJsonResponse(
          { message: "Превышен лимит активных запросов (максимум 1)" },
          { status: 429 },
        );
      }
      taskSequence += 1;
      activeTask = `task-${taskSequence}`;
      return createJsonResponse({ UUID: activeTask });
    }
    if (parsed.pathname === `/api/client/statistics/${activeTask}`) {
      return createJsonResponse({ state: "OK", link: `/reports/${activeTask}.json` });
    }
    if (parsed.pathname === `/reports/${activeTask}.json`) {
      const completedTask = activeTask;
      activeTask = "";
      return createJsonResponse({ rows: [{ task: completedTask }] });
    }
    return createJsonResponse({ error: "unexpected endpoint" }, { status: 404 });
  };
  const baseValues = {
    accountId: "advanced-lifecycle",
    performanceClientId: "client-lifecycle",
    performanceClientSecret: "secret",
    dateFrom: "2026-08-18",
    dateTo: "2026-08-24",
  };
  const [orders, products] = await Promise.all([
    readPerformanceAdvancedReport(
      { values: { ...baseValues, reportKind: "allSkuOrders" } },
      { fetchImpl },
    ),
    readPerformanceAdvancedReport(
      { values: { ...baseValues, reportKind: "allSkuProducts" } },
      { fetchImpl },
    ),
  ]);
  assert.equal(orders.ok, true);
  assert.equal(products.ok, true);
  assert.deepEqual(orders.rows, [{ task: "task-1" }]);
  assert.deepEqual(products.rows, [{ task: "task-2" }]);
  assert.equal(taskSequence, 2);
  assert.equal(calls.filter((path) => path.includes("/generate/json")).length, 2);
});

test("Ozon Performance realtime overview reads direct data and records alerts", async () => {
  const calls = [];
  const notifications = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-budget",
            title: "预算测试计划",
            status: "BUDGET_EXHAUSTED",
            budget: 100_000_000,
            spent: 100,
            clicks: 3,
          },
          {
            id: "campaign-review",
            title: "审核测试计划",
            status: "REJECTED",
            rejectReason: "not approved",
          },
        ],
        total: 2,
      });
    }
    if (url.includes("/api/client/campaign/campaign-budget/v2/products")) {
      return createJsonResponse({
        products: [
          {
            sku: "123",
            title: "推广商品",
            bid: "10",
            status: "ACTIVE",
          },
        ],
      });
    }
    if (url.includes("/api/client/campaign/campaign-review/v2/products")) {
      return createJsonResponse({ products: [] });
    }
    if (url.includes("/api/client/campaign/campaign-budget/objects")) {
      return createJsonResponse({
        objects: [
          { id: "object-1", sku: "123", type: "SKU", status: "ACTIVE" },
        ],
      });
    }
    if (url.includes("/api/client/campaign/campaign-review/objects")) {
      return createJsonResponse({ objects: [] });
    }
    if (url.includes("/api/client/statistics/daily/json")) {
      return createJsonResponse({
        rows: [
          {
            campaignId: "campaign-budget",
            date: "2026-07-01",
            impressions: 10,
            clicks: 3,
            spent: 100,
            orders: 1,
            revenue: 200,
          },
        ],
      });
    }
    if (url.includes("/api/client/statistics/campaign/product/json")) {
      return createJsonResponse({
        rows: [
          {
            campaignId: "campaign-budget",
            sku: "123",
            impressions: 10,
            clicks: 3,
            spent: 100,
            orders: 1,
            revenue: 200,
          },
        ],
      });
    }
    if (url.includes("/api/client/statistics/expense")) {
      return createJsonResponse({
        rows: [
          {
            campaignId: "campaign-budget",
            date: "2026-07-01",
            spent: 100,
          },
        ],
      });
    }
    if (url.includes("/api/client/statistics/campaign/media")) {
      return createJsonResponse({
        rows: [
          {
            campaignId: "campaign-budget",
            date: "2026-07-01",
            views: 20,
            clicks: 2,
            spent: 30,
            mediaType: "banner",
          },
        ],
      });
    }
    if (url.endsWith("/api/client/statistics/list")) {
      return createJsonResponse({ items: [{ UUID: "report-1" }], total: 1 });
    }
    if (url.endsWith("/api/client/statistics/externallist")) {
      return createJsonResponse({
        items: [{ UUID: "external-report-1" }],
        total: 1,
      });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };
  const notificationService = {
    recordNotification(input) {
      notifications.push(input);
      return { id: `notification-${notifications.length}` };
    },
  };

  const payload = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        shopId: "ozon-shop-1",
        shopName: "Ozon 1店",
      },
    },
    { fetchImpl, notificationService },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.cache.enabled, false);
  assert.equal(payload.summary.total, 2);
  assert.equal(payload.summary.budgetExhausted, 1);
  assert.equal(payload.summary.reviewFailed, 1);
  assert.equal(payload.summary.productCount, 1);
  assert.equal(payload.summary.ctr, 30);
  assert.equal(payload.summary.cpc, 33.33);
  assert.equal(payload.summary.roi, 2);
  assert.equal(payload.campaigns[0].budget, 100);
  assert.equal(payload.campaigns[0].type, "未返回类型");
  assert.equal(payload.campaigns[0].products[0].title, "推广商品");
  assert.equal(payload.campaigns[0].objects.length, 1);
  assert.equal(payload.campaigns[0].statistics.roas, 2);
  assert.equal(payload.campaigns[0].statistics.ctr, 30);
  assert.equal(payload.campaigns[0].statistics.cpc, 33.33);
  assert.equal(payload.campaigns[0].products[0].ctr, 30);
  assert.equal(payload.campaigns[0].products[0].cpc, 33.33);
  assert.equal(payload.dailyTrend.length, 1);
  assert.equal(payload.dailyTrend[0].ctr, 30);
  assert.equal(payload.products.length, 1);
  assert.equal(payload.mediaStats.length, 1);
  assert.equal(payload.externalReports.length, 1);
  assert.equal(payload.readIssues.length, 0);
  assert.equal(payload.notifications.recorded, 2);
  assert.deepEqual(
    notifications.map((item) => item.eventType),
    ["performance_budget_exhausted", "performance_moderation_rejected"],
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(
    calls.some(
      (call) =>
        call.url.includes("/statistics/products/sku") && call.method === "POST",
    ),
    true,
  );
  assert.equal(calls.filter((call) => call.method === "POST").length, 2);
});

test("Ozon Performance realtime overview serializes requests and polls async statistics fallback", async () => {
  const calls = [];
  let productAttempts = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-async",
            title: "异步统计计划",
            status: "CAMPAIGN_STATE_RUNNING",
          },
        ],
        total: 1,
      });
    }
    if (url.includes("/api/client/campaign/campaign-async/v2/products")) {
      productAttempts += 1;
      if (productAttempts === 1) {
        return createJsonResponse(
          { error: "Превышен лимит активных запросов (максимум 1)" },
          { status: 429 },
        );
      }
      return createJsonResponse({
        products: [{ sku: "789", title: "异步统计商品", bid: "11" }],
      });
    }
    if (url.includes("/api/client/campaign/campaign-async/objects")) {
      return createJsonResponse({
        objects: [{ id: "object-async", sku: "789", type: "SKU" }],
      });
    }
    if (url.includes("/api/client/statistics/daily/json")) {
      return createJsonResponse({ error: "not ready" }, { status: 404 });
    }
    if (url.includes("/api/client/statistics/campaign/product/json")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/expense")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/campaign/media")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.endsWith("/api/client/statistics/json")) {
      return createJsonResponse({ UUID: "report-async-1" });
    }
    if (url.endsWith("/api/client/statistics/report-async-1")) {
      return createJsonResponse({
        UUID: "report-async-1",
        state: "OK",
        link: "/api/client/statistics/report?UUID=report-async-1",
      });
    }
    if (url.includes("/api/client/statistics/report?UUID=report-async-1")) {
      return createJsonResponse({
        rows: [
          {
            campaignId: "campaign-async",
            date: "2026-07-01",
            impressions: 100,
            clicks: 10,
            spent: 50,
            orders: 2,
            revenue: 250,
          },
        ],
      });
    }
    if (url.endsWith("/api/client/statistics/list")) {
      return createJsonResponse({ items: [{ UUID: "report-async-1" }] });
    }
    if (url.endsWith("/api/client/statistics/externallist")) {
      return createJsonResponse({ items: [] });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        shopId: "ozon-shop-1",
        shopName: "Ozon 1店",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-07",
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.requestPolicy.mode, "per-account-single-concurrency");
  assert.equal(payload.statisticsReport.ok, true);
  assert.equal(payload.statisticsReport.task.uuid, "report-async-1");
  assert.equal(payload.summary.total, 1);
  assert.equal(payload.summary.spent, 50);
  assert.equal(payload.summary.revenue, 250);
  assert.equal(payload.summary.ctr, 10);
  assert.equal(payload.summary.cpc, 5);
  assert.equal(payload.campaigns[0].statistics.roas, 5);
  assert.equal(payload.campaigns[0].statistics.ctr, 10);
  assert.equal(payload.campaigns[0].products[0].title, "异步统计商品");
  assert.equal(productAttempts, 2);
  assert.equal(calls[0].method, "POST");
  assert.equal(
    calls.some(
      (call) =>
        call.url.endsWith("/api/client/statistics/json") &&
        call.method === "POST",
    ),
    true,
  );
  assert.equal(
    calls.every((call) => ["GET", "POST"].includes(call.method)),
    true,
  );
});

test("Ozon Performance write action returns preview without confirmation", async () => {
  const calls = [];
  const payload = await executePerformanceWriteAction(
    {
      action: "updateBudget",
      payload: {
        campaignId: "campaign-1",
        budgetKind: "weeklyBudget",
        budgetRubles: "2000.34",
      },
    },
    {
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method });
        return createJsonResponse({});
      },
    },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.executed, false);
  assert.equal(payload.preview, true);
  assert.equal(payload.request.method, "PATCH");
  assert.equal(payload.request.body.weeklyBudget, "2000340000");
  assert.equal(calls.length, 0);
});

test("Ozon Performance rejects a CPC weekly budget below 2000 rubles per SKU before any remote write", async () => {
  await assert.rejects(
    () =>
      executePerformanceWriteAction({
        action: "updateBudget",
        payload: {
          campaignId: "campaign-budget-minimum",
          budgetKind: "weeklyBudget",
          budgetRubles: "3999",
          campaignProductCount: 2,
          paymentType: "CPC",
        },
      }),
    (error) => {
      assert.equal(error.code, "PERFORMANCE_WRITE_VALIDATION_FAILED");
      assert.match(error.message, /当前 2 个商品至少需要 4000 卢布/u);
      return true;
    },
  );

  const minimumPreview = await executePerformanceWriteAction({
    action: "updateBudget",
    payload: {
      campaignId: "campaign-budget-minimum",
      budgetKind: "weeklyBudget",
      budgetRubles: "4000",
      campaignProductCount: 2,
      paymentType: "CPC",
    },
  });
  assert.equal(minimumPreview.request.body.weeklyBudget, "4000000000");

  const unlimitedPreview = await executePerformanceWriteAction({
    action: "updateBudget",
    payload: {
      campaignId: "campaign-budget-minimum",
      budgetKind: "weeklyBudget",
      budgetRubles: "0",
      campaignProductCount: 2,
      paymentType: "CPC",
    },
  });
  assert.equal(unlimitedPreview.request.body.weeklyBudget, "0");
});

test("Ozon Performance write action executes confirmed budget update", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method,
      body: options.body,
      authorization: options.headers?.authorization,
    });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign/campaign-1")) {
      return createJsonResponse({ campaignId: "campaign-1" });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-1",
            title: "预算计划",
            weeklyBudget: "2000000000",
            state: "CAMPAIGN_STATE_RUNNING",
          },
        ],
      });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await executePerformanceWriteAction(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
      },
      action: "updateBudget",
      confirmWrite: true,
      confirmationCode: "EXECUTE_OZON_PERFORMANCE_WRITE",
      payload: {
        campaignId: "campaign-1",
        budgetKind: "weeklyBudget",
        budgetRubles: "2000",
      },
    },
    { fetchImpl, writeReadbackDelaysMs: [0] },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.executed, true);
  assert.equal(payload.request.endpoint, "/api/client/campaign/campaign-1");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "PATCH", "GET"],
  );
  assert.equal(calls[1].authorization, "Bearer dummy-token-placeholder");
  assert.deepEqual(JSON.parse(calls[1].body), { weeklyBudget: "2000000000" });
  assert.equal(payload.readback.confirmed, true);
});

test("Ozon Performance write action executes confirmed add products", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method,
      body: options.body,
      authorization: options.headers?.authorization,
    });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign/campaign-1/products")) {
      return createJsonResponse({ result: [{ sku: "123", update: true }] });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-1",
            title: "商品计划",
            advObjectType: "SKU",
            state: "CAMPAIGN_STATE_RUNNING",
          },
        ],
      });
    }
    if (url.includes("/api/client/campaign/campaign-1/v2/products")) {
      return createJsonResponse({
        list: [
          { sku: "123", bid: "10", targetCir: 15 },
          { sku: "456", bid: "12" },
        ],
        total: 2,
      });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await executePerformanceWriteAction(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
      },
      action: "addProducts",
      confirmWrite: true,
      confirmationCode: "EXECUTE_OZON_PERFORMANCE_WRITE",
      payload: {
        campaignId: "campaign-1",
        bids: [
          { sku: "123", bid: "10", targetCir: "15" },
          { sku: "456", bid: "12" },
        ],
      },
    },
    { fetchImpl, writeReadbackDelaysMs: [0] },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.executed, true);
  assert.equal(payload.request.method, "POST");
  assert.equal(
    payload.request.endpoint,
    "/api/client/campaign/campaign-1/products",
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "POST", "GET", "GET"],
  );
  assert.equal(calls[1].authorization, "Bearer dummy-token-placeholder");
  assert.deepEqual(JSON.parse(calls[1].body), {
    bids: [
      { sku: "123", targetCir: 15 },
      { sku: "456", bid: "12000000" },
    ],
  });
  assert.equal(payload.readback.confirmed, true);
});

test("Ozon Performance write action executes confirmed remove products", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method,
      body: options.body,
      authorization: options.headers?.authorization,
    });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign/campaign-1/products/delete")) {
      return createJsonResponse({ result: [{ sku: "123", deleted: true }] });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-1",
            title: "商品计划",
            advObjectType: "SKU",
            state: "CAMPAIGN_STATE_RUNNING",
          },
        ],
      });
    }
    if (url.includes("/api/client/campaign/campaign-1/v2/products")) {
      return createJsonResponse({ list: [{ sku: "999", bid: "8" }], total: 1 });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await executePerformanceWriteAction(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
      },
      action: "removeProducts",
      confirmWrite: true,
      confirmationCode: "EXECUTE_OZON_PERFORMANCE_WRITE",
      payload: {
        campaignId: "campaign-1",
        skus: ["123", "456", "123"],
      },
    },
    { fetchImpl, writeReadbackDelaysMs: [0] },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.executed, true);
  assert.equal(payload.request.method, "POST");
  assert.equal(
    payload.request.endpoint,
    "/api/client/campaign/campaign-1/products/delete",
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "POST", "GET", "GET"],
  );
  assert.equal(calls[1].authorization, "Bearer dummy-token-placeholder");
  assert.deepEqual(JSON.parse(calls[1].body), {
    sku: ["123", "456"],
  });
  assert.equal(payload.readback.confirmed, true);
});

test("Ozon Performance write action builds advanced campaign and search promo requests", async () => {
  const editPreview = await executePerformanceWriteAction({
    action: "editCampaign",
    payload: {
      campaignId: "campaign-1",
      title: "新计划名称",
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
      weeklyBudgetRubles: "2000",
      placement: "PLACEMENT_SEARCH_AND_CATEGORY",
      productAutopilotStrategy: "MAX_CLICKS",
    },
  });
  assert.equal(editPreview.preview, true);
  assert.equal(editPreview.request.method, "PATCH");
  assert.equal(editPreview.request.endpoint, "/api/client/campaign/campaign-1");
  assert.deepEqual(editPreview.request.body, {
    fromDate: "2026-07-01",
    toDate: "2026-07-31",
  });

  await assert.rejects(
    () =>
      executePerformanceWriteAction({
        action: "createCampaign",
        payload: {
          createMode: "genericCampaign",
          title: "通用计划",
          advObjectType: "SEARCH_PROMO",
          paymentType: "CPO",
        },
      }),
    (error) => error?.code === "PERFORMANCE_WRITE_VALIDATION_FAILED",
  );

  const searchBidPreview = await executePerformanceWriteAction({
    action: "setSearchPromoBids",
    payload: {
      bids: [
        { sku: "123", bid: "10" },
        { sku: "456", bid: "15" },
      ],
    },
  });
  assert.equal(
    searchBidPreview.request.endpoint,
    "/api/client/campaign/search_promo/v2/bids/set",
  );
  assert.deepEqual(searchBidPreview.request.body, {
    bids: [
      { sku: "123", bid: 10 },
      { sku: "456", bid: 15 },
    ],
  });

  const deleteSearchBidPreview = await executePerformanceWriteAction({
    action: "deleteSearchPromoBids",
    payload: { skus: ["123", "456", "123"] },
  });
  assert.equal(
    deleteSearchBidPreview.request.endpoint,
    "/api/client/campaign/search_promo/v2/bids/delete",
  );
  assert.deepEqual(deleteSearchBidPreview.request.body, {
    sku: ["123", "456"],
  });

  const enableSearchPromoPreview = await executePerformanceWriteAction({
    action: "toggleSearchPromoProduct",
    payload: { mode: "enable", skus: ["123", "456"] },
  });
  assert.equal(
    enableSearchPromoPreview.request.endpoint,
    "/api/client/search_promo/product/enable",
  );
  assert.deepEqual(enableSearchPromoPreview.request.body, {
    skus: ["123", "456"],
  });
});

test("Ozon Performance executes and precisely reads back all ten plan operations", async () => {
  const baseCampaign = {
    id: "campaign-9",
    title: "原计划",
    advObjectType: "SKU",
    state: "CAMPAIGN_STATE_RUNNING",
  };
  const scenarios = [
    {
      action: "createCampaign",
      payload: {
        title: "新建计划",
        placement: "PLACEMENT_SEARCH_AND_CATEGORY",
        productAutopilotStrategy: "MAX_CLICKS",
      },
      method: "POST",
      endpoint: "/api/client/campaign/cpc/v2/product",
      writeResponse: { result: [{ update: true }] },
      campaign: {
        ...baseCampaign,
        id: "created-campaign-10",
        title: "新建计划",
        placement: "PLACEMENT_SEARCH_AND_CATEGORY",
        productAutopilotStrategy: "MAX_CLICKS",
      },
    },
    {
      action: "editCampaign",
      payload: {
        campaignId: "campaign-9",
        title: "新计划",
        fromDate: "2026-08-18",
        toDate: "2026-08-31",
        placement: "PLACEMENT_SEARCH_AND_CATEGORY",
        productAutopilotStrategy: "MAX_CLICKS",
      },
      method: "PATCH",
      endpoint: "/api/client/campaign/campaign-9",
      campaign: {
        ...baseCampaign,
        title: "新计划",
        fromDate: "2026-08-18",
        toDate: "2026-08-31",
        placement: "PLACEMENT_SEARCH_AND_CATEGORY",
        productAutopilotStrategy: "MAX_CLICKS",
      },
    },
    {
      action: "addProducts",
      payload: {
        campaignId: "campaign-9",
        bids: [{ sku: "SKU-1", bid: "11" }],
      },
      method: "POST",
      endpoint: "/api/client/campaign/campaign-9/products",
      products: [{ sku: "SKU-1", bid: "11" }],
    },
    {
      action: "updateBudget",
      payload: {
        campaignId: "campaign-9",
        budgetKind: "weeklyBudget",
        budgetRubles: "2000",
      },
      method: "PATCH",
      endpoint: "/api/client/campaign/campaign-9",
      campaign: { ...baseCampaign, weeklyBudget: "2000000000" },
    },
    {
      action: "setProductBids",
      payload: {
        campaignId: "campaign-9",
        bids: [{ sku: "SKU-1", bid: "17.5" }],
      },
      method: "PUT",
      endpoint: "/api/client/campaign/campaign-9/products",
      products: [{ sku: "SKU-1", bid: "17.5" }],
    },
    {
      action: "removeProducts",
      payload: { campaignId: "campaign-9", skus: ["SKU-1"] },
      method: "POST",
      endpoint: "/api/client/campaign/campaign-9/products/delete",
      products: [{ sku: "SKU-OTHER", bid: "8" }],
    },
    {
      action: "setSearchPromoBids",
      payload: { bids: [{ sku: "SEARCH-1", bid: "14" }] },
      method: "POST",
      endpoint: "/api/client/campaign/search_promo/v2/bids/set",
      searchProducts: [{ sku: "SEARCH-1", bid: "14" }],
    },
    {
      action: "deleteSearchPromoBids",
      payload: { skus: ["SEARCH-1"] },
      method: "POST",
      endpoint: "/api/client/campaign/search_promo/v2/bids/delete",
      searchProducts: [{ sku: "SEARCH-1" }],
    },
    {
      action: "toggleSearchPromoProduct",
      payload: { mode: "enable", skus: ["SEARCH-1"] },
      method: "POST",
      endpoint: "/api/client/search_promo/product/enable",
      writeResponse: { result: [{ sku: "SEARCH-1", update: true }] },
      searchProducts: [{ sku: "SEARCH-1", enabled: true }],
    },
    {
      action: "toggleCampaign",
      payload: { campaignId: "campaign-9", mode: "deactivate" },
      method: "POST",
      endpoint: "/api/client/campaign/campaign-9/deactivate",
      campaign: { ...baseCampaign, state: "CAMPAIGN_STATE_INACTIVE" },
    },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({
        path: parsed.pathname,
        method: options.method,
        body: options.body,
      });
      if (parsed.pathname === "/api/client/token") {
        return createJsonResponse({
          access_token: `token-${scenario.action}`,
          token_type: "Bearer",
          expires_in: 1800,
        });
      }
      if (
        parsed.pathname === scenario.endpoint &&
        options.method === scenario.method
      ) {
        return createJsonResponse(
          scenario.writeResponse || { result: [{ update: true }] },
        );
      }
      if (
        parsed.pathname === "/api/client/campaign" &&
        options.method === "GET"
      ) {
        return createJsonResponse({
          list: [scenario.campaign || baseCampaign],
        });
      }
      if (
        parsed.pathname === "/api/client/campaign/campaign-9/v2/products" &&
        options.method === "GET"
      ) {
        return createJsonResponse({
          list: scenario.products || [],
          total: (scenario.products || []).length,
        });
      }
      if (
        parsed.pathname === "/api/client/campaign/search_promo/v2/products" &&
        options.method === "POST"
      ) {
        return createJsonResponse({
          list: scenario.searchProducts || [],
          total: (scenario.searchProducts || []).length,
        });
      }
      return createJsonResponse(
        { error: `unexpected ${options.method} ${parsed.pathname}` },
        { status: 404 },
      );
    };

    const result = await executePerformanceWriteAction(
      {
        values: {
          performanceClientId: `unit-${scenario.action}@advertising.performance.ozon.ru`,
          performanceClientSecret: "dummy-secret-placeholder",
        },
        action: scenario.action,
        confirmWrite: true,
        confirmationCode: "EXECUTE_OZON_PERFORMANCE_WRITE",
        payload: scenario.payload,
      },
      { fetchImpl, writeReadbackDelaysMs: [0] },
    );

    assert.equal(result.executed, true, scenario.action);
    assert.equal(result.request.endpoint, scenario.endpoint, scenario.action);
    assert.equal(result.request.method, scenario.method, scenario.action);
    assert.equal(
      result.readback.confirmed,
      true,
      `${scenario.action}: ${JSON.stringify(result.readback)}`,
    );
    assert.equal(
      calls.some(
        (call) =>
          call.path === scenario.endpoint && call.method === scenario.method,
      ),
      true,
      scenario.action,
    );
    if (scenario.action === "createCampaign") {
      assert.equal(result.readback.actual.campaignId, "created-campaign-10");
    }
  }
});

test("Ozon Performance executes and confirms all three account-wide promotion operations", async () => {
  const scenarios = [
    {
      action: "toggleAllSkuPromo",
      payload: { mode: "activate" },
      method: "GET",
      endpoint: "/api/client/campaign/all_sku_promo/activate",
      writeResponse: { update: true },
    },
    {
      action: "setAllSkuPromoBid",
      payload: { bid: "7" },
      method: "GET",
      endpoint: "/api/client/campaign/all_sku_promo/set_bid",
      query: { bid: "7" },
      writeResponse: { selectedBid: 7 },
    },
    {
      action: "toggleCarrots",
      payload: { mode: "enable", skus: ["SKU-CARROT"] },
      method: "POST",
      endpoint: "/api/client/campaign/search_promo/carrots/enable",
      writeResponse: {
        skuToInfo: { "SKU-CARROT": { isDisabled: false } },
      },
    },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const parsed = new URL(url);
      calls.push({
        path: parsed.pathname,
        method: options.method,
        query: Object.fromEntries(parsed.searchParams.entries()),
      });
      if (parsed.pathname === "/api/client/token") {
        return createJsonResponse({
          access_token: `token-${scenario.action}`,
          token_type: "Bearer",
          expires_in: 1800,
        });
      }
      if (
        parsed.pathname === scenario.endpoint &&
        options.method === scenario.method
      ) {
        return createJsonResponse(scenario.writeResponse);
      }
      return createJsonResponse(
        { error: `unexpected ${options.method} ${parsed.pathname}` },
        { status: 404 },
      );
    };

    const result = await executePerformanceWriteAction(
      {
        values: {
          performanceClientId: `unit-${scenario.action}@advertising.performance.ozon.ru`,
          performanceClientSecret: "dummy-secret-placeholder",
        },
        action: scenario.action,
        confirmWrite: true,
        confirmationCode: "EXECUTE_OZON_PERFORMANCE_WRITE",
        payload: scenario.payload,
      },
      { fetchImpl, writeReadbackDelaysMs: [0] },
    );

    assert.equal(result.executed, true, scenario.action);
    assert.equal(result.request.endpoint, scenario.endpoint, scenario.action);
    assert.equal(result.request.method, scenario.method, scenario.action);
    assert.equal(
      result.readback.confirmed,
      true,
      `${scenario.action}: ${JSON.stringify(result.readback)}`,
    );
    const writeCall = calls.find(
      (call) =>
        call.path === scenario.endpoint && call.method === scenario.method,
    );
    assert.ok(writeCall, scenario.action);
    if (scenario.query) assert.deepEqual(writeCall.query, scenario.query);
  }
});

test("Ozon Performance retries readback until the exact submitted bid appears", async () => {
  let productReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/client/token") {
      return createJsonResponse({
        access_token: "retry-token",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (
      parsed.pathname === "/api/client/campaign/retry-plan/products" &&
      options.method === "PUT"
    ) {
      return createJsonResponse({
        result: [{ sku: "SKU-RETRY", update: true }],
      });
    }
    if (
      parsed.pathname === "/api/client/campaign" &&
      options.method === "GET"
    ) {
      return createJsonResponse({
        list: [
          {
            id: "retry-plan",
            title: "重试计划",
            advObjectType: "SKU",
            state: "CAMPAIGN_STATE_RUNNING",
          },
        ],
      });
    }
    if (
      parsed.pathname === "/api/client/campaign/retry-plan/v2/products" &&
      options.method === "GET"
    ) {
      productReads += 1;
      return createJsonResponse({
        list: [{ sku: "SKU-RETRY", bid: productReads === 1 ? "10" : "20" }],
        total: 1,
      });
    }
    return createJsonResponse(
      { error: "unexpected endpoint" },
      { status: 404 },
    );
  };

  const result = await executePerformanceWriteAction(
    {
      values: {
        performanceClientId:
          "unit-readback-retry@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
      },
      action: "setProductBids",
      confirmWrite: true,
      confirmationCode: "EXECUTE_OZON_PERFORMANCE_WRITE",
      payload: {
        campaignId: "retry-plan",
        bids: [{ sku: "SKU-RETRY", bid: "20" }],
      },
    },
    { fetchImpl, writeReadbackDelaysMs: [0, 0] },
  );

  assert.equal(result.readback.confirmed, true);
  assert.equal(result.readback.attempts, 2);
  assert.equal(productReads, 2);
});

test("Ozon Performance blocks payload baseUrl injection before credentials leave local-api", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body });
    return createJsonResponse({});
  };

  await assert.rejects(
    () =>
      readPerformanceRealtimeOverview(
        {
          baseUrl: "https://evil.example",
          type: "ozon-performance",
          values: {
            performanceClientId: "unit@advertising.performance.ozon.ru",
            performanceClientSecret: "dummy-secret-placeholder",
          },
        },
        { fetchImpl },
      ),
    (error) => {
      assert.equal(error.code, "PERFORMANCE_BASE_URL_FORBIDDEN");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("Ozon Performance blocks external report URL without leaking bearer token", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.authorization || "" });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-1",
            title: "计划 1",
            state: "CAMPAIGN_STATE_RUNNING",
          },
        ],
      });
    }
    if (url.includes("/api/client/campaign/campaign-1/v2/products")) {
      return createJsonResponse({ products: [] });
    }
    if (url.includes("/api/client/campaign/campaign-1/objects")) {
      return createJsonResponse({ objects: [] });
    }
    if (url.includes("/api/client/statistics/daily/json")) {
      return createJsonResponse({ error: "not ready" }, { status: 404 });
    }
    if (url.includes("/api/client/statistics/campaign/product/json")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/expense")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/campaign/media")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.endsWith("/api/client/statistics/json")) {
      return createJsonResponse({ UUID: "report-evil" });
    }
    if (url.endsWith("/api/client/statistics/report-evil")) {
      return createJsonResponse({
        UUID: "report-evil",
        state: "OK",
        link: "https://evil.example/report.json",
      });
    }
    return createJsonResponse({ items: [] });
  };

  await assert.rejects(
    () =>
      readPerformanceRealtimeOverview(
        {
          type: "ozon-performance",
          values: {
            performanceClientId: "unit@advertising.performance.ozon.ru",
            performanceClientSecret: "dummy-secret-placeholder",
          },
        },
        { fetchImpl },
      ),
    (error) => {
      assert.equal(error.code, "PERFORMANCE_REMOTE_URL_BLOCKED");
      return true;
    },
  );
  assert.equal(
    calls.some((call) => call.url.includes("evil.example")),
    false,
  );
});

test("Ozon Performance can resolve credentials from local-api account repository hook", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
      });
    }
    if (url.endsWith("/api/client/campaign/search_promo/v2/products")) {
      return createJsonResponse({ list: [], total: 0 });
    }
    return createJsonResponse({});
  };

  const payload = await readPerformanceProductCandidates(
    {
      type: "ozon-performance",
      values: { accountId: "performance-unit", page: 1, pageSize: 10 },
    },
    {
      fetchImpl,
      credentialResolver: () => ({
        accountId: "performance-unit",
        clientId: "unit@advertising.performance.ozon.ru",
        clientSecret: "dummy-secret-placeholder",
      }),
    },
  );

  assert.equal(payload.ok, true);
  assert.equal(
    JSON.parse(calls[0].body).client_secret,
    "dummy-secret-placeholder",
  );
});

test("Ozon Performance realtime overview coalesces identical live reads", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({ list: [], total: 0 });
    }
    if (url.includes("/api/client/statistics/daily/json")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/campaign/product/json")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/expense")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/campaign/media")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.endsWith("/api/client/statistics/list")) {
      return createJsonResponse({ items: [], total: 0 });
    }
    if (url.endsWith("/api/client/statistics/externallist")) {
      return createJsonResponse({ items: [], total: 0 });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  try {
    const payload = {
      type: "ozon-performance",
      values: {
        accountId: "performance-unit",
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        shopId: "ozon-shop-1",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-07",
      },
    };
    const [first, second] = await Promise.all([
      readPerformanceRealtimeOverview(payload),
      readPerformanceRealtimeOverview(payload),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(
      calls.filter((call) => call.url.endsWith("/api/client/token")).length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.url.endsWith("/api/client/campaign")).length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ozon Performance fast overview skips heavy report polling without using business cache", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-fast-sku",
            title: "快速商品计划",
            state: "CAMPAIGN_STATE_RUNNING",
            advObjectType: "SKU",
          },
          {
            id: "campaign-fast-search",
            title: "搜索推广计划",
            state: "CAMPAIGN_STATE_RUNNING",
            advObjectType: "SEARCH_PROMO",
          },
        ],
        total: 2,
      });
    }
    if (url.includes("/api/client/campaign/campaign-fast-sku/v2/products")) {
      return createJsonResponse({ products: [] });
    }
    if (url.includes("/api/client/campaign/campaign-fast-search/v2/products")) {
      throw new Error(
        "SEARCH_PROMO should not call campaign v2 products in fast read",
      );
    }
    if (url.includes("/api/client/campaign/") && url.includes("/objects")) {
      return createJsonResponse({ objects: [] });
    }
    if (url.includes("/api/client/statistics/daily/json")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/campaign/product/json")) {
      return createJsonResponse({
        rows: [{ campaignId: "campaign-fast-sku", sku: "sku-1", clicks: 1 }],
      });
    }
    if (url.includes("/api/client/statistics/expense")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/campaign/media")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.endsWith("/api/client/statistics/json")) {
      throw new Error("fast read must not create async statistics task");
    }
    if (
      url.endsWith("/api/client/statistics/list") ||
      url.endsWith("/api/client/statistics/externallist")
    ) {
      throw new Error("fast read must not block on report lists");
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        shopId: "ozon-shop-1",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-07",
        readDepth: "fast",
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.cache.enabled, false);
  assert.equal(payload.readDepth, "fast");
  assert.equal(payload.statisticsReport.skipped, true);
  assert.equal(payload.statisticsTasks.length, 0);
  assert.equal(payload.externalReports.length, 0);
  assert.equal(payload.readIssues.length, 0);
  assert.equal(
    payload.stages.find((stage) => stage.key === "asyncStatistics")?.status,
    "skipped",
  );
  assert.equal(
    payload.stages.find((stage) => stage.key === "statisticsList")?.status,
    "skipped",
  );
  assert.equal(
    payload.stages.find((stage) => stage.key === "externalStatisticsList")
      ?.status,
    "skipped",
  );
  assert.equal(
    calls.some((call) => call.url.endsWith("/api/client/statistics/json")),
    false,
  );
  assert.equal(
    calls.some((call) => call.url.endsWith("/api/client/statistics/list")),
    false,
  );
  assert.equal(
    calls.some((call) =>
      call.url.endsWith("/api/client/statistics/externallist"),
    ),
    false,
  );
});

test("Ozon Performance overview reads only the selected campaign and can skip incompatible object details", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          { id: "campaign-selected", title: "选中计划", status: "RUNNING" },
          { id: "campaign-other", title: "其他计划", status: "RUNNING" },
        ],
        total: 2,
      });
    }
    if (url.includes("/api/client/campaign/campaign-selected/v2/products")) {
      return createJsonResponse({
        products: [{ sku: "sku-selected", title: "选中商品" }],
      });
    }
    if (url.includes("campaign-other") || url.includes("/objects")) {
      throw new Error("未选中的计划和 objects 接口不应被读取");
    }
    if (url.includes("/api/client/statistics/daily/json")) {
      return createJsonResponse({
        rows: [
          {
            campaignId: "campaign-selected",
            date: "2026-07-31",
            impressions: 100,
            clicks: 10,
            spent: 50,
            orders: 2,
            revenue: 200,
          },
        ],
      });
    }
    if (url.includes("/api/client/statistics/campaign/product/json")) {
      return createJsonResponse({
        rows: [
          {
            campaignId: "campaign-selected",
            sku: "sku-selected",
            spent: 50,
            orders: 2,
            revenue: 200,
          },
        ],
      });
    }
    if (url.includes("/api/client/statistics/expense")) {
      return createJsonResponse({
        rows: [{ campaignId: "campaign-selected", spent: 50 }],
      });
    }
    if (url.includes("/api/client/statistics/campaign/media")) {
      return createJsonResponse({ rows: [] });
    }
    if (
      url.endsWith("/api/client/statistics/list") ||
      url.endsWith("/api/client/statistics/externallist")
    ) {
      return createJsonResponse({ items: [], total: 0 });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        campaignId: "campaign-selected",
        includeCampaignObjects: false,
        dateFrom: "2026-07-25",
        dateTo: "2026-07-31",
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.campaignScope.requestedCampaignId, "campaign-selected");
  assert.equal(payload.campaignScope.totalCount, 2);
  assert.equal(payload.campaigns.length, 1);
  assert.equal(payload.campaigns[0].id, "campaign-selected");
  assert.equal(payload.campaigns[0].statistics.spent, 50);
  assert.equal(
    payload.readIssues.length,
    0,
    JSON.stringify(payload.readIssues),
  );
  assert.equal(
    calls.some((call) => call.url.includes("campaign-other")),
    false,
  );
  assert.equal(
    calls.some((call) => call.url.includes("/objects")),
    false,
  );
  assert.ok(
    calls
      .find((call) => call.url.includes("statistics/daily/json"))
      ?.url.includes("campaignIds=campaign-selected"),
  );
});

test("Ozon Performance routes campaign detail reads by campaign state and type", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-active",
            title: "运行中商品计划",
            state: "CAMPAIGN_STATE_RUNNING",
            advObjectType: "SKU",
          },
          {
            id: "campaign-archived",
            title: "已归档商品计划",
            state: "CAMPAIGN_STATE_ARCHIVED",
            advObjectType: "SKU",
          },
          {
            id: "campaign-search",
            title: "按订单付费计划",
            state: "CAMPAIGN_STATE_RUNNING",
            advObjectType: "SEARCH_PROMO",
            paymentType: "CPO",
          },
          {
            id: "campaign-no-objects",
            title: "不提供对象明细的计划",
            state: "CAMPAIGN_STATE_RUNNING",
            advObjectType: "SKU",
          },
          {
            id: "campaign-search-empty",
            title: "暂无可读商品的订单付费计划",
            state: "CAMPAIGN_STATE_RUNNING",
            advObjectType: "SEARCH_PROMO",
            paymentType: "CPO",
          },
        ],
        total: 5,
      });
    }
    if (url.includes("/api/client/campaign/campaign-active/v2/products")) {
      return createJsonResponse({
        products: [
          {
            sku: "sku-active",
            title: "运行中商品",
            bid: "12000000",
            status: "ACTIVE",
          },
        ],
        total: 1,
      });
    }
    if (url.includes("/api/client/campaign/campaign-archived/v2/products")) {
      return createJsonResponse({
        products: [{ sku: "sku-archived", title: "历史商品" }],
        total: 1,
      });
    }
    if (url.includes("/api/client/campaign/campaign-no-objects/v2/products")) {
      return createJsonResponse({
        products: [{ sku: "sku-no-objects", title: "无对象明细商品" }],
        total: 1,
      });
    }
    if (
      url.endsWith(
        "/api/client/campaign/campaign-search/search_promo/v2/products",
      )
    ) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { page: 1, pageSize: 200 });
      return createJsonResponse({
        products: [{ sku: "sku-search", title: "搜索推广商品" }],
        total: 1,
      });
    }
    if (
      url.endsWith(
        "/api/client/campaign/campaign-search-empty/search_promo/v2/products",
      )
    ) {
      return createJsonResponse(
        { error: "campaign is not available in search promotion scope" },
        { status: 404 },
      );
    }
    if (url.includes("/api/client/campaign/campaign-active/objects")) {
      return createJsonResponse({
        list: [{ id: "sku-active", bid: "12000000" }],
      });
    }
    if (url.includes("/api/client/campaign/campaign-no-objects/objects")) {
      return createJsonResponse(
        { error: "campaign object details unavailable" },
        { status: 404 },
      );
    }
    if (url.includes("/objects")) {
      throw new Error("已归档计划和搜索推广计划不应请求 objects 接口");
    }
    if (url.includes("/api/client/statistics/daily/json")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/campaign/product/json")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/expense")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.includes("/api/client/statistics/campaign/media")) {
      return createJsonResponse({ rows: [] });
    }
    if (url.endsWith("/api/client/statistic/products/generate/json")) {
      assert.equal(options.method, "POST");
      return createJsonResponse({ UUID: "campaign-detail-cpo-report" });
    }
    if (url.endsWith("/api/client/statistics/campaign-detail-cpo-report")) {
      return createJsonResponse({
        UUID: "campaign-detail-cpo-report",
        state: "OK",
        link: "/api/client/statistics/report?UUID=campaign-detail-cpo-report",
      });
    }
    if (
      url.includes(
        "/api/client/statistics/report?UUID=campaign-detail-cpo-report",
      )
    ) {
      return createJsonResponse({ rows: [] });
    }
    if (
      url.endsWith("/api/client/statistics/list") ||
      url.endsWith("/api/client/statistics/externallist")
    ) {
      return createJsonResponse({ items: [], total: 0 });
    }
    return createJsonResponse({ rows: [] });
  };

  const payload = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        shopId: "ozon-shop-1",
        dateFrom: "2026-07-25",
        dateTo: "2026-07-31",
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.ok, true);
  assert.equal(
    payload.readIssues.length,
    0,
    JSON.stringify(payload.readIssues),
  );
  assert.equal(payload.products.length, 4);
  assert.equal(payload.objects.length, 2);
  const activeObject = payload.objects.find((row) => row.sku === "sku-active");
  assert.equal(activeObject.title, "运行中商品");
  assert.equal(activeObject.bid, 12);
  assert.equal(activeObject.type, "商品");
  const derivedObject = payload.objects.find(
    (row) => row.sku === "sku-no-objects",
  );
  assert.equal(derivedObject.title, "无对象明细商品");
  assert.equal(derivedObject.objectSource, "campaign-product");
  assert.equal(payload.readAvailability.campaignProductsUnavailable.length, 1);
  assert.equal(payload.readAvailability.campaignObjectsSkipped.length, 3);
  assert.equal(payload.readAvailability.campaignObjectsUnavailable.length, 1);
  assert.equal(
    payload.stages.find((stage) => stage.key === "campaignObjects")
      ?.skippedCount,
    3,
  );
  assert.equal(
    calls.some((call) => call.url.includes("campaign-archived/objects")),
    false,
  );
  assert.equal(
    calls.some((call) => call.url.includes("campaign-search/objects")),
    false,
  );
});

test("Ozon Performance overview preserves missing statistics as null instead of inventing zero", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [{ id: "campaign-no-stats", title: "暂无统计计划" }],
        total: 1,
      });
    }
    throw new Error(`快速读取不应访问其他端点：${url}`);
  };

  const payload = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        readDepth: "fast",
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.campaigns[0].statistics.impressions, null);
  assert.equal(payload.campaigns[0].statistics.clicks, null);
  assert.equal(payload.campaigns[0].statistics.spent, null);
  assert.equal(payload.campaigns[0].statistics.revenue, null);
  assert.equal(payload.campaigns[0].statistics.roas, null);
  assert.equal(payload.campaigns[0].productCount, null);
  assert.equal(payload.campaigns[0].objectCount, null);
  assert.equal(payload.summary.impressions, null);
  assert.equal(payload.summary.spent, null);
  assert.equal(payload.summary.revenue, null);
  assert.equal(payload.summary.roi, null);
  assert.equal(payload.summary.roas, null);
  assert.equal(payload.summary.productCount, null);
});

test("Ozon Performance realtime overview retries transient transport failures without cache fallback", async () => {
  let campaignAttempts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      campaignAttempts += 1;
      if (campaignAttempts === 1) {
        const error = new Error("fetch failed");
        error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
        throw error;
      }
      return createJsonResponse({
        list: [
          {
            id: "campaign-retry",
            title: "重试计划",
            state: "CAMPAIGN_STATE_RUNNING",
          },
        ],
        total: 1,
      });
    }
    return createJsonResponse({ error: "unknown endpoint" }, { status: 404 });
  };

  const payload = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        shopId: "ozon-shop-1",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-07",
        readDepth: "fast",
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.cache.enabled, false);
  assert.equal(payload.cache.fallback, false);
  assert.equal(payload.summary.total, 1);
  assert.equal(campaignAttempts, 2);
});

test("Ozon Performance full overview keeps campaign data when optional realtime endpoints fail", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/client/token")) {
      return createJsonResponse({
        access_token: "dummy-token-placeholder",
        token_type: "Bearer",
        expires_in: 1800,
      });
    }
    if (url.endsWith("/api/client/campaign")) {
      return createJsonResponse({
        list: [
          {
            id: "campaign-partial",
            title: "局部失败计划",
            state: "CAMPAIGN_STATE_RUNNING",
          },
        ],
        total: 1,
      });
    }
    if (url.includes("/api/client/campaign/campaign-partial/v2/products")) {
      return createJsonResponse({
        products: [{ sku: "sku-partial", title: "实时商品" }],
      });
    }
    if (url.includes("/api/client/campaign/campaign-partial/objects")) {
      return createJsonResponse({
        objects: [{ id: "object-partial", sku: "sku-partial", type: "SKU" }],
      });
    }
    const error = new Error("fetch failed");
    error.cause = { code: "UND_ERR_SOCKET" };
    throw error;
  };

  const payload = await readPerformanceRealtimeOverview(
    {
      values: {
        performanceClientId: "unit@advertising.performance.ozon.ru",
        performanceClientSecret: "dummy-secret-placeholder",
        shopId: "ozon-shop-1",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-07",
      },
    },
    { fetchImpl },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.cache.enabled, false);
  assert.equal(payload.cache.fallback, false);
  assert.equal(payload.summary.total, 1);
  assert.equal(payload.campaigns[0].products[0].title, "实时商品");
  assert.ok(payload.readIssues.length >= 1);
});
