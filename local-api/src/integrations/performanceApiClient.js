import { AsyncLocalStorage } from "node:async_hooks";
import {
  normalizeText,
  normalizeLowerText,
  toFiniteNumber,
  firstText,
  firstNumber,
  normalizePerformanceBudgetRubles,
  normalizePerformanceBidRubles,
  pickArrayPayload,
  isPlainObject,
  toPerformanceInspectionRows,
  toPerformancePayloadRows,
  createPerformanceDataSet,
} from "./performanceApiNormalization.js";

const PERFORMANCE_API_TOKEN_PATH = "/api/client/token";
const PERFORMANCE_WRITE_CONFIRMATION_CODE = "EXECUTE_OZON_PERFORMANCE_WRITE";
const PERFORMANCE_REAL_QUEUE_MIN_DELAY_MS = 250;
const PERFORMANCE_WRITE_READBACK_DELAYS_MS = [0, 1000, 2000, 4000];
const PERFORMANCE_WEEKLY_BUDGET_PER_SKU_RUBLES = 2000;
const PERFORMANCE_TOKEN_REUSE_SKEW_MS = 60_000;
const PERFORMANCE_FAST_REMOTE_TIMEOUT_MS = 8_000;
const PERFORMANCE_FULL_REMOTE_TIMEOUT_MS = 12_000;

const performanceQueueStatesByOwner = new Map();
const performanceOverviewInFlightReads = new Map();
const performanceTokenReuseByAccount = new Map();
const performanceTokenKeysByOwner = new Map();
const performanceReportLifecycleTailsByOwner = new Map();
const performanceOwnerContext = new AsyncLocalStorage();
const performanceFencedOwners = new Set();
const performanceQueuedByOwner = new Map();
const performanceActiveByOwner = new Map();
let performanceRecommendationBidEndpointUnavailable = false;

import {
  readPerformanceSnapshot,
  savePerformanceSnapshot,
} from "./performanceSnapshotRuntime.js";
import {
  PERFORMANCE_API_BASE_URL,
  buildPerformanceUrl,
  createIntegrationError,
  createPerformanceTransportError,
  getPayloadValues,
  getPerformanceReportErrorMessage,
  getRemoteMessage,
  getRetryAfterMs,
  getTransportRetryDelayMs,
  isPerformanceBusyLimit,
  isPerformanceSecurityError,
  isPerformanceTransportRetryable,
  normalizeIntegrationType,
  readRemoteJson,
  readRemotePerformanceReport,
  resolvePerformanceBaseUrl,
  resolvePerformanceCredentials,
  trimTrailingSlash,
} from "./performanceApiTransport.js";
import {
  createSkippedPerformanceStage,
  getPerformanceCampaignSelectionId,
  getPerformanceHistoricalProductStatisticsDateRange,
  getPerformanceReadDepth,
  getPerformanceReadPlan,
  getPerformanceSkuStatisticsDateRange,
  normalizeDateRange,
  shouldCoalescePerformanceOverviewRead,
  shouldReadPerformanceBidInsights,
  shouldReadPerformanceCampaignObjects,
  splitPerformanceDateRange,
} from "./performanceReadPlanning.js";
import {
  buildDailyTrend,
  mergePerformanceTrendRows,
  sumMetric,
} from "./performanceCampaignMetrics.js";
import {
  normalizePerformanceCampaign,
  normalizePerformanceCandidateProduct,
  normalizePerformanceObject,
  normalizePerformanceProduct,
  normalizePerformanceStatistic,
} from "./performanceCampaignNormalization.js";
import {
  getCampaignObjectsSkipReason,
  getPerformanceProductIdentityCandidates,
  isRetiredPerformanceCampaign,
  isSearchPromoPerformanceCampaign,
  mergeCampaignRealtimeDetails,
  summarizeCampaigns,
} from "./performanceCampaignMerge.js";
import {
  findReusableStatisticsReport,
  getStatisticsReportLink,
  getStatisticsTaskState,
  getStatisticsTaskUuid,
  isStatisticsTaskFailed,
  isStatisticsTaskReady,
  normalizeStatisticsReportEndpoint,
} from "./performanceStatisticsReports.js";
import {
  combineOptionalBidResponses,
  getBidInsightSourceAvailability,
  getCompetitiveBidMap,
  getMinCpoBidMap,
  getMinimumSkuBidMap,
  getRecommendedBidMap,
  toPerformanceBidInsightRows,
} from "./performanceBidInsights.js";
import {
  createPerformanceSegmentIssues,
  dailyStatisticDedupeKey,
  dedupeSegmentedPerformanceRows,
  expenseStatisticDedupeKey,
  mediaStatisticDedupeKey,
  mergePerformanceProductStatistics,
  normalizePerformancePromotionOrder,
  productStatisticDedupeKey,
  promotionOrderDedupeKey,
  readSegmentedPerformanceRows,
  splitPerformanceValues,
} from "./performanceSegmentedStatistics.js";



function createPerformanceQueueState() {
  return {
    tail: Promise.resolve(),
    active: 0,
    queued: 0,
    total: 0,
    completed: 0,
    failed: 0,
    busyRetries: 0,
    lastRequestAt: 0,
  };
}

function getPerformanceQueueState(ownerId) {
  const key = normalizeText(ownerId);
  if (!key) throw new Error("PERFORMANCE_OWNER_SCOPE_REQUIRED");
  let state = performanceQueueStatesByOwner.get(key);
  if (!state) {
    state = createPerformanceQueueState();
    performanceQueueStatesByOwner.set(key, state);
  }
  return state;
}

function incrementOwnerCount(map, ownerId) {
  map.set(ownerId, (map.get(ownerId) || 0) + 1);
}

function decrementOwnerCount(map, ownerId) {
  const next = Math.max(0, (map.get(ownerId) || 0) - 1);
  if (next === 0) map.delete(ownerId);
  else map.set(ownerId, next);
}

function resolvePerformanceOwnerId(payload = {}, options = {}) {
  const values =
    payload?.values && typeof payload.values === "object"
      ? payload.values
      : payload;
  const accountId = normalizeText(
    options.accountId ||
      values?.accountId ||
      values?.performanceAccountId ||
      values?.performance_account_id ||
      payload?.accountId ||
      payload?.performanceAccountId,
  );
  if (accountId) return accountId;
  const shopId = normalizeText(
    values?.shopId || values?.shop_id || payload?.shopId || payload?.shop_id,
  );
  if (shopId) return `shop:${shopId}`;
  const clientId = normalizeText(
    values?.performanceClientId ||
      values?.clientId ||
      values?.client_id ||
      payload?.performanceClientId,
  );
  return clientId ? `client:${clientId}` : "validation-only";
}

function withPerformanceOwner(payload, options, action) {
  return performanceOwnerContext.run(
    resolvePerformanceOwnerId(payload, options),
    action,
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function withPerformanceReportLifecycle(task) {
  const ownerId = normalizeText(performanceOwnerContext.getStore());
  if (!ownerId) return task();
  const previous = performanceReportLifecycleTailsByOwner.get(ownerId) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  performanceReportLifecycleTailsByOwner.set(ownerId, run);
  return run.finally(() => {
    if (performanceReportLifecycleTailsByOwner.get(ownerId) === run) {
      performanceReportLifecycleTailsByOwner.delete(ownerId);
    }
  });
}

















// Ozon campaign-product responses exist in two live shapes: older/standard
// responses expose bids as rubles (for example `12`), while newer responses
// may expose the same fields as integer micros (`12000000`). Product bids in
// the hundreds of thousands of rubles are not a valid CPC value, so a large
// integer is the stable discriminator without corrupting direct ruble values.


















function getPerformanceOverviewInFlightKey(payload = {}, options = {}) {
  const values = getPayloadValues(payload);
  const dateRange = normalizeDateRange(payload);
  return JSON.stringify({
    accountId: normalizeText(
      values.accountId ||
        values.performanceAccountId ||
        values.performance_account_id ||
        values.performanceClientId ||
        values.clientId ||
        values.client_id ||
        "validation-only",
    ),
    shopId: normalizeText(values.shopId || values.shop_id || values.shopName),
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    readDepth: getPerformanceReadDepth(payload),
    campaignId: getPerformanceCampaignSelectionId(payload),
    includeCampaignObjects: shouldReadPerformanceCampaignObjects(payload),
    includeBidInsights: shouldReadPerformanceBidInsights(payload),
    baseUrl: normalizeText(options.baseUrl || ""),
  });
}

function getPerformanceQueueSnapshot() {
  const rows = [...performanceQueueStatesByOwner.entries()].map(
    ([ownerId, state]) => ({
      ownerId,
      active: state.active,
      queued: state.queued,
      total: state.total,
      completed: state.completed,
      failed: state.failed,
      busyRetries: state.busyRetries,
      lastRequestAt: state.lastRequestAt || null,
    }),
  );
  const sum = (field) =>
    rows.reduce((total, row) => total + Number(row[field] || 0), 0);
  return {
    mode: "per-account-single-concurrency",
    isolationMode: "per-account",
    active: sum("active"),
    queued: sum("queued"),
    total: sum("total"),
    completed: sum("completed"),
    failed: sum("failed"),
    busyRetries: sum("busyRetries"),
    byAccount: rows,
    minDelayMs: PERFORMANCE_REAL_QUEUE_MIN_DELAY_MS,
    note: "每个 Performance 账号使用自己的单并发队列；不同店铺账号互不等待。",
  };
}

async function enqueuePerformanceRequest(task, options = {}) {
  const ownerId = performanceOwnerContext.getStore();
  const performanceQueueState = getPerformanceQueueState(ownerId);
  if (performanceFencedOwners.has(ownerId)) {
    throw createIntegrationError(
      "PERFORMANCE_ACCOUNT_QUIESCED",
      "Performance account is being removed.",
      409,
    );
  }
  performanceQueueState.total += 1;
  performanceQueueState.queued += 1;
  incrementOwnerCount(performanceQueuedByOwner, ownerId);
  const run = performanceQueueState.tail.then(async () => {
    performanceQueueState.queued = Math.max(
      0,
      performanceQueueState.queued - 1,
    );
    decrementOwnerCount(performanceQueuedByOwner, ownerId);
    if (performanceFencedOwners.has(ownerId)) {
      throw createIntegrationError(
        "PERFORMANCE_ACCOUNT_QUIESCED",
        "Performance account is being removed.",
        409,
      );
    }
    performanceQueueState.active += 1;
    incrementOwnerCount(performanceActiveByOwner, ownerId);
    try {
      const minDelayMs = Number(options.minDelayMs) || 0;
      const elapsed = Date.now() - performanceQueueState.lastRequestAt;
      if (minDelayMs > 0 && elapsed < minDelayMs) {
        await sleep(minDelayMs - elapsed);
      }
      const result = await task();
      performanceQueueState.completed += 1;
      return result;
    } catch (error) {
      performanceQueueState.failed += 1;
      throw error;
    } finally {
      performanceQueueState.active = Math.max(
        0,
        performanceQueueState.active - 1,
      );
      performanceQueueState.lastRequestAt = Date.now();
      decrementOwnerCount(performanceActiveByOwner, ownerId);
    }
  });
  performanceQueueState.tail = run.catch(() => {});
  return run;
}

function createPerformanceTimeoutPayload(url, timeoutMs) {
  return {
    error: {
      code: "PERFORMANCE_REMOTE_TIMEOUT",
      message: `Performance API 请求超过 ${timeoutMs}ms，已停止等待。`,
    },
    endpoint: normalizeText(url),
  };
}

async function fetchPerformanceResponseWithTimeout({
  url,
  fetchImpl,
  requestOptions,
  timeoutMs,
}) {
  const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  if (!safeTimeoutMs) {
    const response = await fetchImpl(url, requestOptions);
    return { timedOut: false, response };
  }

  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const options = controller
    ? { ...requestOptions, signal: controller.signal }
    : requestOptions;
  const timeoutMarker = { timedOut: true };
  let timeoutId = null;
  const fetchPromise = Promise.resolve()
    .then(() => fetchImpl(url, options))
    .then((response) => ({ timedOut: false, response }))
    .catch((error) => ({ timedOut: false, error }));
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      controller?.abort?.();
      resolve(timeoutMarker);
    }, safeTimeoutMs);
  });
  const result = await Promise.race([fetchPromise, timeoutPromise]);
  if (timeoutId) clearTimeout(timeoutId);
  if (result === timeoutMarker || result?.timedOut) return { timedOut: true };
  if (result?.error) throw result.error;
  return result;
}

async function requestPerformanceQueuedJson({
  url,
  fetchImpl,
  requestOptions,
  responseReader = readRemoteJson,
  maxBusyRetries = 4,
  maxTransportRetries = 2,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  const isRealFetch = fetchImpl === globalThis.fetch;
  const minDelayMs = isRealFetch ? PERFORMANCE_REAL_QUEUE_MIN_DELAY_MS : 0;
  return enqueuePerformanceRequest(
    async () => {
      let busyAttempt = 0;
      let transportAttempt = 0;
      let totalAttempts = 0;
      for (;;) {
        totalAttempts += 1;
        let remoteResult;
        try {
          remoteResult = await fetchPerformanceResponseWithTimeout({
            url,
            fetchImpl,
            requestOptions,
            timeoutMs,
          });
        } catch (error) {
          if (
            transportAttempt < maxTransportRetries &&
            isPerformanceTransportRetryable(error)
          ) {
            await sleep(
              isRealFetch ? getTransportRetryDelayMs(transportAttempt) : 0,
            );
            transportAttempt += 1;
            continue;
          }
          throw createPerformanceTransportError(error);
        }
        if (remoteResult.timedOut) {
          if (transportAttempt < maxTransportRetries) {
            await sleep(
              isRealFetch ? getTransportRetryDelayMs(transportAttempt) : 0,
            );
            transportAttempt += 1;
            continue;
          }
          return {
            ok: false,
            status: 504,
            payload: createPerformanceTimeoutPayload(url, timeoutMs),
            attempts: totalAttempts,
            busyRetried: busyAttempt > 0,
            transportRetried: transportAttempt > 0,
            timedOut: true,
          };
        }
        const response = remoteResult.response;
        const payload = await responseReader(response);
        if (
          busyAttempt < maxBusyRetries &&
          isPerformanceBusyLimit(payload, response.status)
        ) {
          getPerformanceQueueState(
            performanceOwnerContext.getStore(),
          ).busyRetries += 1;
          await sleep(
            isRealFetch ? getRetryAfterMs(response.headers, busyAttempt) : 0,
          );
          busyAttempt += 1;
          continue;
        }
        return {
          ok: response.ok,
          status: response.status,
          payload,
          attempts: totalAttempts,
          busyRetried: busyAttempt > 0,
          transportRetried: transportAttempt > 0,
        };
      }
    },
    { minDelayMs },
  );
}

async function requestPerformanceReportRows({
  baseUrl,
  token,
  endpoint,
  query,
  fetchImpl,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  const response = await requestPerformanceQueuedJson({
    url: buildPerformanceUrl(baseUrl, endpoint, query),
    fetchImpl,
    requestOptions: {
      method: "GET",
      headers: {
        accept: "application/json, text/csv, text/plain",
        authorization: `Bearer ${token.accessToken}`,
      },
    },
    responseReader: readRemotePerformanceReport,
    timeoutMs,
  });
  return {
    ...response,
    rows: response.ok && Array.isArray(response.payload?.rows)
      ? response.payload.rows
      : [],
    format: normalizeText(response.payload?.format),
  };
}

function normalizeListPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { itemCount: 0, total: null };
  }
  const list =
    (Array.isArray(payload.list) && payload.list) ||
    (Array.isArray(payload.items) && payload.items) ||
    (Array.isArray(payload.rows) && payload.rows) ||
    (Array.isArray(payload.result) && payload.result) ||
    (Array.isArray(payload.objects) && payload.objects) ||
    null;
  const total = Number(payload.total ?? payload.count ?? payload.totalCount);
  return {
    itemCount: list ? list.length : 0,
    total: Number.isFinite(total) ? total : list ? list.length : null,
  };
}

function getPerformanceTokenReuseKey(baseUrl, clientId) {
  return `${trimTrailingSlash(baseUrl || PERFORMANCE_API_BASE_URL)}::${normalizeText(clientId)}`;
}

function getReusablePerformanceToken({ baseUrl, clientId, fetchImpl }) {
  if (fetchImpl !== globalThis.fetch) return null;
  const key = getPerformanceTokenReuseKey(baseUrl, clientId);
  const record = performanceTokenReuseByAccount.get(key);
  if (!record || !record.accessToken) return null;
  if (
    record.expiresAt &&
    record.expiresAt <= Date.now() + PERFORMANCE_TOKEN_REUSE_SKEW_MS
  ) {
    performanceTokenReuseByAccount.delete(key);
    return null;
  }
  return {
    accessToken: record.accessToken,
    tokenType: record.tokenType || "Bearer",
    expiresIn: record.expiresIn ?? null,
    reused: true,
  };
}

function rememberReusablePerformanceToken({ baseUrl, clientId, token }) {
  if (!token?.accessToken) return;
  const expiresInMs =
    Number(token.expiresIn) > 0 ? Number(token.expiresIn) * 1000 : 0;
  const tokenKey = getPerformanceTokenReuseKey(baseUrl, clientId);
  performanceTokenReuseByAccount.set(tokenKey, {
    accessToken: token.accessToken,
    tokenType: token.tokenType || "Bearer",
    expiresIn: token.expiresIn ?? null,
    expiresAt: expiresInMs ? Date.now() + expiresInMs : 0,
  });
  const ownerId = performanceOwnerContext.getStore();
  const ownerKeys = performanceTokenKeysByOwner.get(ownerId) || new Set();
  ownerKeys.add(tokenKey);
  performanceTokenKeysByOwner.set(ownerId, ownerKeys);
}

async function requestPerformanceToken({
  baseUrl,
  clientId,
  clientSecret,
  fetchImpl,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  const reusableToken = getReusablePerformanceToken({
    baseUrl,
    clientId,
    fetchImpl,
  });
  if (reusableToken) return reusableToken;

  const response = await requestPerformanceQueuedJson({
    url: buildPerformanceUrl(baseUrl, PERFORMANCE_API_TOKEN_PATH),
    fetchImpl,
    requestOptions: {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    },
    timeoutMs,
  });
  if (!response.ok || !response.payload?.access_token) {
    throw createIntegrationError(
      "PERFORMANCE_TOKEN_FAILED",
      `Performance Token 获取失败：${getRemoteMessage(response.payload)}`,
      response.status >= 400 && response.status < 500 ? 400 : 502,
      { remoteStatus: response.status },
    );
  }
  const token = {
    accessToken: response.payload.access_token,
    tokenType: normalizeText(response.payload.token_type) || "Bearer",
    expiresIn: Number(response.payload.expires_in) || null,
    reused: false,
  };
  if (fetchImpl === globalThis.fetch) {
    rememberReusablePerformanceToken({ baseUrl, clientId, token });
  }
  return token;
}

async function requestPerformanceReadCheck({
  baseUrl,
  token,
  endpoint,
  key,
  title,
  fetchImpl,
}) {
  const response = await requestPerformanceQueuedJson({
    url: buildPerformanceUrl(baseUrl, endpoint),
    fetchImpl,
    requestOptions: {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token.accessToken}`,
      },
    },
  });
  const listSummary = normalizeListPayload(response.payload);
  return {
    key,
    title,
    endpoint,
    ok: response.ok,
    status: response.status,
    itemCount: listSummary.itemCount,
    total: listSummary.total,
    error: response.ok
      ? null
      : {
          code:
            response.payload?.error?.code ||
            response.payload?.code ||
            "PERFORMANCE_READ_CHECK_FAILED",
          message: getRemoteMessage(response.payload),
        },
  };
}

async function requestPerformanceJson({
  baseUrl,
  token,
  endpoint,
  query,
  fetchImpl,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  return requestPerformanceQueuedJson({
    url: buildPerformanceUrl(baseUrl, endpoint, query),
    fetchImpl,
    requestOptions: {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token.accessToken}`,
      },
    },
    timeoutMs,
  });
}

async function requestPerformanceWriteJson({
  baseUrl,
  token,
  endpoint,
  query,
  method,
  body,
  fetchImpl,
  maxBusyRetries = 4,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  return requestPerformanceQueuedJson({
    url: buildPerformanceUrl(baseUrl, endpoint, query),
    fetchImpl,
    requestOptions: {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token.accessToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    maxBusyRetries,
    timeoutMs,
  });
}

function requireTextField(value, fieldName, message) {
  const text = normalizeText(value);
  if (!text) {
    throw createIntegrationError(
      "PERFORMANCE_WRITE_VALIDATION_FAILED",
      message || `${fieldName}不能为空。`,
      400,
      { field: fieldName },
    );
  }
  return text;
}

function normalizeMoneyMicros(value, fieldName) {
  const number = toFiniteNumber(value);
  if (number === null || number < 0) {
    throw createIntegrationError(
      "PERFORMANCE_WRITE_VALIDATION_FAILED",
      `${fieldName}必须是大于或等于 0 的金额。`,
      400,
      { field: fieldName },
    );
  }
  return String(Math.round(number * 1_000_000));
}

function readBudgetMicros(params = {}, key, rubleKey, label) {
  const rawValue = normalizeText(params[key]);
  if (rawValue) return rawValue;
  if (params[rubleKey] !== undefined && params[rubleKey] !== null) {
    return normalizeMoneyMicros(params[rubleKey], label);
  }
  return "";
}

function getPerformanceBudgetProductCount(params = {}) {
  const skuCount = new Set(
    (Array.isArray(params.bids) ? params.bids : [])
      .map((row) => normalizeText(row?.sku))
      .filter(Boolean),
  ).size;
  if (skuCount > 0) return skuCount;
  const reportedCount = Number(
    params.campaignProductCount ?? params.productCount ?? params.productsCount,
  );
  return Number.isFinite(reportedCount) && reportedCount > 0
    ? Math.floor(reportedCount)
    : 1;
}

function validatePerformanceWeeklyBudgetRubles(
  params = {},
  rubleKey = "weeklyBudgetRubles",
) {
  if (normalizeText(params.paymentType).toUpperCase() === "CPO") return;
  if (params[rubleKey] === undefined || params[rubleKey] === null) return;
  const rawValue = normalizeText(params[rubleKey]);
  if (!rawValue) return;
  const amount = toFiniteNumber(rawValue);
  if (amount === null || amount < 0) return;
  if (amount === 0) return;
  const productCount = getPerformanceBudgetProductCount(params);
  const minimum = productCount * PERFORMANCE_WEEKLY_BUDGET_PER_SKU_RUBLES;
  if (amount >= minimum) return;
  throw createIntegrationError(
    "PERFORMANCE_WRITE_VALIDATION_FAILED",
    `周预算最低为每个商品 ${PERFORMANCE_WEEKLY_BUDGET_PER_SKU_RUBLES} 卢布；当前 ${productCount} 个商品至少需要 ${minimum} 卢布，0 表示取消限制。`,
    400,
    { field: rubleKey, productCount, minimumRubles: minimum },
  );
}

function normalizeCpcBidRow(row = {}, strategyValue = "") {
  const sku = requireTextField(row.sku, "sku", "商品 SKU 不能为空。");
  const result = { sku };
  const configuredStrategy = normalizeText(strategyValue).toUpperCase();
  const strategy =
    configuredStrategy ||
    (normalizeText(row.topPosition)
      ? "TOP_PROMOTION"
      : toFiniteNumber(row.targetCir) !== null
        ? "TARGET_CIR"
        : normalizeText(row.bid)
          ? "TARGET_BIDS"
          : "");
  if (strategy === "TARGET_BIDS") {
    const bid = normalizeText(row.bid);
    if (!bid) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "平均点击成本策略必须填写商品出价。",
        400,
        { field: "bid", sku },
      );
    }
    result.bid = normalizeMoneyMicros(bid, "商品出价");
  } else if (strategy === "TARGET_CIR") {
    const targetCir = toFiniteNumber(row.targetCir);
    if (targetCir === null || targetCir < 10 || targetCir > 100) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "目标广告成本比必须填写 10% 到 100%。",
        400,
        { field: "targetCir", sku },
      );
    }
    result.targetCir = targetCir;
  } else if (strategy === "TOP_PROMOTION") {
    const topPosition = normalizeText(row.topPosition);
    if (!["Топ-4", "Топ-12", "Топ-20", "Топ-30"].includes(topPosition)) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "目标位置只能选择 Топ-4、Топ-12、Топ-20 或 Топ-30。",
        400,
        { field: "topPosition", sku },
      );
    }
    result.topPosition = topPosition;
  }
  return result;
}

