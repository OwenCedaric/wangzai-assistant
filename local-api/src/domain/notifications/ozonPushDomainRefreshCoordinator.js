const ORDER_PUSH_ROUTES = Object.freeze({
  TYPE_NEW_POSTING: "FBS",
  TYPE_POSTING_CANCELLED: "FBS",
  TYPE_STATE_CHANGED: "FBS",
  TYPE_CUTOFF_DATE_CHANGED: "FBS",
  TYPE_DELIVERY_DATE_CHANGED: "FBS",
  TYPE_FBO_POSTING_NEW: "FBO",
  TYPE_FBO_POSTING_CANCELLED: "FBO",
  TYPE_FBO_POSTING_STATE_CHANGED: "FBO",
  TYPE_FBO_POSTING_DELIVERY_DATE_CHANGED: "FBO",
  TYPE_ORDER_NEW: "",
  TYPE_ORDER_CANCELLED: "",
  TYPE_ORDER_STATE_CHANGED: "",
});

const PRODUCT_PUSH_ROUTES = Object.freeze({
  TYPE_CREATE_OR_UPDATE_ITEM: ["detail", "pictures", "attributes"],
  TYPE_CREATE_ITEM: ["detail", "pictures", "attributes"],
  TYPE_UPDATE_ITEM: ["detail", "pictures", "attributes"],
  TYPE_PRICE_INDEX_CHANGED: ["prices"],
  TYPE_STOCKS_CHANGED: ["stocks"],
  TYPE_FBO_STOCKS_CHANGED: ["stocks"],
});

const CUSTOMER_PUSH_TYPES = new Set([
  "TYPE_NEW_MESSAGE",
  "TYPE_UPDATE_MESSAGE",
  "TYPE_MESSAGE_READ",
  "TYPE_CHAT_CLOSED",
]);

const CACHE_DEPENDENCIES = Object.freeze({
  orders: ["orders", "profit", "logistics", "reports", "dashboard-overview"],
  products: ["products", "marketing", "dashboard-overview"],
  customerService: ["customerService"],
});

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);

function normalizeText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function productRef(value = {}) {
  return {
    productId: normalizeText(value.productId ?? value.product_id),
    offerId: normalizeText(value.offerId ?? value.offer_id),
    sku: normalizeText(value.sku ?? value.skuId ?? value.sku_id),
  };
}

function productRefKey(ref = {}) {
  return `${normalizeText(ref.productId)}\u0000${normalizeText(ref.offerId)}\u0000${normalizeText(ref.sku)}`;
}

function unique(values = []) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function routeEvent(input = {}) {
  const messageType = normalizeText(input.messageType ?? input.message_type);
  const shopId = normalizeText(input.shopId ?? input.shop_id);
  if (!shopId) return { ignored: true, reason: "shop_identity_missing" };

  if (Object.hasOwn(ORDER_PUSH_ROUTES, messageType)) {
    const postingNumber = normalizeText(input.postingNumber ?? input.posting_number);
    if (!postingNumber) return { ignored: true, reason: "order_identity_missing" };
    return {
      domain: "orders",
      shopId,
      key: postingNumber,
      identity: postingNumber,
      postingNumber,
      sourceHint: ORDER_PUSH_ROUTES[messageType],
      messageType,
    };
  }

  if (Object.hasOwn(PRODUCT_PUSH_ROUTES, messageType)) {
    const providedRefs = Array.isArray(input.productRefs) ? input.productRefs : [];
    const refs = (providedRefs.length
      ? providedRefs
      : [{ productId: input.productId, offerId: input.offerId, sku: input.sku }])
      .map(productRef)
      .filter((ref) => ref.productId || ref.offerId || ref.sku);
    const deduped = new Map(refs.map((ref) => [productRefKey(ref), ref]));
    if (!deduped.size) return { ignored: true, reason: "product_identity_missing" };
    return {
      domain: "products",
      shopId,
      refs: [...deduped.values()],
      facets: PRODUCT_PUSH_ROUTES[messageType],
      messageType,
    };
  }

  if (CUSTOMER_PUSH_TYPES.has(messageType)) {
    const chatId = normalizeText(input.chatId ?? input.chat_id);
    return {
      domain: "customerService",
      shopId,
      key: chatId || "__chat_list__",
      identity: chatId || "__chat_list__",
      chatId,
      messageType,
    };
  }
  return { ignored: true, reason: "push_type_has_no_refresh_route" };
}

/**
 * Coalesces signed Ozon push bursts into exact per-shop read-backs. Ozon's
 * scheduler still enforces endpoint rate limits; this outer queue adds push
 * dedupe, bounded retry and one-at-a-time shop propagation.
 */
