import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertPaidCapabilityPointsAvailable,
  createPaidCapabilityPointsReader,
} from "./paidCapabilityPoints.js";
import {
  APPROVED_IMAGE_API_BASE_URL,
  APPROVED_IMAGE_MODEL_ID,
  isApprovedImageProvider,
} from "./imageGenerationProviderPolicy.js";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_HEADERS = new Set([
  "accept",
  "content-type",
  "if-match",
  "x-idempotency-key",
  "x-request-id",
]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LEGACY_IMPORT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const PROFIT_LEDGER_SNAPSHOT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DATA_BACKUP_CONTROL_MAX_BODY_BYTES = 128 * 1024;
const DATA_ANALYSIS_SNAPSHOT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const IMAGE_PROMPT_PLAN_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_LOCAL_API_PROXY_TIMEOUT_MAX_MS = 120_000;
const THIN_CACHE_MAX_BYTES = 8 * 1024 * 1024;

function safeCacheScope(session = {}, profileId = "") {
  const identity = String(
    session?.user?.id ||
      session?.user?.email ||
      session?.user?.username ||
      profileId ||
      "anonymous",
  ).trim();
  return crypto
    .createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24);
}

function createThinResponseCache(directory) {
  const root = String(directory || "").trim();
  if (!root) return null;
  fs.mkdirSync(root, { recursive: true });
  function cachePath(scope, request) {
    const url = new URL(request.url);
    const key = crypto
      .createHash("sha256")
      .update(`${scope}\0${request.method}\0${url.pathname}${url.search}`)
      .digest("hex");
    return path.join(root, scope, `${key}.json`);
  }
  return Object.freeze({
    read(scope, request) {
      try {
        const payload = JSON.parse(
          fs.readFileSync(cachePath(scope, request), "utf8"),
        );
        return payload && Object.hasOwn(payload, "data")
          ? payload.data
          : undefined;
      } catch {
        return undefined;
      }
    },
    write(scope, request, data) {
      try {
        const serialized = JSON.stringify({
          savedAt: new Date().toISOString(),
          data,
        });
        if (Buffer.byteLength(serialized, "utf8") > THIN_CACHE_MAX_BYTES)
          return;
        const target = cachePath(scope, request);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, serialized, {
          encoding: "utf8",
          mode: 0o600,
        });
        fs.renameSync(temporary, target);
      } catch {
        // Cache persistence is best effort and cannot invalidate a server result.
      }
    },
  });
}
const SHOP_LICENSE_GRANT_SYNC_MS = 25_000;
const LONG_RUNNING_LOCAL_API_TIMEOUTS = new Map([
  ["POST /api/account-removal/confirm", 180_000],
  ["POST /api/account-removal/client-verify", 180_000],
  ["POST /api/account-removal/recover", 180_000],
  ["POST /api/account-removal/recover-direct", 180_000],
  ["POST /api/follow-seller-defense/prepare-quick", 300_000],
  ["POST /api/follow-seller-defense/submission-result", 180_000],
  ["POST /api/performance/overview", 300_000],
  ["POST /api/integrations/analyze", 420_000],
  ["POST /api/data-analysis/insights", 300_000],
  ["POST /api/product-descriptions/generate", 180_000],
  ["POST /api/image-prompt-plans/generate", 180_000],
  ["POST /api/product-images/edit", 180_000],
  ["POST /api/product-images/generate", 180_000],
]);
// This is intentionally an exact POST-path list, never a prefix rule.  A
// renderer can carry a large one-time legacy source only into its typed
// SQLite migration route; normal business writes remain capped at 2 MiB.
const LEGACY_IMPORT_POST_PATHS = new Set([
  "/api/cache/marketing/legacy-import",
  "/api/shops/legacy-import",
  "/api/products/material/legacy-import",
  "/api/products/source-links/legacy-import",
  "/api/purchase/source-links/legacy-import",
  "/api/sales/source-links/legacy-import",
  "/api/purchase/orders/overrides/legacy-import",
]);
// A 90-day canonical profit ledger contains compact evidence for every order
// and legitimately exceeds the ordinary 2 MiB business-write ceiling. Keep
// the larger allowance scoped to the exact SQLite snapshot PUT route; adjacent
// profit writes and other methods remain on the normal limit.
const LARGE_TYPED_WRITE_PATHS = new Map([
  ["POST /api/protected-compute/execute", 2 * 1024 * 1024 + 4096],
  ["PUT /api/profit/ledger-snapshot", PROFIT_LEDGER_SNAPSHOT_MAX_BODY_BYTES],
  ["POST /api/app/data-backup-import", DATA_BACKUP_CONTROL_MAX_BODY_BYTES],
  [
    "POST /api/cache/data-analysis/snapshot",
    DATA_ANALYSIS_SNAPSHOT_MAX_BODY_BYTES,
  ],
  ["POST /api/image-prompt-plans/generate", IMAGE_PROMPT_PLAN_MAX_BODY_BYTES],
  ["POST /api/product-images/edit", IMAGE_PROMPT_PLAN_MAX_BODY_BYTES],
  [
    "POST /api/app/historical-product-import/preflight",
    LEGACY_IMPORT_MAX_BODY_BYTES,
  ],
  [
    "POST /api/app/historical-order-import/preflight",
    LEGACY_IMPORT_MAX_BODY_BYTES,
  ],
]);
const PROTECTED_COMPUTE_PERMISSIONS = new Map([
  ["collection-pricing.quote", "collection_pricing.use"],
  ["profitability.quote", "profit.view"],
  ["profit.ledger-batch", "profit.view"],
]);
const PAID_CAPABILITY_BUSINESS_PATHS = new Set([
  "/api/product-descriptions/generate",
  "/api/image-prompt-plans/generate",
  "/api/data-analysis/insights",
  "/api/integrations/analyze",
  "/api/integrations/read",
  "/api/product-images/generate",
  "/api/product-images/edit",
]);
const V2_TEXT_MODEL_CAPABILITIES = new Map([
  ["/api/product-descriptions/generate", "text.product-description"],
  ["/api/image-prompt-plans/generate", "text.image-plan"],
  ["/api/integrations/analyze", "text.external-insight"],
  ["/api/data-analysis/insights", "text.external-insight"],
]);
const V2_TEXT_MODEL_TEMPLATE_IDS = new Set([
  "product-description.v1",
  "attribute-autofill.v1",
  "profit-order-review.v1",
  "image-plan.v1",
  "attribute-visual-evidence.v1",
  "external-ozon-insight.v1",
  "product-selection.v1",
  "performance-ad-insight.v1",
  "operational-report.v1",
  "data-analysis.v1",
  "product-selection-source-plan.v1",
  "generic-skill-runtime.v1",
]);
const BUILTIN_POINTS_MODEL_ACCOUNT_ID = "builtin-points";
const ALLOWED_BUILTIN_TEXT_MODELS = new Set([
  "gpt-5.6-terra",
  "gpt-5.6-sol",
]);
const ALLOWED_TEXT_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const V2_MODEL_ERROR_MESSAGES = new Map([
  [
    "POINT_BALANCE_INSUFFICIENT",
    "当前账户积分不足，无法使用旺崽内置模型；请充值积分后重试。",
  ],
  [
    "POINTS_INSUFFICIENT",
    "当前账户积分不足，无法使用旺崽内置模型；请充值积分后重试。",
  ],
  [
    "PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE",
    "本次模型调用没有完成，积分正在安全核对；系统不会自动重复调用或重复扣费，请稍后重试。",
  ],
  [
    "PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN",
    "模型服务连接超时，本次结果尚未返回；系统不会自动重复调用，请稍后重试。",
  ],
  [
    "PAID_CAPABILITY_PROVIDER_PRICING_UNAVAILABLE",
    "模型服务的积分计费状态暂时无法读取，请稍后重试。",
  ],
  [
    "PAID_CAPABILITY_SOURCE_IMAGE_REJECTED",
    "参考图片未通过私有图片存储校验，请重新读取商品图片后再试。",
  ],
  [
    "PAID_CAPABILITY_SOURCE_IMAGE_UNAVAILABLE",
    "私有参考图片暂时无法读取，请稍后重试。",
  ],
]);
const V2_IMAGE_MODEL_CAPABILITIES = new Map([
  ["/api/product-images/generate", "image.generate"],
  ["/api/product-images/edit", "image.edit"],
]);
const V2_IMAGE_MODEL_TEMPLATE_IDS = new Set(["product-image-generation.v1"]);
const V2_CORE_LEGACY_PATH_PATTERNS = Object.freeze([
  /^\/api\/customer-service\/(?:probe|translate)(?:\/|$)/u,
  /^\/api\/data-analysis\/insights$/u,
  /^\/api\/exchange-rate\/rub-cny\/(?:daily-batch|realtime)$/u,
  /^\/api\/follow-seller-defense(?:\/|$)/u,
  /^\/api\/integrations\/(?:read|test)$/u,
  /^\/api\/logistics\/cross-border\/(?:charges|endpoints|read|write)(?:\/|$)/u,
  /^\/api\/ozon\/(?:notification-settings|notifications|request|scheduler)(?:\/|$)/u,
  /^\/api\/performance\/(?:action|overview|products)$/u,
  /^\/api\/prompt-library\/skill-source\/resolve$/u,
  /^\/api\/product-images\/import(?:\/|$)/u,
  /^\/api\/products\/historical-dimension-sync\/(?:confirm|preview)$/u,
  /^\/api\/protected-compute$/u,
  /^\/api\/purchase\/(?:browser-capture|browser\/tasks)(?:\/|$)/u,
  /^\/api\/returns\/reasons\/translate$/u,
  /^\/api\/sync(?:\/|$)/u,
  /^\/api\/write(?:\/|$)/u,
]);

function shouldUseV2CoreLegacyPath(request = {}) {
  return V2_CORE_LEGACY_PATH_PATTERNS.some((pattern) =>
    pattern.test(request.pathname || ""),
  );
}

function usesServerTextModelTemplate(request = {}) {
  if (
    request.method !== "POST" ||
    !V2_TEXT_MODEL_CAPABILITIES.has(request.pathname) ||
    !request.serialized
  )
    return false;
  try {
    const input = JSON.parse(request.serialized);
    return Boolean(
      String(input?.templateId || input?.template_id || "").trim(),
    );
  } catch {
    return false;
  }
}