function normalizeSearchPromoBidRow(row = {}) {
  const sku = requireTextField(row.sku, "sku", "商品 SKU 不能为空。");
  const bid = toFiniteNumber(row.bid);
  if (bid === null || bid < 0) {
    throw createIntegrationError(
      "PERFORMANCE_WRITE_VALIDATION_FAILED",
      "订单出价必须填写大于或等于 0 的商品价格占比。",
      400,
      { field: "bid", sku },
    );
  }
  return { sku, bid };
}

function normalizeSkuList(params = {}) {
  const source = Array.isArray(params.skus)
    ? params.skus
    : Array.isArray(params.sku)
      ? params.sku
      : Array.isArray(params.selectedSkus)
        ? params.selectedSkus
        : [params.sku];
  return [
    ...new Set(
      source.map((value) => normalizeText(value)).filter((value) => value),
    ),
  ];
}

function getPerformanceWriteParams(payload = {}) {
  const values = getPayloadValues(payload);
  return {
    ...(payload.payload ?? {}),
    ...(payload.params ?? {}),
    ...(values.payload ?? {}),
    ...(values.params ?? {}),
  };
}

function buildPerformanceWriteRequest(payload = {}) {
  const values = getPayloadValues(payload);
  const params = getPerformanceWriteParams(payload);
  const action = normalizeText(
    payload.action || values.action || params.action,
  );

  if (action === "createCampaign") {
    const createMode = normalizeText(
      params.createMode || params.campaignCreateType,
    );
    if (createMode && createMode !== "productCpc") {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "Ozon 当前只允许通过 Performance API 创建按点击收费的商品计划。",
        400,
        { field: "createMode" },
      );
    }
    const body = {
      title: requireTextField(params.title, "title", "计划名称不能为空。"),
      placement:
        normalizeText(params.placement) || "PLACEMENT_SEARCH_AND_CATEGORY",
      productAutopilotStrategy:
        normalizeText(params.productAutopilotStrategy) || "MAX_CLICKS",
    };
    const fromDate = normalizeText(params.fromDate);
    const toDate = normalizeText(params.toDate);
    if (fromDate) body.fromDate = fromDate;
    if (toDate) body.toDate = toDate;
    const weeklyBudget = readBudgetMicros(
      params,
      "weeklyBudget",
      "weeklyBudgetRubles",
      "周预算",
    );
    validatePerformanceWeeklyBudgetRubles(params, "weeklyBudgetRubles");
    if (weeklyBudget) body.weeklyBudget = weeklyBudget;
    return {
      action,
      title: "创建推广计划",
      method: "POST",
      endpoint: "/api/client/campaign/cpc/v2/product",
      body,
    };
  }

  if (action === "editCampaign") {
    const campaignId = requireTextField(
      params.campaignId,
      "campaignId",
      "请选择要编辑的推广计划。",
    );
    const body = {};
    validatePerformanceWeeklyBudgetRubles(params, "weeklyBudgetRubles");
    const fromDate = normalizeText(params.fromDate);
    const toDate = normalizeText(params.toDate);
    if (fromDate) body.fromDate = fromDate;
    if (toDate) body.toDate = toDate;
    if (!Object.keys(body).length) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "至少需要修改开始日期或结束日期。预算请使用“修改预算”。",
        400,
        { field: "campaign" },
      );
    }
    return {
      action,
      title: "编辑推广计划",
      method: "PATCH",
      endpoint: `/api/client/campaign/${encodeURIComponent(campaignId)}`,
      body,
    };
  }

  if (action === "updateBudget") {
    const campaignId = requireTextField(
      params.campaignId,
      "campaignId",
      "请选择要修改预算的推广计划。",
    );
    const budgetKind = normalizeText(params.budgetKind) || "weeklyBudget";
    if (!["budget", "weeklyBudget"].includes(budgetKind)) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "预算类型不正确。",
        400,
        { field: "budgetKind" },
      );
    }
    if (budgetKind === "weeklyBudget") {
      validatePerformanceWeeklyBudgetRubles(params, "budgetRubles");
    }
    const budgetValue = readBudgetMicros(
      params,
      budgetKind,
      "budgetRubles",
      "预算",
    );
    if (!budgetValue) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "预算金额不能为空。",
        400,
        { field: "budgetRubles" },
      );
    }
    return {
      action,
      title: "修改推广计划预算",
      method: "PATCH",
      endpoint: `/api/client/campaign/${encodeURIComponent(campaignId)}`,
      body: { [budgetKind]: budgetValue },
    };
  }

  if (action === "setProductBids") {
    const campaignId = requireTextField(
      params.campaignId,
      "campaignId",
      "请选择要调整出价的推广计划。",
    );
    const sourceBids = Array.isArray(params.bids)
      ? params.bids
      : [
          {
            sku: params.sku,
            bid: params.bid,
            targetCir: params.targetCir,
            topPosition: params.topPosition,
          },
        ];
    const strategy = normalizeText(
      params.productAutopilotStrategy || params.strategyCode,
    );
    const bids = sourceBids.map((row) => normalizeCpcBidRow(row, strategy));
    if (!bids.length) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "至少需要填写 1 个商品 SKU。",
        400,
        { field: "bids" },
      );
    }
    return {
      action,
      title: "调整推广商品出价",
      method: "PUT",
      endpoint: `/api/client/campaign/${encodeURIComponent(campaignId)}/products`,
      body: { bids },
    };
  }

  if (action === "setSearchPromoBids") {
    const sourceBids = Array.isArray(params.bids)
      ? params.bids
      : [
          {
            sku: params.sku,
            bid: params.bid,
            targetCir: params.targetCir,
            topPosition: params.topPosition,
          },
        ];
    const bids = sourceBids.map(normalizeSearchPromoBidRow);
    if (!bids.length) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "至少需要选择 1 个搜索推广商品。",
        400,
        { field: "bids" },
      );
    }
    if (bids.length > 1000) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "搜索推广单次最多设置 1000 个商品。",
        400,
        { field: "bids" },
      );
    }
    return {
      action,
      title: "设置搜索推广商品出价",
      method: "POST",
      endpoint: "/api/client/campaign/search_promo/v2/bids/set",
      body: { bids },
    };
  }

  if (action === "addProducts") {
    const campaignId = requireTextField(
      params.campaignId,
      "campaignId",
      "请选择要添加商品的推广计划。",
    );
    const sourceBids = Array.isArray(params.bids)
      ? params.bids
      : [
          {
            sku: params.sku,
            bid: params.bid,
            targetCir: params.targetCir,
            topPosition: params.topPosition,
          },
        ];
    const strategy = normalizeText(
      params.productAutopilotStrategy || params.strategyCode,
    );
    const bids = sourceBids.map((row) => normalizeCpcBidRow(row, strategy));
    if (!bids.length) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "至少需要选择 1 个商品。",
        400,
        { field: "bids" },
      );
    }
    if (bids.length > 500) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "单个推广计划最多添加 500 个商品。",
        400,
        { field: "bids" },
      );
    }
    return {
      action,
      title: "添加商品到推广计划",
      method: "POST",
      endpoint: `/api/client/campaign/${encodeURIComponent(campaignId)}/products`,
      body: { bids },
    };
  }

  if (action === "removeProducts") {
    const campaignId = requireTextField(
      params.campaignId,
      "campaignId",
      "请选择要移除商品的推广计划。",
    );
    const skus = normalizeSkuList(params);
    if (!skus.length) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "至少需要选择 1 个要移除的商品。",
        400,
        { field: "skus" },
      );
    }
    if (skus.length > 1000) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "单次最多移除 1000 个商品。",
        400,
        { field: "skus" },
      );
    }
    return {
      action,
      title: "移除推广计划商品",
      method: "POST",
      endpoint: `/api/client/campaign/${encodeURIComponent(campaignId)}/products/delete`,
      body: { sku: skus },
    };
  }

  if (action === "deleteSearchPromoBids") {
    const skus = normalizeSkuList(params);
    if (!skus.length) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "至少需要选择 1 个要删除搜索推广出价的商品。",
        400,
        { field: "skus" },
      );
    }
    if (skus.length > 1000) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "搜索推广单次最多删除 1000 个商品出价。",
        400,
        { field: "skus" },
      );
    }
    return {
      action,
      title: "删除搜索推广商品出价",
      method: "POST",
      endpoint: "/api/client/campaign/search_promo/v2/bids/delete",
      body: { sku: skus },
    };
  }

  if (action === "toggleSearchPromoProduct") {
    const skus = normalizeSkuList(params);
    if (!skus.length) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "至少需要选择 1 个搜索推广商品。",
        400,
        { field: "skus" },
      );
    }
    if (skus.length > 1000) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "搜索推广单次最多启停 1000 个商品。",
        400,
        { field: "skus" },
      );
    }
    const mode = normalizeLowerText(params.mode || params.nextState);
    const enabled = mode === "enable" || mode === "activate";
    return {
      action,
      title: enabled ? "开启商品搜索推广" : "关闭商品搜索推广",
      method: "POST",
      endpoint: enabled
        ? "/api/client/search_promo/product/enable"
        : "/api/client/search_promo/product/disable",
      body: { skus },
    };
  }

  if (action === "toggleAllSkuPromo") {
    const mode = normalizeLowerText(params.mode || params.nextState);
    const nextMode = mode === "activate" ? "activate" : "deactivate";
    return {
      action,
      title:
        nextMode === "activate"
          ? "开启全店按订单付费推广"
          : "关闭全店按订单付费推广",
      method: "GET",
      endpoint: `/api/client/campaign/all_sku_promo/${nextMode}`,
      query: undefined,
      body: undefined,
    };
  }

  if (action === "setAllSkuPromoBid") {
    const bid = normalizeText(params.bid);
    if (!["5", "7", "9"].includes(bid)) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "全店按订单付费费率只能选择 5%、7% 或 9%。",
        400,
        { field: "bid" },
      );
    }
    return {
      action,
      title: "修改全店按订单付费费率",
      method: "GET",
      endpoint: "/api/client/campaign/all_sku_promo/set_bid",
      query: { bid },
      body: undefined,
    };
  }

  if (action === "toggleCarrots") {
    const skus = normalizeSkuList(params);
    if (!skus.length) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "至少需要选择 1 个要加入或退出 Морковск 活动的商品。",
        400,
        { field: "skus" },
      );
    }
    if (skus.length > 1000) {
      throw createIntegrationError(
        "PERFORMANCE_WRITE_VALIDATION_FAILED",
        "Морковск 活动单次最多操作 1000 个商品。",
        400,
        { field: "skus" },
      );
    }
    const mode = normalizeLowerText(params.mode || params.nextState);
    const enabled = mode === "enable" || mode === "activate";
    return {
      action,
      title: enabled ? "商品加入 Морковск 活动" : "商品退出 Морковск 活动",
      method: "POST",
      endpoint: enabled
        ? "/api/client/campaign/search_promo/carrots/enable"
        : "/api/client/campaign/search_promo/carrots/disable",
      body: { skus },
    };
  }

  if (action === "toggleCampaign") {
    const campaignId = requireTextField(
      params.campaignId,
      "campaignId",
      "请选择要启停的推广计划。",
    );
    const mode = normalizeLowerText(params.mode || params.nextState);
    const nextMode = mode === "activate" ? "activate" : "deactivate";
    return {
      action,
      title: nextMode === "activate" ? "启动推广计划" : "暂停推广计划",
      method: "POST",
      endpoint: `/api/client/campaign/${encodeURIComponent(campaignId)}/${nextMode}`,
      body: undefined,
    };
  }

  throw createIntegrationError(
    "PERFORMANCE_WRITE_ACTION_UNSUPPORTED",
    "暂不支持该推广写入操作。",
    400,
    { action },
  );
}

function createPerformanceWritePreview(request) {
  return {
    action: request.action,
    title: request.title,
    method: request.method,
    endpoint: request.endpoint,
    query: request.query ?? null,
    body: request.body ?? null,
  };
}

function getCreatedPerformanceCampaignId(remotePayload = {}) {
  return (
    firstText(remotePayload, ["campaignId", "campaign_id", "id"]) ||
    firstText(remotePayload?.result, ["campaignId", "campaign_id", "id"]) ||
    firstText(remotePayload?.campaign, ["campaignId", "campaign_id", "id"]) ||
    firstText(pickArrayPayload(remotePayload)[0], [
      "campaignId",
      "campaign_id",
      "id",
    ])
  );
}

function isSamePerformanceAmount(actualValue, expectedValue) {
  const actual = toFiniteNumber(actualValue);
  const expected = toFiniteNumber(expectedValue);
  if (actual === null || expected === null) return false;
  return Math.abs(actual - expected) < 0.000001;
}

function toExpectedBudgetRubles(value) {
  return normalizePerformanceBudgetRubles(value);
}

function isSamePerformanceText(actualValue, expectedValue) {
  return normalizeLowerText(actualValue) === normalizeLowerText(expectedValue);
}

function isSamePerformanceDate(actualValue, expectedValue) {
  return (
    normalizeText(actualValue).slice(0, 10) ===
    normalizeText(expectedValue).slice(0, 10)
  );
}

function getPerformanceWriteCampaignId(params = {}, remotePayload = {}) {
  return (
    normalizeText(params.campaignId) ||
    getCreatedPerformanceCampaignId(remotePayload)
  );
}

function verifyPerformanceCampaignWrite({ action, request, params, campaign }) {
  if (!campaign) {
    return {
      confirmed: false,
      mismatches: ["Ozon 回读中未找到目标推广计划"],
      actual: null,
    };
  }
  const mismatches = [];
  const body = request.body || {};
  const textFields = [
    ["title", "title", "计划名称"],
    ["placement", "placementCode", "投放位置"],
    ["productAutopilotStrategy", "strategyCode", "出价策略"],
    ["advObjectType", "typeCode", "推广对象类型"],
    ["paymentType", "paymentType", "付费方式"],
  ];
  for (const [requestKey, campaignKey, label] of textFields) {
    if (!Object.prototype.hasOwnProperty.call(body, requestKey)) continue;
    if (!isSamePerformanceText(campaign[campaignKey], body[requestKey])) {
      mismatches.push(`${label}尚未回读为提交值`);
    }
  }
  for (const [requestKey, campaignKey, label] of [
    ["fromDate", "fromDate", "开始日期"],
    ["toDate", "toDate", "结束日期"],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(body, requestKey)) continue;
    if (!isSamePerformanceDate(campaign[campaignKey], body[requestKey])) {
      mismatches.push(`${label}尚未回读为提交值`);
    }
  }
  for (const [requestKey, campaignKey, label] of [
    ["budget", "totalBudget", "总预算"],
    ["dailyBudget", "dailyBudget", "日预算"],
    ["weeklyBudget", "weeklyBudget", "周预算"],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(body, requestKey)) continue;
    const expectedRubles = toExpectedBudgetRubles(body[requestKey]);
    if (!isSamePerformanceAmount(campaign[campaignKey], expectedRubles)) {
      mismatches.push(`${label}尚未回读为提交金额`);
    }
  }
  if (action === "toggleCampaign") {
    const expectedRunning =
      normalizeLowerText(params.mode || params.nextState) === "activate";
    const statusConfirmed = expectedRunning
      ? campaign.statusLabel === "运行中"
      : ["已暂停", "已停止", "已结束"].includes(campaign.statusLabel);
    if (!statusConfirmed)
      mismatches.push(
        expectedRunning ? "计划尚未回读为运行中" : "计划尚未回读为已暂停",
      );
  }
  return {
    confirmed: mismatches.length === 0,
    mismatches,
    actual: {
      campaignId: campaign.id,
      title: campaign.title,
      status: campaign.status,
      statusLabel: campaign.statusLabel,
      fromDate: campaign.fromDate,
      toDate: campaign.toDate,
      placement: campaign.placementCode,
      strategy: campaign.strategyCode,
      totalBudget: campaign.totalBudget,
      dailyBudget: campaign.dailyBudget,
      weeklyBudget: campaign.weeklyBudget,
    },
  };
}

function verifyPerformanceProductRows({ action, request, rows = [] }) {
  const productsBySku = new Map(
    rows.map((row) => [normalizeText(row?.sku), row]).filter(([sku]) => sku),
  );
  const expectedBids = Array.isArray(request.body?.bids)
    ? request.body.bids
    : [];
  const expectedSkus =
    action === "removeProducts"
      ? normalizeSkuList({ skus: request.body?.sku })
      : expectedBids.map((row) => normalizeText(row.sku)).filter(Boolean);
  const mismatches = [];
  if (action === "removeProducts") {
    for (const sku of expectedSkus) {
      if (productsBySku.has(sku)) mismatches.push(`SKU ${sku} 仍存在于计划中`);
    }
  } else {
    for (const expected of expectedBids) {
      const sku = normalizeText(expected.sku);
      const actual = productsBySku.get(sku);
      if (!actual) {
        mismatches.push(`SKU ${sku} 尚未出现在计划中`);
        continue;
      }
      if (
        Object.prototype.hasOwnProperty.call(expected, "bid") &&
        !isSamePerformanceAmount(
          actual.bid,
          normalizePerformanceBidRubles(expected.bid),
        )
      ) {
        mismatches.push(`SKU ${sku} 的出价尚未回读为提交值`);
      }
      if (
        Object.prototype.hasOwnProperty.call(expected, "targetCir") &&
        !isSamePerformanceAmount(actual.targetCir, expected.targetCir)
      ) {
        mismatches.push(`SKU ${sku} 的目标广告成本比尚未回读为提交值`);
      }
      if (
        Object.prototype.hasOwnProperty.call(expected, "topPosition") &&
        !isSamePerformanceText(actual.topPosition, expected.topPosition)
      ) {
        mismatches.push(`SKU ${sku} 的目标位置尚未回读为提交值`);
      }
    }
  }
  return {
    confirmed: expectedSkus.length > 0 && mismatches.length === 0,
    mismatches: expectedSkus.length ? mismatches : ["没有可核对的商品 SKU"],
    actual: {
      productCount: rows.length,
      matchedSkus: expectedSkus.filter((sku) => productsBySku.has(sku)),
    },
  };
}

