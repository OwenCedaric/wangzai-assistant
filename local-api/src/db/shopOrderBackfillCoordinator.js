const NON_RETRYABLE_CODES = new Set([
  'SHOP_BINDING_DISABLED',
  'SHOP_BINDING_NOT_ACTIVE',
  'SHOP_SCOPE_NOT_FOUND',
  'SHOP_SCOPE_FORBIDDEN',
  'SHOP_INCARNATION_STALE',
  'SHOP_CREDENTIAL_REVISION_STALE',
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), minimum), maximum);
}

export function createShopOrderBackfillCoordinator({
  shopRepository,
  shopOrderStorage,
  batchSize = 100,
  batchDelayMs = 250,
  discoveryIntervalMs = 300_000,
  maxRetries = 3,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => undefined,
  onShopCompleted = () => undefined,
} = {}) {
  if (!shopRepository?.listShops) throw new Error('SHOP_ORDER_BACKFILL_REPOSITORY_REQUIRED');
  if (!shopOrderStorage?.backfillNextBatch) throw new Error('SHOP_ORDER_BACKFILL_STORAGE_REQUIRED');
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new Error('SHOP_ORDER_BACKFILL_TIMER_REQUIRED');
  }

  const normalizedBatchSize = boundedInteger(batchSize, 100, 1, 300);
  const normalizedBatchDelayMs = boundedInteger(batchDelayMs, 250, 10, 60_000);
  const normalizedDiscoveryIntervalMs = boundedInteger(discoveryIntervalMs, 300_000, 1_000, 3_600_000);
  const normalizedMaxRetries = boundedInteger(maxRetries, 3, 0, 20);
  const queue = [];
  const queuedShopIds = new Set();
  const retryCounts = new Map();
  const pausedOwners = new Set();
  let active = false;
  let processing = false;
  let timer = null;
  const counters = {
    discoveries: 0,
    batches: 0,
    mirroredRows: 0,
    verifiedRows: 0,
    completedShops: 0,
    failures: 0,
    lastErrorCode: '',
    lastShopId: '',
    lastRunAt: '',
  };

  function enqueueShop(shopIdInput) {
    const shopId = normalizeText(shopIdInput);
    if (!shopId || pausedOwners.has(shopId) || queuedShopIds.has(shopId)) return false;
    queuedShopIds.add(shopId);
    queue.push(shopId);
    return true;
  }

  function discover() {
    const shops = shopRepository.listShops();
    let added = 0;
    for (const shop of shops) {
      if (shop?.status !== 'active' || shop?.disabledAt) continue;
      if (enqueueShop(shop.id)) added += 1;
    }
    counters.discoveries += 1;
    return Object.freeze({ discovered: shops.length, added, queued: queue.length });
  }

  function schedule(delayMs) {
    if (!active || timer) return;
    timer = setTimer(() => {
      timer = null;
      tick();
    }, delayMs);
    timer?.unref?.();
  }

  function reportFailure(error, shopId) {
    const errorCode = String(error?.code || error?.message || 'SHOP_ORDER_BACKFILL_FAILED');
    counters.failures += 1;
    counters.lastErrorCode = errorCode;
    try {
      shopOrderStorage.recordBackfillFailure?.({ shopId, errorCode });
    } catch {
      // The original migration failure is the useful diagnostic.
    }
    try { onError(error, { shopId, errorCode }); } catch { /* observer only */ }
    return errorCode;
  }

  function runOnce() {
    if (processing) return Object.freeze({ ok: true, skipped: true, reason: 'already_processing' });
    if (!queue.length) discover();
    const shopId = queue.shift();
    if (!shopId) return Object.freeze({ ok: true, idle: true });
    queuedShopIds.delete(shopId);
    processing = true;
    counters.lastShopId = shopId;
    counters.lastRunAt = new Date().toISOString();
    try {
      const result = shopOrderStorage.backfillNextBatch({ shopId, batchSize: normalizedBatchSize });
      counters.batches += 1;
      counters.mirroredRows += Number(result?.mirrored) || 0;
      counters.verifiedRows += Number(result?.verified) || 0;
      if (result?.hasMore) {
        enqueueShop(shopId);
      } else {
        retryCounts.delete(shopId);
        if (!result?.alreadyComplete) counters.completedShops += 1;
        onShopCompleted({ shopId, result });
      }
      return Object.freeze({ ok: true, shopId, ...result });
    } catch (error) {
      const errorCode = reportFailure(error, shopId);
      const retries = (retryCounts.get(shopId) || 0) + 1;
      retryCounts.set(shopId, retries);
      if (!NON_RETRYABLE_CODES.has(errorCode) && retries <= normalizedMaxRetries) enqueueShop(shopId);
      return Object.freeze({ ok: false, shopId, errorCode, retries });
    } finally {
      processing = false;
    }
  }

  function tick() {
    if (!active) return;
    runOnce();
    schedule(queue.length ? normalizedBatchDelayMs : normalizedDiscoveryIntervalMs);
  }

  function start() {
    if (active) return snapshot();
    active = true;
    discover();
    schedule(10);
    return snapshot();
  }

  function stop() {
    active = false;
    if (timer) clearTimer(timer);
    timer = null;
    queue.length = 0;
    queuedShopIds.clear();
    retryCounts.clear();
    return snapshot();
  }

  function wake(shopId = '') {
    const normalizedShopId = normalizeText(shopId);
    if (normalizedShopId) enqueueShop(normalizedShopId);
    else discover();
    if (active && !processing) {
      if (timer) clearTimer(timer);
      timer = null;
      schedule(10);
    }
    return snapshot();
  }

  function snapshot() {
    return Object.freeze({
      mode: 'single-lane-round-robin-resumable',
      active,
      processing,
      batchSize: normalizedBatchSize,
      batchDelayMs: normalizedBatchDelayMs,
      discoveryIntervalMs: normalizedDiscoveryIntervalMs,
      maxRetries: normalizedMaxRetries,
      queuedShops: queue.length,
      ...counters,
    });
  }

  function pauseOwner(shopIdInput) {
    const shopId = normalizeText(shopIdInput);
    if (!shopId) throw new Error('SHOP_ORDER_BACKFILL_OWNER_REQUIRED');
    pausedOwners.add(shopId);
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index] === shopId) queue.splice(index, 1);
    queuedShopIds.delete(shopId); retryCounts.delete(shopId);
    return { paused: true, active: processing && counters.lastShopId === shopId ? 1 : 0 };
  }
  function releaseOwner(shopIdInput) { const id = normalizeText(shopIdInput); pausedOwners.delete(id); return { paused: false }; }
  function getOwnerStatus(shopIdInput) { const id = normalizeText(shopIdInput); return { paused: pausedOwners.has(id), queued: queuedShopIds.has(id) ? 1 : 0, active: processing && counters.lastShopId === id ? 1 : 0 }; }

  return Object.freeze({ start, stop, wake, discover, runOnce, snapshot, pauseOwner, releaseOwner, getOwnerStatus });
}