function usesServerImageModel(request = {}, localCacheAgent = false) {
  if (
    request.method !== "POST" ||
    !V2_IMAGE_MODEL_CAPABILITIES.has(request.pathname)
  )
    return false;
  if (localCacheAgent) return true;
  if (!request.serialized) return false;
  try {
    const input = JSON.parse(request.serialized);
    const candidate = Array.isArray(input?.modelSelection?.candidates)
      ? input.modelSelection.candidates[0]
      : null;
    const accountId = String(
      input?.accountId ||
        input?.account_id ||
        candidate?.accountId ||
        candidate?.account_id ||
        "",
    ).trim();
    return accountId === BUILTIN_POINTS_MODEL_ACCOUNT_ID;
  } catch {
    return false;
  }
}
const ACCOUNT_REMOVAL_PERMISSION = "dashboard.view";
const ACCOUNT_REMOVAL_FIXED_ROUTES = new Map([
  ["POST /api/account-removal/preview", ACCOUNT_REMOVAL_PERMISSION],
  ["POST /api/account-removal/prepare-preview", ACCOUNT_REMOVAL_PERMISSION],
  ["POST /api/account-removal/release-preview", ACCOUNT_REMOVAL_PERMISSION],
  ["POST /api/account-removal/confirm", ACCOUNT_REMOVAL_PERMISSION],
  ["POST /api/account-removal/client-verify", ACCOUNT_REMOVAL_PERMISSION],
  ["POST /api/account-removal/client-failure", ACCOUNT_REMOVAL_PERMISSION],
  ["POST /api/account-removal/recover", ACCOUNT_REMOVAL_PERMISSION],
  ["POST /api/account-removal/recover-direct", ACCOUNT_REMOVAL_PERMISSION],
  ["GET /api/account-removal/pending", ACCOUNT_REMOVAL_PERMISSION],
]);
const PERMISSION_RULES = [
  { pattern: /^\/api\/internal\/shutdown$/, permission: "__internal.runtime" },
  {
    pattern: /^\/api\/internal\/shop-license-grants$/,
    permission: "__internal.shopLicenseGrants",
  },
  {
    pattern: /^\/api\/internal\/purchase-browser(?:\/|$)/,
    permission: "__internal.purchaseBrowser",
  },
  {
    pattern: /^\/api\/internal\/model-api-credentials\/get$/,
    permission: "__internal.modelApiCredentials",
  },
  { pattern: /^\/api\/app\/storage-audit$/, permission: "dashboard.view" },
  {
    pattern:
      /^\/api\/app\/(?:data-consistency-audit|database-compaction-preview|database-compaction\/confirm|shop-scope-manual-preview|shop-scope-manual-resolution\/confirm|shop-scope-repair\/confirm|technical-retention\/(?:confirm|status))$/,
    permission: "dashboard.view",
  },
  { pattern: /^\/api\/app\/shop-scope-preview$/, permission: "dashboard.view" },
  {
    pattern: /^\/api\/app\/(?:technical-retention-preview|technical-archives)$/,
    permission: "dashboard.view",
  },
  {
    pattern: /^\/api\/app\/recovery-backup-preview$/,
    permission: "dashboard.view",
  },
  {
    pattern: /^\/api\/app\/data-backup-(?:preview|history)$/,
    permission: "dashboard.view",
  },
  { pattern: /^\/api\/app\/data-backup-import$/, permission: "dashboard.view" },
  {
    pattern: /^\/api\/app\/data-backup-import-history$/,
    permission: "dashboard.view",
  },
  {
    pattern:
      /^\/api\/app\/historical-product-import\/(?:preflight|confirm|history)$/,
    permission: "products.view",
  },
  {
    pattern:
      /^\/api\/app\/historical-order-import\/(?:preflight|confirm|history)$/,
    permission: "products.view",
  },
  { pattern: /^\/api\/app\/recovery\/command$/, permission: "dashboard.view" },
  {
    pattern:
      /^\/api\/app\/(?:continuous-sync-status|maintenance-status|automatic-maintenance\/status)$/,
    permission: "dashboard.view",
  },
  { pattern: /^\/api\/sync\/jobs(?:\/|$)/, permission: "dashboard.view" },
  {
    pattern:
      /^\/api\/(?:cache|sync|write)\/products(?:\/|$)|^\/api\/(?:products|product-images)(?:\/|$)|^\/api\/(?:cache\/catalog|catalog)(?:\/|$)/,
    permission: "products.view",
  },
  { pattern: /^\/api\/image-provenance(?:\/|$)/, permission: "products.view" },
  {
    pattern: /^\/api\/follow-seller-defense(?:\/|$)/,
    permission: "products.view",
  },
  {
    pattern: /^\/api\/prompt-library\/skill-source\/resolve$/,
    permission: "dashboard.view",
  },
  {
    pattern: /^\/api\/(?:product-descriptions|image-prompt-plans)\/generate$/,
    permission: "products.view",
  },
  {
    pattern:
      /^\/api\/(?:cache|sync|write)\/(?:orders|returns)(?:\/|$)|^\/api\/(?:orders|sales|returns)(?:\/|$)/,
    permission: "orders.view",
  },
  {
    pattern: /^\/api\/purchase(?:\/|$)|^\/api\/logistics\/cross-border(?:\/|$)/,
    permission: "purchase.manage",
  },
  {
    pattern: /^\/api\/(?:cache|sync)\/logistics(?:\/|$)/,
    permission: "warehouse.view",
  },
  {
    pattern:
      /^\/api\/(?:cache|sync)\/(?:finance|profit|rating-penalties)(?:\/|$)|^\/api\/(?:finance|profit|rating-penalties|exchange-rate)(?:\/|$)/,
    permission: "profit.view",
  },
  {
    pattern:
      /^\/api\/(?:cache|sync|write)\/marketing(?:\/|$)|^\/api\/performance(?:\/|$)/,
    permission: "marketing.view",
  },
  {
    pattern:
      /^\/api\/(?:cache|sync)\/data-analysis(?:\/|$)|^\/api\/data-analysis(?:\/|$)/,
    permission: "analytics.view",
  },
  {
    pattern:
      /^\/api\/customer-service(?:\/|$)|^\/api\/write\/customerService(?:\/|$)/,
    permission: "customer_service.view",
  },
  {
    pattern: /^\/api\/smart-reply(?:\/|$)/,
    permission: "customer_service.view",
  },
  {
    pattern:
      /^\/api\/shops(?:\/|$)|^\/api\/(?:integrations\/(?:test|profiles|read|analyze|seerfar)|model-api\/accounts|profile-settings|profile-assets)(?:\/|$)/,
    permission: "dashboard.view",
  },
  {
    pattern:
      /^\/api\/ozon\/(?:notifications|notification-settings|push-bindings)(?:\/|$)|^\/api\/ozon\/scheduler\/(?:pause|resume)-/,
    permission: "dashboard.view",
  },
];

function accountRemovalPermissionForRequest({
  method = "",
  pathname = "",
} = {}) {
  if (!pathname.startsWith("/api/account-removal/")) return undefined;
  const normalizedMethod = String(method || "").toUpperCase();
  if (normalizedMethod) {
    const fixed = ACCOUNT_REMOVAL_FIXED_ROUTES.get(
      `${normalizedMethod} ${pathname}`,
    );
    if (fixed) return fixed;
  } else if (
    [...ACCOUNT_REMOVAL_FIXED_ROUTES.keys()].some((route) =>
      route.endsWith(` ${pathname}`),
    )
  ) {
    return ACCOUNT_REMOVAL_PERMISSION;
  }

  const operationMatch = pathname.match(
    /^\/api\/account-removal\/operations\/([^/]+?)(\/resume)?$/u,
  );
  if (!operationMatch) return null;
  let operationId;
  try {
    operationId = decodeURIComponent(operationMatch[1]);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(operationId)) return null;
  if (!normalizedMethod) return ACCOUNT_REMOVAL_PERMISSION;
  if (operationMatch[2]) {
    return normalizedMethod === "POST" ? ACCOUNT_REMOVAL_PERMISSION : null;
  }
  return normalizedMethod === "GET" ? ACCOUNT_REMOVAL_PERMISSION : null;
}

const AUTHORIZED_SYSTEM_PATHS = [
  /^\/health$/,
  /^\/api\/app\/status$/,
  /^\/api\/ozon\/(?:endpoints|errors|rate-limit\/status|scheduler\/status)$/,
];

function isRecoveryShellRequestAllowed(request) {
  if (
    request.pathname === "/health" ||
    request.pathname === "/api/app/status"
  ) {
    return request.method === "GET";
  }
  if (request.pathname === "/api/shops") return request.method === "GET";
  return (
    request.pathname === "/api/app/recovery/command" &&
    request.method === "POST"
  );
}

const DOMAIN_PERMISSIONS = new Map([
  ["dashboard-business-share", "dashboard.view"],
  ["dashboard-overview", "dashboard.view"],
  ["products", "products.view"],
  ["catalog", "products.view"],
  ["images", "products.view"],
  ["orders", "orders.view"],
  ["returns", "orders.view"],
  ["purchase", "purchase.manage"],
  ["cross-border", "purchase.manage"],
  ["logistics", "warehouse.view"],
  ["finance", "profit.view"],
  ["profit", "profit.view"],
  ["profit-report", "profit.view"],
  ["rating-penalties", "profit.view"],
  ["marketing", "marketing.view"],
  ["performance", "marketing.view"],
  ["data-analysis", "analytics.view"],
  ["dataanalysis", "analytics.view"],
  ["reports", "analytics.view"],
  ["customer-service", "customer_service.view"],
  ["customerservice", "customer_service.view"],
]);

function dynamicDomainPermission(pathname) {
  const syncStateMatch = pathname.match(/^\/api\/sync\/state\/([^/]+)$/);
  if (syncStateMatch) {
    return (
      DOMAIN_PERMISSIONS.get(
        decodeURIComponent(syncStateMatch[1]).toLowerCase(),
      ) || null
    );
  }
  const match = pathname.match(/^\/api\/(?:cache|sync|write)\/([^/]+)(?:\/|$)/);
  return match
    ? DOMAIN_PERMISSIONS.get(decodeURIComponent(match[1]).toLowerCase()) || null
    : undefined;
}