function getSearchPromoEnabledState(row = {}) {
  for (const key of [
    "isSearchPromoEnabled",
    "searchPromoEnabled",
    "search_promo_enabled",
    "isEnabled",
    "enabled",
    "isActive",
    "active",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (typeof value === "boolean") return value;
    const text = normalizeLowerText(value);
    if (["true", "1", "enabled", "active", "running", "on"].includes(text))
      return true;
    if (["false", "0", "disabled", "inactive", "stopped", "off"].includes(text))
      return false;
  }
  const status = firstText(row, [
    "searchPromoStatus",
    "search_promo_status",
    "promotionStatus",
    "status",
    "state",
  ]);
  const statusLower = normalizeLowerText(status);
  if (/enabled|active|running|started|включ|актив/u.test(statusLower))
    return true;
  if (/disabled|inactive|stopped|paused|выключ|отключ/u.test(statusLower))
    return false;
  return null;
}

function hasExplicitPerformanceWriteAcknowledgement(remotePayload, skus = []) {
  const rows = toPerformancePayloadRows(remotePayload);
  const acknowledgements = new Map();
  for (const row of rows) {
    const sku = firstText(row, ["sku", "ozonSku", "ozon_sku", "productSku"]);
    const acknowledged =
      row?.update === true ||
      row?.updated === true ||
      row?.success === true ||
      row?.ok === true;
    if (sku) acknowledgements.set(sku, acknowledged);
  }
  if (skus.length && skus.every((sku) => acknowledgements.get(sku) === true))
    return true;
  return (
    rows.length === 1 &&
    (rows[0]?.update === true ||
      rows[0]?.updated === true ||
      rows[0]?.success === true ||
      rows[0]?.ok === true)
  );
}

function verifySearchPromoWrite({
  action,
  request,
  params,
  rows = [],
  remotePayload,
}) {
  const rowsBySku = new Map();
  for (const row of rows) {
    const normalized = normalizePerformanceCandidateProduct(row);
    rowsBySku.set(normalizeText(normalized.sku), { normalized, raw: row });
  }
  const expectedBids = Array.isArray(request.body?.bids)
    ? request.body.bids
    : [];
  const expectedSkus = expectedBids.length
    ? expectedBids.map((row) => normalizeText(row.sku)).filter(Boolean)
    : normalizeSkuList({
        skus: request.body?.skus,
        sku: request.body?.sku,
      });
  const mismatches = [];
  if (action === "setSearchPromoBids") {
    for (const expected of expectedBids) {
      const sku = normalizeText(expected.sku);
      const actual = rowsBySku.get(sku)?.normalized;
      if (!actual) {
        mismatches.push(`SKU ${sku} 尚未出现在搜索推广商品回读中`);
        continue;
      }
      if (
        Object.prototype.hasOwnProperty.call(expected, "bid") &&
        !isSamePerformanceAmount(actual.bid, expected.bid)
      ) {
        mismatches.push(`SKU ${sku} 的搜索推广出价尚未回读为提交值`);
      }
      if (
        Object.prototype.hasOwnProperty.call(expected, "targetCir") &&
        !isSamePerformanceAmount(
          firstNumber(actual.raw, ["targetCir", "target_cir", "cir"]),
          expected.targetCir,
        )
      ) {
        mismatches.push(`SKU ${sku} 的目标广告成本比尚未回读为提交值`);
      }
      if (
        Object.prototype.hasOwnProperty.call(expected, "topPosition") &&
        !isSamePerformanceText(
          firstText(actual.raw, ["topPosition", "top_position"]),
          expected.topPosition,
        )
      ) {
        mismatches.push(`SKU ${sku} 的目标位置尚未回读为提交值`);
      }
    }
  } else if (action === "deleteSearchPromoBids") {
    for (const sku of expectedSkus) {
      const actual = rowsBySku.get(sku)?.normalized;
      if (actual && actual.bid !== null && actual.bid !== undefined) {
        mismatches.push(`SKU ${sku} 的搜索推广出价仍存在`);
      }
    }
  } else if (action === "toggleSearchPromoProduct") {
    const expectedEnabled = ["enable", "activate"].includes(
      normalizeLowerText(params.mode || params.nextState),
    );
    for (const sku of expectedSkus) {
      const actual = rowsBySku.get(sku);
      const enabledState = getSearchPromoEnabledState(actual?.raw);
      if (enabledState === null) {
        mismatches.push(`SKU ${sku} 的搜索推广启停状态未在查询接口返回`);
      } else if (enabledState !== expectedEnabled) {
        mismatches.push(`SKU ${sku} 的搜索推广启停状态尚未回读为提交值`);
      }
    }
    if (
      mismatches.length &&
      hasExplicitPerformanceWriteAcknowledgement(remotePayload, expectedSkus)
    ) {
      return {
        confirmed: true,
        confirmationSource: "ozon-write-response",
        mismatches: [],
        actual: { acknowledgedSkus: expectedSkus },
      };
    }
  }
  return {
    confirmed: expectedSkus.length > 0 && mismatches.length === 0,
    confirmationSource: "ozon-readback",
    mismatches: expectedSkus.length ? mismatches : ["没有可核对的商品 SKU"],
    actual: {
      matchedSkus: expectedSkus.filter((sku) => rowsBySku.has(sku)),
    },
  };
}

async function readPerformanceSearchPromoProductsForReadback({
  baseUrl,
  token,
  fetchImpl,
  timeoutMs,
}) {
  const rows = [];
  const pageSize = 200;
  for (let page = 1; page <= 50; page += 1) {
    const response = await requestPerformanceWriteJson({
      baseUrl,
      token,
      endpoint: "/api/client/campaign/search_promo/v2/products",
      method: "POST",
      body: { page, pageSize },
      fetchImpl,
      timeoutMs,
    });
    if (!response.ok) return { ...response, rows };
    const pageRows = pickArrayPayload(response.payload);
    rows.push(...pageRows);
    const total = getPagedPayloadTotal(response.payload);
    const hasNext = Number.isFinite(total)
      ? rows.length < total
      : pageRows.length >= pageSize;
    if (!hasNext || pageRows.length === 0) return { ...response, rows };
  }
  return { ok: true, status: 200, rows, truncated: true };
}

async function readPerformanceWriteSnapshot({
  action,
  request,
  params,
  remotePayload,
  baseUrl,
  token,
  fetchImpl,
  timeoutMs,
}) {
  if (
    [
      "setSearchPromoBids",
      "deleteSearchPromoBids",
      "toggleSearchPromoProduct",
    ].includes(action)
  ) {
    const response = await readPerformanceSearchPromoProductsForReadback({
      baseUrl,
      token,
      fetchImpl,
      timeoutMs,
    });
    return {
      ok: response.ok && response.truncated !== true,
      status: response.status,
      rows: response.rows || [],
      error:
        response.truncated === true
          ? "搜索推广商品超过安全回读上限，未用不完整列表确认写入结果"
          : response.ok
            ? null
            : getRemoteMessage(response.payload),
    };
  }

  const campaignResponse = await readAllPerformanceCampaigns({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs,
  });
  if (!campaignResponse.ok) {
    return {
      ok: false,
      status: campaignResponse.status,
      error: getRemoteMessage(campaignResponse.payload),
      campaigns: [],
      products: [],
    };
  }
  const campaigns = campaignResponse.rows.map(normalizePerformanceCampaign);
  const campaignId = getPerformanceWriteCampaignId(params, remotePayload);
  const expectedTitle = normalizeText(request.body?.title || params.title);
  const exactTitleCampaigns = expectedTitle
    ? campaigns.filter(
        (row) => normalizeText(row.title) === expectedTitle,
      )
    : [];
  const campaign =
    campaigns.find(
      (row) => normalizeText(row.id) === campaignId && campaignId,
    ) ||
    (exactTitleCampaigns.length === 1 ? exactTitleCampaigns[0] : null);
  if (
    !["addProducts", "removeProducts", "setProductBids"].includes(action) ||
    !campaign
  ) {
    return { ok: true, campaigns, campaign, products: [] };
  }
  const productRead = await readCampaignProducts({
    baseUrl,
    token,
    campaigns: [campaign],
    fetchImpl,
    timeoutMs,
  });
  return {
    ok:
      productRead.issues.length === 0 &&
      productRead.unavailableCampaigns.length === 0,
    campaigns,
    campaign,
    products: productRead.productsByCampaign.get(campaign.id) || [],
    error:
      productRead.issues[0]?.message ||
      productRead.unavailableCampaigns[0]?.message ||
      "",
  };
}

function verifyPerformanceWriteSnapshot({
  action,
  request,
  params,
  remotePayload,
  snapshot,
}) {
  if (!snapshot?.ok) {
    return {
      confirmed: false,
      mismatches: [snapshot?.error || "Ozon 回读失败"],
      actual: null,
    };
  }
  if (["addProducts", "removeProducts", "setProductBids"].includes(action)) {
    return verifyPerformanceProductRows({
      action,
      request,
      rows: snapshot.products,
    });
  }
  if (
    [
      "setSearchPromoBids",
      "deleteSearchPromoBids",
      "toggleSearchPromoProduct",
    ].includes(action)
  ) {
    return verifySearchPromoWrite({
      action,
      request,
      params,
      rows: snapshot.rows,
      remotePayload,
    });
  }
  return verifyPerformanceCampaignWrite({
    action,
    request,
    params,
    campaign: snapshot.campaign,
  });
}

async function performPerformanceWriteReadback({
  action,
  request,
  payload,
  remotePayload,
  baseUrl,
  token,
  fetchImpl,
  options,
}) {
  const params = getPerformanceWriteParams(payload);
  if (
    ["toggleAllSkuPromo", "setAllSkuPromoBid", "toggleCarrots"].includes(
      action,
    )
  ) {
    const expectedSkus = normalizeSkuList(params);
    const mismatches = [];
    if (action === "setAllSkuPromoBid") {
      const actualBid = firstNumber(remotePayload, ["selectedBid", "bid"]);
      const expectedBid = toFiniteNumber(params.bid);
      if (
        actualBid !== null &&
        expectedBid !== null &&
        !isSamePerformanceAmount(actualBid, expectedBid)
      ) {
        mismatches.push("Ozon 返回的全店推广费率与提交值不一致");
      }
    }
    if (action === "toggleCarrots" && isPlainObject(remotePayload?.skuToInfo)) {
      const expectedDisabled = !["enable", "activate"].includes(
        normalizeLowerText(params.mode || params.nextState),
      );
      for (const sku of expectedSkus) {
        const info = remotePayload.skuToInfo[sku];
        if (!isPlainObject(info) || typeof info.isDisabled !== "boolean") continue;
        if (info.isDisabled !== expectedDisabled) {
          mismatches.push(`SKU ${sku} 的 Морковск 活动状态与提交值不一致`);
        }
      }
    }
    return {
      status: mismatches.length ? "pending" : "confirmed",
      confirmed: mismatches.length === 0,
      attempts: 1,
      confirmationSource: "ozon-write-response",
      mismatches,
      actual: {
        mode: normalizeText(params.mode || params.nextState),
        bid: normalizeText(params.bid),
        acknowledgedSkus: expectedSkus,
        response: remotePayload ?? null,
      },
    };
  }
  const configuredDelays = Array.isArray(options.writeReadbackDelaysMs)
    ? options.writeReadbackDelaysMs
    : PERFORMANCE_WRITE_READBACK_DELAYS_MS;
  const delays = configuredDelays.length ? configuredDelays : [0];
  let lastVerification = null;
  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index] > 0) await sleep(delays[index]);
    try {
      const snapshot = await readPerformanceWriteSnapshot({
        action,
        request,
        params,
        remotePayload,
        baseUrl,
        token,
        fetchImpl,
        timeoutMs:
          options.writeReadbackTimeoutMs || PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
      });
      lastVerification = verifyPerformanceWriteSnapshot({
        action,
        request,
        params,
        remotePayload,
        snapshot,
      });
    } catch (error) {
      lastVerification = {
        confirmed: false,
        mismatches: [normalizeText(error?.message) || "Ozon 回读失败"],
        actual: null,
      };
    }
    if (lastVerification.confirmed) {
      return {
        status: "confirmed",
        confirmed: true,
        attempts: index + 1,
        confirmationSource:
          lastVerification.confirmationSource || "ozon-readback",
        mismatches: [],
        actual: lastVerification.actual,
      };
    }
  }
  return {
    status: "pending",
    confirmed: false,
    attempts: delays.length,
    confirmationSource: "ozon-readback",
    mismatches: lastVerification?.mismatches || [
      "Ozon 回读尚未返回提交后的状态",
    ],
    actual: lastVerification?.actual || null,
  };
}

