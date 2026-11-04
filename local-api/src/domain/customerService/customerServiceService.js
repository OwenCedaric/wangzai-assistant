const CUSTOMER_SERVICE_READ_ENDPOINTS = new Set([
  "chat.list",
  "chat.history",
  "shop.sellerInfo",
  "review.list",
  "review.info",
  "review.commentList",
  "review.count",
  "question.list",
  "question.info",
  "question.count",
  "question.answerList",
  "question.topSku",
]);

import { createCustomerServiceWriteService } from "./customerServiceWriteService.js";
import { createCustomerOutboundFileStore } from "./customerOutboundFileStore.js";
import { createCustomerMessageTranslationService } from "./customerMessageTranslationService.js";
import { createCustomerPushViewMarkerRepository } from "../../db/repositories/customerPushViewMarkerRepository.js";
import { createOrderRepository } from "../../db/repositories/orderRepository.js";
import { createPurchaseOrderOverrideRepository } from "../../db/repositories/purchaseOrderOverrideRepository.js";
import { createPurchaseSourceLinkRepository } from "../../db/repositories/purchaseSourceLinkRepository.js";
import { createCrossBorderOrderRepository } from "../../db/repositories/crossBorderOrderRepository.js";
import {
  createSyncJobService,
  SYNC_JOB_STATUS,
} from "../../sync/syncJobService.js";
import { createSyncStateService } from "../../sync/syncStateService.js";
import { createStableHash } from "../../utils/stableHash.js";

const CUSTOMER_SERVICE_ENDPOINT_ALIASES = Object.freeze({
  chat: "chat.list",
  chats: "chat.list",
  list: "chat.list",
  history: "chat.history",
  reviews: "review.list",
  review: "review.list",
  questions: "question.list",
  question: "question.list",
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function hasTable(db, tableName) {
  try {
    return Boolean(
      db
        ?.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(tableName),
    );
  } catch {
    return false;
  }
}

function getOrderRaw(row = {}) {
  return row?.raw && typeof row.raw === "object" && !Array.isArray(row.raw)
    ? row.raw
    : {};
}

function getOrderPostingNumber(row = {}) {
  return normalizeText(row.postingNumber ?? row.posting_number ?? row.id);
}

function getOrderBaseNumber(row = {}) {
  const raw = getOrderRaw(row);
  return normalizeText(
    row.orderNumber ?? row.order_number ?? raw.order_number ?? raw.orderNumber,
  );
}

function isCustomerOrderNumberMatch(row = {}, requestedNumber = "") {
  const target = normalizeText(requestedNumber);
  if (!target) return false;
  const postingNumber = getOrderPostingNumber(row);
  const baseNumber = getOrderBaseNumber(row);
  if (postingNumber === target || baseNumber === target) return true;
  if (postingNumber.startsWith(`${target}-`)) {
    return /^\d+$/u.test(postingNumber.slice(target.length + 1));
  }
  if (baseNumber && target.startsWith(`${baseNumber}-`)) {
    return /^\d+$/u.test(target.slice(baseNumber.length + 1));
  }
  return false;
}

function collectCustomerOrderLookupKeys(requestedNumber, rows = []) {
  const keys = new Set([normalizeText(requestedNumber)]);
  rows.forEach((row) => {
    const raw = getOrderRaw(row);
    [
      getOrderPostingNumber(row),
      getOrderBaseNumber(row),
      row.orderKey,
      row.order_key,
      row.orderId,
      row.order_id,
      raw.order_id,
    ].forEach((value) => {
      const key = normalizeText(value);
      if (key) keys.add(key);
    });
  });
  return [...keys].filter(Boolean);
}

function collectUniqueRows(loadRows, keys, getIdentity) {
  const rows = [];
  const seen = new Set();
  keys.forEach((keyword) => {
    const payload = loadRows(keyword);
    (Array.isArray(payload?.rows) ? payload.rows : []).forEach((row) => {
      const identity = normalizeText(getIdentity(row)) || JSON.stringify(row);
      if (seen.has(identity)) return;
      seen.add(identity);
      rows.push(row);
    });
  });
  return rows;
}

function normalizeEndpointKey(input = {}) {
  const direct = normalizeText(input.endpointKey ?? input.endpoint_key);
  if (direct) return direct;
  const action = normalizeText(
    input.action || input.channel || input.type || "chat",
  );
  return CUSTOMER_SERVICE_ENDPOINT_ALIASES[action] || action || "chat.list";
}

function normalizeTranslationRequestId(value) {
  const requestId = normalizeText(value);
  if (!requestId) return "";
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(requestId)) {
    throw new Error("CUSTOMER_TRANSLATION_REQUEST_ID_INVALID");
  }
  return requestId;
}

function toPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function clampInteger(
  value,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const integer = toPositiveInteger(value, fallback, max);
  return Math.max(min, Math.min(integer, max));
}

function compactJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
}