export function createOzonPushDomainRefreshCoordinator({
  refreshOrders,
  refreshProducts,
  refreshCustomerService,
  invalidateDomainHotCache,
  onDomainRefreshed,
  debounceMs = 3_000,
  minBatchIntervalMs = 1_000,
  maxBatchSize = 20,
  maxAttempts = 3,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  dedupeTtlMs = 10 * 60_000,
  failedDedupeTtlMs = 30_000,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  sleepFn = sleep,
  logger = console,
} = {}) {
  const shops = new Map();
  const recentlyFinished = new Map();
  let stopped = false;

  function stateFor(shopId) {
    let state = shops.get(shopId);
    if (!state) {
      state = { pending: new Map(), timer: null, runningPromise: null, lastBatchStartedAt: 0 };
      shops.set(shopId, state);
    }
    return state;
  }

  function pruneFinished() {
    const timestamp = now();
    for (const [key, expiresAt] of recentlyFinished) {
      if (expiresAt <= timestamp) recentlyFinished.delete(key);
    }
  }

  function schedule(shopId, state) {
    if (stopped || state.timer || state.runningPromise) return;
    state.timer = setTimeoutFn(() => {
      state.timer = null;
      if (!stopped) void drainShop(shopId);
    }, Math.max(0, debounceMs));
    state.timer?.unref?.();
  }

  function queueEntry(state, entry, remoteId) {
    const queueKey = `${entry.domain}:${entry.key}`;
    const recentKey = remoteId ? `${entry.shopId}:${queueKey}:${remoteId}` : "";
    if (recentKey && (recentlyFinished.get(recentKey) || 0) > now()) return false;
    const existing = state.pending.get(queueKey);
    if (existing) {
      existing.remoteIds.add(remoteId).delete("");
      existing.facets = unique([...(existing.facets || []), ...(entry.facets || [])]);
      if (!existing.sourceHint) existing.sourceHint = entry.sourceHint;
      return false;
    }
    state.pending.set(queueKey, {
      ...entry,
      queueKey,
      remoteIds: new Set([remoteId].filter(Boolean)),
      queuedAt: now(),
    });
    return true;
  }

  function enqueue(input = {}) {
    if (stopped) return { queued: false, ignored: true, reason: "coordinator_stopped" };
    const routed = routeEvent(input);
    if (routed.ignored) return { queued: false, ignored: true, reason: routed.reason };
    pruneFinished();
    const state = stateFor(routed.shopId);
    const remoteId = normalizeText(input.remoteId);
    let queuedCount = 0;
    if (routed.domain === "products") {
      routed.refs.forEach((ref) => {
        const key = productRefKey(ref);
        if (queueEntry(state, { ...routed, refs: [ref], key }, remoteId)) queuedCount += 1;
      });
    } else if (queueEntry(state, routed, remoteId)) {
      queuedCount = 1;
    }
    if (queuedCount) schedule(routed.shopId, state);
    return {
      queued: queuedCount > 0,
      deduped: queuedCount === 0,
      shopId: routed.shopId,
      domain: routed.domain,
      queuedCount,
      ...(routed.postingNumber ? { postingNumber: routed.postingNumber } : {}),
      ...(routed.chatId ? { chatId: routed.chatId } : {}),
    };
  }

  async function invalidateCaches(domain, shopId) {
    for (const cacheDomain of CACHE_DEPENDENCIES[domain] || [domain]) {
      await invalidateDomainHotCache?.(cacheDomain, shopId);
    }
  }

  async function finalizeSuccessfulRefresh(domain, shopId, entries, result) {
    if (!entries.length) return;
    await invalidateCaches(domain, shopId);
    try {
      await onDomainRefreshed?.({ domain, shopId, entries, result });
    } catch (error) {
      logger?.warn?.("Ozon 推送已完成精准刷新，但页面实时通知失败", {
        shopId,
        domain,
        error: error instanceof Error ? error.message : normalizeText(error),
      });
    }
  }

  async function refreshGroup(shopId, domain, entries, attempt) {
    const requestCycle = `${now()}-${attempt}`;
    if (domain === "orders") {
      const postingNumbers = unique(entries.map((entry) => entry.postingNumber));
      const sourceHints = Object.fromEntries(
        entries.filter((entry) => entry.sourceHint).map((entry) => [entry.postingNumber, entry.sourceHint]),
      );
      const result = await refreshOrders?.({
        shopId,
        postingNumbers,
        sourceHints,
        priority: "P1",
        requestedBy: "ozon-push-domain-refresh",
        requestCycle,
      });
      const failed = new Set(
        (Array.isArray(result?.results) ? result.results : [])
          .filter((row) => row?.found !== true)
          .map((row) => normalizeText(row?.postingNumber))
          .filter(Boolean),
      );
      if (!result?.ok || (!result?.results?.length && Number(result?.foundCount || 0) < postingNumbers.length)) {
        postingNumbers.forEach((postingNumber) => failed.add(postingNumber));
      }
      const successful = entries.filter((entry) => !failed.has(entry.postingNumber));
      await finalizeSuccessfulRefresh(domain, shopId, successful, result);
      return { result, failedEntries: entries.filter((entry) => failed.has(entry.postingNumber)) };
    }

    if (domain === "products") {
      const refs = entries.flatMap((entry) => entry.refs || []);
      const facets = unique(entries.flatMap((entry) => entry.facets || []));
      const result = await refreshProducts?.({
        shopId,
        refs,
        facets,
        priority: "P1",
        requestedBy: "ozon-push-domain-refresh",
        requestCycle,
      });
      const failed = new Set(Array.isArray(result?.failedRefKeys) ? result.failedRefKeys : []);
      if (!result?.ok && !failed.size) entries.forEach((entry) => failed.add(entry.key));
      const successful = entries.filter((entry) => !failed.has(entry.key));
      await finalizeSuccessfulRefresh(domain, shopId, successful, result);
      return { result, failedEntries: entries.filter((entry) => failed.has(entry.key)) };
    }

    const chatIds = unique(entries.map((entry) => entry.chatId));
    const includeChatList = entries.some((entry) => !entry.chatId);
    const result = await refreshCustomerService?.({
      shopId,
      chatIds,
      includeChatList,
      priority: "P1",
      requestedBy: "ozon-push-domain-refresh",
      requestCycle,
    });
    const failed = new Set(Array.isArray(result?.failedChatIds) ? result.failedChatIds : []);
    if (!result?.ok && !failed.size) entries.forEach((entry) => failed.add(entry.identity));
    const successful = entries.filter((entry) => !failed.has(entry.identity));
    await finalizeSuccessfulRefresh(domain, shopId, successful, result);
    return { result, failedEntries: entries.filter((entry) => failed.has(entry.identity)) };
  }

  async function synchronizeGroup(shopId, domain, originalEntries) {
    let remaining = [...originalEntries];
    let lastResult = null;
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts) && remaining.length; attempt += 1) {
      try {
        const outcome = await refreshGroup(shopId, domain, remaining, attempt);
        lastResult = outcome.result;
        remaining = outcome.failedEntries;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      if (!remaining.length || attempt >= Math.max(1, maxAttempts)) break;
      const delay = Number(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)]) || 0;
      await sleepFn(Math.max(0, delay));
    }

    const failedKeys = new Set(remaining.map((entry) => entry.queueKey));
    const timestamp = now();
    originalEntries.forEach((entry) => {
      const ttl = failedKeys.has(entry.queueKey) ? failedDedupeTtlMs : dedupeTtlMs;
      entry.remoteIds.forEach((remoteId) => {
        recentlyFinished.set(
          `${shopId}:${entry.queueKey}:${remoteId}`,
          timestamp + Math.max(0, ttl),
        );
      });
    });
    if (remaining.length) {
      logger?.warn?.("Ozon 推送触发的精准刷新重试后仍未完成", {
        shopId,
        domain,
        identities: remaining.map((entry) => entry.identity || entry.key),
        error: lastError instanceof Error ? lastError.message : normalizeText(lastError),
      });
    }
    return {
      ok: remaining.length === 0,
      shopId,
      domain,
      requested: originalEntries.length,
      synchronized: originalEntries.length - remaining.length,
      failed: remaining.length,
      lastResult,
    };
  }

  async function drainShop(shopId) {
    const state = stateFor(shopId);
    if (state.runningPromise) return state.runningPromise;
    state.runningPromise = (async () => {
      const summaries = [];
      while (!stopped && state.pending.size) {
        const waitMs = Math.max(0, state.lastBatchStartedAt + minBatchIntervalMs - now());
        if (waitMs) await sleepFn(waitMs);
        const batch = [...state.pending.values()].slice(0, Math.max(1, maxBatchSize));
        batch.forEach((entry) => state.pending.delete(entry.queueKey));
        state.lastBatchStartedAt = now();
        for (const domain of unique(batch.map((entry) => entry.domain))) {
          summaries.push(await synchronizeGroup(shopId, domain, batch.filter((entry) => entry.domain === domain)));
        }
      }
      return summaries;
    })().catch((error) => {
      logger?.error?.("Ozon 推送精准刷新队列执行失败", {
        shopId,
        error: error instanceof Error ? error.message : normalizeText(error),
      });
      return [];
    }).finally(() => {
      state.runningPromise = null;
      if (state.pending.size) schedule(shopId, state);
    });
    return state.runningPromise;
  }

  async function flushNow(shopId) {
    const normalizedShopId = normalizeText(shopId);
    const state = stateFor(normalizedShopId);
    if (state.timer) clearTimeoutFn(state.timer);
    state.timer = null;
    return drainShop(normalizedShopId);
  }

  function getStatus() {
    return {
      stopped,
      shops: [...shops.entries()].map(([shopId, state]) => ({
        shopId,
        pending: state.pending.size,
        running: Boolean(state.runningPromise),
      })),
      recentDedupeKeys: recentlyFinished.size,
    };
  }

  function stop() {
    stopped = true;
    for (const state of shops.values()) {
      if (state.timer) clearTimeoutFn(state.timer);
      state.timer = null;
      state.pending.clear();
    }
    recentlyFinished.clear();
  }

  return { enqueue, flushNow, getStatus, stop };
}

export const ozonPushDomainRefreshRoutes = Object.freeze({
  orders: ORDER_PUSH_ROUTES,
  products: PRODUCT_PUSH_ROUTES,
  customer: [...CUSTOMER_PUSH_TYPES],
});