function recordPerformanceNotifications({
  notificationService,
  payload,
  campaigns,
}) {
  if (!notificationService?.recordNotification) {
    return {
      budgetExhausted: 0,
      moderationRejected: 0,
      recorded: 0,
      deduped: 0,
    };
  }
  const values = getPayloadValues(payload);
  const shopId = normalizeText(
    values.shopId || values.shop_id || payload.shopId || payload.shop_id,
  );
  const shopName = normalizeText(
    values.shopName ||
      values.shop_name ||
      payload.shopName ||
      payload.shop_name,
  );
  const result = {
    budgetExhausted: 0,
    moderationRejected: 0,
    recorded: 0,
    deduped: 0,
  };
  for (const campaign of campaigns) {
    if (campaign.alerts?.budgetExhausted) {
      result.budgetExhausted += 1;
      const recorded = notificationService.recordNotification({
        shopId,
        shopName,
        domain: "performance",
        eventType: "performance_budget_exhausted",
        severity: "warning",
        title: "付费推广：计划预算已花完",
        summary: `计划「${campaign.title}」预算已花完，请检查是否需要追加预算。`,
        entityType: "performance_campaign",
        entityId: campaign.id,
        sourceEndpoint: "/api/client/campaign",
        newValue: {
          status: campaign.status,
          statusLabel: campaign.statusLabel,
          budget: campaign.budget,
          spent: campaign.spent,
          budgetRemaining: campaign.budgetRemaining,
        },
        dedupeWindowMinutes: 365 * 24 * 60,
      });
      if (recorded?.deduped) result.deduped += 1;
      else if (recorded?.id) result.recorded += 1;
    }
    if (campaign.alerts?.moderationRejected) {
      result.moderationRejected += 1;
      const recorded = notificationService.recordNotification({
        shopId,
        shopName,
        domain: "performance",
        eventType: "performance_moderation_rejected",
        severity: "error",
        title: "付费推广：广告审核不通过",
        summary: `计划「${campaign.title}」审核不通过，请进入付费推广页面查看详情。`,
        entityType: "performance_campaign",
        entityId: campaign.id,
        sourceEndpoint: "/api/client/campaign",
        newValue: {
          status: campaign.status,
          statusLabel: campaign.statusLabel,
          statusText: campaign.statusText,
        },
        dedupeWindowMinutes: 365 * 24 * 60,
      });
      if (recorded?.deduped) result.deduped += 1;
      else if (recorded?.id) result.recorded += 1;
    }
  }
  return result;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function readOptionalPerformanceJson({
  baseUrl,
  token,
  endpoint,
  query,
  method = "GET",
  body,
  fetchImpl,
  label,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  let response;
  try {
    response =
      normalizeLowerText(method) === "get"
        ? await requestPerformanceJson({
            baseUrl,
            token,
            endpoint,
            query,
            fetchImpl,
            timeoutMs,
          })
        : await requestPerformanceWriteJson({
            baseUrl,
            token,
            endpoint,
            method,
            body,
            fetchImpl,
            timeoutMs,
          });
  } catch (error) {
    if (isPerformanceSecurityError(error)) throw error;
    return {
      ok: false,
      endpoint,
      label,
      status: error?.statusCode || 0,
      rows: [],
      error: {
        code: error?.code || "READ_FAILED",
        message:
          error instanceof Error
            ? error.message
            : String(error || "Performance API 实时读取失败。"),
      },
    };
  }
  if (response.ok) {
    return {
      ok: true,
      endpoint,
      label,
      payload: response.payload,
      rows: pickArrayPayload(response.payload),
    };
  }
  return {
    ok: false,
    endpoint,
    label,
    status: response.status,
    rows: [],
    error: {
      code:
        response.payload?.error?.code ||
        response.payload?.code ||
        "READ_FAILED",
      message: getRemoteMessage(response.payload),
    },
  };
}

async function readFirstAvailablePerformanceJson({
  baseUrl,
  token,
  endpointCandidates,
  query,
  fetchImpl,
  label,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  const endpoints = Array.isArray(endpointCandidates)
    ? endpointCandidates.filter(Boolean)
    : [];
  let lastResponse = null;
  const attempts = [];
  for (const endpoint of endpoints) {
    const response = await readOptionalPerformanceJson({
      baseUrl,
      token,
      endpoint,
      query,
      fetchImpl,
      label,
      timeoutMs,
    });
    attempts.push({
      endpoint,
      ok: response.ok,
      status: response.status || 200,
    });
    if (response.ok) return { ...response, attempts };
    lastResponse = response;
  }
  return {
    ...(lastResponse || {
      ok: false,
      endpoint: endpoints[0] || "",
      label,
      status: 0,
      rows: [],
      error: { message: `${label || "辅助接口"}没有可读取的接口路径。` },
    }),
    attempts,
  };
}

async function recoverReusableStatisticsReport({
  baseUrl,
  token,
  campaignIds,
  dateRange,
  fetchImpl,
}) {
  const response = await requestPerformanceJson({
    baseUrl,
    token,
    endpoint: "/api/client/statistics/externallist",
    query: { page: 1, pageSize: 100 },
    fetchImpl,
  });
  if (!response.ok) return null;
  return findReusableStatisticsReport(response.payload, {
    campaignIds,
    dateRange,
  });
}

async function readAsyncStatisticsReport(args) {
  try {
    return await withPerformanceReportLifecycle(() =>
      readAsyncStatisticsReportUnsafe(args),
    );
  } catch (error) {
    if (isPerformanceSecurityError(error)) throw error;
    return {
      ok: false,
      endpoint: "/api/client/statistics/json",
      status: error?.statusCode || 0,
      rows: [],
      task: null,
      error: {
        code: error?.code || "READ_FAILED",
        message:
          error instanceof Error
            ? error.message
            : String(error || "统计任务实时读取失败。"),
      },
    };
  }
}

async function readAsyncStatisticsReportUnsafe({
  baseUrl,
  token,
  campaignIds,
  dateRange,
  fetchImpl,
}) {
  if (!campaignIds.length) {
    return {
      ok: false,
      skipped: true,
      endpoint: "/api/client/statistics/json",
      rows: [],
      task: null,
      error: { message: "没有可生成统计任务的推广计划。" },
    };
  }
  const createResponse = await requestPerformanceWriteJson({
    baseUrl,
    token,
    endpoint: "/api/client/statistics/json",
    method: "POST",
    body: {
      campaigns: campaignIds,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      groupBy: "DATE",
    },
    fetchImpl,
    maxBusyRetries: 0,
  });
  let taskPayload = createResponse.payload;
  let reusedTask = false;
  if (!createResponse.ok && Number(createResponse.status) === 429) {
    const reusableReport = await recoverReusableStatisticsReport({
      baseUrl,
      token,
      campaignIds,
      dateRange,
      fetchImpl,
    });
    if (reusableReport) {
      taskPayload = reusableReport;
      reusedTask = true;
    }
  }
  if (!createResponse.ok && !reusedTask) {
    return {
      ok: false,
      endpoint: "/api/client/statistics/json",
      status: createResponse.status,
      rows: [],
      task: null,
      error: { message: getPerformanceReportErrorMessage(createResponse.payload) },
    };
  }
  const uuid = getStatisticsTaskUuid(taskPayload);
  if (!uuid) {
    const inlineRows = pickArrayPayload(taskPayload);
    return {
      ok: inlineRows.length > 0,
      endpoint: "/api/client/statistics/json",
      status: createResponse.status,
      rows: inlineRows,
      task: {
        uuid: "",
        state: inlineRows.length ? "OK" : "UNKNOWN",
        polls: 0,
        reused: reusedTask,
      },
      error: inlineRows.length ? null : { message: "统计任务未返回 UUID。" },
    };
  }

  const pollDelayMs = fetchImpl === globalThis.fetch ? 1500 : 0;
  const maxPolls = fetchImpl === globalThis.fetch ? 6 : 4;
  let lastStatusPayload = null;
  for (let pollIndex = 0; pollIndex < maxPolls; pollIndex += 1) {
    if (pollIndex > 0) await sleep(pollDelayMs);
    const statusResponse = await requestPerformanceJson({
      baseUrl,
      token,
      endpoint: `/api/client/statistics/${encodeURIComponent(uuid)}`,
      fetchImpl,
    });
    if (!statusResponse.ok) {
      return {
        ok: false,
        endpoint: `/api/client/statistics/${uuid}`,
        status: statusResponse.status,
        rows: [],
        task: {
          uuid,
          state: "HTTP_ERROR",
          polls: pollIndex + 1,
          reused: reusedTask,
        },
        error: { message: getRemoteMessage(statusResponse.payload) },
      };
    }
    lastStatusPayload = statusResponse.payload;
    const inlineRows = pickArrayPayload(statusResponse.payload);
    if (inlineRows.length) {
      return {
        ok: true,
        endpoint: `/api/client/statistics/${uuid}`,
        status: statusResponse.status,
        rows: inlineRows,
        task: {
          uuid,
          state: getStatisticsTaskState(statusResponse.payload) || "OK",
          polls: pollIndex + 1,
          reused: reusedTask,
        },
        error: null,
      };
    }
    if (isStatisticsTaskFailed(statusResponse.payload)) {
      return {
        ok: false,
        endpoint: `/api/client/statistics/${uuid}`,
        status: statusResponse.status,
        rows: [],
        task: {
          uuid,
          state: getStatisticsTaskState(statusResponse.payload) || "ERROR",
          polls: pollIndex + 1,
          reused: reusedTask,
        },
        error: {
          message:
            getRemoteMessage(statusResponse.payload) || "统计任务生成失败。",
        },
      };
    }
    if (!isStatisticsTaskReady(statusResponse.payload)) continue;

    const reportEndpoint = normalizeStatisticsReportEndpoint(
      getStatisticsReportLink(statusResponse.payload),
    );
    if (!reportEndpoint) {
      return {
        ok: false,
        endpoint: `/api/client/statistics/${uuid}`,
        status: statusResponse.status,
        rows: [],
        task: {
          uuid,
          state: getStatisticsTaskState(statusResponse.payload) || "OK",
          polls: pollIndex + 1,
          reused: reusedTask,
        },
        error: { message: "统计任务已完成，但未返回可下载链接。" },
      };
    }
    const reportResponse = await requestPerformanceJson({
      baseUrl,
      token,
      endpoint: reportEndpoint,
      fetchImpl,
    });
    return {
      ok: reportResponse.ok,
      endpoint: reportEndpoint,
      status: reportResponse.status,
      rows: reportResponse.ok ? pickArrayPayload(reportResponse.payload) : [],
      task: {
        uuid,
        state: getStatisticsTaskState(statusResponse.payload) || "OK",
        polls: pollIndex + 1,
        link: reportEndpoint,
        reused: reusedTask,
      },
      error: reportResponse.ok
        ? null
        : { message: getRemoteMessage(reportResponse.payload) },
    };
  }

  return {
    ok: false,
    endpoint: `/api/client/statistics/${uuid}`,
    status: 202,
    rows: [],
    task: {
      uuid,
      state: getStatisticsTaskState(lastStatusPayload) || "IN_PROGRESS",
      polls: maxPolls,
      reused: reusedTask,
    },
    error: { message: "统计任务仍在生成中，请稍后刷新。" },
  };
}

const PERFORMANCE_ADVANCED_REPORTS = {
  allSkuOrders: {
    label: "全店推广订单",
    endpoint: "/api/client/statistics/all_sku_promo/orders/generate/json",
    method: "GET",
  },
  allSkuProducts: {
    label: "全店推广商品",
    endpoint: "/api/client/statistics/all_sku_promo/products/generate/json",
    method: "GET",
  },
  phrases: {
    label: "搜索词统计",
    endpoint: "/api/client/statistics/phrases/json",
    method: "POST",
  },
  attribution: {
    label: "推广归因统计",
    endpoint: "/api/client/statistics/attribution/json",
    method: "POST",
  },
  video: {
    label: "视频推广统计",
    endpoint: "/api/client/statistics/video/json",
    method: "POST",
  },
  vendorTraffic: {
    label: "外部流量统计",
    endpoint: "/api/client/vendors/statistics",
    method: "POST",
    vendorType: "TRAFFIC_SOURCES",
  },
  vendorOrders: {
    label: "外部订单统计",
    endpoint: "/api/client/vendors/statistics",
    method: "POST",
    vendorType: "ORDERS",
  },
};

function getPerformanceReportCampaignIds(values = {}) {
  const source = Array.isArray(values.campaignIds)
    ? values.campaignIds
    : [values.campaignId];
  return [...new Set(source.map(normalizeText).filter(Boolean))];
}

async function readSingleGeneratedPerformanceReportUnsafe({
  baseUrl,
  token,
  config,
  values,
  dateRange,
  fetchImpl,
  maxPolls: configuredMaxPolls,
}) {
  const campaignIds = getPerformanceReportCampaignIds(values);
  if (["phrases", "attribution", "video"].includes(values.reportKind) && !campaignIds.length) {
    throw createIntegrationError(
      "PERFORMANCE_REPORT_CAMPAIGN_REQUIRED",
      "该报表需要先选择至少一个适用的推广计划。",
      400,
    );
  }
  const query = ["allSkuOrders", "allSkuProducts"].includes(values.reportKind)
    ? {
        "timeBounds.from": `${dateRange.dateFrom}T00:00:00Z`,
        "timeBounds.to": `${dateRange.dateTo}T23:59:59Z`,
      }
    : undefined;
  let body;
  if (["phrases", "attribution"].includes(values.reportKind)) {
    body = {
      campaigns: campaignIds,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      from: `${dateRange.dateFrom}T00:00:00Z`,
      to: `${dateRange.dateTo}T23:59:59Z`,
      groupBy: "DATE",
    };
  } else if (values.reportKind === "video") {
    body = {
      campaigns: campaignIds,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      groupBy: "DATE",
    };
  } else if (config.vendorType) {
    body = {
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      type: config.vendorType,
    };
  }
  const createResponse = await requestPerformanceWriteJson({
    baseUrl,
    token,
    endpoint: config.endpoint,
    query,
    method: config.method,
    body,
    fetchImpl,
    maxBusyRetries: fetchImpl === globalThis.fetch ? 2 : 4,
  });
  if (!createResponse.ok) {
    return {
      ok: false,
      endpoint: config.endpoint,
      status: createResponse.status,
      rows: [],
      task: null,
      error: {
        message: getPerformanceReportErrorMessage(
          createResponse.payload,
          `${config.label}创建失败。`,
        ),
      },
    };
  }
  const inlineRows = pickArrayPayload(createResponse.payload);
  const uuid = getStatisticsTaskUuid(createResponse.payload);
  if (!uuid) {
    return {
      ok: true,
      endpoint: config.endpoint,
      status: createResponse.status,
      rows: inlineRows,
      task: null,
      error: null,
    };
  }
  const maxPolls = Number.isFinite(Number(configuredMaxPolls))
    ? Math.max(1, Math.min(60, Number(configuredMaxPolls)))
    : fetchImpl === globalThis.fetch
      ? 30
      : 4;
  const pollDelayMs = fetchImpl === globalThis.fetch ? 1_000 : 0;
  let lastPayload = null;
  for (let index = 0; index < maxPolls; index += 1) {
    if (index > 0) await sleep(pollDelayMs);
    const statusEndpoint = config.vendorType
      ? `/api/client/vendors/statistics/${encodeURIComponent(uuid)}`
      : `/api/client/statistics/${encodeURIComponent(uuid)}`;
    const statusResponse = await requestPerformanceJson({
      baseUrl,
      token,
      endpoint: statusEndpoint,
      query: config.vendorType ? { vendor: true } : undefined,
      fetchImpl,
    });
    if (!statusResponse.ok) {
      return {
        ok: false,
        endpoint: statusEndpoint,
        status: statusResponse.status,
        rows: [],
        task: { uuid, state: "HTTP_ERROR", polls: index + 1 },
        error: { message: getPerformanceReportErrorMessage(statusResponse.payload) },
      };
    }
    lastPayload = statusResponse.payload;
    const statusRows = pickArrayPayload(lastPayload);
    if (statusRows.length) {
      return {
        ok: true,
        endpoint: statusEndpoint,
        status: statusResponse.status,
        rows: statusRows,
        task: { uuid, state: getStatisticsTaskState(lastPayload) || "OK", polls: index + 1 },
        error: null,
      };
    }
    if (isStatisticsTaskFailed(lastPayload)) {
      return {
        ok: false,
        endpoint: statusEndpoint,
        status: statusResponse.status,
        rows: [],
        task: { uuid, state: getStatisticsTaskState(lastPayload) || "ERROR", polls: index + 1 },
        error: { message: getPerformanceReportErrorMessage(lastPayload, "报表任务生成失败。") },
      };
    }
    if (!isStatisticsTaskReady(lastPayload)) continue;
    const reportEndpoint = normalizeStatisticsReportEndpoint(getStatisticsReportLink(lastPayload));
    if (!reportEndpoint) {
      return {
        ok: false,
        endpoint: statusEndpoint,
        status: statusResponse.status,
        rows: [],
        task: { uuid, state: getStatisticsTaskState(lastPayload) || "OK", polls: index + 1 },
        error: { message: "报表任务已完成，但 Ozon 没有返回可下载链接。" },
      };
    }
    const reportResponse = config.vendorType
      ? await requestPerformanceReportRows({
          baseUrl,
          token,
          endpoint: reportEndpoint,
          fetchImpl,
        })
      : await requestPerformanceJson({
          baseUrl,
          token,
          endpoint: reportEndpoint,
          fetchImpl,
        });
    return {
      ok: reportResponse.ok,
      endpoint: reportEndpoint,
      status: reportResponse.status,
      rows: reportResponse.ok
        ? config.vendorType
          ? reportResponse.rows
          : pickArrayPayload(reportResponse.payload)
        : [],
      task: {
        uuid,
        state: getStatisticsTaskState(lastPayload) || "OK",
        polls: index + 1,
        link: reportEndpoint,
      },
      error: reportResponse.ok
        ? null
        : { message: getPerformanceReportErrorMessage(reportResponse.payload) },
    };
  }
  return {
    ok: false,
    endpoint: `/api/client/statistics/${uuid}`,
    status: 202,
    rows: [],
    task: { uuid, state: getStatisticsTaskState(lastPayload) || "IN_PROGRESS", polls: maxPolls },
    error: { message: "报表仍在生成中，请稍后刷新。" },
  };
}

function readSingleGeneratedPerformanceReport(args) {
  return withPerformanceReportLifecycle(() =>
    readSingleGeneratedPerformanceReportUnsafe(args),
  );
}

const PERFORMANCE_MAX_CAMPAIGNS_PER_REPORT = 10;

function splitPerformanceCampaignIds(
  campaignIds = [],
  maxCampaigns = PERFORMANCE_MAX_CAMPAIGNS_PER_REPORT,
) {
  const normalized = [
    ...new Set(campaignIds.map(normalizeText).filter(Boolean)),
  ];
  const batchSize = Math.max(1, Math.floor(Number(maxCampaigns) || 1));
  const batches = [];
  for (let index = 0; index < normalized.length; index += batchSize) {
    batches.push(normalized.slice(index, index + batchSize));
  }
  return batches;
}

function dedupePerformanceAdvancedReportRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readGeneratedPerformanceReport(args) {
  const { values = {}, config } = args;
  const reportKind = normalizeText(values.reportKind);
  if (!["phrases", "attribution", "video"].includes(reportKind)) {
    return readSingleGeneratedPerformanceReport(args);
  }
  const campaignIds = getPerformanceReportCampaignIds(values);
  if (!campaignIds.length) {
    return {
      ok: true,
      endpoint: config.endpoint,
      status: 200,
      rows: [],
      tasks: [],
      error: null,
      message: "当前账号没有适用于该报表的推广计划。",
    };
  }
  const batches = splitPerformanceCampaignIds(campaignIds);
  const results = [];
  for (const campaignBatch of batches) {
    const response = await readSingleGeneratedPerformanceReport({
      ...args,
      values: { ...values, campaignIds: campaignBatch },
    });
    results.push({ ...response, campaignIds: campaignBatch });
    if (!response.ok && [202, 429].includes(Number(response.status))) break;
  }
  const successfulResults = results.filter((item) => item.ok);
  const failedResults = results.filter((item) => !item.ok);
  const rows = dedupePerformanceAdvancedReportRows(
    successfulResults.flatMap((item) => item.rows || []),
  );
  return {
    ok: failedResults.length === 0,
    partial: successfulResults.length > 0 && failedResults.length > 0,
    endpoint: config.endpoint,
    status: failedResults[0]?.status || successfulResults[0]?.status || 200,
    rows,
    task: results.length === 1 ? results[0]?.task || null : null,
    tasks: results.flatMap((item) => item.task ? [item.task] : item.tasks || []),
    batchCount: results.length,
    requestedBatchCount: batches.length,
    error: failedResults.length
      ? {
          message: failedResults[0]?.error?.message || "部分推广报表读取失败。",
        }
      : null,
  };
}

async function readHistoricalProductStatisticsReport({
  baseUrl,
  token,
  campaignIds,
  dateRange,
  fetchImpl,
}) {
  const campaignBatches = splitPerformanceCampaignIds(campaignIds);
  const dateSegments = splitPerformanceDateRange(dateRange);
  if (!campaignBatches.length || !dateSegments.length) {
    return {
      ok: false,
      skipped: true,
      endpoint: "/api/client/statistics/json",
      label: "历史商品统计",
      rows: [],
      segments: [],
      segmentCount: 0,
      successfulSegmentCount: 0,
      failedSegmentCount: 0,
      tasks: [],
      error: null,
    };
  }

  const segments = [];
  const rowItems = [];
  const tasks = [];
  let segmentIndex = 0;
  // Ozon permits only one report export at a time per account. Keep both date
  // and campaign batches sequential; a single report may contain at most ten
  // campaigns and at most 62 days.
  reportSegments: for (const segmentRange of dateSegments) {
    for (const batch of campaignBatches) {
      const response = await readAsyncStatisticsReport({
        baseUrl,
        token,
        campaignIds: batch,
        dateRange: segmentRange,
        fetchImpl,
      });
      const segment = {
        index: segmentIndex,
        dateFrom: segmentRange.dateFrom,
        dateTo: segmentRange.dateTo,
        campaignIds: batch,
        ok: Boolean(response?.ok),
        endpoint: normalizeText(response?.endpoint),
        status: response?.status || (response?.ok ? 200 : 0),
        rowCount: Array.isArray(response?.rows) ? response.rows.length : 0,
        attempts: [],
        task: response?.task || null,
        error: response?.error || null,
      };
      segments.push(segment);
      if (response?.task) tasks.push(response.task);
      for (const [rowIndex, row] of (response?.rows || []).entries()) {
        rowItems.push({ row, rowIndex, segment });
      }
      segmentIndex += 1;
      // The account allows only one active export. Once a report is still
      // generating (or Ozon reports the active-report limit), starting the
      // next batch can only create a 429 storm and never produce useful data.
      if (
        !response?.ok &&
        (Number(response?.status) === 202 || Number(response?.status) === 429)
      ) {
        break reportSegments;
      }
    }
  }

  const successfulSegmentCount = segments.filter(
    (segment) => segment.ok,
  ).length;
  const failedSegments = segments.filter((segment) => !segment.ok);
  const firstFailure = failedSegments[0] || null;
  const firstSuccess = segments.find((segment) => segment.ok) || null;
  return {
    ok: failedSegments.length === 0,
    complete: failedSegments.length === 0,
    partial: successfulSegmentCount > 0 && failedSegments.length > 0,
    endpoint:
      firstSuccess?.endpoint ||
      firstFailure?.endpoint ||
      "/api/client/statistics/json",
    label: "历史商品统计",
    status: firstFailure?.status || firstSuccess?.status || 200,
    rows: dedupeSegmentedPerformanceRows(rowItems, productStatisticDedupeKey),
    segments,
    segmentCount: segments.length,
    successfulSegmentCount,
    failedSegmentCount: failedSegments.length,
    tasks,
    task:
      tasks.length === 1
        ? tasks[0]
        : {
            uuid: "",
            state: failedSegments.length ? "PARTIAL" : "OK",
            polls: tasks.reduce(
              (total, task) => total + (Number(task?.polls) || 0),
              0,
            ),
            tasks,
          },
    error: firstFailure
      ? {
          code:
            firstFailure.error?.code || "HISTORICAL_PRODUCT_STATISTICS_FAILED",
          message: `历史商品统计有 ${failedSegments.length}/${segments.length} 个分段读取失败；首个失败范围 ${firstFailure.dateFrom} 至 ${firstFailure.dateTo}：${firstFailure.error?.message || "读取失败"}`,
        }
      : null,
  };
}

async function readOptionalRecommendationBids({
  baseUrl,
  token,
  skus,
  fetchImpl,
}) {
  if (!skus.length) return { ok: true, rows: [], map: new Map() };
  if (performanceRecommendationBidEndpointUnavailable) {
    return {
      ok: true,
      unavailable: true,
      status: 404,
      rows: [],
      map: new Map(),
      successfulRequestedSkus: new Set(),
      failedRequestedSkus: new Set(),
      reason: "当前 Ozon Performance 版本不再提供独立推荐出价接口。",
    };
  }
  const responses = await mapWithConcurrency(
    splitPerformanceValues(skus),
    3,
    async (batch) => ({
      ...(await requestPerformanceWriteJson({
        baseUrl,
        token,
        endpoint: "/api/client/search_promo/bids/recommendation",
        method: "POST",
        body: { skus: batch },
        fetchImpl,
      })),
      requestedSkus: batch,
    }),
  );
  const combined = combineOptionalBidResponses(responses, getRecommendedBidMap);
  if (!combined.ok && Number(combined.status) === 404) {
    performanceRecommendationBidEndpointUnavailable = true;
    return {
      ...combined,
      ok: true,
      partial: false,
      unavailable: true,
      error: null,
      failedRequestedSkus: new Set(),
      reason: "当前 Ozon Performance 版本不再提供独立推荐出价接口。",
    };
  }
  return combined;
}

async function readOptionalCompetitiveBids({
  baseUrl,
  token,
  campaignId,
  skus,
  fetchImpl,
}) {
  if (!campaignId || !skus.length)
    return { ok: true, rows: [], map: new Map(), skipped: true };
  const endpoint = `/api/client/campaign/${encodeURIComponent(campaignId)}/products/bids/competitive`;
  const responses = await mapWithConcurrency(
    splitPerformanceValues(skus),
    3,
    async (batch) => ({
      ...(await requestPerformanceJson({
        baseUrl,
        token,
        endpoint,
        query: { skus: batch },
        fetchImpl,
      })),
      requestedSkus: batch,
    }),
  );
  return combineOptionalBidResponses(responses, getCompetitiveBidMap);
}

async function readOptionalMinCpoBids({ baseUrl, token, skus, fetchImpl }) {
  if (!skus.length) return { ok: true, rows: [], map: new Map() };
  const responses = await mapWithConcurrency(
    splitPerformanceValues(skus),
    3,
    async (batch) => ({
      ...(await requestPerformanceWriteJson({
        baseUrl,
        token,
        endpoint: "/api/client/search_promo/get_cpo_min_bids",
        method: "POST",
        body: { skus: batch },
        fetchImpl,
      })),
      requestedSkus: batch,
    }),
  );
  return combineOptionalBidResponses(responses, getMinCpoBidMap);
}

async function readOptionalMinimumSkuBids({
  baseUrl,
  token,
  skus,
  fetchImpl,
  marketplaceId = "RU",
  paymentType = "CPC",
}) {
  if (!skus.length) return { ok: true, rows: [], map: new Map() };
  const responses = await mapWithConcurrency(
    splitPerformanceValues(skus),
    3,
    async (batch) => ({
      ...(await requestPerformanceWriteJson({
        baseUrl,
        token,
        endpoint: "/api/client/min/sku",
        method: "POST",
        body: { marketplaceId, paymentType, sku: batch },
        fetchImpl,
      })),
      requestedSkus: batch,
    }),
  );
  return combineOptionalBidResponses(responses, getMinimumSkuBidMap);
}

async function readCampaignProductBidInsights({
  baseUrl,
  token,
  campaigns = [],
  productsByCampaign = new Map(),
  fetchImpl,
}) {
  const skus = [
    ...new Set(
      campaigns.flatMap((campaign) =>
        (productsByCampaign.get(campaign.id) || [])
          .map((product) => normalizeText(product?.sku))
          .filter(Boolean),
      ),
    ),
  ];
  if (!skus.length) {
    return {
      skipped: true,
      status: "skipped",
      rows: [],
      issues: [],
      reason: "当前计划没有可读取出价的商品。",
    };
  }

  const [recommendation, minCpo, minimumCpc, competitiveRows] = await Promise.all([
    readOptionalRecommendationBids({ baseUrl, token, skus, fetchImpl }),
    readOptionalMinCpoBids({ baseUrl, token, skus, fetchImpl }),
    readOptionalMinimumSkuBids({ baseUrl, token, skus, fetchImpl }),
    mapWithConcurrency(campaigns, 4, async (campaign) => {
      const campaignSkus = [
        ...new Set(
          (productsByCampaign.get(campaign.id) || [])
            .map((product) => normalizeText(product?.sku))
            .filter(Boolean),
        ),
      ];
      const response = await readOptionalCompetitiveBids({
        baseUrl,
        token,
        campaignId: campaign.id,
        skus: campaignSkus,
        fetchImpl,
      });
      return { campaign, response };
    }),
  ]);
  const competitiveByCampaign = new Map(
    competitiveRows.map(({ campaign, response }) => [
      normalizeText(campaign.id),
      response,
    ]),
  );
  const rows = [];
  for (const campaign of campaigns) {
    const competitive = competitiveByCampaign.get(
      normalizeText(campaign.id),
    ) || {
      ok: true,
      skipped: true,
      map: new Map(),
    };
    const nextProducts = (productsByCampaign.get(campaign.id) || []).map(
      (product) => {
        const sku = normalizeText(product?.sku);
        // Each visible reference value belongs to one exact official endpoint.
        // Never reuse a previous/product-row value when that endpoint failed or
        // returned no value, otherwise a partial read would look complete.
        const recommendedBid = recommendation.map.has(sku)
          ? normalizePerformanceBidRubles(recommendation.map.get(sku))
          : null;
        const competitiveBid = competitive.map.has(sku)
          ? normalizePerformanceBidRubles(competitive.map.get(sku))
          : null;
        const minCpoBid = minCpo.map.has(sku)
          ? normalizePerformanceBidRubles(minCpo.map.get(sku))
          : null;
        const minimumCpcBid = minimumCpc.map.has(sku)
          ? toFiniteNumber(minimumCpc.map.get(sku))
          : null;
        const nextProduct = {
          ...product,
          recommendedBid,
          competitiveBid,
          minCpoBid,
          minimumCpcBid,
          bidAvailability: {
            recommended: getBidInsightSourceAvailability(
              recommendation,
              recommendation.map.has(sku),
              sku,
            ),
            competitive: getBidInsightSourceAvailability(
              competitive,
              competitive.map.has(sku),
              sku,
            ),
            minCpo: getBidInsightSourceAvailability(
              minCpo,
              minCpo.map.has(sku),
              sku,
            ),
            minimumCpc: getBidInsightSourceAvailability(
              minimumCpc,
              minimumCpc.map.has(sku),
              sku,
            ),
          },
        };
        rows.push(nextProduct);
        return nextProduct;
      },
    );
    productsByCampaign.set(campaign.id, nextProducts);
  }

  const issues = [
    ...(recommendation.ok
      ? []
      : [
          {
            kind: "recommended-bids",
            label: "推荐出价",
            endpoint: "/api/client/search_promo/bids/recommendation",
            status: recommendation.status,
            message: recommendation.error?.message || "推荐出价读取失败",
          },
        ]),
    ...competitiveRows.flatMap(({ campaign, response }) =>
      response.ok
        ? []
        : [
            {
              kind: "competitive-bids",
              label: "竞争出价",
              campaignId: campaign.id,
              campaignTitle: campaign.title,
              endpoint: `/api/client/campaign/${campaign.id}/products/bids/competitive`,
              status: response.status,
              message: response.error?.message || "竞争出价读取失败",
            },
          ],
    ),
    ...(minCpo.ok
      ? []
      : [
          {
            kind: "min-cpo-bids",
            label: "最低订单出价",
            endpoint: "/api/client/search_promo/get_cpo_min_bids",
            status: minCpo.status,
            message: minCpo.error?.message || "最低订单出价读取失败",
          },
          ]),
    ...(minimumCpc.ok
      ? []
      : [
          {
            kind: "minimum-cpc-bids",
            label: "最低 CPC 出价",
            endpoint: "/api/client/min/sku",
            status: minimumCpc.status,
            message: minimumCpc.error?.message || "最低 CPC 出价读取失败",
          },
        ]),
  ];
  const successfulSourceCount =
    [recommendation, minCpo, minimumCpc].filter(
      (response) => response.ok || response.partial,
    ).length +
    competitiveRows.filter(({ response }) => response.ok || response.partial)
      .length;
  const sourceCount = 3 + competitiveRows.length;
  return {
    ok: issues.length === 0,
    partial: issues.length > 0 && successfulSourceCount > 0,
    status:
      issues.length === 0
        ? rows.length
          ? "success"
          : "empty"
        : successfulSourceCount > 0
          ? "partial"
          : "failed",
    rows,
    issues,
    sourceCount,
    successfulSourceCount,
    failedSourceCount: issues.length,
    sources: {
      recommendation,
      minCpo,
      minimumCpc,
      competitive: competitiveRows,
    },
  };
}

async function readPerformanceProductCandidatesImpl(
  payload = {},
  options = {},
) {
  const { clientId, clientSecret } = await resolvePerformanceCredentials(
    payload,
    options,
  );
  if (!clientId || !clientSecret) {
    throw createIntegrationError(
      "PERFORMANCE_CREDENTIALS_REQUIRED",
      "请填写 Ozon Performance API 的 client_id 和 client_secret。",
      400,
    );
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw createIntegrationError(
      "FETCH_UNAVAILABLE",
      "当前 Node 运行环境不支持 fetch。",
      500,
    );
  }

  const values = getPayloadValues(payload);
  const baseUrl = resolvePerformanceBaseUrl(payload, options);
  const page = Math.max(1, Number(values.page) || 1);
  const pageSize = Math.max(1, Math.min(200, Number(values.pageSize) || 80));
  const keyword = normalizeLowerText(values.keyword);
  const availabilityFilter = normalizeLowerText(
    values.availabilityFilter || values.availableFilter,
  );
  const campaignId = normalizeText(values.campaignId);
  const stages = [];
  const startedAt = new Date().toISOString();

  stages.push({
    key: "token",
    label: "正在获取 Performance token",
    status: "running",
  });
  const token = await requestPerformanceToken({
    baseUrl,
    clientId,
    clientSecret,
    fetchImpl,
  });
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: "success",
  };

  stages.push({
    key: "products",
    label: "正在读取可推广商品池",
    status: "running",
  });
  const productResponse = await requestPerformanceWriteJson({
    baseUrl,
    token,
    endpoint: "/api/client/campaign/search_promo/v2/products",
    method: "POST",
    body: { page, pageSize },
    fetchImpl,
  });
  if (!productResponse.ok) {
    throw createIntegrationError(
      "PERFORMANCE_PRODUCTS_READ_FAILED",
      `可推广商品池读取失败：${getRemoteMessage(productResponse.payload)}`,
      productResponse.status >= 400 && productResponse.status < 500 ? 400 : 502,
      { remoteStatus: productResponse.status },
    );
  }
  let rows = pickArrayPayload(productResponse.payload).map(
    normalizePerformanceCandidateProduct,
  );
  if (keyword) {
    rows = rows.filter((row) =>
      [row.sku, row.sourceSku, row.title, row.id, row.key]
        .map(normalizeLowerText)
        .some((value) => value.includes(keyword)),
    );
  }
  if (availabilityFilter === "available") {
    rows = rows.filter((row) => row.available !== false);
  } else if (availabilityFilter === "unavailable") {
    rows = rows.filter((row) => row.available === false);
  }
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: "success",
    count: rows.length,
  };

  const skus = rows
    .map((row) => row.sku)
    .filter(Boolean)
    .slice(0, 200);
  stages.push({
    key: "recommendedBids",
    label: "正在读取推荐出价",
    status: "running",
  });
  const recommendation = await readOptionalRecommendationBids({
    baseUrl,
    token,
    skus,
    fetchImpl,
  });
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: recommendation.ok ? "success" : "partial",
    count: recommendation.map.size,
  };

  stages.push({
    key: "competitiveBids",
    label: "正在读取竞争出价",
    status: "running",
  });
  const competitive = await readOptionalCompetitiveBids({
    baseUrl,
    token,
    campaignId,
    skus,
    fetchImpl,
  });
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: competitive.ok ? "success" : "partial",
    count: competitive.map.size,
    skipped: competitive.skipped || undefined,
  };

  stages.push({
    key: "minCpoBids",
    label: "正在读取最低 CPO 出价",
    status: "running",
  });
  const minCpo = await readOptionalMinCpoBids({
    baseUrl,
    token,
    skus,
    fetchImpl,
  });
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: minCpo.ok ? "success" : "partial",
    count: minCpo.map.size,
  };

  stages.push({
    key: "minimumCpcBids",
    label: "正在读取最低 CPC 出价",
    status: "running",
  });
  const minimumCpc = await readOptionalMinimumSkuBids({
    baseUrl,
    token,
    skus,
    fetchImpl,
    marketplaceId: normalizeText(values.marketplaceId) || "RU",
    paymentType: "CPC",
  });
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: minimumCpc.ok ? "success" : "partial",
    count: minimumCpc.map.size,
  };

  rows = rows.map((row) => ({
    ...row,
    recommendedBid: recommendation.map.get(row.sku) ?? null,
    competitiveBid: competitive.map.get(row.sku) ?? null,
    minCpoBid: minCpo.map.get(row.sku) ?? null,
    minimumCpcBid: minimumCpc.map.get(row.sku) ?? null,
  }));

  const total = Number(
    productResponse.payload?.total ?? productResponse.payload?.count,
  );
  const effectiveTotal = Number.isFinite(total) ? total : rows.length;
  return {
    ok: true,
    source: "ozon-performance-realtime",
    provider: "Ozon Performance API",
    cache: {
      enabled: false,
      fallback: false,
      note: "付费推广商品选择直接读取 Performance API，不使用本地商品缓存兜底。",
    },
    requestPolicy: getPerformanceQueueSnapshot(),
    startedAt,
    finishedAt: new Date().toISOString(),
    page,
    pageSize,
    total: effectiveTotal,
    hasNext: page * pageSize < effectiveTotal,
    rows,
    stages,
    readIssues: [
      ...(recommendation.ok
        ? []
        : [
            {
              endpoint: "/api/client/search_promo/bids/recommendation",
              status: recommendation.status,
              message: recommendation.error?.message || "推荐出价读取失败",
            },
          ]),
      ...(competitive.ok
        ? []
        : [
            {
              endpoint:
                "/api/client/campaign/{campaignId}/products/bids/competitive",
              status: competitive.status,
              message: competitive.error?.message || "竞争出价读取失败",
            },
          ]),
      ...(minCpo.ok
        ? []
        : [
            {
              endpoint: "/api/client/search_promo/get_cpo_min_bids",
              status: minCpo.status,
              message: minCpo.error?.message || "最低 CPO 出价读取失败",
            },
          ]),
      ...(minimumCpc.ok
        ? []
        : [
            {
              endpoint: "/api/client/min/sku",
              status: minimumCpc.status,
              message: minimumCpc.error?.message || "最低 CPC 出价读取失败",
            },
          ]),
    ],
  };
}