function createCustomerServiceSyncJobId() {
  return `customer_service_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeMaxPages(value, fallback = 100) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), 100);
}

function isSchedulerOk(result = {}) {
  return Boolean(
    result.ok ||
    result.status === "success" ||
    result.status === "partial" ||
    result.status === "cache_hit",
  );
}

function schedulerErrorMessage(result, fallback = "Ozon 客服会话读取失败") {
  return (
    result?.errors?.[0]?.message ||
    result?.job?.lastError ||
    result?.error?.message ||
    fallback
  );
}

function withDefaultProbeParams(endpointKey, input = {}) {
  const params =
    input.params && typeof input.params === "object" ? { ...input.params } : {};
  const limit = toPositiveInteger(input.limit ?? params.limit, 20, 100);
  const offset = Math.max(
    0,
    toPositiveInteger(input.offset ?? params.offset, 0, 10_000),
  );

  if (endpointKey === "chat.list") {
    const cursor = normalizeText(input.cursor ?? params.cursor);
    const {
      cursor: _ignoredCursor,
      offset: _ignoredOffset,
      ...restParams
    } = params;
    return {
      limit,
      ...restParams,
      ...(cursor ? { cursor } : { offset: 0 }),
    };
  }

  if (endpointKey === "chat.history") {
    const chatId = normalizeText(
      input.chatId ?? input.chat_id ?? params.chat_id,
    );
    return { limit, ...params, ...(chatId ? { chat_id: chatId } : {}) };
  }

  if (endpointKey === "shop.sellerInfo") {
    return { ...params };
  }

  if (endpointKey === "review.list" || endpointKey === "question.list") {
    const safeLimit = clampInteger(input.limit ?? params.limit, 20, {
      min: 20,
      max: 100,
    });
    return { ...params, limit: safeLimit, offset };
  }

  return { ...params };
}

function extractSchedulerData(payload = {}) {
  if (payload?.data !== undefined) return payload.data;
  if (payload?.cache?.payload_json) {
    try {
      return JSON.parse(payload.cache.payload_json);
    } catch {
      return null;
    }
  }
  if (payload?.cache?.data_json) {
    try {
      return JSON.parse(payload.cache.data_json);
    } catch {
      return null;
    }
  }
  return null;
}

export function createCustomerServiceService({
  db,
  ozonScheduler,
  ozonClient,
  shopRepository,
  messageTranslationService,
  pushViewMarkerRepository,
  outboundFileStore,
  orderReadPort = null,
  backgroundRunner = (task) => setImmediate(task),
} = {}) {
  const stagedFileStore =
    outboundFileStore || createCustomerOutboundFileStore();
  const writeService = createCustomerServiceWriteService({
    ozonScheduler,
    outboundFileStore: stagedFileStore,
  });
  const translationService =
    messageTranslationService || createCustomerMessageTranslationService();
  const markerRepository =
    pushViewMarkerRepository ||
    (db?.prepare ? createCustomerPushViewMarkerRepository(db) : null);
  const orderRepository = orderReadPort || (hasTable(db, "ozon_orders")
    ? createOrderRepository(db)
    : null);
  const purchaseOverrideRepository = hasTable(db, "purchase_order_overrides")
    ? createPurchaseOrderOverrideRepository(db)
    : null;
  const purchaseSourceLinkRepository = hasTable(db, "purchase_source_links")
    ? createPurchaseSourceLinkRepository(db)
    : null;
  const crossBorderOrderRepository = hasTable(db, "cross_border_order_records")
    ? createCrossBorderOrderRepository(db)
    : null;
  const activeTranslationRequests = new Map();
  const pendingTranslationCancellations = new Map();
  const jobService = db ? createSyncJobService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;

  async function readChatFile(input = {}) {
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const fileUrl = normalizeText(input.fileUrl ?? input.file_url ?? input.url);
    if (!shopId) {
      const error = new Error("读取聊天图片必须指定 Ozon 店铺。");
      error.code = "CUSTOMER_CHAT_FILE_SHOP_REQUIRED";
      error.statusCode = 400;
      throw error;
    }
    if (!fileUrl) {
      const error = new Error("聊天图片地址为空。");
      error.code = "CUSTOMER_CHAT_FILE_URL_REQUIRED";
      error.statusCode = 400;
      throw error;
    }
    if (
      !ozonClient?.requestBinaryReadOnly ||
      !shopRepository?.getShopCredentialsForInternalUse
    ) {
      const error = new Error("Ozon 聊天图片读取服务未连接。");
      error.code = "CUSTOMER_CHAT_FILE_SERVICE_UNAVAILABLE";
      error.statusCode = 503;
      throw error;
    }
    const allowed = shopRepository
      .listShopsForContext({
        tenantId: shopRepository.tenantId,
        userId: shopRepository.userId,
      })
      .some((shop) => shop.id === shopId);
    if (!allowed) {
      const error = new Error("当前账号无权读取该店铺的聊天图片。");
      error.code = "CUSTOMER_CHAT_FILE_SCOPE_FORBIDDEN";
      error.statusCode = 403;
      throw error;
    }
    const shopCredentials =
      shopRepository.getShopCredentialsForInternalUse(shopId);
    if (!shopCredentials?.clientId || !shopCredentials?.apiKey) {
      const error = new Error("该店铺缺少有效的 Ozon 接口配置。");
      error.code = "CUSTOMER_CHAT_FILE_CREDENTIALS_MISSING";
      error.statusCode = 409;
      throw error;
    }
    return ozonClient.requestBinaryReadOnly({
      endpointKey: "chat.file",
      shopCredentials,
      resourceUrl: fileUrl,
      signal: input.signal,
      requestId: `customer-chat-file:${createStableHash({ shopId, fileUrl }, { length: 24 })}`,
    });
  }

  function rememberPendingTranslationCancellation(requestId) {
    if (!requestId) return;
    while (pendingTranslationCancellations.size >= 200) {
      pendingTranslationCancellations.delete(
        pendingTranslationCancellations.keys().next().value,
      );
    }
    pendingTranslationCancellations.set(requestId, Date.now());
  }

  async function translateMessages(input = {}) {
    const requestId = normalizeTranslationRequestId(
      input.requestId ?? input.request_id,
    );
    const controller = new AbortController();
    const parentSignal =
      input.signal && typeof input.signal.addEventListener === "function"
        ? input.signal
        : null;
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });

    if (requestId) {
      if (pendingTranslationCancellations.delete(requestId)) controller.abort();
      activeTranslationRequests.get(requestId)?.abort();
      activeTranslationRequests.set(requestId, controller);
    }
    try {
      return await translationService.translateMessages({
        ...input,
        requestId,
        signal: controller.signal,
      });
    } finally {
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (
        requestId &&
        activeTranslationRequests.get(requestId) === controller
      ) {
        activeTranslationRequests.delete(requestId);
      }
    }
  }

  function cancelMessageTranslation(input = {}) {
    const requestId = normalizeTranslationRequestId(
      input.requestId ?? input.request_id,
    );
    const controller = requestId
      ? activeTranslationRequests.get(requestId)
      : null;
    if (controller) controller.abort();
    else rememberPendingTranslationCancellation(requestId);
    return { ok: true, requestId, cancelled: Boolean(controller) };
  }

  async function probeRead(input = {}) {
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    if (!shopId) {
      return {
        ok: false,
        domain: "customerService",
        error: {
          code: "CUSTOMER_SERVICE_SHOP_ID_REQUIRED",
          message: "shopId is required for customer service probe.",
        },
      };
    }

    const endpointKey = normalizeEndpointKey(input);
    if (!CUSTOMER_SERVICE_READ_ENDPOINTS.has(endpointKey)) {
      return {
        ok: false,
        domain: "customerService",
        endpointKey,
        error: {
          code: "CUSTOMER_SERVICE_ENDPOINT_NOT_ALLOWED",
          message: "客服咨询探测只允许读取类 endpoint。",
        },
      };
    }

    const params = withDefaultProbeParams(endpointKey, input);
    if (endpointKey === "chat.history" && !params.chat_id) {
      return {
        ok: false,
        domain: "customerService",
        endpointKey,
        error: {
          code: "CHAT_ID_REQUIRED",
          message: "chat.history probe requires chat_id.",
        },
      };
    }

    if (!ozonScheduler?.executeReadOnly) {
      return {
        ok: false,
        domain: "customerService",
        endpointKey,
        error: {
          code: "CUSTOMER_SERVICE_SCHEDULER_NOT_CONNECTED",
          message: "Ozon scheduler is not connected.",
        },
      };
    }

    const forceRefresh = input.forceRefresh === true;
    const defaultIdempotencyKey = `customer-service-probe:${shopId}:${endpointKey}:${compactJson(params)}`;

    const scheduled = await ozonScheduler.executeReadOnly({
      shopId,
      domain: "customerService",
      endpointKey,
      action: "customer-service-probe",
      priority: input.priority || "P1",
      params,
      cacheKey: `customerService:${shopId}:${endpointKey}:${compactJson(params)}`,
      idempotencyKey:
        input.idempotencyKey ||
        (forceRefresh ? undefined : defaultIdempotencyKey),
      requestedBy: input.requestedBy || "customer-service-probe",
      forceRefresh,
      allowStale: input.allowStale !== false,
      // A visible customer-service read must return the canonical Ozon payload,
      // not a transient queued/running job shell. Concurrent identical reads are
      // coalesced by the scheduler and awaited here so the UI cannot mistake an
      // in-flight request for an empty conversation list.
      waitForResult: true,
    });

    const data = extractSchedulerData(scheduled);
    return {
      ok: scheduled?.ok === true,
      domain: "customerService",
      endpointKey,
      params,
      probedAt: nowIso(),
      scheduler: scheduled,
      data,
      rowCount: Array.isArray(data?.chats)
        ? data.chats.length
        : Array.isArray(data?.messages)
          ? data.messages.length
          : Array.isArray(data)
            ? data.length
            : Number(scheduled?.results?.[0]?.rowCount) || 0,
    };
  }

  function readCache(query = {}) {
    if (!ozonScheduler?.readCache) {
      return {
        ok: false,
        domain: "customerService",
        error: {
          code: "CUSTOMER_SERVICE_CACHE_NOT_CONNECTED",
          message: "customerService cache reader is not connected.",
        },
      };
    }
    return ozonScheduler.readCache("customerService", query);
  }

  function readOrderRouteContext(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const requestedNumber = normalizeText(
      query.postingNumber ??
        query.posting_number ??
        query.orderNumber ??
        query.order_number,
    );
    if (!shopId || !orderRepository) {
      return {
        ok: true,
        source: "sqlite",
        requestedNumber,
        rows: [],
        purchaseRows: [],
        purchaseLinks: [],
        logisticsRows: [],
        total: 0,
      };
    }

    if (!requestedNumber) {
      const orderPage = orderRepository.listOrders({
        shopId,
        pageSize: 100,
        page: 1,
      });
      const rows = Array.isArray(orderPage?.rows) ? orderPage.rows : [];
      return {
        ok: true,
        source: "sqlite",
        requestedNumber: "",
        rows,
        purchaseRows: [],
        purchaseLinks: [],
        logisticsRows: [],
        total: Math.max(Number(orderPage?.total) || 0, rows.length),
      };
    }

    const orderPage = orderRepository.listOrders({
      shopId,
      keyword: requestedNumber,
      pageSize: 100,
      page: 1,
    });
    const rows = (Array.isArray(orderPage?.rows) ? orderPage.rows : []).filter(
      (row) => isCustomerOrderNumberMatch(row, requestedNumber),
    );
    const lookupKeys = collectCustomerOrderLookupKeys(requestedNumber, rows);
    const purchaseRows = purchaseOverrideRepository
      ? collectUniqueRows(
          (keyword) =>
            purchaseOverrideRepository.listOverrides({
              shopId,
              keyword,
              pageSize: 100,
            }),
          lookupKeys,
          (row) => row.id ?? `${row.orderKey}:${row.postingNumber}:${row.sku}`,
        )
      : [];
    const purchaseLinks = purchaseSourceLinkRepository
      ? collectUniqueRows(
          (keyword) =>
            purchaseSourceLinkRepository.listLinks({
              shopId,
              keyword,
              pageSize: 100,
            }),
          lookupKeys,
          (row) => row.id ?? `${row.orderKey}:${row.slotIndex}`,
        )
      : [];
    const logisticsLookupKeys = [
      ...lookupKeys,
      ...purchaseRows.flatMap((row) => [
        row.purchaseOrderNumber,
        row.purchase_order_number,
      ]),
    ]
      .map(normalizeText)
      .filter(Boolean);
    const logisticsRows = crossBorderOrderRepository
      ? crossBorderOrderRepository.listRecordsByLookupKeys(
          logisticsLookupKeys,
          {
            shopId,
          },
        )
      : [];

    return {
      ok: true,
      source: "sqlite",
      requestedNumber,
      rows,
      purchaseRows,
      purchaseLinks,
      logisticsRows,
      total: rows.length,
    };
  }

  async function runCustomerServiceSyncJob(job, input = {}) {
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const pageSize = clampInteger(input.pageSize ?? input.limit, 100, {
      min: 1,
      max: 100,
    });
    const maxPages = normalizeMaxPages(input.maxPages, 100);
    const requestedBy =
      normalizeText(input.requestedBy ?? input.requested_by) ||
      "customer-service-domain-sync";
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let lastError = null;
    let cursor = normalizeText(input.cursor);
    const seenCursors = new Set();
    let completedPages = 0;

    jobService.updateJob(job.jobId, {
      status: SYNC_JOB_STATUS.running,
      startedAt: nowIso(),
      progressTotal: maxPages,
      progressDone: 0,
    });
    stateService.upsertState({
      domain: "customerService",
      shopId,
      scopeKey: "customerService:chat.list",
      status: "running",
      lastAttemptAt: nowIso(),
    });

    try {
      for (let page = 0; page < maxPages; page += 1) {
        const params = {
          limit: pageSize,
          ...(cursor ? { cursor } : { offset: 0 }),
        };
        const scheduled = await ozonScheduler.executeReadOnly({
          shopId,
          domain: "customerService",
          endpointKey: "chat.list",
          action: "sync-customer-chats",
          priority: input.priority || "P3",
          profile: input.profile ?? input.schedulerProfile,
          source: input.source || "continuous-sync",
          syncMode: input.syncMode ?? input.sync_mode ?? "steady",
          params,
          cacheKey: `customerService:${shopId}:chat.list:${compactJson(params)}`,
          idempotencyKey: `${job.jobId}:chat.list:${cursor || "first"}`,
          requestedBy,
          forceRefresh: input.forceRefresh !== false,
          allowStale: true,
        });
        if (!isSchedulerOk(scheduled)) {
          throw new Error(schedulerErrorMessage(scheduled));
        }
        const data = extractSchedulerData(scheduled) || {};
        const chats = Array.isArray(data.chats) ? data.chats : [];
        if (scheduled.status === "cache_hit" || scheduled.reused) {
          unchangedCount += chats.length;
        } else {
          changedCount += chats.length;
        }
        completedPages += 1;
        const nextCursor = normalizeText(data.cursor);
        jobService.updateJob(job.jobId, {
          progressDone: completedPages,
          changedCount,
          unchangedCount,
          failedCount,
        });
        const hasNext = data.has_next ?? data.hasNext;
        const shouldContinue = Boolean(
          hasNext === true &&
          chats.length > 0 &&
          nextCursor &&
          nextCursor !== cursor &&
          !seenCursors.has(nextCursor),
        );
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
        if (!shouldContinue || chats.length === 0) {
          break;
        }
      }
    } catch (error) {
      failedCount = 1;
      lastError = error instanceof Error ? error.message : String(error);
    }

    const finalStatus =
      failedCount === 0 ? SYNC_JOB_STATUS.success : SYNC_JOB_STATUS.failed;
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: completedPages,
      progressTotal: maxPages,
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      finishedAt: nowIso(),
    });
    stateService.upsertState({
      domain: "customerService",
      shopId,
      scopeKey: "customerService:chat.list",
      status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
      lastAttemptAt: nowIso(),
      lastError,
      remoteCursor: cursor,
      changedCount,
      unchangedCount,
    });
    return { job: finalJob };
  }

  function startSync(input = {}) {
    if (!ozonScheduler?.executeReadOnly || !jobService || !stateService) {
      return {
        ok: false,
        domain: "customerService",
        error: {
          code: "CUSTOMER_SERVICE_SYNC_NOT_CONNECTED",
          message: "客服会话后台同步服务未连接。",
        },
      };
    }
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    if (!shopId) {
      return {
        ok: false,
        domain: "customerService",
        error: {
          code: "CUSTOMER_SERVICE_SHOP_ID_REQUIRED",
          message: "客服会话同步需要店铺 ID。",
        },
      };
    }
    const pageSize = clampInteger(input.pageSize ?? input.limit, 100, {
      min: 1,
      max: 100,
    });
    const maxPages = normalizeMaxPages(input.maxPages, 100);
    const normalizedInput = {
      ...input,
      shopId,
      endpointKey: "chat.list",
      pageSize,
      maxPages,
    };
    const requestFingerprint = createStableHash(
      {
        domain: "customerService",
        shopId,
        endpointKey: "chat.list",
        pageSize,
        maxPages,
        forceRefresh: input.forceRefresh !== false,
      },
      { length: 32 },
    );
    const reusable = jobService.findReusableJob({
      requestFingerprint,
      idempotencyKey: input.idempotencyKey ?? input.idempotency_key,
    });
    if (reusable?.job) {
      return {
        ok: true,
        accepted: true,
        domain: "customerService",
        endpointKey: "chat.list",
        jobId: reusable.job.jobId,
        job: reusable.job,
        status: reusable.job.status,
        reused: true,
        reusedFromJobId: reusable.job.jobId,
        reason: reusable.reason,
      };
    }
    const job = jobService.createJob({
      id: createCustomerServiceSyncJobId(),
      domain: "customerService",
      shopId,
      endpointKey: "chat.list",
      action: "sync-customer-chats",
      priority: input.priority || "P3",
      profile: input.profile ?? input.schedulerProfile ?? null,
      source: input.source ?? input.syncSource ?? null,
      requestedBy:
        input.requestedBy ||
        input.requested_by ||
        "customer-service-domain-sync",
      cacheKey: `customerService:${shopId}:chat.list`,
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + 60_000).toISOString(),
      progressTotal: maxPages,
    });
    backgroundRunner(() => {
      runCustomerServiceSyncJob(job, normalizedInput).catch((error) => {
        jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
        });
      });
    });
    return {
      ok: true,
      accepted: true,
      domain: "customerService",
      endpointKey: "chat.list",
      jobId: job.jobId,
      job,
      status: job.status,
      reused: false,
    };
  }

  return {
    domain: "customerService",
    readCache,
    readOrderRouteContext,
    startSync,
    runCustomerServiceSyncJob,
    probeRead,
    readChatFile,
    stageOutboundFile(input = {}) {
      const shopId = normalizeText(input.shopId ?? input.shop_id);
      if (!shopId || !shopRepository?.listShopsForContext) {
        const error = new Error("发送附件必须指定已绑定的 Ozon 店铺。");
        error.code = "CUSTOMER_FILE_SHOP_REQUIRED";
        error.statusCode = 400;
        throw error;
      }
      const allowed = shopRepository
        .listShopsForContext({
          tenantId: shopRepository.tenantId,
          userId: shopRepository.userId,
        })
        .some((shop) => shop.id === shopId);
      if (!allowed) {
        const error = new Error("当前账号无权向该店铺会话发送附件。");
        error.code = "CUSTOMER_FILE_SCOPE_FORBIDDEN";
        error.statusCode = 403;
        throw error;
      }
      return stagedFileStore.stage({ ...input, shopId });
    },
    translateMessages,
    cancelMessageTranslation,
    readPushViewMarkers(input = {}) {
      if (!markerRepository) {
        return {
          ok: false,
          source: "sqlite",
          rows: [],
          error: {
            code: "CUSTOMER_PUSH_VIEW_MARKER_DB_NOT_CONNECTED",
            message: "客服已查看记录数据库未连接。",
          },
        };
      }
      const rows = markerRepository.listMarkers(input);
      return { ok: true, source: "sqlite", count: rows.length, rows };
    },
    savePushViewMarker(input = {}) {
      if (!markerRepository) {
        return {
          ok: false,
          source: "sqlite",
          error: {
            code: "CUSTOMER_PUSH_VIEW_MARKER_DB_NOT_CONNECTED",
            message: "客服已查看记录数据库未连接。",
          },
        };
      }
      return {
        ok: true,
        source: "sqlite",
        marker: markerRepository.saveMarker(input),
      };
    },
    executeConfirmedWrite(context = {}) {
      return writeService.executeConfirmedWrite(context);
    },
    allowedReadEndpoints: [...CUSTOMER_SERVICE_READ_ENDPOINTS],
  };
}