function permissionForRequest(request, input) {
  if (request.pathname === "/api/protected-compute/execute") {
    const capability = String(input?.body?.capability || "").trim();
    return PROTECTED_COMPUTE_PERMISSIONS.get(capability) || null;
  }
  if (
    request.pathname === "/api/protected-compute/status" ||
    request.pathname === "/api/protected-compute/contracts"
  ) {
    // Runtime metadata is available to any authorized desktop session; the
    // execute route applies the capability's exact module permission.
    return "";
  }
  if (request.pathname.startsWith("/api/protected-compute/")) return null;
  const accountRemovalPermission = accountRemovalPermissionForRequest(request);
  if (accountRemovalPermission !== undefined) return accountRemovalPermission;
  const direct = PERMISSION_RULES.find((rule) =>
    rule.pattern.test(request.pathname),
  );
  if (direct) return direct.permission;
  if (AUTHORIZED_SYSTEM_PATHS.some((pattern) => pattern.test(request.pathname)))
    return "";
  const dynamic = dynamicDomainPermission(request.pathname);
  if (dynamic !== undefined) return dynamic;
  if (request.pathname !== "/api/ozon/request") return null;
  const endpoint = String(
    input?.body?.endpointKey ||
      input?.body?.endpoint_key ||
      input?.body?.endpoint ||
      "",
  ).toLowerCase();
  if (endpoint === "finance.transactionlist" || endpoint === "/v3/finance/transaction/list") {
    // Explicit official readback only. Keep the existing exact-shop entitlement
    // checks and backend read-only endpoint guard; never grant a finance prefix.
    return request.method === "POST" && String(input?.body?.access || "").toLowerCase() === "read"
      ? "profit.view"
      : null;
  }
  if (endpoint.includes("product") || endpoint.includes("catalog"))
    return "products.view";
  if (
    endpoint.includes("return") ||
    endpoint.includes("order") ||
    endpoint.includes("posting")
  ) {
    return "orders.view";
  }
  if (endpoint.includes("marketing") || endpoint.includes("promotion"))
    return "marketing.view";
  if (
    endpoint.includes("chat") ||
    endpoint.includes("review") ||
    endpoint.includes("question")
  ) {
    return "customer_service.view";
  }
  return null;
}

function maximumBodyBytesForRequest({ method, pathname }) {
  if (method === "POST" && LEGACY_IMPORT_POST_PATHS.has(pathname)) {
    return LEGACY_IMPORT_MAX_BODY_BYTES;
  }
  return LARGE_TYPED_WRITE_PATHS.get(`${method} ${pathname}`) || MAX_BODY_BYTES;
}

export function requiredPermissionForLocalApi(
  pathname,
  body = {},
  method = "",
) {
  return permissionForRequest({ pathname, method }, { body });
}

export function maximumTimeoutMsForLocalApiRequest(method, pathname) {
  return (
    LONG_RUNNING_LOCAL_API_TIMEOUTS.get(
      `${String(method || "GET").toUpperCase()} ${pathname}`,
    ) || DEFAULT_LOCAL_API_PROXY_TIMEOUT_MAX_MS
  );
}

function normalizedInput(baseUrl, input = {}) {
  const method = String(input.method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method))
    throw new Error("不支持的本地 API 请求方法");
  const base = new URL(baseUrl);
  const candidate = new URL(String(input.path || ""), `${baseUrl}/`);
  if (
    candidate.origin !== base.origin ||
    (candidate.pathname !== "/health" &&
      !candidate.pathname.startsWith("/api/"))
  ) {
    throw new Error("本地 API 请求地址不在允许范围内");
  }
  const serialized =
    input.body === undefined ? undefined : JSON.stringify(input.body);
  if (
    serialized &&
    Buffer.byteLength(serialized, "utf8") >
      maximumBodyBytesForRequest({ method, pathname: candidate.pathname })
  ) {
    throw new Error("本地 API 请求体过大");
  }
  const headers = {};
  for (const [name, value] of Object.entries(input.headers || {})) {
    const normalizedName = name.toLowerCase();
    if (ALLOWED_HEADERS.has(normalizedName))
      headers[normalizedName] = String(value);
  }
  return {
    method,
    url: candidate.toString(),
    pathname: candidate.pathname,
    serialized,
    headers,
  };
}

function requiresBlockingShopLicenseGrantSync(request) {
  if (!request || request.method === "GET") return false;
  if (
    request.pathname === "/api/shops" ||
    request.pathname === "/api/shops/legacy-import"
  )
    return true;
  return (
    request.pathname === "/api/ozon/request" ||
    /^\/api\/follow-seller-defense\/(?:prepare|confirm|submission-result|readback|readback-result)$/.test(
      request.pathname,
    ) ||
    request.pathname.startsWith("/api/sync/") ||
    request.pathname.startsWith("/api/write/") ||
    request.pathname.startsWith("/api/performance/")
  );
}

const EXACT_SHOP_LICENSE_SCOPE_PATTERNS = Object.freeze([
  /^\/api\/shops\/[^/]+\/test$/u,
  /^\/api\/ozon\/request$/u,
  /^\/api\/ozon\/notifications(?:\/(?:read|clear))?$/u,
  /^\/api\/ozon\/push-bindings$/u,
  /^\/api\/(?:cache|sync|write)\/(?:orders|returns|products|marketing|performance|data-analysis|dashboard-overview|dashboard-business-share|profit-report)(?:\/|$)/u,
  /^\/api\/(?:orders|sales|returns)(?:\/|$)/u,
]);

function requiresExactOzonShopLicenseScope(request = {}) {
  return EXACT_SHOP_LICENSE_SCOPE_PATTERNS.some((pattern) =>
    pattern.test(String(request.pathname || "")),
  );
}

function splitShopScopeValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item ?? "").split(","))
    .map((item) => item.trim())
    .filter((item) => item && item !== "all");
}

function requestedOzonShopScopes(request = {}, input = {}) {
  const scopes = [];
  const append = (value) => scopes.push(...splitShopScopeValues(value));
  const url = new URL(request.url);
  for (const key of [
    "shopId",
    "shop_id",
    "shopIds",
    "shop_ids",
    "targetShopId",
    "target_shop_id",
    "sourceShopId",
    "source_shop_id",
  ]) {
    for (const value of url.searchParams.getAll(key)) append(value);
  }
  let body = input?.body;
  if ((!body || typeof body !== "object") && request.serialized) {
    try {
      body = JSON.parse(request.serialized);
    } catch {
      body = null;
    }
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const key of [
      "shopId",
      "shop_id",
      "shopIds",
      "shop_ids",
      "targetShopId",
      "target_shop_id",
      "sourceShopId",
      "source_shop_id",
      "uploadShopIds",
      "upload_shop_ids",
    ]) append(body[key]);
  }
  const connectionMatch = String(request.pathname || "").match(
    /^\/api\/shops\/([^/]+)\/test$/u,
  );
  if (connectionMatch) {
    try {
      append(decodeURIComponent(connectionMatch[1]));
    } catch {
      append(connectionMatch[1]);
    }
  }
  return [...new Set(scopes)];
}

function normalizedRequestId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,160}$/u.test(text) ? text : "";
}

async function parsedResponse(response) {
  const text = await response.text();
  if (!text) return null;
  if (
    (response.headers.get("content-type") || "").includes("application/json")
  ) {
    try {
      return JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: {
          code: "LOCAL_API_INVALID_RESPONSE",
          message: "本地 API 响应无效",
        },
      };
    }
  }
  return text;
}

const MODEL_API_DISCOVERY_UPDATE_FIELDS = Object.freeze([
  "apiAlias",
  "provider",
  "baseUrl",
  "defaultModel",
  "usageScene",
  "detectionStatus",
  "detectedSource",
  "detectedAt",
  "availableModels",
  "capabilities",
  "discoveryVerified",
]);

function publicModelApiDiscoveryUpdates(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const updates = {};
  for (const field of MODEL_API_DISCOVERY_UPDATE_FIELDS) {
    if (Object.hasOwn(input, field)) updates[field] = input[field];
  }
  return updates;
}