async function readPerformanceAdvancedReportImpl(payload = {}, options = {}) {
  const values = getPayloadValues(payload);
  const reportKind = normalizeText(values.reportKind || payload.reportKind);
  const config = PERFORMANCE_ADVANCED_REPORTS[reportKind];
  if (!config) {
    throw createIntegrationError(
      "PERFORMANCE_REPORT_UNSUPPORTED",
      "暂不支持该推广报表。",
      400,
      { reportKind },
    );
  }
  const { clientId, clientSecret } = await resolvePerformanceCredentials(payload, options);
  if (!clientId || !clientSecret) {
    throw createIntegrationError(
      "PERFORMANCE_CREDENTIALS_REQUIRED",
      "请填写 Ozon Performance API 的 client_id 和 client_secret。",
      400,
    );
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw createIntegrationError("FETCH_UNAVAILABLE", "当前 Node 运行环境不支持 fetch。", 500);
  }
  const baseUrl = resolvePerformanceBaseUrl(payload, options);
  const token = await requestPerformanceToken({
    baseUrl,
    clientId,
    clientSecret,
    fetchImpl,
  });
  let eligibleCampaigns = null;
  let reportValues = { ...values, reportKind };
  if (["phrases", "attribution", "video"].includes(reportKind)) {
    const campaignsResponse = await readAllPerformanceCampaigns({
      baseUrl,
      token,
      fetchImpl,
    });
    if (!campaignsResponse.ok) {
      return {
        ok: false,
        reportKind,
        label: config.label,
        source: "ozon-performance-realtime",
        provider: "Ozon Performance API",
        generatedAt: new Date().toISOString(),
        rows: [],
        error: {
          message: `无法读取推广计划，不能准确生成${config.label}：${getRemoteMessage(campaignsResponse.payload)}`,
        },
      };
    }
    const requestedIds = new Set(getPerformanceReportCampaignIds(values));
    const normalizedCampaigns = campaignsResponse.rows.map(normalizePerformanceCampaign);
    const scopedCampaigns = requestedIds.size
      ? normalizedCampaigns.filter((campaign) => requestedIds.has(campaign.id))
      : normalizedCampaigns;
    const isEligible = (campaign) => {
      const type = normalizeLowerText(campaign.typeCode);
      const placement = normalizeText(campaign.placementCode).toUpperCase();
      const payment = normalizeText(campaign.paymentType).toUpperCase();
      if (reportKind === "phrases") {
        return (
          placement === "PLACEMENT_TOP_PROMOTION" &&
          (!payment || payment === "CPC" || payment === "PAY_PER_CLICK") &&
          !type.includes("banner") &&
          !type.includes("video")
        );
      }
      if (reportKind === "attribution") {
        return type.includes("banner") && !type.includes("video");
      }
      return type.includes("video");
    };
    eligibleCampaigns = scopedCampaigns.filter(isEligible);
    reportValues = {
      ...reportValues,
      campaignIds: eligibleCampaigns.map((campaign) => campaign.id),
    };
    if (!eligibleCampaigns.length) {
      const reportKindLabel = reportKind === "phrases"
        ? "置顶推广（按点击付费）"
        : reportKind === "attribution"
          ? "横幅广告"
          : "视频广告";
      return {
        ok: true,
        reportKind,
        label: config.label,
        source: "ozon-performance-realtime",
        provider: "Ozon Performance API",
        generatedAt: new Date().toISOString(),
        rows: [],
        task: null,
        error: null,
        message: `当前账号没有${reportKindLabel}计划，因此该报表没有可读取的数据。`,
        eligibility: {
          campaignCount: normalizedCampaigns.length,
          scopedCampaignCount: scopedCampaigns.length,
          eligibleCampaignCount: 0,
        },
      };
    }
  }
  const result = await readGeneratedPerformanceReport({
    baseUrl,
    token,
    config,
    values: reportValues,
    dateRange: normalizeDateRange(payload),
    fetchImpl,
    maxPolls: options.reportMaxPolls,
  });
  return {
    ...result,
    reportKind,
    label: config.label,
    source: "ozon-performance-realtime",
    provider: "Ozon Performance API",
    generatedAt: new Date().toISOString(),
    ...(eligibleCampaigns
      ? {
          eligibility: {
            eligibleCampaignCount: eligibleCampaigns.length,
          },
        }
      : {}),
  };
}

async function readSearchPromoStatisticsReportUnsafe({
  baseUrl,
  token,
  reportKind,
  dateRange,
  fetchImpl,
  maxPolls: configuredMaxPolls,
}) {
  const normalizedKind = reportKind === "orders" ? "orders" : "products";
  const endpoint = `/api/client/statistic/${normalizedKind}/generate/json`;
  try {
    const createResponse = await requestPerformanceWriteJson({
      baseUrl,
      token,
      endpoint,
      method: "POST",
      body: {
        from: `${dateRange.dateFrom}T00:00:00Z`,
        to: `${dateRange.dateTo}T23:59:59Z`,
      },
      fetchImpl,
      maxBusyRetries: fetchImpl === globalThis.fetch ? 2 : 4,
    });
    if (!createResponse.ok) {
      return {
        ok: false,
        endpoint,
        status: createResponse.status,
        rows: [],
        task: null,
        error: { message: getPerformanceReportErrorMessage(createResponse.payload, "订单推广报表创建失败。") },
      };
    }
    const uuid = getStatisticsTaskUuid(createResponse.payload);
    if (!uuid) {
      const inlineRows = pickArrayPayload(createResponse.payload);
      return {
        ok: inlineRows.length > 0,
        endpoint,
        status: createResponse.status,
        rows: inlineRows,
        task: {
          uuid: "",
          state: inlineRows.length ? "OK" : "UNKNOWN",
          polls: 0,
        },
        error: inlineRows.length
          ? null
          : { message: "订单推广统计任务未返回 UUID。" },
      };
    }
    const pollDelayMs = fetchImpl === globalThis.fetch ? 1_000 : 0;
    const maxPolls = Number.isFinite(Number(configuredMaxPolls))
      ? Math.max(1, Math.min(60, Number(configuredMaxPolls)))
      : fetchImpl === globalThis.fetch
        ? 8
        : 4;
    let lastStatusPayload = null;
    for (let pollIndex = 0; pollIndex < maxPolls; pollIndex += 1) {
      if (pollIndex > 0) await sleep(pollDelayMs);
      const statusResponse = await requestPerformanceJson({
        baseUrl,
        token,
        endpoint: `/api/client/statistics/${encodeURIComponent(uuid)}`,
        fetchImpl,
      });
      if (!statusResponse.ok) {
        return {
          ok: false,
          endpoint: `/api/client/statistics/${uuid}`,
          status: statusResponse.status,
          rows: [],
          task: { uuid, state: "HTTP_ERROR", polls: pollIndex + 1 },
          error: { message: getPerformanceReportErrorMessage(statusResponse.payload, "订单推广报表状态读取失败。") },
        };
      }
      lastStatusPayload = statusResponse.payload;
      const inlineRows = pickArrayPayload(statusResponse.payload);
      if (inlineRows.length) {
        return {
          ok: true,
          endpoint: `/api/client/statistics/${uuid}`,
          status: statusResponse.status,
          rows: inlineRows,
          task: {
            uuid,
            state: getStatisticsTaskState(statusResponse.payload) || "OK",
            polls: pollIndex + 1,
          },
          error: null,
        };
      }
      if (isStatisticsTaskFailed(statusResponse.payload)) {
        return {
          ok: false,
          endpoint: `/api/client/statistics/${uuid}`,
          status: statusResponse.status,
          rows: [],
          task: {
            uuid,
            state: getStatisticsTaskState(statusResponse.payload) || "ERROR",
            polls: pollIndex + 1,
          },
          error: {
            message:
              getPerformanceReportErrorMessage(
                statusResponse.payload,
                "订单推广报表生成失败。",
              ),
          },
        };
      }
      if (!isStatisticsTaskReady(statusResponse.payload)) continue;
      const reportEndpoint = normalizeStatisticsReportEndpoint(
        getStatisticsReportLink(statusResponse.payload),
      );
      if (!reportEndpoint) {
        return {
          ok: false,
          endpoint: `/api/client/statistics/${uuid}`,
          status: statusResponse.status,
          rows: [],
          task: {
            uuid,
            state: getStatisticsTaskState(statusResponse.payload) || "OK",
            polls: pollIndex + 1,
          },
          error: { message: "订单推广报表已完成，但未返回下载地址。" },
        };
      }
      const reportResponse = await requestPerformanceJson({
        baseUrl,
        token,
        endpoint: reportEndpoint,
        fetchImpl,
      });
      return {
        ok: reportResponse.ok,
        endpoint: reportEndpoint,
        status: reportResponse.status,
        rows: reportResponse.ok ? pickArrayPayload(reportResponse.payload) : [],
        task: {
          uuid,
          state: getStatisticsTaskState(statusResponse.payload) || "OK",
          polls: pollIndex + 1,
          link: reportEndpoint,
        },
        error: reportResponse.ok
          ? null
          : { message: getPerformanceReportErrorMessage(reportResponse.payload, "订单推广报表下载失败。") },
      };
    }
    return {
      ok: false,
      endpoint: `/api/client/statistics/${uuid}`,
      status: 202,
      rows: [],
      task: {
        uuid,
        state: getStatisticsTaskState(lastStatusPayload) || "IN_PROGRESS",
        polls: maxPolls,
      },
      error: { message: "订单推广报表仍在生成中，请稍后刷新。" },
    };
  } catch (error) {
    if (isPerformanceSecurityError(error)) throw error;
    return {
      ok: false,
      endpoint,
      status: error?.statusCode || 0,
      rows: [],
      task: null,
      error: {
        code: error?.code || "READ_FAILED",
        message:
          error instanceof Error
            ? error.message
            : String(error || "订单推广报表读取失败。"),
      },
    };
  }
}

function readSearchPromoStatisticsReport(args) {
  return withPerformanceReportLifecycle(() =>
    readSearchPromoStatisticsReportUnsafe(args),
  );
}

async function readSegmentedSearchPromoStatisticsReport({
  baseUrl,
  token,
  reportKind,
  dateRange,
  fetchImpl,
  maxPolls,
}) {
  const normalizedKind = reportKind === "orders" ? "orders" : "products";
  const result = await readSegmentedPerformanceRows({
    dateRange,
    label: normalizedKind === "orders" ? "推广订单报表" : "按订单计费商品统计",
    dedupeKey:
      normalizedKind === "orders"
        ? promotionOrderDedupeKey
        : productStatisticDedupeKey,
    readSegment: (segmentRange) =>
      readSearchPromoStatisticsReport({
        baseUrl,
        token,
        reportKind: normalizedKind,
        dateRange: segmentRange,
        fetchImpl,
        maxPolls,
      }),
  });
  const tasks = result.segments.map((segment) => segment.task).filter(Boolean);
  return {
    ...result,
    task:
      tasks.length === 1
        ? tasks[0]
        : {
            uuid: "",
            state: result.ok ? "OK" : result.partial ? "PARTIAL" : "ERROR",
            polls: tasks.reduce(
              (total, task) => total + (Number(task.polls) || 0),
              0,
            ),
            tasks,
          },
  };
}

async function readSegmentedFirstAvailablePerformanceJson({
  baseUrl,
  token,
  endpointCandidates,
  query,
  fetchImpl,
  label,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
  dateRange,
  dedupeKey,
}) {
  return readSegmentedPerformanceRows({
    dateRange,
    label,
    dedupeKey,
    readSegment: (segmentRange) =>
      readFirstAvailablePerformanceJson({
        baseUrl,
        token,
        endpointCandidates,
        query: {
          ...query,
          dateFrom: segmentRange.dateFrom,
          dateTo: segmentRange.dateTo,
        },
        fetchImpl,
        label,
        timeoutMs,
      }),
  });
}

async function readPerformancePromotionOrdersImpl(payload = {}, options = {}) {
  const { clientId, clientSecret } = await resolvePerformanceCredentials(
    payload,
    options,
  );
  if (!clientId || !clientSecret) {
    throw createIntegrationError(
      "PERFORMANCE_CREDENTIALS_REQUIRED",
      "请填写 Ozon Performance API 的 client_id 和 client_secret。",
      400,
    );
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw createIntegrationError(
      "FETCH_UNAVAILABLE",
      "当前 Node 运行环境不支持 fetch。",
      500,
    );
  }

  const baseUrl = resolvePerformanceBaseUrl(payload, options);
  const dateRange = normalizeDateRange(payload);
  const startedAt = new Date().toISOString();
  const token = await requestPerformanceToken({
    baseUrl,
    clientId,
    clientSecret,
    fetchImpl,
  });
  const report = await readSegmentedSearchPromoStatisticsReport({
    baseUrl,
    token,
    reportKind: "orders",
    dateRange,
    fetchImpl,
    // 订单报表只在用户进入对应报表时生成，可以比首屏指标多等一会，
    // 但仍设置上限，避免 Ozon 任务异常时把页面永久挂住。
    maxPolls: fetchImpl === globalThis.fetch ? 20 : 6,
  });
  if (!report.ok && !report.partial) {
    throw createIntegrationError(
      report.task?.state === "IN_PROGRESS"
        ? "PERFORMANCE_ORDERS_REPORT_PENDING"
        : "PERFORMANCE_ORDERS_REPORT_READ_FAILED",
      report.error?.message || "推广订单报表读取失败。",
      report.task?.state === "IN_PROGRESS" ? 503 : 502,
      { remoteStatus: report.status, task: report.task || null },
    );
  }

  const rows = report.rows.map(normalizePerformancePromotionOrder);
  const distinctOrderIds = new Set(
    rows.map((row) => row.orderId).filter(Boolean),
  );
  const hasStableOrderIdentity = rows.every((row) => normalizeText(row.orderId));
  return {
    ok: report.ok,
    complete: report.ok,
    partial: report.partial,
    source: "ozon-performance-realtime",
    provider: "Ozon Performance API",
    startedAt,
    finishedAt: new Date().toISOString(),
    dateRange,
    total: rows.length,
    summary: {
      rowCount: rows.length,
      // An item quantity is not an order count. Only expose an exact order
      // count when every returned row carries an order identity; an empty,
      // completed report is the only other authoritative zero.
      orderCount: rows.length ? (hasStableOrderIdentity ? distinctOrderIds.size : null) : 0,
      itemQuantity: sumMetric(rows, "quantity"),
      revenue: sumMetric(rows, "revenue"),
      spent: sumMetric(rows, "spent"),
    },
    rows,
    task: report.task,
    segmentCount: report.segmentCount,
    successfulSegmentCount: report.successfulSegmentCount,
    failedSegmentCount: report.failedSegmentCount,
    segments: report.segments,
    error: report.error,
  };
}

function getCampaignProductReadRequest(
  campaign = {},
  page = 1,
  pageSize = 200,
) {
  const campaignId = encodeURIComponent(campaign.id);
  if (isSearchPromoPerformanceCampaign(campaign)) {
    return {
      endpoint: `/api/client/campaign/${campaignId}/search_promo/v2/products`,
      method: "POST",
      body: { page, pageSize },
    };
  }
  return {
    endpoint: `/api/client/campaign/${campaignId}/v2/products`,
    method: "GET",
    query: { page, pageSize },
  };
}

function getPagedPayloadTotal(payload) {
  return firstNumber(payload, ["total", "totalCount", "total_count", "count"]);
}

async function readCampaignProducts({
  baseUrl,
  token,
  campaigns,
  fetchImpl,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  const productsByCampaign = new Map();
  const issues = [];
  const unavailableCampaigns = [];
  const results = await mapWithConcurrency(campaigns, 4, async (campaign) => {
    const rows = [];
    const pageSize = 200;
    for (let page = 1; page <= 50; page += 1) {
      const request = getCampaignProductReadRequest(campaign, page, pageSize);
      const response = await readOptionalPerformanceJson({
        baseUrl,
        token,
        ...request,
        fetchImpl,
        timeoutMs,
        label: `计划「${campaign.title}」商品列表`,
      });
      if (!response.ok) {
        const issue = {
          kind: "campaign-products",
          label: "计划商品",
          campaignId: campaign.id,
          campaignTitle: campaign.title,
          endpoint: request.endpoint,
          status: response.status,
          message: response.error?.message || "商品列表读取失败",
        };
        if (
          (response.status === 400 || response.status === 404) &&
          (isRetiredPerformanceCampaign(campaign) ||
            isSearchPromoPerformanceCampaign(campaign))
        ) {
          unavailableCampaigns.push({
            ...issue,
            message: isRetiredPerformanceCampaign(campaign)
              ? "已归档计划当前不提供商品明细"
              : "订单付费计划当前没有可读取的商品明细",
          });
        } else {
          issues.push(issue);
        }
        break;
      }
      rows.push(...response.rows);
      const total = getPagedPayloadTotal(response.payload);
      const hasNext = Number.isFinite(total)
        ? rows.length < total
        : response.rows.length >= pageSize;
      if (!hasNext || response.rows.length === 0) break;
    }
    return {
      campaignId: campaign.id,
      products: rows.map((row, index) =>
        normalizePerformanceProduct(row, campaign, index),
      ),
    };
  });
  for (const result of results) {
    productsByCampaign.set(result.campaignId, result.products);
  }
  return {
    productsByCampaign,
    issues,
    unavailableCampaigns,
    totalProducts: results.reduce(
      (sum, item) => sum + (item.products?.length || 0),
      0,
    ),
  };
}

async function readCampaignObjects({
  baseUrl,
  token,
  campaigns,
  fetchImpl,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  const objectsByCampaign = new Map();
  const issues = [];
  const skippedCampaigns = [];
  const unavailableCampaigns = [];
  const results = await mapWithConcurrency(campaigns, 1, async (campaign) => {
    const skipReason = getCampaignObjectsSkipReason(campaign);
    if (skipReason) {
      skippedCampaigns.push({
        campaignId: campaign.id,
        campaignTitle: campaign.title,
        reason: skipReason,
      });
      return { campaignId: campaign.id, objects: [], skipped: true };
    }
    const endpoint = `/api/client/campaign/${encodeURIComponent(campaign.id)}/objects`;
    const response = await readOptionalPerformanceJson({
      baseUrl,
      token,
      endpoint,
      fetchImpl,
      timeoutMs,
      label: `计划「${campaign.title}」投放对象`,
    });
    if (!response.ok) {
      const issue = {
        kind: "campaign-objects",
        label: "投放对象",
        campaignId: campaign.id,
        campaignTitle: campaign.title,
        endpoint,
        status: response.status,
        message: response.error?.message || "投放对象读取失败",
      };
      if (response.status === 404) {
        unavailableCampaigns.push({
          ...issue,
          message: "当前计划不提供单独投放对象明细",
        });
      } else {
        issues.push(issue);
      }
      return { campaignId: campaign.id, objects: [] };
    }
    return {
      campaignId: campaign.id,
      objects: response.rows.map((row, index) =>
        normalizePerformanceObject(row, campaign, index),
      ),
    };
  });
  for (const result of results) {
    objectsByCampaign.set(result.campaignId, result.objects);
  }
  return {
    objectsByCampaign,
    issues,
    skippedCampaigns,
    unavailableCampaigns,
    requestedCampaignCount: campaigns.length - skippedCampaigns.length,
    totalObjects: results.reduce(
      (sum, item) => sum + (item.objects?.length || 0),
      0,
    ),
  };
}

function findCampaignReadEntry(rows = [], campaignId = "") {
  const target = normalizeText(campaignId);
  return (Array.isArray(rows) ? rows : []).find(
    (row) => normalizeText(row?.campaignId) === target,
  );
}

function createCampaignDetailAvailability({
  campaign,
  includeCampaignDetails,
  includeCampaignObjects,
  includeBidInsights,
  productRead,
  objectRead,
  bidInsightRead,
}) {
  const products = Array.isArray(campaign?.products) ? campaign.products : [];
  const objects = Array.isArray(campaign?.objects) ? campaign.objects : [];
  const productIssue = findCampaignReadEntry(productRead?.issues, campaign?.id);
  const productUnavailable = findCampaignReadEntry(
    productRead?.unavailableCampaigns,
    campaign?.id,
  );
  const objectIssue = findCampaignReadEntry(objectRead?.issues, campaign?.id);
  const objectUnavailable = findCampaignReadEntry(
    objectRead?.unavailableCampaigns,
    campaign?.id,
  );
  const objectSkipped = findCampaignReadEntry(
    objectRead?.skippedCampaigns,
    campaign?.id,
  );
  const derivedObjectCount = objects.filter(
    (row) => row?.objectSource === "campaign-product",
  ).length;
  const bidRows = (
    Array.isArray(bidInsightRead?.rows) ? bidInsightRead.rows : []
  ).filter(
    (row) => normalizeText(row?.campaignId) === normalizeText(campaign?.id),
  );
  const getProductStatus = () => {
    if (!includeCampaignDetails) return "skipped";
    if (productIssue) return products.length ? "partial" : "failed";
    if (productUnavailable) return "unavailable";
    return products.length ? "success" : "empty";
  };
  const getObjectStatus = () => {
    if (!includeCampaignDetails || !includeCampaignObjects) return "skipped";
    if (objectIssue) return objects.length ? "partial" : "failed";
    if (objects.length) return "success";
    if (objectUnavailable) return "unavailable";
    if (objectSkipped) return "skipped";
    return "empty";
  };
  return {
    products: {
      status: getProductStatus(),
      count: products.length,
      note: productIssue?.message || productUnavailable?.message || "",
    },
    objects: {
      status: getObjectStatus(),
      count: objects.length,
      source: derivedObjectCount
        ? "campaign-products"
        : objects.length
          ? "campaign-objects"
          : "",
      note: derivedObjectCount
        ? `投放对象接口未返回独立行，已用同一计划的 ${derivedObjectCount} 个权威商品明细补全。`
        : objectIssue?.message ||
          objectUnavailable?.message ||
          objectSkipped?.reason ||
          "",
    },
    bidInsights: {
      status:
        includeCampaignDetails && includeBidInsights
          ? normalizeLowerText(bidInsightRead?.status) ||
            (bidRows.length ? "success" : "empty")
          : "skipped",
      count: bidRows.length,
      note: normalizeText(bidInsightRead?.reason),
    },
  };
}

async function readAllPerformanceCampaigns({
  baseUrl,
  token,
  fetchImpl,
  timeoutMs = PERFORMANCE_FULL_REMOTE_TIMEOUT_MS,
}) {
  const endpoint = "/api/client/campaign";
  const rows = [];
  const seenCampaignIds = new Set();
  let lastPayload = null;
  let pageSize = 0;
  for (let page = 1; page <= 100; page += 1) {
    const response = await requestPerformanceJson({
      baseUrl,
      token,
      endpoint,
      // Keep the first request identical to the historical endpoint. Ozon
      // normally returns the complete campaign list; pagination is activated
      // only when the payload explicitly proves that more rows exist.
      query: page === 1 ? undefined : { page, pageSize },
      fetchImpl,
      timeoutMs,
    });
    if (!response.ok)
      return {
        ...response,
        endpoint,
        rows,
        payload: lastPayload || response.payload,
      };
    lastPayload = response.payload;
    const pageRows = pickArrayPayload(response.payload);
    for (const row of pageRows) {
      const campaignId = firstText(row, [
        "id",
        "campaignId",
        "campaign_id",
        "advObjectId",
      ]);
      const dedupeKey = campaignId || JSON.stringify(row);
      if (seenCampaignIds.has(dedupeKey)) continue;
      seenCampaignIds.add(dedupeKey);
      rows.push(row);
    }
    const total = getPagedPayloadTotal(response.payload);
    if (page === 1) pageSize = Math.max(1, pageRows.length);
    const hasNext = Number.isFinite(total) ? rows.length < total : false;
    if (!hasNext || pageRows.length === 0) {
      return {
        ...response,
        endpoint,
        rows,
        payload: response.payload,
        pageCount: page,
      };
    }
  }
  return {
    ok: true,
    status: 200,
    endpoint,
    rows,
    payload: lastPayload,
    pageCount: 100,
    truncated: true,
  };
}

async function testPlatformIntegrationConnectionImpl(
  payload = {},
  options = {},
) {
  const integrationType = normalizeIntegrationType(payload);
  if (integrationType !== "ozon-performance") {
    throw createIntegrationError(
      "UNSUPPORTED_INTEGRATION_TYPE",
      "当前只接入 Ozon Performance API 只读连接测试；其他平台接口先保存为本地草稿。",
      400,
      { supportedTypes: ["ozon-performance"] },
    );
  }

  const { clientId, clientSecret } = await resolvePerformanceCredentials(
    payload,
    options,
  );
  if (!clientId || !clientSecret) {
    throw createIntegrationError(
      "PERFORMANCE_CREDENTIALS_REQUIRED",
      "请填写 Ozon Performance API 的 client_id 和 client_secret。",
      400,
    );
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw createIntegrationError(
      "FETCH_UNAVAILABLE",
      "当前 Node 运行环境不支持 fetch。",
      500,
    );
  }

  const baseUrl = resolvePerformanceBaseUrl(payload, options);
  const testedAt = new Date().toISOString();
  const token = await requestPerformanceToken({
    baseUrl,
    clientId,
    clientSecret,
    fetchImpl,
  });
  const checks = await Promise.all([
    requestPerformanceReadCheck({
      baseUrl,
      token,
      endpoint: "/api/client/campaign",
      key: "campaigns",
      title: "广告计划列表",
      fetchImpl,
    }),
    requestPerformanceReadCheck({
      baseUrl,
      token,
      endpoint: "/api/client/statistics/list",
      key: "statisticsList",
      title: "统计任务列表",
      fetchImpl,
    }),
  ]);
  const failedCheck = checks.find((check) => !check.ok);
  if (failedCheck) {
    throw createIntegrationError(
      "PERFORMANCE_READ_CHECK_FAILED",
      `${failedCheck.title}读取失败：${failedCheck.error?.message || `HTTP ${failedCheck.status}`}`,
      failedCheck.status >= 400 && failedCheck.status < 500 ? 400 : 502,
      { checks, remoteStatus: failedCheck.status },
    );
  }

  const campaignCheck = checks.find((check) => check.key === "campaigns");
  const statisticsCheck = checks.find(
    (check) => check.key === "statisticsList",
  );
  return {
    ok: true,
    type: "ozon-performance",
    provider: "Ozon Performance API",
    testedAt,
    baseUrl,
    auth: {
      ok: true,
      tokenType: token.tokenType,
      expiresIn: token.expiresIn,
    },
    requiredFields: ["client_id", "client_secret"],
    checks,
    summary: {
      campaignCount: campaignCheck?.total ?? campaignCheck?.itemCount ?? 0,
      statisticsTaskCount:
        statisticsCheck?.total ?? statisticsCheck?.itemCount ?? 0,
    },
    capabilities: {
      read: [
        "广告计划列表",
        "计划商品",
        "投放对象",
        "计划日报",
        "商品统计",
        "广告花费统计",
        "媒体广告统计",
        "统计任务列表",
        "外部报表列表",
      ],
      write: [
        "创建计划",
        "编辑计划",
        "修改预算",
        "添加/移除商品",
        "调整出价",
        "搜索推广出价",
        "启停广告（需单独确认）",
      ],
    },
    message:
      "Ozon Performance API 只读连接测试通过，未执行任何创建、预算、出价或扣费写入。",
  };
}

async function readPerformanceRealtimeOverviewCore(payload = {}, options = {}) {
  const { clientId, clientSecret } = await resolvePerformanceCredentials(
    payload,
    options,
  );
  if (!clientId || !clientSecret) {
    throw createIntegrationError(
      "PERFORMANCE_CREDENTIALS_REQUIRED",
      "请填写 Ozon Performance API 的 client_id 和 client_secret。",
      400,
    );
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw createIntegrationError(
      "FETCH_UNAVAILABLE",
      "当前 Node 运行环境不支持 fetch。",
      500,
    );
  }

  const baseUrl = resolvePerformanceBaseUrl(payload, options);
  const startedAt = new Date().toISOString();
  const readPlan = getPerformanceReadPlan(payload);
  const fastOverview = readPlan.depth === "fast";
  const includeCampaignDetails = readPlan.includeCampaignDetails;
  const includeRealtimeStatistics = readPlan.includeRealtimeStatistics;
  const includeAsyncStatisticsFallback =
    readPlan.includeAsyncStatisticsFallback;
  const includeSearchPromoStatistics = readPlan.includeSearchPromoStatistics;
  const includeReferenceData = readPlan.includeReferenceData;
  const fastTimeoutMs =
    Number(options.fastTimeoutMs) > 0
      ? Number(options.fastTimeoutMs)
      : PERFORMANCE_FAST_REMOTE_TIMEOUT_MS;
  const remoteTimeoutMs = fastOverview
    ? fastTimeoutMs
    : PERFORMANCE_FULL_REMOTE_TIMEOUT_MS;
  const stages = [];
  stages.push({
    key: "token",
    label: "正在获取 Performance token",
    status: "running",
  });
  const token = await requestPerformanceToken({
    baseUrl,
    clientId,
    clientSecret,
    fetchImpl,
    timeoutMs: remoteTimeoutMs,
  });
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: "success",
  };

  stages.push({
    key: "campaigns",
    label: "正在读取广告计划列表",
    status: "running",
  });
  const campaignResponse = await readAllPerformanceCampaigns({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs: remoteTimeoutMs,
  });
  if (!campaignResponse.ok) {
    throw createIntegrationError(
      "PERFORMANCE_CAMPAIGNS_READ_FAILED",
      `广告计划列表读取失败：${getRemoteMessage(campaignResponse.payload)}`,
      campaignResponse.status >= 400 && campaignResponse.status < 500
        ? 400
        : 502,
      { remoteStatus: campaignResponse.status },
    );
  }
  const allBaseCampaigns = campaignResponse.rows.map(
    normalizePerformanceCampaign,
  );
  const requestedCampaignId = getPerformanceCampaignSelectionId(payload);
  // The products depth is an account/shop-level catalog read. Ignore a stale
  // campaign selection carried by the renderer so every current and future
  // campaign is included. Detail depth remains strictly single-campaign.
  const selectedCampaignId =
    readPlan.depth === "products" ? "" : requestedCampaignId;
  const baseCampaigns = selectedCampaignId
    ? allBaseCampaigns.filter(
        (campaign) => normalizeText(campaign.id) === selectedCampaignId,
      )
    : allBaseCampaigns;
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: "success",
    count: allBaseCampaigns.length,
    selectedCount: baseCampaigns.length,
    pageCount: campaignResponse.pageCount || 1,
  };

  let productRead = {
    productsByCampaign: new Map(),
    issues: [],
    unavailableCampaigns: [],
    totalProducts: 0,
    skipped: !includeCampaignDetails,
  };
  if (!includeCampaignDetails) {
    stages.push(
      createSkippedPerformanceStage(
        "campaignProducts",
        "正在读取计划商品",
        "首屏按计划批量读取统计；计划商品只在打开具体计划时读取，避免逐个计划阻塞页面。",
      ),
    );
  } else {
    stages.push({
      key: "campaignProducts",
      label: "正在读取计划商品",
      status: "running",
    });
    productRead = await readCampaignProducts({
      baseUrl,
      token,
      campaigns: baseCampaigns,
      fetchImpl,
      timeoutMs: remoteTimeoutMs,
    });
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: productRead.issues.length ? "partial" : "success",
      count: productRead.totalProducts,
      issueCount: productRead.issues.length,
      unavailableCount: productRead.unavailableCampaigns.length,
    };
  }

  const includeBidInsights = shouldReadPerformanceBidInsights(payload);
  let bidInsightRead = {
    skipped: true,
    status: "skipped",
    rows: [],
    issues: [],
    reason: includeCampaignDetails
      ? "当前页面未请求搜索出价参考。"
      : "首屏不读取搜索出价参考。",
  };
  if (!includeCampaignDetails || !includeBidInsights) {
    stages.push(
      createSkippedPerformanceStage(
        "campaignBidInsights",
        "正在读取搜索出价参考",
        bidInsightRead.reason,
      ),
    );
  } else {
    stages.push({
      key: "campaignBidInsights",
      label: "正在读取搜索出价参考",
      status: "running",
    });
    bidInsightRead = await readCampaignProductBidInsights({
      baseUrl,
      token,
      campaigns: baseCampaigns,
      productsByCampaign: productRead.productsByCampaign,
      fetchImpl,
    });
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: bidInsightRead.status,
      count: bidInsightRead.rows.length,
      issueCount: bidInsightRead.issues.length,
      sourceCount: bidInsightRead.sourceCount || 0,
      successfulSourceCount: bidInsightRead.successfulSourceCount || 0,
      failedSourceCount: bidInsightRead.failedSourceCount || 0,
      reason: bidInsightRead.reason,
    };
  }

  const readCampaignObjectsEnabled =
    shouldReadPerformanceCampaignObjects(payload);
  const productsOnlyRead = readPlan.depth === "products";
  let objectRead = {
    objectsByCampaign: new Map(),
    issues: [],
    skippedCampaigns: [],
    unavailableCampaigns: [],
    requestedCampaignCount: 0,
    totalObjects: 0,
    skipped: !includeCampaignDetails || !readCampaignObjectsEnabled,
  };
  if (!includeCampaignDetails) {
    stages.push(
      createSkippedPerformanceStage(
        "campaignObjects",
        "正在读取投放对象",
        "首屏不逐计划读取投放对象；打开具体计划时再按需读取。",
      ),
    );
  } else if (productsOnlyRead || !readCampaignObjectsEnabled) {
    stages.push(
      createSkippedPerformanceStage(
        "campaignObjects",
        "正在读取投放对象",
        productsOnlyRead
          ? "商品投放页只读取全部计划商品，已跳过投放对象接口。"
          : "当前分析只需要计划、商品和统计数据，已跳过不适用于部分计划类型的投放对象接口。",
      ),
    );
  } else {
    stages.push({
      key: "campaignObjects",
      label: "正在读取投放对象",
      status: "running",
    });
    objectRead = await readCampaignObjects({
      baseUrl,
      token,
      campaigns: baseCampaigns,
      fetchImpl,
      timeoutMs: remoteTimeoutMs,
    });
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: objectRead.issues.length ? "partial" : "success",
      count: objectRead.totalObjects,
      issueCount: objectRead.issues.length,
      skippedCount: objectRead.skippedCampaigns.length,
      unavailableCount: objectRead.unavailableCampaigns.length,
      reason:
        objectRead.skippedCampaigns.length ||
        objectRead.unavailableCampaigns.length
          ? `已按计划类型和状态自动分流；${objectRead.skippedCampaigns.length} 个计划无需读取，${objectRead.unavailableCampaigns.length} 个计划未提供单独对象明细。`
          : "已读取所有适用计划的投放对象。",
    };
  }

  const dateRange = normalizeDateRange(payload);
  const productSkuStatisticsRange = getPerformanceSkuStatisticsDateRange(
    dateRange,
    options.now || new Date(),
  );
  const historicalProductStatisticsRange =
    getPerformanceHistoricalProductStatisticsDateRange(
      dateRange,
      productSkuStatisticsRange,
    );
  const campaignIds = baseCampaigns.map((campaign) => campaign.id);
  const skippedRealtimeStatsReason =
    "快速实时读取不阻塞首屏；统计数据进入报表或完整刷新时实时读取。";

  let dailyStatisticsResponse = {
    ok: true,
    endpoint: "/api/client/statistics/daily/json",
    label: "计划日报",
    rows: [],
    skipped: !includeRealtimeStatistics,
  };
  let dailyStats = [];
  if (!includeRealtimeStatistics) {
    stages.push(
      createSkippedPerformanceStage(
        "dailyStatistics",
        "正在读取计划日报",
        skippedRealtimeStatsReason,
      ),
    );
  } else {
    stages.push({
      key: "dailyStatistics",
      label: "正在读取计划日报",
      status: "running",
    });
    dailyStatisticsResponse = await readSegmentedFirstAvailablePerformanceJson({
      baseUrl,
      token,
      endpointCandidates: [
        "/api/client/statistics/daily/json",
        "/api/client/statistics/daily",
      ],
      query: { campaignIds },
      dateRange,
      dedupeKey: dailyStatisticDedupeKey,
      fetchImpl,
      label: "计划日报",
      timeoutMs: remoteTimeoutMs,
    });
    dailyStats = dailyStatisticsResponse.rows.map(
      normalizePerformanceStatistic,
    );
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: dailyStatisticsResponse.ok ? "success" : "partial",
      count: dailyStats.length,
      segmentCount: dailyStatisticsResponse.segmentCount,
      successfulSegmentCount: dailyStatisticsResponse.successfulSegmentCount,
      failedSegmentCount: dailyStatisticsResponse.failedSegmentCount,
    };
  }

  let productStatisticsResponse = {
    ok: true,
    endpoint: "/api/client/statistics/campaign/product/json",
    label: "商品统计",
    rows: [],
    skipped: !includeRealtimeStatistics,
  };
  let campaignProductStats = [];
  if (!includeRealtimeStatistics) {
    stages.push(
      createSkippedPerformanceStage(
        "productStatistics",
        "正在读取商品统计",
        skippedRealtimeStatsReason,
      ),
    );
  } else {
    stages.push({
      key: "productStatistics",
      label: "正在读取商品统计",
      status: "running",
    });
    productStatisticsResponse =
      await readSegmentedFirstAvailablePerformanceJson({
        baseUrl,
        token,
        endpointCandidates: [
          "/api/client/statistics/campaign/product/json",
          "/api/client/statistics/campaign/product",
        ],
        query: { campaignIds },
        dateRange,
        dedupeKey: productStatisticDedupeKey,
        fetchImpl,
        label: "商品统计",
        timeoutMs: remoteTimeoutMs,
      });
    campaignProductStats = productStatisticsResponse.rows.map(
      normalizePerformanceStatistic,
    );
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: productStatisticsResponse.ok ? "success" : "partial",
      count: campaignProductStats.length,
      segmentCount: productStatisticsResponse.segmentCount,
      successfulSegmentCount: productStatisticsResponse.successfulSegmentCount,
      failedSegmentCount: productStatisticsResponse.failedSegmentCount,
    };
  }

  let productSkuStatisticsResponse = {
    ok: true,
    endpoint: "/api/client/statistics/products/sku",
    label: "SKU 商品效果统计",
    rows: [],
    skipped:
      !includeRealtimeStatistics ||
      campaignIds.length === 0 ||
      !productSkuStatisticsRange.available,
    reason: !productSkuStatisticsRange.available
      ? `Ozon SKU 商品效果接口只允许读取莫斯科日期 ${productSkuStatisticsRange.allowedFrom} 至 ${productSkuStatisticsRange.allowedTo}；当前所选日期没有可读取的 SKU 明细。`
      : "",
  };
  let productStats = [];
  if (
    !includeRealtimeStatistics ||
    !campaignIds.length ||
    !productSkuStatisticsRange.available
  ) {
    stages.push(
      createSkippedPerformanceStage(
        "productSkuStatistics",
        "正在读取 SKU 商品效果统计",
        !includeRealtimeStatistics
          ? skippedRealtimeStatsReason
          : !campaignIds.length
            ? "当前没有可读取的推广计划。"
            : productSkuStatisticsResponse.reason,
      ),
    );
  } else {
    stages.push({
      key: "productSkuStatistics",
      label: "正在读取 SKU 商品效果统计",
      status: "running",
    });
    productSkuStatisticsResponse = await readOptionalPerformanceJson({
      baseUrl,
      token,
      endpoint: "/api/client/statistics/products/sku",
      method: "POST",
      body: {
        campaignIds,
        dateFrom: productSkuStatisticsRange.dateFrom,
        dateTo: productSkuStatisticsRange.dateTo,
      },
      fetchImpl,
      label: "SKU 商品效果统计",
      timeoutMs: remoteTimeoutMs,
    });
    productStats = productSkuStatisticsResponse.rows.map(
      normalizePerformanceStatistic,
    );
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: productSkuStatisticsResponse.ok ? "success" : "partial",
      count: productStats.length,
    };
  }

  const historicalProductCampaignIds = baseCampaigns
    .filter(
      (campaign) =>
        !isSearchPromoPerformanceCampaign(campaign) &&
        (productRead.productsByCampaign.get(campaign.id) || []).length > 1,
    )
    .map((campaign) => campaign.id);
  let historicalProductStatisticsReport = {
    ok: true,
    skipped: true,
    endpoint: "/api/client/statistics/json",
    rows: [],
    segments: [],
    segmentCount: 0,
    successfulSegmentCount: 0,
    failedSegmentCount: 0,
    tasks: [],
    error: null,
  };
  let historicalProductStats = [];
  if (readPlan.depth === "products") {
    if (
      !historicalProductStatisticsRange.available ||
      historicalProductCampaignIds.length === 0
    ) {
      stages.push(
        createSkippedPerformanceStage(
          "historicalProductStatistics",
          "正在读取所选日期商品统计",
          !historicalProductStatisticsRange.available
            ? "当前日期全部在实时 SKU 接口可读范围内，无需生成历史商品报表。"
            : "当前计划均为单商品计划，已直接使用同日期范围的计划统计，无需生成历史商品报表。",
        ),
      );
    } else {
      stages.push({
        key: "historicalProductStatistics",
        label: "正在读取所选日期商品统计",
        status: "running",
      });
      historicalProductStatisticsReport =
        await readHistoricalProductStatisticsReport({
          baseUrl,
          token,
          campaignIds: historicalProductCampaignIds,
          dateRange: historicalProductStatisticsRange,
          fetchImpl,
        });
      historicalProductStats = historicalProductStatisticsReport.rows.map(
        normalizePerformanceStatistic,
      );
      stages[stages.length - 1] = {
        ...stages[stages.length - 1],
        status: historicalProductStatisticsReport.ok
          ? "success"
          : historicalProductStatisticsReport.partial
            ? "partial"
            : "failed",
        count: historicalProductStats.length,
        segmentCount: historicalProductStatisticsReport.segmentCount,
        successfulSegmentCount:
          historicalProductStatisticsReport.successfulSegmentCount,
        failedSegmentCount:
          historicalProductStatisticsReport.failedSegmentCount,
      };
    }
  }

  let expenseStatisticsResponse = {
    ok: true,
    endpoint: "/api/client/statistics/expense/json",
    label: "广告花费统计",
    rows: [],
    skipped: !includeRealtimeStatistics,
    attempts: [],
  };
  let expenseStats = [];
  if (!includeRealtimeStatistics) {
    stages.push(
      createSkippedPerformanceStage(
        "expenseStatistics",
        "正在读取广告花费统计",
        skippedRealtimeStatsReason,
      ),
    );
  } else {
    stages.push({
      key: "expenseStatistics",
      label: "正在读取广告花费统计",
      status: "running",
    });
    expenseStatisticsResponse =
      await readSegmentedFirstAvailablePerformanceJson({
        baseUrl,
        token,
        endpointCandidates: [
          "/api/client/statistics/expense/json",
          "/api/client/statistics/expense",
        ],
        query: { campaignIds },
        dateRange,
        dedupeKey: expenseStatisticDedupeKey,
        fetchImpl,
        label: "广告花费统计",
        timeoutMs: remoteTimeoutMs,
      });
    expenseStats = expenseStatisticsResponse.rows.map(
      normalizePerformanceStatistic,
    );
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: expenseStatisticsResponse.ok ? "success" : "partial",
      count: expenseStats.length,
      endpoint: expenseStatisticsResponse.endpoint,
      segmentCount: expenseStatisticsResponse.segmentCount,
      successfulSegmentCount: expenseStatisticsResponse.successfulSegmentCount,
      failedSegmentCount: expenseStatisticsResponse.failedSegmentCount,
    };
  }

  let mediaStatisticsResponse = {
    ok: true,
    endpoint: "/api/client/statistics/campaign/media/json",
    label: "媒体广告统计",
    rows: [],
    skipped: !includeRealtimeStatistics,
  };
  let mediaStats = [];
  if (!includeRealtimeStatistics) {
    stages.push(
      createSkippedPerformanceStage(
        "mediaStatistics",
        "正在读取媒体广告统计",
        skippedRealtimeStatsReason,
      ),
    );
  } else {
    stages.push({
      key: "mediaStatistics",
      label: "正在读取媒体广告统计",
      status: "running",
    });
    mediaStatisticsResponse = await readSegmentedFirstAvailablePerformanceJson({
      baseUrl,
      token,
      endpointCandidates: [
        "/api/client/statistics/campaign/media/json",
        "/api/client/statistics/campaign/media",
      ],
      query: { campaignIds },
      dateRange,
      dedupeKey: mediaStatisticDedupeKey,
      fetchImpl,
      label: "媒体广告统计",
      timeoutMs: remoteTimeoutMs,
    });
    mediaStats = mediaStatisticsResponse.rows.map((row, index) => ({
      ...normalizePerformanceStatistic(row, index),
      mediaType:
        firstText(row, ["mediaType", "media_type", "format", "placement"]) ||
        "媒体广告",
    }));
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: mediaStatisticsResponse.ok ? "success" : "partial",
      count: mediaStats.length,
      segmentCount: mediaStatisticsResponse.segmentCount,
      successfulSegmentCount: mediaStatisticsResponse.successfulSegmentCount,
      failedSegmentCount: mediaStatisticsResponse.failedSegmentCount,
    };
  }

  let asyncStatisticsReport = {
    ok: false,
    skipped: true,
    rows: [],
    task: null,
    error: null,
  };
  if (campaignIds.length && !dailyStats.length) {
    if (!includeAsyncStatisticsFallback) {
      stages.push(
        createSkippedPerformanceStage(
          "asyncStatistics",
          "正在创建并轮询统计任务",
          "首屏优先使用同步聚合统计；只有同步统计缺失且进入计划详情或完整刷新时才创建异步报表。",
        ),
      );
    } else {
      stages.push({
        key: "asyncStatistics",
        label: "正在创建并轮询统计任务",
        status: "running",
      });
      asyncStatisticsReport = await readAsyncStatisticsReport({
        baseUrl,
        token,
        campaignIds,
        dateRange,
        fetchImpl,
      });
      stages[stages.length - 1] = {
        ...stages[stages.length - 1],
        status: asyncStatisticsReport.ok ? "success" : "partial",
        count: asyncStatisticsReport.rows.length,
        taskUuid: asyncStatisticsReport.task?.uuid || "",
        taskState: asyncStatisticsReport.task?.state || "",
        pollCount: asyncStatisticsReport.task?.polls || 0,
      };
    }
  }
  const asyncStats = asyncStatisticsReport.rows.map(
    normalizePerformanceStatistic,
  );
  const searchPromoCampaigns = baseCampaigns.filter(
    (campaign) =>
      normalizeLowerText(campaign.paymentType) === "cpo" ||
      normalizeLowerText(campaign.typeCode).includes("search_promo"),
  );
  let searchPromoProductsReport = {
    ok: true,
    skipped: !includeSearchPromoStatistics || searchPromoCampaigns.length === 0,
    endpoint: "/api/client/statistic/products/generate/json",
    rows: [],
    task: null,
    error: null,
  };
  if (searchPromoCampaigns.length && includeSearchPromoStatistics) {
    stages.push({
      key: "searchPromoProductsStatistics",
      label: "正在读取按订单计费商品统计",
      status: "running",
    });
    searchPromoProductsReport = await readSegmentedSearchPromoStatisticsReport({
      baseUrl,
      token,
      reportKind: "products",
      dateRange,
      fetchImpl,
    });
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: searchPromoProductsReport.ok ? "success" : "partial",
      count: searchPromoProductsReport.rows.length,
      taskUuid: searchPromoProductsReport.task?.uuid || "",
      taskState: searchPromoProductsReport.task?.state || "",
      pollCount: searchPromoProductsReport.task?.polls || 0,
      segmentCount: searchPromoProductsReport.segmentCount,
      successfulSegmentCount: searchPromoProductsReport.successfulSegmentCount,
      failedSegmentCount: searchPromoProductsReport.failedSegmentCount,
    };
  } else {
    stages.push(
      createSkippedPerformanceStage(
        "searchPromoProductsStatistics",
        "正在读取按订单计费商品统计",
        searchPromoCampaigns.length
          ? "按订单计费报表需要创建任务并轮询，已移到 AI 完整快照后台读取，不阻塞页面实时指标。"
          : "当前没有按订单计费推广计划。",
      ),
    );
  }
  const searchPromoStats = searchPromoProductsReport.rows.map(
    normalizePerformanceStatistic,
  );
  if (searchPromoCampaigns.length === 1) {
    for (const row of searchPromoStats) {
      // Search-promo JSON rows may expose a generic `id` for the product/order
      // itself.  The report is generated for the account-level CPO campaign,
      // so that generic id must never be mistaken for a campaign id.
      row.campaignId = searchPromoCampaigns[0].id;
    }
  }
  const effectiveDailyStats = mergePerformanceTrendRows(
    dailyStats,
    expenseStats,
    [...asyncStats, ...searchPromoStats],
  );
  const authoritativeProductStats = mergePerformanceProductStatistics(
    historicalProductStats,
    productStats,
  );
  const campaignProductDetailStats = campaignProductStats.filter(
    (stat) => getPerformanceProductIdentityCandidates(stat).length > 0,
  );
  const asyncProductDetailStats = asyncStats.filter(
    (stat) => getPerformanceProductIdentityCandidates(stat).length > 0,
  );
  const effectiveProductStats = authoritativeProductStats.length
    ? authoritativeProductStats
    : campaignProductDetailStats.length
      ? campaignProductDetailStats
      : asyncProductDetailStats;

  let statisticsResponse = {
    ok: true,
    rows: [],
    skipped: !includeReferenceData,
  };
  let statisticsTasks = [];
  if (!includeReferenceData) {
    stages.push(
      createSkippedPerformanceStage(
        "statisticsList",
        "正在读取统计任务列表",
        "快速实时读取不阻塞首屏；进入统计报表时会重新实时读取。",
      ),
    );
  } else {
    stages.push({
      key: "statisticsList",
      label: "正在读取统计任务列表",
      status: "running",
    });
    statisticsResponse = await readOptionalPerformanceJson({
      baseUrl,
      token,
      endpoint: "/api/client/statistics/list",
      fetchImpl,
      label: "统计任务列表",
    });
    statisticsTasks = statisticsResponse.rows;
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: statisticsResponse.ok ? "success" : "partial",
      count: statisticsTasks.length,
    };
  }

  let externalReportsResponse = {
    ok: true,
    rows: [],
    skipped: !includeReferenceData,
  };
  let externalReports = [];
  if (!includeReferenceData) {
    stages.push(
      createSkippedPerformanceStage(
        "externalStatisticsList",
        "正在读取外部报表列表",
        "快速实时读取不阻塞首屏；进入统计报表时会重新实时读取。",
      ),
    );
  } else {
    stages.push({
      key: "externalStatisticsList",
      label: "正在读取外部报表列表",
      status: "running",
    });
    externalReportsResponse = await readOptionalPerformanceJson({
      baseUrl,
      token,
      endpoint: "/api/client/statistics/externallist",
      fetchImpl,
      label: "外部报表列表",
    });
    externalReports = externalReportsResponse.rows;
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: externalReportsResponse.ok ? "success" : "partial",
      count: externalReports.length,
    };
  }

  let availableModesResponse = {
    ok: true,
    endpoint: "/api/client/campaign/available",
    rows: [],
    skipped: !includeReferenceData,
  };
  let limitsResponse = {
    ok: true,
    endpoint: "/api/client/limits/list",
    rows: [],
    skipped: !includeReferenceData,
  };
  let bonusProductsResponse = {
    ok: true,
    endpoint: "/api/client/products_with_bonuses",
    rows: [],
    skipped: !includeReferenceData,
  };
  let vendorTagResponse = {
    ok: true,
    endpoint: "/api/client/organisation/vendor_tag",
    rows: [],
    skipped: !includeReferenceData,
  };
  if (!includeReferenceData) {
    stages.push(
      createSkippedPerformanceStage(
        "availableModes",
        "正在读取可用推广模式",
        skippedRealtimeStatsReason,
      ),
    );
    stages.push(
      createSkippedPerformanceStage(
        "limits",
        "正在读取推广出价限制",
        skippedRealtimeStatsReason,
      ),
    );
    stages.push(
      createSkippedPerformanceStage(
        "bonusProducts",
        "正在读取奖金商品",
        skippedRealtimeStatsReason,
      ),
    );
    stages.push(
      createSkippedPerformanceStage(
        "vendorTag",
        "正在读取外部推广组织标签",
        skippedRealtimeStatsReason,
      ),
    );
  } else {
    stages.push({
      key: "availableModes",
      label: "正在读取可用推广模式",
      status: "running",
    });
    availableModesResponse = await readFirstAvailablePerformanceJson({
      baseUrl,
      token,
      endpointCandidates: [
        "/api/client/campaign/available",
        "/campaign/available",
      ],
      fetchImpl,
      label: "可用推广模式",
      timeoutMs: remoteTimeoutMs,
    });
    availableModesResponse.rows = toPerformancePayloadRows(
      availableModesResponse.payload,
    );
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: availableModesResponse.ok ? "success" : "partial",
      count: availableModesResponse.rows.length,
      endpoint: availableModesResponse.endpoint,
    };

    stages.push({
      key: "limits",
      label: "正在读取推广出价限制",
      status: "running",
    });
    limitsResponse = await readOptionalPerformanceJson({
      baseUrl,
      token,
      endpoint: "/api/client/limits/list",
      fetchImpl,
      label: "推广出价限制",
      timeoutMs: remoteTimeoutMs,
    });
    limitsResponse.rows = toPerformancePayloadRows(limitsResponse.payload);
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: limitsResponse.ok ? "success" : "partial",
      count: limitsResponse.rows.length,
    };

    stages.push({
      key: "bonusProducts",
      label: "正在读取奖金商品",
      status: "running",
    });
    bonusProductsResponse = await readOptionalPerformanceJson({
      baseUrl,
      token,
      endpoint: "/api/client/products_with_bonuses",
      fetchImpl,
      label: "奖金商品",
      timeoutMs: remoteTimeoutMs,
    });
    bonusProductsResponse.rows = toPerformancePayloadRows(
      bonusProductsResponse.payload,
    );
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: bonusProductsResponse.ok ? "success" : "partial",
      count: bonusProductsResponse.rows.length,
    };

    stages.push({
      key: "vendorTag",
      label: "正在读取外部推广组织标签",
      status: "running",
    });
    vendorTagResponse = await readOptionalPerformanceJson({
      baseUrl,
      token,
      endpoint: "/api/client/organisation/vendor_tag",
      fetchImpl,
      label: "外部推广组织标签",
      timeoutMs: remoteTimeoutMs,
    });
    vendorTagResponse.rows = toPerformancePayloadRows(
      vendorTagResponse.payload,
    );
    stages[stages.length - 1] = {
      ...stages[stages.length - 1],
      status: vendorTagResponse.ok ? "success" : "partial",
      count: vendorTagResponse.rows.length,
    };
  }

  const readIssues = [
    ...productRead.issues,
    ...objectRead.issues,
    ...bidInsightRead.issues,
    ...createPerformanceSegmentIssues(dailyStatisticsResponse, {
      kind: "campaign-daily-statistics",
      label: "计划日报",
    }),
    ...createPerformanceSegmentIssues(productStatisticsResponse, {
      kind: "campaign-product-statistics",
      label: "计划商品投放统计",
    }),
    ...createPerformanceSegmentIssues(historicalProductStatisticsReport, {
      kind: "historical-product-statistics",
      label: "历史商品统计",
    }),
    ...createPerformanceSegmentIssues(expenseStatisticsResponse, {
      kind: "campaign-expense-statistics",
      label: "花费统计",
    }),
    ...createPerformanceSegmentIssues(mediaStatisticsResponse, {
      kind: "campaign-media-statistics",
      label: "媒体统计",
    }),
    ...createPerformanceSegmentIssues(searchPromoProductsReport, {
      kind: "search-promo-product-statistics",
      label: "按订单计费商品统计",
    }),
    ...(dailyStatisticsResponse.ok ||
    asyncStatisticsReport.ok ||
    dailyStatisticsResponse.failedSegmentCount > 0
      ? []
      : [
          {
            kind: "campaign-daily-statistics",
            label: "计划日报",
            endpoint: dailyStatisticsResponse.endpoint,
            status: dailyStatisticsResponse.status,
            message:
              dailyStatisticsResponse.error?.message ||
              asyncStatisticsReport.error?.message ||
              "计划日报读取失败",
          },
        ]),
    ...(productStatisticsResponse.ok ||
    productStatisticsResponse.failedSegmentCount > 0
      ? []
      : [
          {
            kind: "campaign-product-statistics",
            label: "计划商品投放统计",
            endpoint: productStatisticsResponse.endpoint,
            status: productStatisticsResponse.status,
            message:
              productStatisticsResponse.error?.message ||
              "计划商品投放统计读取失败",
          },
        ]),
    ...(productSkuStatisticsResponse.ok || effectiveProductStats.length
      ? []
      : [
          {
            kind: "product-sku-statistics",
            label: "SKU 商品效果统计",
            endpoint: productSkuStatisticsResponse.endpoint,
            status: productSkuStatisticsResponse.status,
            message:
              productSkuStatisticsResponse.error?.message ||
              "SKU 商品效果统计读取失败",
          },
        ]),
    ...(expenseStatisticsResponse.ok ||
    expenseStatisticsResponse.failedSegmentCount > 0
      ? []
      : [
          {
            kind: "campaign-expense-statistics",
            label: "花费统计",
            endpoint: expenseStatisticsResponse.endpoint,
            status: expenseStatisticsResponse.status,
            message:
              expenseStatisticsResponse.error?.message ||
              "广告花费统计读取失败",
            attempts: expenseStatisticsResponse.attempts,
          },
        ]),
    ...(mediaStatisticsResponse.ok ||
    mediaStatisticsResponse.failedSegmentCount > 0
      ? []
      : [
          {
            kind: "campaign-media-statistics",
            label: "媒体统计",
            endpoint: mediaStatisticsResponse.endpoint,
            status: mediaStatisticsResponse.status,
            message:
              mediaStatisticsResponse.error?.message || "媒体广告统计读取失败",
          },
        ]),
    ...(statisticsResponse.ok
      ? []
      : [
          {
            kind: "statistics-task-list",
            label: "统计任务",
            endpoint: statisticsResponse.endpoint,
            status: statisticsResponse.status,
            message: statisticsResponse.error?.message || "统计任务读取失败",
          },
        ]),
    ...(externalReportsResponse.ok
      ? []
      : [
          {
            kind: "external-report-list",
            label: "外部报表",
            endpoint: externalReportsResponse.endpoint,
            status: externalReportsResponse.status,
            message:
              externalReportsResponse.error?.message || "外部报表列表读取失败",
          },
        ]),
    ...(searchPromoProductsReport.ok ||
    searchPromoProductsReport.failedSegmentCount > 0 ||
    searchPromoCampaigns.length === 0
      ? []
      : [
          {
            kind: "search-promo-product-statistics",
            label: "按订单计费商品统计",
            endpoint: searchPromoProductsReport.endpoint,
            status: searchPromoProductsReport.status,
            message:
              searchPromoProductsReport.error?.message ||
              "按订单计费商品统计读取失败",
          },
        ]),
    ...[
      availableModesResponse,
      limitsResponse,
      bonusProductsResponse,
      vendorTagResponse,
    ]
      .filter(
        (response) =>
          response && response.ok === false && response.status !== 404,
      )
      .map((response) => ({
        kind: "performance-reference-data",
        label: response.label || "推广辅助数据",
        endpoint: response.endpoint,
        status: response.status,
        message: response.error?.message || "推广辅助数据读取失败",
      })),
  ];

  const campaigns = mergeCampaignRealtimeDetails({
    campaigns: baseCampaigns,
    productsByCampaign: productRead.productsByCampaign,
    objectsByCampaign: objectRead.objectsByCampaign,
    deriveObjectsFromProducts:
      includeCampaignDetails && readCampaignObjectsEnabled && !productsOnlyRead,
    dailyStats,
    campaignProductStats,
    expenseStats,
    mediaStats,
    asyncStats: [...asyncStats, ...searchPromoStats],
    productStats: effectiveProductStats,
    statisticResponses: {
      daily: dailyStatisticsResponse,
      campaignProduct: productStatisticsResponse,
      expense: expenseStatisticsResponse,
      media: mediaStatisticsResponse,
      async: asyncStatisticsReport,
      searchPromo: searchPromoProductsReport,
    },
    dateRange,
    now: options.now || new Date(),
  }).map((campaign) => {
    if (!includeCampaignDetails) return campaign;
    const detailAvailability = createCampaignDetailAvailability({
      campaign,
      includeCampaignDetails,
      includeCampaignObjects: readCampaignObjectsEnabled,
      includeBidInsights,
      productRead,
      objectRead,
      bidInsightRead,
    });
    const productsAuthoritative = ["success", "empty"].includes(
      detailAvailability.products.status,
    );
    const objectsAuthoritative = ["success", "empty"].includes(
      detailAvailability.objects.status,
    );
    return {
      ...campaign,
      productCount: productsAuthoritative
        ? campaign.products.length
        : campaign.productCount,
      productCountSource: productsAuthoritative
        ? "campaign-products"
        : campaign.productCountSource,
      objectCount: objectsAuthoritative
        ? campaign.objects.length
        : campaign.objectCount,
      objectCountSource: objectsAuthoritative
        ? "campaign-objects"
        : campaign.objectCountSource,
      detailAvailability,
      detailRead: {
        products: true,
        objects: readCampaignObjectsEnabled,
        bidInsights: includeBidInsights,
        finishedAt: new Date().toISOString(),
      },
    };
  });

  stages.push({
    key: "alerts",
    label: "正在同步推广提醒",
    status: "running",
  });
  const notificationSummary = recordPerformanceNotifications({
    notificationService: options.notificationService,
    payload,
    campaigns,
  });
  stages[stages.length - 1] = {
    ...stages[stages.length - 1],
    status: "success",
    count: notificationSummary.recorded,
  };

  const campaignObjectRows = campaigns.flatMap(
    (campaign) => campaign.objects || [],
  );
  const derivedCampaignObjectCount = campaignObjectRows.filter(
    (row) => row?.objectSource === "campaign-product",
  ).length;
  const dataSets = {
    campaigns: createPerformanceDataSet({
      key: "campaigns",
      label: "推广计划完整返回",
      endpoint: "/api/client/campaign",
      rows: toPerformanceInspectionRows(allBaseCampaigns),
      response: campaignResponse,
    }),
    campaignProducts: createPerformanceDataSet({
      key: "campaignProducts",
      label: "计划商品完整返回",
      endpoint: "/api/client/campaign/{campaignId}/v2/products",
      rows: toPerformanceInspectionRows(
        campaigns.flatMap((campaign) => campaign.products || []),
        {
          context: (row) => ({
            _campaignId: row?.campaignId || "",
            _campaignTitle: row?.campaignTitle || "",
          }),
        },
      ),
      status: productRead.skipped
        ? "skipped"
        : productRead.issues.length
          ? "partial"
          : productRead.totalProducts
            ? "success"
            : "empty",
      note: productRead.issues.length
        ? `${productRead.issues.length} 个计划商品接口未完整返回。`
        : "",
    }),
    campaignObjects: createPerformanceDataSet({
      key: "campaignObjects",
      label: "投放对象完整返回",
      endpoint: "/api/client/campaign/{campaignId}/objects",
      rows: toPerformanceInspectionRows(campaignObjectRows, {
        context: (row) => ({
          _campaignId: row?.campaignId || "",
          _campaignTitle: row?.campaignTitle || "",
        }),
      }),
      status: objectRead.skipped
        ? "skipped"
        : objectRead.issues.length
          ? "partial"
          : campaignObjectRows.length
            ? "success"
            : "empty",
      note: [
        objectRead.issues.length
          ? `${objectRead.issues.length} 个计划对象接口未完整返回。`
          : "",
        derivedCampaignObjectCount
          ? `${derivedCampaignObjectCount} 个对象已由同计划权威商品明细补全。`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    }),
    campaignBidInsights: createPerformanceDataSet({
      key: "campaignBidInsights",
      label: "搜索出价参考完整返回",
      endpoint:
        "/api/client/search_promo/bids/recommendation + /products/bids/competitive + /get_cpo_min_bids + /api/client/min/sku",
      // Unlike generic inspection rows, bid insight rows must not unwrap the
      // campaign-product `raw` object. Only the four exact bid endpoints from
      // this read are allowed to populate these fields.
      rows: toPerformanceBidInsightRows(bidInsightRead.rows),
      response: bidInsightRead,
      status: bidInsightRead.status,
      note:
        bidInsightRead.reason ||
        (bidInsightRead.issues.length
          ? `${bidInsightRead.issues.length} 项出价参考接口未完整返回。`
          : ""),
    }),
    dailyStatistics: createPerformanceDataSet({
      key: "dailyStatistics",
      label: "计划日报完整返回",
      endpoint: dailyStatisticsResponse.endpoint,
      rows: toPerformanceInspectionRows(dailyStats),
      response: dailyStatisticsResponse,
    }),
    campaignProductStatistics: createPerformanceDataSet({
      key: "campaignProductStatistics",
      label: "计划商品投放统计完整返回",
      endpoint: productStatisticsResponse.endpoint,
      rows: toPerformanceInspectionRows(campaignProductStats),
      response: productStatisticsResponse,
    }),
    productSkuStatistics: createPerformanceDataSet({
      key: "productSkuStatistics",
      label: "SKU 商品效果统计完整返回",
      endpoint: productSkuStatisticsResponse.endpoint,
      rows: toPerformanceInspectionRows(productStats),
      response: productSkuStatisticsResponse,
      note:
        productSkuStatisticsRange.available &&
        (productSkuStatisticsRange.dateFrom !== dateRange.dateFrom ||
          productSkuStatisticsRange.dateTo !== dateRange.dateTo)
          ? `Ozon 接口限制：SKU 商品效果只读取莫斯科日期 ${productSkuStatisticsRange.dateFrom} 至 ${productSkuStatisticsRange.dateTo}；计划日报和计划商品统计仍按所选 ${dateRange.dateFrom} 至 ${dateRange.dateTo} 读取。`
          : productSkuStatisticsResponse.reason,
    }),
    ...(readPlan.depth === "products"
      ? {
          historicalProductStatistics: createPerformanceDataSet({
            key: "historicalProductStatistics",
            label: "所选日期商品统计完整返回",
            endpoint:
              historicalProductStatisticsReport.endpoint ||
              "/api/client/statistics/json",
            rows: toPerformanceInspectionRows(historicalProductStats),
            response: historicalProductStatisticsReport,
            note: historicalProductStatisticsRange.available
              ? `已通过 Ozon 异步商品报表补读 ${historicalProductStatisticsRange.dateFrom} 至 ${historicalProductStatisticsRange.dateTo}；实时 SKU 接口继续负责最近可读日期，重叠日期按实时结果覆盖。`
              : "当前日期全部在实时 SKU 接口可读范围内，无需补读历史商品报表。",
          }),
        }
      : {}),
    expenseStatistics: createPerformanceDataSet({
      key: "expenseStatistics",
      label: "广告花费完整返回",
      endpoint: expenseStatisticsResponse.endpoint,
      rows: toPerformanceInspectionRows(expenseStats),
      response: expenseStatisticsResponse,
    }),
    mediaStatistics: createPerformanceDataSet({
      key: "mediaStatistics",
      label: "媒体广告统计完整返回",
      endpoint: mediaStatisticsResponse.endpoint,
      rows: toPerformanceInspectionRows(mediaStats),
      response: mediaStatisticsResponse,
    }),
    searchPromoProductStatistics: createPerformanceDataSet({
      key: "searchPromoProductStatistics",
      label: "按订单计费商品统计完整返回",
      endpoint: searchPromoProductsReport.endpoint,
      rows: toPerformanceInspectionRows(searchPromoProductsReport.rows),
      response: searchPromoProductsReport,
      note:
        searchPromoCampaigns.length &&
        searchPromoProductsReport.ok &&
        !searchPromoProductsReport.rows.length
          ? "Ozon 报表已完成并明确返回空 rows，当前统计期没有按订单计费商品记录。"
          : "",
    }),
    asyncStatistics: createPerformanceDataSet({
      key: "asyncStatistics",
      label: "异步统计报表完整返回",
      endpoint: asyncStatisticsReport.endpoint || "/api/client/statistics/json",
      rows: toPerformanceInspectionRows(asyncStats),
      response: asyncStatisticsReport,
    }),
    statisticsTasks: createPerformanceDataSet({
      key: "statisticsTasks",
      label: "统计任务完整返回",
      endpoint: statisticsResponse.endpoint || "/api/client/statistics/list",
      rows: statisticsTasks,
      response: statisticsResponse,
    }),
    externalReports: createPerformanceDataSet({
      key: "externalReports",
      label: "外部流量报表完整返回",
      endpoint:
        externalReportsResponse.endpoint ||
        "/api/client/statistics/externallist",
      rows: externalReports,
      response: externalReportsResponse,
    }),
    availableModes: createPerformanceDataSet({
      key: "availableModes",
      label: "可用推广模式完整返回",
      endpoint: availableModesResponse.endpoint,
      rows: availableModesResponse.rows,
      response: availableModesResponse,
      status:
        !availableModesResponse.ok && availableModesResponse.status === 404
          ? "unavailable"
          : undefined,
    }),
    limits: createPerformanceDataSet({
      key: "limits",
      label: "推广出价限制完整返回",
      endpoint: limitsResponse.endpoint,
      rows: limitsResponse.rows,
      response: limitsResponse,
      status:
        !limitsResponse.ok && limitsResponse.status === 404
          ? "unavailable"
          : undefined,
    }),
    bonusProducts: createPerformanceDataSet({
      key: "bonusProducts",
      label: "奖金商品完整返回",
      endpoint: bonusProductsResponse.endpoint,
      rows: bonusProductsResponse.rows,
      response: bonusProductsResponse,
      status:
        !bonusProductsResponse.ok && bonusProductsResponse.status === 404
          ? "unavailable"
          : undefined,
    }),
    vendorTag: createPerformanceDataSet({
      key: "vendorTag",
      label: "外部推广组织标签完整返回",
      endpoint: vendorTagResponse.endpoint,
      rows: vendorTagResponse.rows,
      response: vendorTagResponse,
      status:
        !vendorTagResponse.ok && vendorTagResponse.status === 404
          ? "unavailable"
          : undefined,
    }),
  };
  const dataCatalog = Object.values(dataSets).map(
    ({ rows, ...entry }) => entry,
  );
  const finishedAt = new Date().toISOString();
  const aiRequiredDataSetKeys = [
    "campaigns",
    "dailyStatistics",
    "campaignProductStatistics",
    "expenseStatistics",
    "mediaStatistics",
    ...(productSkuStatisticsRange.available ? ["productSkuStatistics"] : []),
    ...(searchPromoCampaigns.length ? ["searchPromoProductStatistics"] : []),
  ];
  const aiIncompleteDataSets = aiRequiredDataSetKeys.filter((key) => {
    const status = normalizeLowerText(dataSets[key]?.status);
    return !["success", "empty"].includes(status);
  });
  const aiSnapshotDepth = readPlan.depth === "ai" || readPlan.depth === "full";

  return {
    ok: true,
    source: "ozon-performance-realtime",
    cache: {
      enabled: false,
      fallback: false,
      note: "本次返回来自 Performance API 实时读取；已验证结果会另存为秒开快照，不会替代后台实时刷新。",
    },
    readDepth: readPlan.depth,
    requestPolicy: getPerformanceQueueSnapshot(),
    provider: "Ozon Performance API",
    campaignScope: {
      requestedCampaignId,
      appliedCampaignId: selectedCampaignId,
      matched: requestedCampaignId
        ? readPlan.depth === "products" || baseCampaigns.length > 0
        : true,
      selectedCount: baseCampaigns.length,
      totalCount: allBaseCampaigns.length,
    },
    startedAt,
    finishedAt,
    freshness: {
      capturedAt: finishedAt,
      ageMs: 0,
      live: true,
      readDepth: readPlan.depth,
    },
    aiReadiness: {
      ready: aiSnapshotDepth && aiIncompleteDataSets.length === 0,
      capturedAt: finishedAt,
      maxAgeMs: 120_000,
      requiredDataSets: aiRequiredDataSetKeys,
      incompleteDataSets: aiIncompleteDataSets,
      reason: !aiSnapshotDepth
        ? "页面实时指标已返回，AI 决策需等待后台完整快照。"
        : aiIncompleteDataSets.length
          ? `AI 决策数据尚未完整返回：${aiIncompleteDataSets.join(", ")}`
          : "AI 决策数据完整且为本次实时读取。",
      limitations:
        productSkuStatisticsRange.available &&
        (productSkuStatisticsRange.dateFrom !== dateRange.dateFrom ||
          productSkuStatisticsRange.dateTo !== dateRange.dateTo)
          ? [
              `SKU 商品效果受 Ozon 限制，只覆盖 ${productSkuStatisticsRange.dateFrom} 至 ${productSkuStatisticsRange.dateTo}。`,
            ]
          : [],
    },
    auth: {
      tokenType: token.tokenType,
      expiresIn: token.expiresIn,
      tokenReused: Boolean(token.reused),
    },
    stages,
    dateRange,
    productSkuStatisticsRange,
    historicalProductStatisticsRange,
    summary: summarizeCampaigns(campaigns),
    campaigns,
    products: campaigns.flatMap((campaign) => campaign.products || []),
    objects: campaigns.flatMap((campaign) => campaign.objects || []),
    dailyTrend: buildDailyTrend(effectiveDailyStats),
    dailyStats: effectiveDailyStats,
    campaignProductStats,
    productStats: effectiveProductStats,
    expenseStats,
    mediaStats,
    searchPromoStats,
    searchPromoProductsReport: {
      ok: searchPromoProductsReport.ok,
      skipped: Boolean(searchPromoProductsReport.skipped),
      endpoint: searchPromoProductsReport.endpoint,
      task: searchPromoProductsReport.task,
      rows: searchPromoProductsReport.rows,
      error: searchPromoProductsReport.error,
    },
    statisticsReport: asyncStatisticsReport.skipped
      ? { skipped: true, rows: [] }
      : {
          ok: asyncStatisticsReport.ok,
          endpoint: asyncStatisticsReport.endpoint,
          rows: asyncStatisticsReport.rows,
          task: asyncStatisticsReport.task,
          error: asyncStatisticsReport.error,
        },
    statisticsTasks,
    externalReports,
    dataCatalog,
    dataSets,
    readAvailability: {
      campaignProductsUnavailable: productRead.unavailableCampaigns,
      campaignObjectsSkipped: objectRead.skippedCampaigns,
      campaignObjectsUnavailable: objectRead.unavailableCampaigns,
    },
    readIssues,
    notifications: notificationSummary,
  };
}