export function createLocalApiProxy({
  baseUrl,
  authToken,
  licenseRuntime,
  recoveryMode = false,
  remoteCore = false,
  localCacheAgent = false,
  coreServiceUrl = "",
  cacheDirectory = "",
  profileId = "",
  fetchImpl = fetch,
  stageImageModelSources = null,
}) {
  const pendingControllers = new Map();
  const thinCache = remoteCore ? createThinResponseCache(cacheDirectory) : null;
  let shopLicenseGrantSyncPromise;
  let shopLicenseGrantFreshUntilMs = 0;
  let shopLicenseGrantInitialized = false;
  let localShopLicenseRowsPromise;
  let localShopLicenseRowsFreshUntilMs = 0;
  let localShopLicenseRows = [];
  const normalizedCoreServiceUrl = String(coreServiceUrl || "")
    .trim()
    .replace(/\/$/u, "");
  const readPaidCapabilityPointsWallet = createPaidCapabilityPointsReader({
    licenseRuntime,
  });
  let builtinPointsCheckPromise = null;
  let builtinPointsCheckCache = null;
  let builtinPointsCheckFreshUntilMs = 0;

  async function verifyBuiltinPoints() {
    if (builtinPointsCheckCache && builtinPointsCheckFreshUntilMs > Date.now()) {
      return builtinPointsCheckCache;
    }
    if (builtinPointsCheckPromise) return builtinPointsCheckPromise;
    builtinPointsCheckPromise = (async () => {
      try {
        const result = {
          ok: true,
          wallet: assertPaidCapabilityPointsAvailable(
            await readPaidCapabilityPointsWallet(),
          ),
        };
        // This is only a short-lived local preflight cache. Every protected
        // compute request is still independently authorized and charged by
        // Core V2; coalescing only removes duplicate wallet reads in a burst.
        builtinPointsCheckCache = result;
        builtinPointsCheckFreshUntilMs = Date.now() + 1_000;
        return result;
      } catch (error) {
        return {
          ok: false,
          status: Number(error?.status) || 503,
          data: {
            ok: false,
            error: {
              code: String(error?.code || "POINTS_CHECK_FAILED"),
              message: String(
                error?.publicMessage ||
                  error?.message ||
                  "无法核验当前账户积分，暂时不能使用旺崽内置能力。",
              ),
            },
          },
        };
      } finally {
        builtinPointsCheckPromise = null;
      }
    })();
    return builtinPointsCheckPromise;
  }

  async function executeV2ShopConnectionTest({
    request,
    cacheScope,
    accessToken,
    signal,
  }) {
    if (!normalizedCoreServiceUrl)
      throw new Error("V2_CORE_SERVICE_URL_REQUIRED");
    const shopMatch = request.pathname.match(/^\/api\/shops\/([^/]+)\/test$/u);
    if (!shopMatch) throw new Error("V2_SHOP_TEST_PATH_INVALID");
    const shopId = decodeURIComponent(shopMatch[1]);
    const localResponse = await fetchImpl(
      `${baseUrl}/v1/internal/shop-credentials/get`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-wangzai-cache-agent-token": authToken,
          "x-wangzai-cache-scope": cacheScope,
        },
        body: JSON.stringify({ shopId }),
        signal,
      },
    );
    const local = await parsedResponse(localResponse);
    if (
      !localResponse.ok ||
      !local?.credentials?.clientId ||
      !local?.credentials?.apiKey
    ) {
      return { ok: false, status: localResponse.status, data: local };
    }
    let token = accessToken;
    const forward = () =>
      fetchImpl(
        `${normalizedCoreServiceUrl}/api/core-v2/ozon/shop-connection-test`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            client_id: local.credentials.clientId,
            api_key: local.credentials.apiKey,
          }),
          signal,
        },
      );
    let remoteResponse = await forward();
    if (remoteResponse.status === 401) {
      await remoteResponse.body?.cancel?.().catch(() => undefined);
      token = await getProtectedComputeToken({
        forceRefresh: true,
        rejectedAccessToken: token,
      });
      if (!token)
        return {
          ok: false,
          status: 401,
          error: "登录会话刷新失败，请重新登录。",
        };
      remoteResponse = await forward();
    }
    const remote = await parsedResponse(remoteResponse);
    if (!remoteResponse.ok) {
      const detail =
        remote?.detail && typeof remote.detail === "object"
          ? remote.detail
          : remote;
      return {
        ok: false,
        status: remoteResponse.status,
        data: {
          ok: false,
          error: {
            code: String(detail?.code || "OZON_CONNECTION_TEST_FAILED"),
            message: String(detail?.message || "Ozon 店铺连接测试失败。"),
          },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      data: {
        ...remote,
        sellerInfo: remote?.sellerInfo ?? remote?.seller_info ?? null,
        shop: local.shop,
      },
    };
  }

  async function executeV2SmartReplyNotificationPoll({
    cacheScope,
    accessToken,
    signal,
  }) {
    if (!normalizedCoreServiceUrl)
      throw new Error("V2_CORE_SERVICE_URL_REQUIRED");
    const localHeaders = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-wangzai-cache-agent-token": authToken,
      "x-wangzai-cache-scope": cacheScope,
    };
    const modeResponse = await fetchImpl(`${baseUrl}/api/smart-reply/mode`, {
      method: "GET",
      headers: localHeaders,
      signal,
    });
    const mode = await parsedResponse(modeResponse);
    if (!modeResponse.ok || mode?.mode !== "local") {
      return {
        ok: modeResponse.ok,
        status: modeResponse.ok ? 200 : modeResponse.status,
        data: modeResponse.ok
          ? { ok: true, accepted: 0, mode: "cloud" }
          : mode,
      };
    }

    let token = accessToken;
    const readNotifications = () =>
      fetchImpl(
        `${normalizedCoreServiceUrl}/api/core-v2/legacy/api/ozon/notifications?read=unread&limit=100`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "x-wangzai-thin-profile-id": String(profileId || ""),
          },
          signal,
        },
      );
    let notificationResponse = await readNotifications();
    if (notificationResponse.status === 401) {
      await notificationResponse.body?.cancel?.().catch(() => undefined);
      token = await licenseRuntime.getUserAccessToken({
        forceRefresh: true,
        rejectedAccessToken: token,
      });
      if (!token) {
        return { ok: false, status: 401, error: "登录会话刷新失败，请重新登录。" };
      }
      notificationResponse = await readNotifications();
    }
    const notificationPayload = await parsedResponse(notificationResponse);
    if (!notificationResponse.ok) {
      return {
        ok: false,
        status: notificationResponse.status,
        data: notificationPayload,
      };
    }
    const orderEventTypes = new Set([
      "order_new",
      "order_paid",
      "order_status_changed",
      "order_cancelled",
      "fbo_order_new",
      "fbo_order_status_changed",
      "fbo_order_cancelled",
    ]);
    const notifications = (Array.isArray(notificationPayload?.rows)
      ? notificationPayload.rows
      : [])
      .filter((row) => row?.domain === "orders")
      .filter((row) => orderEventTypes.has(String(row?.eventType || "")))
      .filter((row) => String(row?.shopId || "").trim())
      .filter((row) => String(row?.postingNumber || "").trim())
      .slice(0, 100)
      .map((row) => ({
        id: String(row.id || "").trim(),
        domain: "orders",
        eventType: String(row.eventType || "").trim(),
        shopId: String(row.shopId || "").trim(),
        ...(String(
          row.clientId || row.shopClientId || row.sellerId || "",
        ).trim()
          ? {
              clientId: String(
                row.clientId || row.shopClientId || row.sellerId || "",
              ).trim(),
            }
          : {}),
        postingNumber: String(row.postingNumber || "").trim(),
        createdAt: String(row.createdAt || "").trim(),
      }));
    const localResponse = await fetchImpl(
      `${baseUrl}/v1/internal/smart-reply/notification-hints`,
      {
        method: "POST",
        headers: localHeaders,
        body: JSON.stringify({ notifications }),
        signal,
      },
    );
    return {
      ok: localResponse.ok,
      status: localResponse.status,
      data: await parsedResponse(localResponse),
    };
  }

  async function executeV2ModelApiAccountSave({
    request,
    cacheScope,
    accessToken,
    signal,
  }) {
    let input;
    try {
      input = request.serialized ? JSON.parse(request.serialized) : {};
    } catch {
      return { ok: false, status: 400, error: "模型中转账号数据无效。" };
    }
    const websiteUrl = String(
      input?.websiteUrl || input?.website_url || "",
    ).trim();
    const pendingDiscoveryUpdates = (detectionStatus) => ({
      discoveryVerified: false,
      detectionStatus,
      detectedSource: "",
      detectedAt: new Date().toISOString(),
    });
    let updates = {};
    if (websiteUrl) {
      let apiKey = String(input?.apiKey || input?.api_key || "").trim();
      const accountId = String(input?.id || input?.accountId || "").trim();
      const inputHasApiKey =
        Object.hasOwn(input || {}, "apiKey") ||
        Object.hasOwn(input || {}, "api_key");
      if (!inputHasApiKey && accountId) {
        try {
          const credentialResponse = await fetchImpl(
            `${baseUrl}/v1/internal/model-api-credentials/get`,
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "x-wangzai-cache-agent-token": authToken,
                "x-wangzai-cache-scope": cacheScope,
              },
              body: JSON.stringify({ accountId }),
              signal,
            },
          );
          const credentials = await parsedResponse(credentialResponse);
          if (credentialResponse.ok)
            apiKey = String(credentials?.credentials?.apiKey || "").trim();
        } catch {
          // Saving non-secret account fields must remain available even when the
          // internal credential read is temporarily unavailable.
          apiKey = "";
        }
      }
      if (accessToken && normalizedCoreServiceUrl) {
        try {
          let token = accessToken;
          const discover = () =>
            fetchImpl(
              `${normalizedCoreServiceUrl}/api/core-v2/model-api/discover`,
              {
                method: "POST",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                  website_url: websiteUrl,
                  api_key: apiKey || null,
                  api_alias: String(
                    input?.apiAlias || input?.api_alias || "",
                  ).trim(),
                }),
                signal,
              },
            );
          let discoveryResponse = await discover();
          if (discoveryResponse.status === 401) {
            await discoveryResponse.body?.cancel?.().catch(() => undefined);
            token = await getProtectedComputeToken({
              forceRefresh: true,
              rejectedAccessToken: token,
            });
            if (token) discoveryResponse = await discover();
          }
          const discovery = await parsedResponse(discoveryResponse);
          const publicUpdates = publicModelApiDiscoveryUpdates(
            discovery?.updates,
          );
          if (discoveryResponse.ok && publicUpdates) {
            updates = publicUpdates;
          } else {
            updates = pendingDiscoveryUpdates(
              "已保存账号，接口识别暂未完成，稍后重试。",
            );
          }
        } catch {
          updates = pendingDiscoveryUpdates(
            "已保存账号，接口识别暂未完成，稍后重试。",
          );
        }
      } else if (!accessToken) {
        updates = pendingDiscoveryUpdates(
          "已保存账号，登录会话恢复后再识别接口。",
        );
      } else {
        updates = pendingDiscoveryUpdates(
          "已保存账号，管理服务配置恢复后再识别接口。",
        );
      }
    }
    const localResponse = await fetchImpl(`${baseUrl}/api/model-api/accounts`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-wangzai-cache-agent-token": authToken,
        "x-wangzai-cache-scope": cacheScope,
      },
      body: JSON.stringify({ ...input, ...updates }),
      signal,
    });
    return {
      ok: localResponse.ok,
      status: localResponse.status,
      data: await parsedResponse(localResponse),
    };
  }

  async function executeV2TextModelRequest({
    request,
    cacheScope,
    accessToken,
    signal,
    requestId,
  }) {
    if (!normalizedCoreServiceUrl) {
      return {
        ok: false,
        status: 503,
        error: "管理服务配置缺失，暂时无法调用模型。",
      };
    }
    let input;
    try {
      input = request.serialized ? JSON.parse(request.serialized) : {};
    } catch {
      return { ok: false, status: 400, error: "模型请求数据无效。" };
    }
    const capability = V2_TEXT_MODEL_CAPABILITIES.get(request.pathname);
    const templateId = String(
      input?.templateId || input?.template_id || "",
    ).trim();
    const templateInput = input?.templateInput || input?.template_input;
    if (!V2_TEXT_MODEL_TEMPLATE_IDS.has(templateId)) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: {
            code: "V2_SERVER_PROMPT_TEMPLATE_REQUIRED",
            message: "当前功能尚未迁移到服务器提示词模板。",
          },
        },
      };
    }
    if (
      !templateInput ||
      typeof templateInput !== "object" ||
      Array.isArray(templateInput)
    ) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: {
            code: "V2_SERVER_PROMPT_INPUT_REQUIRED",
            message: "本次模型任务缺少结构化真实数据。",
          },
        },
      };
    }
    const accountId = String(
      input?.accountId || input?.account_id || "",
    ).trim();
    const model = String(input?.model || "").trim();
    const usesByokModel =
      Boolean(accountId && model) &&
      accountId !== BUILTIN_POINTS_MODEL_ACCOUNT_ID;
    const requestedProviderModel = String(
      usesByokModel
        ? model
        : input?.providerModel ||
            input?.provider_model ||
            (ALLOWED_BUILTIN_TEXT_MODELS.has(model)
              ? model
              : "gpt-5.6-terra"),
    ).trim();
    const reasoningEffort = String(
      input?.reasoningEffort || input?.reasoning_effort || "medium",
    )
      .trim()
      .toLowerCase();
    if (
      !usesByokModel &&
      !ALLOWED_BUILTIN_TEXT_MODELS.has(requestedProviderModel)
    ) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: {
            code: "TEXT_MODEL_FORBIDDEN",
            message: "当前只允许使用 GPT-5.6 Terra 和 GPT-5.6 Sol。",
          },
        },
      };
    }
    if (!ALLOWED_TEXT_REASONING_EFFORTS.has(reasoningEffort)) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: {
            code: "TEXT_REASONING_EFFORT_FORBIDDEN",
            message: "推理强度只允许选择低、中或高。",
          },
        },
      };
    }
    let byok = null;
    if (usesByokModel) {
      try {
        const credentialPath = localCacheAgent
          ? "/v1/internal/model-api-credentials/get"
          : "/api/internal/model-api-credentials/get";
        const credentialHeaders = localCacheAgent
          ? {
              "x-wangzai-cache-agent-token": authToken,
              "x-wangzai-cache-scope": cacheScope,
            }
          : { "x-wangzai-local-api-token": authToken };
        const credentialResponse = await fetchImpl(
          `${baseUrl}${credentialPath}`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...credentialHeaders,
            },
            body: JSON.stringify({ accountId }),
            signal,
          },
        );
        const credentialPayload = await parsedResponse(credentialResponse);
        const account = credentialPayload?.account;
        const apiKey = String(
          credentialPayload?.credentials?.apiKey || "",
        ).trim();
        const baseUrlValue = String(account?.baseUrl || "").trim();
        const availableModels = Array.isArray(account?.availableModels)
          ? account.availableModels
          : [];
        const selectedModel = availableModels.find(
          (item) => String(item?.id || item?.model || "").trim() === model,
        );
        if (availableModels.length && !selectedModel) {
          return {
            ok: false,
            status: 400,
            data: {
              ok: false,
              error: {
                code: "TEXT_MODEL_NOT_DISCOVERED",
                message: "当前接口没有发现所选文本模型。",
              },
            },
          };
        }
        const modelCapabilities = (
          Array.isArray(selectedModel?.capabilities)
            ? selectedModel.capabilities
            : []
        )
          .map((item) =>
            String(item || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean);
        if (
          modelCapabilities.length &&
          !modelCapabilities.includes("text-generation")
        ) {
          return {
            ok: false,
            status: 400,
            data: {
              ok: false,
              error: {
                code: "TEXT_MODEL_CAPABILITY_INVALID",
                message: "当前所选模型不是文本生成模型。",
              },
            },
          };
        }
        let baseUrlAccepted = false;
        try {
          const parsed = new URL(baseUrlValue);
          baseUrlAccepted =
            parsed.protocol === "https:" &&
            !parsed.username &&
            !parsed.password &&
            !parsed.search &&
            !parsed.hash;
        } catch {
          baseUrlAccepted = false;
        }
        if (
          credentialResponse.ok &&
          account?.discoveryVerified === true &&
          apiKey &&
          baseUrlAccepted
        ) {
          byok = {
            account_id: accountId,
            base_url: baseUrlValue,
            api_key: apiKey,
            model,
          };
        }
      } catch {
        // A local BYOK read failure falls back to the authenticated points
        // model. It never sends a partial credential object to Core V2.
        byok = null;
      }
    }
    if (!byok) {
      const pointsCheck = await verifyBuiltinPoints();
      if (!pointsCheck.ok) return pointsCheck;
    }
    const referenceImages = [
      ...new Set(
        [
          ...(Array.isArray(input?.referenceImageUrls)
            ? input.referenceImageUrls
            : []),
          ...(Array.isArray(input?.referenceImages) ? input.referenceImages : []),
        ]
          .map((item) =>
            String(
              item?.url || item?.dataUrl || item?.data_url || item || "",
            ).trim(),
          )
          .filter(Boolean),
      ),
    ].slice(0, 10);
    const coreBody = {
      capability,
      request_id: requestId || `desktop-${crypto.randomUUID()}`,
      template_id: templateId,
      template_input: templateInput,
      custom_rules: String(
        input?.customRules || input?.custom_rules || "",
      ).trim(),
      user_instruction: String(
        input?.userInstruction || input?.user_instruction || "",
      ).trim(),
      reference_images: referenceImages,
      model: byok?.model || requestedProviderModel,
      reasoning_effort: reasoningEffort,
      byok,
    };
    let token = accessToken;
    const forward = () =>
      fetchImpl(`${normalizedCoreServiceUrl}/api/core-v2/text-model/execute`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(coreBody),
        signal,
      });
    let response;
    try {
      response = await forward();
      if (response.status === 401) {
        await response.body?.cancel?.().catch(() => undefined);
        token = await getProtectedComputeToken({
          forceRefresh: true,
          rejectedAccessToken: token,
        });
        if (!token)
          return {
            ok: false,
            status: 401,
            error: "登录会话刷新失败，请重新登录。",
          };
        response = await forward();
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return {
        ok: false,
        status: 0,
        error: "管理服务连接失败，模型请求尚未执行。",
      };
    }
    const remote = await parsedResponse(response);
    if (!response.ok) {
      const detail =
        remote?.detail && typeof remote.detail === "object"
          ? remote.detail
          : remote;
      const errorCode = String(detail?.code || "TEXT_MODEL_EXECUTION_FAILED");
      return {
        ok: false,
        status: response.status,
        data: {
          ok: false,
          error: {
            code: errorCode,
            message:
              V2_MODEL_ERROR_MESSAGES.get(errorCode) ||
              String(detail?.message || "模型暂时无法完成本次请求。"),
          },
        },
      };
    }
    const common = {
      ok: true,
      model: String(remote?.model || model || "builtin-points"),
      accountId: String(remote?.account_id || ""),
      usage: remote?.usage || null,
      ...(remote?.billing ? { billing: remote.billing } : {}),
    };
    if (request.pathname === "/api/product-descriptions/generate") {
      return {
        ok: true,
        status: 200,
        data: { ...common, description: String(remote?.text || "") },
      };
    }
    if (request.pathname === "/api/image-prompt-plans/generate") {
      const referenceImageCount = Math.max(
        0,
        Number(remote?.reference_image_count) || 0,
      );
      return {
        ok: true,
        status: 200,
        data: {
          ...common,
          planText: String(remote?.text || ""),
          referenceImageCount,
          requestedReferenceImageCount: referenceImages.length,
          referenceImagePolicy: referenceImageCount
            ? "vision-planner"
            : "deferred-to-image-model",
        },
      };
    }
    if (request.pathname === "/api/data-analysis/insights") {
      return {
        ok: true,
        status: 200,
        data: {
          ...common,
          insight: String(remote?.text || ""),
          dashboardMeta: input?.dashboardMeta || input?.dashboard_meta || null,
          query: input?.query || null,
        },
      };
    }
    return {
      ok: true,
      status: 200,
      data: { ...common, reportText: String(remote?.text || "") },
    };
  }
  async function executeV2ImageModelRequest({
    request,
    cacheScope,
    accessToken,
    signal,
    requestId,
  }) {
    if (!normalizedCoreServiceUrl) {
      return {
        ok: false,
        status: 503,
        error: "管理服务配置缺失，暂时无法生成图片。",
      };
    }
    let input;
    try {
      input = request.serialized ? JSON.parse(request.serialized) : {};
    } catch {
      return { ok: false, status: 400, error: "图片请求数据无效。" };
    }
    const capability = V2_IMAGE_MODEL_CAPABILITIES.get(request.pathname);
    const templateId = String(
      input?.promptTemplateId || input?.prompt_template_id || "",
    ).trim();
    const templateInput =
      input?.promptTemplateInput || input?.prompt_template_input;
    if (!V2_IMAGE_MODEL_TEMPLATE_IDS.has(templateId)) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: {
            code: "V2_SERVER_IMAGE_TEMPLATE_REQUIRED",
            message: "当前生图功能尚未迁移到服务器图片模板。",
          },
        },
      };
    }
    if (
      !templateInput ||
      typeof templateInput !== "object" ||
      Array.isArray(templateInput)
    ) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: {
            code: "V2_SERVER_IMAGE_INPUT_REQUIRED",
            message: "本次生图任务缺少结构化商品事实。",
          },
        },
      };
    }
    const shopId = String(input?.shopId || input?.shop_id || "").trim();
    if (!shopId || shopId === "shop-unbound") {
      return {
        ok: false,
        status: 400,
        error: "当前没有有效店铺，不能生成未绑定店铺的商品图。",
      };
    }
    const candidate = Array.isArray(input?.modelSelection?.candidates)
      ? input.modelSelection.candidates[0]
      : null;
    const accountId = String(
      input?.accountId || input?.account_id || candidate?.accountId || "",
    ).trim();
    const model = String(input?.model || candidate?.model || "").trim();
    if (!accountId || model !== APPROVED_IMAGE_MODEL_ID) {
      return {
        ok: false,
        status: 422,
        data: {
          ok: false,
          error: {
            code: "IMAGE_MODEL_PROVIDER_FORBIDDEN",
            message: `图片生成只允许 ${APPROVED_IMAGE_API_BASE_URL} 的 ${APPROVED_IMAGE_MODEL_ID}。`,
          },
        },
      };
    }
    let byok = null;
    if (accountId !== BUILTIN_POINTS_MODEL_ACCOUNT_ID) {
      try {
        const credentialResponse = await fetchImpl(
          `${baseUrl}/v1/internal/model-api-credentials/get`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "x-wangzai-cache-agent-token": authToken,
              "x-wangzai-cache-scope": cacheScope,
            },
            body: JSON.stringify({ accountId }),
            signal,
          },
        );
        const credentialPayload = await parsedResponse(credentialResponse);
        const account = credentialPayload?.account;
        const apiKey = String(
          credentialPayload?.credentials?.apiKey || "",
        ).trim();
        const baseUrlValue = String(account?.baseUrl || "").trim();
        const availableModels = Array.isArray(account?.availableModels)
          ? account.availableModels
          : [];
        const selectedModel = availableModels.find(
          (item) => String(item?.id || item?.model || "").trim() === model,
        );
        const requiredCapability =
          capability === "image.edit" ? "image-edit" : "image-generation";
        const modelCapabilities = (
          Array.isArray(selectedModel?.capabilities)
            ? selectedModel.capabilities
            : []
        )
          .map((item) =>
            String(item || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean);
        const baseUrlAccepted = isApprovedImageProvider(baseUrlValue, model);
        if (
          credentialResponse.ok &&
          account?.discoveryVerified === true &&
          apiKey &&
          baseUrlAccepted &&
          (!availableModels.length || Boolean(selectedModel)) &&
          (!modelCapabilities.length ||
            modelCapabilities.includes(requiredCapability))
        ) {
          byok = {
            account_id: accountId,
            base_url: baseUrlValue,
            api_key: apiKey,
            model,
          };
        }
      } catch {
        byok = null;
      }
    }
    if (accountId !== BUILTIN_POINTS_MODEL_ACCOUNT_ID && !byok) {
      return {
        ok: false,
        status: 422,
        data: {
          ok: false,
          error: {
            code: "IMAGE_MODEL_PROVIDER_FORBIDDEN",
            message: `未找到经过验证的 ${APPROVED_IMAGE_API_BASE_URL} / ${APPROVED_IMAGE_MODEL_ID} 配置，图片请求已阻止。`,
          },
        },
      };
    }
    if (accountId === BUILTIN_POINTS_MODEL_ACCOUNT_ID) {
      const pointsCheck = await verifyBuiltinPoints();
      if (!pointsCheck.ok) return pointsCheck;
    }
    let sourceImages = [
      ...(Array.isArray(input?.sourceImageUrls) ? input.sourceImageUrls : []),
      input?.sourceUrl,
      input?.dataBase64,
    ]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 4);
    if (capability === "image.edit" && !sourceImages.length) {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error: {
            code: "V2_IMAGE_SOURCE_REQUIRED",
            message: input?.assetId
              ? "当前本机图片资产尚未完成 V2 上传迁移，请先使用可访问的 HTTPS 图片。"
              : "图生图缺少参考图片。",
          },
        },
      };
    }
    let stagedSourceCleanup = async () => {};
    if (
      capability === "image.edit" &&
      accountId === BUILTIN_POINTS_MODEL_ACCOUNT_ID
    ) {
      if (typeof stageImageModelSources !== "function") {
        return {
          ok: false,
          status: 503,
          data: {
            ok: false,
            error: {
              code: "IMAGE_MODEL_SOURCE_STAGING_UNAVAILABLE",
              message: "参考图片安全读取组件尚未启动，暂时不能交给管理端统一OSS。",
            },
          },
        };
      }
      try {
        const staged = await stageImageModelSources({
          sourceImages,
          tenantId: cacheScope,
          shopId,
          signal,
        });
        sourceImages = Array.isArray(staged?.sourceImages)
          ? staged.sourceImages.map((item) => String(item || "").trim()).filter(Boolean)
          : [];
        stagedSourceCleanup = typeof staged?.cleanup === "function"
          ? staged.cleanup
          : stagedSourceCleanup;
        if (!sourceImages.length) {
          throw Object.assign(new Error("参考图片没有完成安全读取。"), {
            code: "IMAGE_MODEL_SOURCE_STAGING_FAILED",
          });
        }
      } catch (error) {
        return {
          ok: false,
          status: Number(error?.statusCode || error?.status) || 422,
          data: {
            ok: false,
            error: {
              code: String(error?.code || "IMAGE_MODEL_SOURCE_STAGING_FAILED"),
              message: String(error?.message || "参考图片安全准备失败。"),
            },
          },
        };
      }
    }
    const coreBody = {
      capability,
      request_id: requestId || `desktop-image-${crypto.randomUUID()}`,
      shop_id: shopId,
      template_id: templateId,
      template_input: templateInput,
      size: String(input?.size || "1008x1344").trim(),
      quality: String(input?.quality || "2k").trim(),
      source_images: capability === "image.edit" ? sourceImages : [],
      byok,
    };
    let token = accessToken;
    const forward = () =>
      fetchImpl(`${normalizedCoreServiceUrl}/api/core-v2/image-model/execute`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(coreBody),
        signal,
      });
    let response;
    let remote;
    try {
      try {
        response = await forward();
        if (response.status === 401) {
          await response.body?.cancel?.().catch(() => undefined);
          token = await getProtectedComputeToken({
            forceRefresh: true,
            rejectedAccessToken: token,
          });
          if (!token)
            return {
              ok: false,
              status: 401,
              error: "登录会话刷新失败，请重新登录。",
            };
          response = await forward();
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        return {
          ok: false,
          status: 0,
          error: "管理服务连接失败，图片请求尚未执行。",
        };
      }
      remote = await parsedResponse(response);
    } finally {
      await stagedSourceCleanup().catch(() => undefined);
    }
    if (!response.ok) {
      const detail =
        remote?.detail && typeof remote.detail === "object"
          ? remote.detail
          : remote;
      const errorCode = String(
        detail?.code || "IMAGE_MODEL_EXECUTION_FAILED",
      );
      return {
        ok: false,
        status: response.status,
        data: {
          ok: false,
          error: {
            code: errorCode,
            message: String(
              V2_MODEL_ERROR_MESSAGES.get(errorCode) ||
                detail?.message ||
                "图片模型暂时无法完成本次请求。",
            ),
          },
        },
      };
    }
    const image = Array.isArray(remote?.images) ? remote.images[0] : null;
    const remoteUrl = String(image?.url || "").trim();
    const encoded = String(image?.b64_json || image?.b64Json || "").trim();
    const previewUrl =
      remoteUrl || (encoded ? `data:image/png;base64,${encoded}` : "");
    if (!previewUrl)
      return {
        ok: false,
        status: 502,
        error: "图片模型没有返回可展示的图片。",
      };
    let persistedAsset = null;
    if (input?.persistGeneratedAsset === true) {
      try {
        const product = templateInput?.product || {};
        const localPersistenceResponse = await fetchImpl(
          `${baseUrl}/api/product-images/import`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...(localCacheAgent
                ? {
                    "x-wangzai-cache-agent-token": authToken,
                    "x-wangzai-cache-scope": cacheScope,
                  }
                : { "x-wangzai-local-api-token": authToken }),
            },
            body: JSON.stringify({
              shopId,
              productId: String(product?.productId || "").trim(),
              offerId: String(product?.offerId || "").trim(),
              sourceType: String(input?.sourceType || "collection-generated-v2").trim(),
              storageScope: "temporary",
              variant: capability === "image.edit" ? "collection-edited" : "collection-generated",
              ...(remoteUrl
                ? { sourceUrl: remoteUrl }
                : { dataBase64: `data:image/png;base64,${encoded}` }),
            }),
            signal,
          },
        );
        const localPersistence = await parsedResponse(localPersistenceResponse);
        const candidate = localPersistenceResponse.ok
          ? (localPersistence?.asset || localPersistence?.result?.asset || null)
          : null;
        if (String(candidate?.id || candidate?.assetId || "").trim()) {
          persistedAsset = candidate;
        }
      } catch {
        // The generated provider URL is still returned. Collection save has a
        // second import path so an already charged image is never discarded.
        persistedAsset = null;
      }
    }
    const legacyAssetId = input?.persistGeneratedAsset === true
      ? ""
      : `v2-image-${crypto
          .createHash("sha256")
          .update(`${coreBody.request_id}\0${remoteUrl || encoded.slice(0, 256)}`)
          .digest("hex")
          .slice(0, 24)}`;
    const assetId = String(persistedAsset?.id || persistedAsset?.assetId || legacyAssetId).trim();
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        model: String(remote?.model || model || "builtin-points"),
        accountId: String(remote?.account_id || ""),
        ...(remote?.billing ? { billing: remote.billing } : {}),
        persistenceStatus: persistedAsset ? "completed" : "pending",
        asset: {
          ...(persistedAsset || {}),
          id: assetId,
          assetId,
          localUrl: String(persistedAsset?.localUrl || previewUrl).trim(),
          previewUrl: String(persistedAsset?.previewUrl || persistedAsset?.localUrl || previewUrl).trim(),
          providerUrl: remoteUrl,
          storageScope: String(persistedAsset?.storageScope || "temporary").trim(),
          variant: String(
            persistedAsset?.variant || (capability === "image.edit" ? "edited" : "generated"),
          ).trim(),
        },
        delivery: { mode: remoteUrl ? "provider-url" : "inline-base64" },
      },
    };
  }

  async function getProtectedComputeToken({
    forceRefresh = false,
    rejectedAccessToken = "",
  } = {}) {
    if (typeof licenseRuntime.getProtectedComputeAccessToken === "function") {
      return String(
        await licenseRuntime.getProtectedComputeAccessToken({
          forceRefresh,
          rejectedAccessToken,
        }),
      ).trim();
    }
    if (forceRefresh)
      throw new Error("PROTECTED_COMPUTE_TOKEN_REFRESH_UNAVAILABLE");
    const context = await licenseRuntime.getRecoveryRemoteContext?.();
    return String(context?.accessToken || "").trim();
  }

  async function replaceLocalShopLicenseGrants(grants) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const cacheScope = safeCacheScope(
        await licenseRuntime.getSession?.(),
        profileId,
      );
      const response = await fetchImpl(
        localCacheAgent
          ? `${baseUrl}/v1/internal/smart-reply/shop-entitlements`
          : `${baseUrl}/api/internal/shop-license-grants`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(localCacheAgent
              ? {
                  "x-wangzai-cache-agent-token": authToken,
                  "x-wangzai-cache-scope": cacheScope,
                }
              : { "x-wangzai-local-api-token": authToken }),
            ...(!localCacheAgent
              ? { "x-wangzai-cache-scope": cacheScope }
              : {}),
            ...(remoteCore && !localCacheAgent
              ? {
                  Authorization: `Bearer ${await licenseRuntime.getUserAccessToken()}`,
                  "x-wangzai-thin-profile-id": String(profileId || ""),
                }
              : {}),
          },
          body: JSON.stringify({ grants }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error("本地店铺授权清单同步失败");
      await response.body?.cancel?.().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readLocalShopLicenseRows({ forceRefresh = false } = {}) {
    if (!forceRefresh && localShopLicenseRowsFreshUntilMs > Date.now()) {
      return localShopLicenseRows;
    }
    if (forceRefresh && localShopLicenseRowsPromise) {
      await localShopLicenseRowsPromise.catch(() => undefined);
    }
    if (forceRefresh) localShopLicenseRowsFreshUntilMs = 0;
    localShopLicenseRowsPromise ||= (async () => {
    const cacheScope = safeCacheScope(
      await licenseRuntime.getSession?.(),
      profileId,
    );
    const response = await fetchImpl(`${baseUrl}/api/shops`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(localCacheAgent
          ? {
              "x-wangzai-cache-agent-token": authToken,
              "x-wangzai-cache-scope": cacheScope,
            }
          : { "x-wangzai-local-api-token": authToken }),
      },
    });
    const payload = await parsedResponse(response);
    if (!response.ok) throw new Error("无法读取本机店铺授权范围");
    const rows = Array.isArray(payload) ? payload : payload?.shops;
      localShopLicenseRows = (Array.isArray(rows) ? rows : [])
        .map((shop) => ({
          shopId: String(shop?.id || shop?.shopId || shop?.shop_id || "").trim(),
          clientId: String(shop?.clientId || shop?.client_id || "").trim(),
        }))
        .filter((shop) => shop.shopId && shop.clientId);
      localShopLicenseRowsFreshUntilMs = Date.now() + 2_000;
      return localShopLicenseRows;
    })().finally(() => {
      localShopLicenseRowsPromise = undefined;
    });
    return localShopLicenseRowsPromise;
  }

  async function assertExactOzonShopLicenseScopes(request, input) {
    if (!requiresExactOzonShopLicenseScope(request)) return;
    const requestedScopes = requestedOzonShopScopes(request, input);
    if (!requestedScopes.length) {
      throw new Error("读取 Ozon 店铺数据前必须指定已绑定卡密的店铺");
    }
    let rows = await readLocalShopLicenseRows();
    const resolveClientId = (scope) => {
      const matching = rows.find((shop) =>
        shop.shopId === scope || shop.clientId === scope,
      );
      return matching?.clientId || "";
    };
    if (requestedScopes.some((scope) => !resolveClientId(scope))) {
      rows = await readLocalShopLicenseRows({ forceRefresh: true });
    }
    for (const scope of requestedScopes) {
      const matching = rows.find((shop) =>
        shop.shopId === scope || shop.clientId === scope,
      );
      if (!matching?.clientId) {
        throw new Error("当前请求包含无法确认授权归属的 Ozon 店铺");
      }
      await licenseRuntime.assertOzonShopEntitled(matching.clientId);
    }
  }

  async function syncShopLicenseGrants({ forceRefresh = false } = {}) {
    if (typeof licenseRuntime.getOzonShopEntitlementGrants !== "function")
      return;
    // POST /api/shops can immediately follow /api/license/bind-shop.  A grant
    // snapshot cached just before the bind does not contain the new Client ID,
    // so the local service would reject a card that License Center has already
    // bound.  Let the in-flight refresh settle, then deliberately fetch one
    // post-bind snapshot for explicit account saves.
    if (forceRefresh && shopLicenseGrantSyncPromise) {
      await shopLicenseGrantSyncPromise.catch(() => undefined);
    }
    if (forceRefresh) shopLicenseGrantFreshUntilMs = 0;
    if (shopLicenseGrantFreshUntilMs > Date.now()) return;
    shopLicenseGrantSyncPromise ||= (async () => {
      try {
        const grants = await licenseRuntime.getOzonShopEntitlementGrants();
        const normalizedGrants = Array.isArray(grants) ? grants : [];
        await replaceLocalShopLicenseGrants(normalizedGrants);
        shopLicenseGrantInitialized = true;
        const nearestExpiry = normalizedGrants.reduce((minimum, grant) => {
          const expiry = Date.parse(String(grant?.expireAt || ""));
          return Number.isFinite(expiry) ? Math.min(minimum, expiry) : minimum;
        }, Number.POSITIVE_INFINITY);
        shopLicenseGrantFreshUntilMs = Math.min(
          Date.now() + SHOP_LICENSE_GRANT_SYNC_MS,
          nearestExpiry,
        );
      } catch (error) {
        shopLicenseGrantFreshUntilMs = 0;
        shopLicenseGrantInitialized = false;
        await replaceLocalShopLicenseGrants([]).catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      shopLicenseGrantSyncPromise = undefined;
    });
    await shopLicenseGrantSyncPromise;
  }

  const proxyLocalApi = async function proxyLocalApi(input) {
    let request;
    let protectedComputeAccessToken = "";
    let remoteCoreAccessToken = "";
    let cacheScope = "";
    let isProtectedComputeRequest = false;
    let isPaidCapabilityBusinessRequest = false;
    let isV2ShopConnectionTest = false;
    let isV2SmartReplyNotificationPoll = false;
    let isV2ModelApiAccountSave = false;
    let isV2TextModelRequest = false;
    let isV2ImageModelRequest = false;
    let isV2CoreLegacyRequest = false;
    try {
      request = normalizedInput(baseUrl, input);
      if (request.pathname === "/api/internal/shutdown") {
        return {
          ok: false,
          status: 403,
          error: "该本地接口仅供桌面端主进程关闭流程使用",
        };
      }
      if (request.pathname === "/api/internal/shop-license-grants") {
        return {
          ok: false,
          status: 403,
          error: "店铺授权清单仅供桌面端主进程维护",
        };
      }
      if (request.pathname.startsWith("/api/internal/purchase-browser/")) {
        return {
          ok: false,
          status: 403,
          error: "拍单执行回执接口仅供桌面端内置浏览器使用",
        };
      }
      if (request.pathname === "/api/internal/model-api-credentials/get") {
        return {
          ok: false,
          status: 403,
          error: "模型接口凭证仅供桌面端主进程读取",
        };
      }
      if (recoveryMode && !isRecoveryShellRequestAllowed(request)) {
        return {
          ok: false,
          status: 423,
          error: "当前资料等待恢复，仅可使用恢复入口。",
        };
      }
      const runtime = await licenseRuntime.getRuntime();
      if (runtime.mode === "enforce") {
        const session = await licenseRuntime.getSession();
        if (!session.authorized) {
          return { ok: false, status: 403, error: "请先完成软件授权" };
        }
        // The local service owns all actual Ozon traffic, including background
        // sync. Keep its in-memory grants authoritative and fail closed to an
        // empty set whenever License Center cannot refresh the list.
        const forceShopGrantRefresh = request.method !== "GET" && (
          request.pathname === "/api/shops"
          || request.pathname === "/api/shops/legacy-import"
        );
        const grantSync = syncShopLicenseGrants({
          forceRefresh: forceShopGrantRefresh,
        });
        const smartReplyRequest = request.pathname.startsWith("/api/smart-reply/");
        const smartReplyNeedsFreshGrants =
          smartReplyRequest && request.method !== "GET";
        if (
          requiresBlockingShopLicenseGrantSync(request) ||
          smartReplyNeedsFreshGrants ||
          (smartReplyRequest && !shopLicenseGrantInitialized)
        ) {
          await grantSync.catch(() => undefined);
        } else {
          // SQLite/cache/UI reads must not queue behind a remote License Center
          // refresh. Start one shared refresh in the background; Ozon network
          // and smart-reply writes still wait for the authoritative grant list.
          void grantSync.catch(() => undefined);
        }
        const requiredPermission = permissionForRequest(request, input);
        if (requiredPermission === null) {
          const message = "本地 API 缺少明确的授权策略";
          return {
            ok: false,
            status: 403,
            error: message,
            data: {
              ok: false,
              error: {
                code: "LOCAL_API_AUTH_POLICY_MISSING",
                message,
              },
              method: request.method,
              path: request.pathname,
            },
          };
        }
        const permissions = new Set(session.entitlement?.permissions || []);
        if (requiredPermission && !permissions.has(requiredPermission)) {
          return {
            ok: false,
            status: 403,
            error: `当前授权缺少权限：${requiredPermission}`,
          };
        }
        try {
          await assertExactOzonShopLicenseScopes(request, input);
        } catch (error) {
          return {
            ok: false,
            status: 403,
            error:
              error?.message ||
              "当前 Ozon 店铺未绑定有效卡密或授权已到期",
          };
        }
        if (request.method === "POST" && request.pathname === "/api/shops") {
          const clientId = String(
            input?.body?.clientId || input?.body?.client_id || "",
          ).trim();
          if (!clientId) {
            return {
              ok: false,
              status: 403,
              error: "保存 Ozon 店铺前必须提供 Client ID 并完成卡密绑定",
            };
          }
          try {
            await licenseRuntime.assertOzonShopEntitled(clientId);
          } catch (error) {
            return {
              ok: false,
              status: 403,
              error: error?.message || "当前 Ozon 店铺没有有效授权",
            };
          }
        }
        if (
          request.method === "POST" &&
          request.pathname === "/api/shops/legacy-import"
        ) {
          const importedShops = Array.isArray(input?.body?.shops)
            ? input.body.shops
            : [];
          if (!importedShops.length) {
            return { ok: false, status: 403, error: "旧店铺导入缺少授权范围" };
          }
          for (const shop of importedShops) {
            const clientId = String(
              shop?.clientId || shop?.client_id || "",
            ).trim();
            if (!clientId) {
              return {
                ok: false,
                status: 403,
                error: "旧店铺缺少 Client ID，不能确认卡密归属",
              };
            }
            try {
              await licenseRuntime.assertOzonShopEntitled(clientId);
            } catch (error) {
              return {
                ok: false,
                status: 403,
                error: error?.message || "旧店铺没有有效授权",
              };
            }
          }
        }
      }
      isProtectedComputeRequest =
        request.method === "POST" &&
        request.pathname === "/api/protected-compute/execute";
      isPaidCapabilityBusinessRequest =
        request.method === "POST" &&
        PAID_CAPABILITY_BUSINESS_PATHS.has(request.pathname);
      isV2ShopConnectionTest = Boolean(
        localCacheAgent &&
        request.method === "POST" &&
        /^\/api\/shops\/[^/]+\/test$/u.test(request.pathname),
      );
      isV2SmartReplyNotificationPoll = Boolean(
        localCacheAgent &&
        remoteCore &&
        request.method === "POST" &&
        request.pathname === "/api/smart-reply/local/notification-poll",
      );
      isV2ModelApiAccountSave = Boolean(
        localCacheAgent &&
        request.method === "POST" &&
        request.pathname === "/api/model-api/accounts",
      );
      isV2TextModelRequest = Boolean(usesServerTextModelTemplate(request));
      isV2ImageModelRequest = usesServerImageModel(request, localCacheAgent);
      isV2CoreLegacyRequest = Boolean(
        localCacheAgent &&
        normalizedCoreServiceUrl &&
        shouldUseV2CoreLegacyPath(request),
      );
      if (isProtectedComputeRequest) {
        try {
          protectedComputeAccessToken = await getProtectedComputeToken();
        } catch {
          protectedComputeAccessToken = "";
        }
        if (!protectedComputeAccessToken) {
          return {
            ok: false,
            status: 401,
            error: "请先登录授权账号后再使用受保护计算。",
          };
        }
      }
      if (isPaidCapabilityBusinessRequest && !isV2TextModelRequest) {
        try {
          protectedComputeAccessToken = await getProtectedComputeToken();
        } catch {
          // BYOK remains usable without a cloud token. Paid fallback fails
          // closed inside the local service if no authenticated token exists.
          protectedComputeAccessToken = "";
        }
      }
      if (isV2ShopConnectionTest) {
        try {
          protectedComputeAccessToken = await getProtectedComputeToken();
        } catch {
          protectedComputeAccessToken = "";
        }
        if (!protectedComputeAccessToken) {
          return {
            ok: false,
            status: 401,
            error: "请先登录授权账号后再测试店铺。",
          };
        }
      }
      if (isV2ModelApiAccountSave) {
        try {
          const inputBody = request.serialized
            ? JSON.parse(request.serialized)
            : {};
          if (
            String(inputBody?.websiteUrl || inputBody?.website_url || "").trim()
          ) {
            protectedComputeAccessToken = await getProtectedComputeToken();
          }
        } catch {
          protectedComputeAccessToken = "";
        }
      }
      if (isV2TextModelRequest) {
        try {
          protectedComputeAccessToken = await getProtectedComputeToken();
        } catch {
          protectedComputeAccessToken = "";
        }
        if (!protectedComputeAccessToken) {
          return {
            ok: false,
            status: 401,
            error: "请先登录授权账号后再调用模型。",
          };
        }
      }
      if (isV2ImageModelRequest) {
        try {
          protectedComputeAccessToken ||= await getProtectedComputeToken();
        } catch {
          protectedComputeAccessToken = "";
        }
        if (!protectedComputeAccessToken) {
          return {
            ok: false,
            status: 401,
            error: "请先登录授权账号后再生成图片。",
          };
        }
      }
      if (remoteCore || isV2CoreLegacyRequest) {
        remoteCoreAccessToken = await licenseRuntime.getUserAccessToken();
      }
      if (isV2SmartReplyNotificationPoll && !remoteCoreAccessToken) {
        return {
          ok: false,
          status: 401,
          error: "请先登录授权账号后再接收订单消息提醒。",
        };
      }
      if (
        remoteCore ||
        localCacheAgent ||
        request.pathname.startsWith("/api/smart-reply/")
      ) {
        cacheScope = safeCacheScope(
          await licenseRuntime.getSession?.(),
          profileId,
        );
      }
    } catch (error) {
      return {
        ok: false,
        status: 400,
        error: error?.message || "本地 API 请求无效",
      };
    }

    const controller = new AbortController();
    const requestId = normalizedRequestId(input?.requestId);
    if (requestId) {
      const previous = pendingControllers.get(requestId);
      previous?.abort();
      pendingControllers.set(requestId, controller);
    }
    const timeoutMs = Math.min(
      Math.max(Number(input?.timeoutMs) || 10_000, 1_000),
      maximumTimeoutMsForLocalApiRequest(request.method, request.pathname),
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (isV2ShopConnectionTest) {
        return await executeV2ShopConnectionTest({
          request,
          cacheScope,
          accessToken: protectedComputeAccessToken,
          signal: controller.signal,
        });
      }
      if (isV2SmartReplyNotificationPoll) {
        return await executeV2SmartReplyNotificationPoll({
          cacheScope,
          accessToken: remoteCoreAccessToken,
          signal: controller.signal,
        });
      }
      if (isV2ModelApiAccountSave) {
        return await executeV2ModelApiAccountSave({
          request,
          cacheScope,
          accessToken: protectedComputeAccessToken,
          signal: controller.signal,
        });
      }
      if (isV2TextModelRequest) {
        return await executeV2TextModelRequest({
          request,
          cacheScope,
          accessToken: protectedComputeAccessToken,
          signal: controller.signal,
          requestId,
        });
      }
      if (isV2ImageModelRequest) {
        return await executeV2ImageModelRequest({
          request,
          cacheScope,
          accessToken: protectedComputeAccessToken,
          signal: controller.signal,
          requestId,
        });
      }
      const forward = (accessToken) => {
        const targetUrl = isV2CoreLegacyRequest
          ? `${normalizedCoreServiceUrl}/api/core-v2/legacy${request.pathname}${request.search || ""}`
          : request.url;
        return fetchImpl(targetUrl, {
          method: request.method,
          headers: {
            Accept: "application/json",
            ...(request.serialized
              ? { "Content-Type": "application/json" }
              : {}),
            ...request.headers,
            ...(localCacheAgent
              ? {
                  "x-wangzai-cache-agent-token": authToken,
                  "x-wangzai-cache-scope": cacheScope,
                }
              : {
                  "x-wangzai-local-api-token": authToken,
                  ...(request.pathname.startsWith("/api/smart-reply/")
                    ? { "x-wangzai-cache-scope": cacheScope }
                    : {}),
                }),
            ...((remoteCore || isV2CoreLegacyRequest) && remoteCoreAccessToken
              ? {
                  Authorization: `Bearer ${remoteCoreAccessToken}`,
                  "x-wangzai-thin-profile-id": String(profileId || ""),
                }
              : {}),
            ...(isProtectedComputeRequest && accessToken
              ? { "x-wangzai-protected-compute-access-token": accessToken }
              : {}),
            ...(isPaidCapabilityBusinessRequest && accessToken
              ? { "x-wangzai-paid-capability-access-token": accessToken }
              : {}),
            ...(requestId ? { "x-request-id": requestId } : {}),
          },
          body: request.serialized,
          signal: controller.signal,
        });
      };
      let response = await forward(protectedComputeAccessToken);
      if ((remoteCore || isV2CoreLegacyRequest) && response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        remoteCoreAccessToken = await licenseRuntime.getUserAccessToken({
          forceRefresh: true,
          rejectedAccessToken: remoteCoreAccessToken,
        });
        response = await forward(protectedComputeAccessToken);
      }
      if (isProtectedComputeRequest && response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        try {
          protectedComputeAccessToken = await getProtectedComputeToken({
            forceRefresh: true,
            rejectedAccessToken: protectedComputeAccessToken,
          });
        } catch {
          return {
            ok: false,
            status: 401,
            error: "登录会话刷新失败，请重新登录后再使用受保护计算。",
          };
        }
        if (!protectedComputeAccessToken) {
          return {
            ok: false,
            status: 401,
            error: "登录会话刷新失败，请重新登录后再使用受保护计算。",
          };
        }
        response = await forward(protectedComputeAccessToken);
      }
      const data = await parsedResponse(response);
      if (
        remoteCore &&
        request.method === "GET" &&
        response.ok &&
        thinCache &&
        cacheScope
      ) {
        thinCache.write(cacheScope, request, data);
      }
      if (
        remoteCore &&
        request.method === "GET" &&
        !response.ok &&
        response.status >= 500 &&
        thinCache &&
        cacheScope
      ) {
        const cached = thinCache.read(cacheScope, request);
        if (cached !== undefined) {
          return {
            ok: true,
            status: 200,
            data: cached,
            cached: true,
            stale: true,
          };
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        data,
      };
    } catch (error) {
      if (remoteCore && request?.method === "GET" && thinCache && cacheScope) {
        const cached = thinCache.read(cacheScope, request);
        if (cached !== undefined) {
          return {
            ok: true,
            status: 200,
            data: cached,
            cached: true,
            stale: true,
          };
        }
      }
      return {
        ok: false,
        status: 0,
        error:
          error?.name === "AbortError"
            ? "本地 API 请求超时"
            : "无法连接本地 API",
      };
    } finally {
      clearTimeout(timer);
      if (requestId && pendingControllers.get(requestId) === controller) {
        pendingControllers.delete(requestId);
      }
    }
  };

  proxyLocalApi.cancel = (requestId) => {
    const normalized = normalizedRequestId(requestId);
    const controller = normalized ? pendingControllers.get(normalized) : null;
    if (!controller)
      return { ok: true, canceled: false, requestId: normalized || null };
    controller.abort();
    pendingControllers.delete(normalized);
    return { ok: true, canceled: true, requestId: normalized };
  };
  proxyLocalApi.pendingCount = () => pendingControllers.size;
  return proxyLocalApi;
}