async function readPerformanceRealtimeOverviewImpl(payload = {}, options = {}) {
  const values = getPayloadValues(payload);
  if (getPerformanceReadDepth(payload) === "orders") {
    return readPerformancePromotionOrdersImpl(payload, options);
  }
  if (values.snapshotOnly === true) {
    const snapshot = readPerformanceSnapshot(payload);
    if (!snapshot) return { ok: true, found: false, snapshot: null };
    const capturedAt = snapshot.payload?.finishedAt || snapshot.updatedAt;
    const capturedAtMs = Date.parse(capturedAt || 0);
    return {
      ok: true,
      found: true,
      snapshot: {
        ...snapshot.payload,
        source: "sqlite-performance-snapshot",
        cache: {
          enabled: true,
          fallback: true,
          updatedAt: snapshot.updatedAt,
          note: "先显示最近一次已验证数据，后台立即实时更新。",
        },
        freshness: {
          ...(snapshot.payload?.freshness || {}),
          capturedAt,
          ageMs: Number.isFinite(capturedAtMs)
            ? Math.max(0, Date.now() - capturedAtMs)
            : null,
          live: false,
        },
        aiReadiness: {
          ...(snapshot.payload?.aiReadiness || {}),
          ready: false,
          reason: "本地快照只用于秒开页面；AI 必须等待本次实时完整读取。",
        },
      },
    };
  }
  if (!shouldCoalescePerformanceOverviewRead(options)) {
    const overview = await readPerformanceRealtimeOverviewCore(
      payload,
      options,
    );
    savePerformanceSnapshot(payload, overview);
    return overview;
  }
  const inFlightKey = getPerformanceOverviewInFlightKey(payload, options);
  const currentRead = performanceOverviewInFlightReads.get(inFlightKey);
  if (currentRead) return currentRead;

  const nextRead = readPerformanceRealtimeOverviewCore(payload, options).then(
    (overview) => {
      savePerformanceSnapshot(payload, overview);
      return overview;
    },
  );
  performanceOverviewInFlightReads.set(inFlightKey, nextRead);
  try {
    return await nextRead;
  } finally {
    if (performanceOverviewInFlightReads.get(inFlightKey) === nextRead) {
      performanceOverviewInFlightReads.delete(inFlightKey);
    }
  }
}

async function executePerformanceWriteActionImpl(payload = {}, options = {}) {
  const request = buildPerformanceWriteRequest(payload);
  const values = getPayloadValues(payload);
  const confirmWrite =
    payload.confirmWrite === true || values.confirmWrite === true;
  const confirmationCode = normalizeText(
    payload.confirmationCode || values.confirmationCode,
  );
  const dryRun = payload.dryRun === true || values.dryRun === true;
  resolvePerformanceBaseUrl(payload, options);

  if (
    !confirmWrite ||
    confirmationCode !== PERFORMANCE_WRITE_CONFIRMATION_CODE ||
    dryRun
  ) {
    return {
      ok: true,
      executed: false,
      preview: true,
      provider: "Ozon Performance API",
      safety: {
        requiredConfirmationCode: PERFORMANCE_WRITE_CONFIRMATION_CODE,
        message: "当前请求未通过真实写入确认，仅返回预览，未向 Ozon Performance 提交。",
      },
      request: createPerformanceWritePreview(request),
    };
  }

  const { clientId, clientSecret } = await resolvePerformanceCredentials(
    payload,
    options,
  );
  if (!clientId || !clientSecret) {
    throw createIntegrationError(
      "PERFORMANCE_CREDENTIALS_REQUIRED",
      "请填写 Ozon Performance API 的 client_id 和 client_secret。",
      400,
    );
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw createIntegrationError(
      "FETCH_UNAVAILABLE",
      "当前 Node 运行环境不支持 fetch。",
      500,
    );
  }

  const baseUrl = resolvePerformanceBaseUrl(payload, options);
  const startedAt = new Date().toISOString();
  const token = await requestPerformanceToken({
    baseUrl,
    clientId,
    clientSecret,
    fetchImpl,
  });
  const response = await requestPerformanceWriteJson({
    baseUrl,
    token,
    endpoint: request.endpoint,
    query: request.query,
    method: request.method,
    body: request.body,
    fetchImpl,
  });
  if (!response.ok) {
    throw createIntegrationError(
      "PERFORMANCE_WRITE_FAILED",
      `${request.title}失败：${getRemoteMessage(response.payload)}`,
      response.status >= 400 && response.status < 500 ? 400 : 502,
      { remoteStatus: response.status },
    );
  }
  const readback = await performPerformanceWriteReadback({
    action: request.action,
    request,
    payload,
    remotePayload: response.payload,
    baseUrl,
    token,
    fetchImpl,
    options,
  });
  return {
    ok: true,
    executed: true,
    preview: false,
    realWrite: true,
    dryRun: false,
    source: "ozon-performance-write",
    provider: "Ozon Performance API",
    startedAt,
    finishedAt: new Date().toISOString(),
    request: createPerformanceWritePreview(request),
    remote: {
      status: response.status,
      payload: response.payload,
    },
    readback,
    message: readback.confirmed
      ? `${request.title}已生效，并已完成 Ozon 精确回读确认。`
      : `${request.title}已提交到 Ozon，但当前回读尚未一致：${readback.mismatches[0]}`,
  };
}

export function readPerformanceProductCandidates(payload = {}, options = {}) {
  return withPerformanceOwner(payload, options, () =>
    readPerformanceProductCandidatesImpl(payload, options),
  );
}

export function readPerformanceAdvancedReport(payload = {}, options = {}) {
  return withPerformanceOwner(payload, options, () =>
    readPerformanceAdvancedReportImpl(payload, options),
  );
}

export function testPlatformIntegrationConnection(payload = {}, options = {}) {
  return withPerformanceOwner(payload, options, () =>
    testPlatformIntegrationConnectionImpl(payload, options),
  );
}

export function readPerformanceRealtimeOverview(payload = {}, options = {}) {
  return withPerformanceOwner(payload, options, () =>
    readPerformanceRealtimeOverviewImpl(payload, options),
  );
}

export function executePerformanceWriteAction(payload = {}, options = {}) {
  return withPerformanceOwner(payload, options, () =>
    executePerformanceWriteActionImpl(payload, options),
  );
}

export function getPerformanceAccountRemovalStatus(accountId) {
  const ownerId = normalizeText(accountId);
  let inFlightReads = 0;
  for (const key of performanceOverviewInFlightReads.keys()) {
    try {
      if (JSON.parse(key)?.accountId === ownerId) inFlightReads += 1;
    } catch {
      // A malformed legacy coalescing key is not attributed to this owner.
    }
  }
  return {
    fenced: performanceFencedOwners.has(ownerId),
    queued: performanceQueuedByOwner.get(ownerId) || 0,
    active: performanceActiveByOwner.get(ownerId) || 0,
    inFlightReads,
    reportLifecycleActive: performanceReportLifecycleTailsByOwner.has(ownerId),
    tokenCount: performanceTokenKeysByOwner.get(ownerId)?.size || 0,
  };
}

export async function quiescePerformanceAccount(
  accountId,
  { timeoutMs = 30_000 } = {},
) {
  const ownerId = normalizeText(accountId);
  performanceFencedOwners.add(ownerId);
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
  for (;;) {
    const status = getPerformanceAccountRemovalStatus(ownerId);
    if (
      status.queued === 0 &&
      status.active === 0 &&
      status.inFlightReads === 0 &&
      !status.reportLifecycleActive
    ) {
      return { ok: true, ...status };
    }
    if (Date.now() >= deadline) {
      throw createIntegrationError(
        "PERFORMANCE_ACCOUNT_DRAIN_TIMEOUT",
        "Timed out while draining Performance account requests.",
        409,
      );
    }
    await sleep(10);
  }
}

export function clearPerformanceAccountRuntime(accountId) {
  const ownerId = normalizeText(accountId);
  let removedTokens = 0;
  for (const tokenKey of performanceTokenKeysByOwner.get(ownerId) || []) {
    if (performanceTokenReuseByAccount.delete(tokenKey)) removedTokens += 1;
  }
  performanceTokenKeysByOwner.delete(ownerId);
  const removedQueueState = performanceQueueStatesByOwner.delete(ownerId);
  const removedReportLifecycle = performanceReportLifecycleTailsByOwner.delete(ownerId);
  let removedReads = 0;
  for (const key of [...performanceOverviewInFlightReads.keys()]) {
    try {
      if (JSON.parse(key)?.accountId !== ownerId) continue;
      performanceOverviewInFlightReads.delete(key);
      removedReads += 1;
    } catch {
      // Preserve unattributed legacy keys.
    }
  }
  return {
    ok: true,
    removedTokens,
    removedReads,
    removedQueueState,
    removedReportLifecycle,
    fenced: performanceFencedOwners.has(ownerId),
  };
}

export function releasePerformanceAccountFence(accountId) {
  const ownerId = normalizeText(accountId);
  return { ok: true, released: performanceFencedOwners.delete(ownerId) };
}

export function createPlatformIntegrationTestErrorPayload(error) {
  return {
    ok: false,
    error: {
      code: error?.code || "PLATFORM_INTEGRATION_TEST_FAILED",
      message: error instanceof Error ? error.message : String(error),
      status: error?.remoteStatus ?? null,
      supportedTypes: error?.supportedTypes ?? undefined,
    },
    checks: Array.isArray(error?.checks) ? error.checks : undefined,
  };
}
