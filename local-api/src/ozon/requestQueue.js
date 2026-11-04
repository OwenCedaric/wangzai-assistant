const PRIORITY_WEIGHT = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, WRITE: 0 });

const KNOWN_PROFILES = new Set(['foreground', 'background', 'write', 'readback']);

function normalizePriority(priority) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_WEIGHT, priority) ? priority : 'P2';
}

function normalizeProfile(profile) {
  return KNOWN_PROFILES.has(profile) ? profile : 'foreground';
}

function getLimit(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function getOptionalLimit(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function endpointSpecificConcurrency(item = {}) {
  return getOptionalLimit(item.ticket?.endpoint?.rate?.concurrency ?? item.ticket?.endpoint?.rateLimit?.concurrency);
}

function createQueueError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'OzonRequestQueueError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requireShopId(value) {
  const shopId = String(value || '').trim();
  if (shopId) return shopId;
  throw createQueueError(
    'OZON_QUEUE_SHOP_SCOPE_REQUIRED',
    'Ozon request queue requires an exact shopId.',
  );
}

function count(map, key) {
  return map.get(key) || 0;
}

function increment(map, key) {
  map.set(key, count(map, key) + 1);
}

function decrement(map, key) {
  const next = Math.max(0, count(map, key) - 1);
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

export function createRequestQueue(options = {}) {
  const profiles = options.profiles && typeof options.profiles === 'object' ? options.profiles : {};
  const permitController = options.permitController || options.trafficController || null;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const shopConcurrency = getLimit(options.shopConcurrency, 2);
  const endpointConcurrency = getLimit(options.endpointConcurrency, 2);
  const writeConcurrency = getLimit(options.writeConcurrency, 1);
  const maxQueueSizePerShop = getLimit(options.maxQueueSizePerShop ?? options.maxQueueSize, 500);
  const queueTimeoutMs = getLimit(options.queueTimeoutMs, 30_000);
  const queue = [];
  const active = new Map();
  const permitWaitTraceIntervalMs = getLimit(options.permitWaitTraceIntervalMs, 1_000);
  const globalConcurrency = getLimit(options.globalConcurrency, 8);
  const activeByShop = new Map();
  const activeByShopEndpoint = new Map();
  const activeByProfile = new Map();
  const activeByProfileShop = new Map();
  const activeByProfileShopEndpoint = new Map();
  const canceledJobIds = new Set();
  const pausedShops = new Set();
  const quiescedShops = new Set();
  const pausedEndpoints = new Set();
  let sequence = 0;
  let dispatchSequence = 0;
  const lastDispatchByShop = new Map();
  let rejectedCount = 0;
  let pumpTimer = null;
  let pumpTimerDueAt = 0;

  function profileShopKey(profile, shopId) {
    return `${profile}::${shopId}`;
  }

  function shopEndpointKey(shopId, endpointKey) {
    return `${shopId}::${endpointKey || 'unknown'}`;
  }

  function profileShopEndpointKey(profile, shopId, endpointKey) {
    return `${profile}::${shopId}::${endpointKey || 'unknown'}`;
  }

  function profileLimit(profile, name) {
    return getOptionalLimit(profiles?.[profile]?.[name]);
  }

  function schedulePump(waitMs = 0) {
    const delay = Math.max(0, Math.min(Number(waitMs) || 0, 2_147_483_647));
    if (delay === 0) {
      queueMicrotask(pump);
      return;
    }

    const dueAt = Date.now() + delay;
    if (pumpTimer && pumpTimerDueAt <= dueAt) return;
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimerDueAt = dueAt;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pumpTimerDueAt = 0;
      pump();
    }, delay);
  }

  function emit(phase, item, extra = {}) {
    try {
      onEvent({
        phase,
        status: extra.status || phase,
        jobId: item?.jobId || null,
        requestId: item?.id || item?.ticket?.requestId || null,
        domain: item?.ticket?.domain || item?.domain || null,
        shopId: item?.shopId || null,
        endpointKey: item?.endpointKey || null,
        batchIndex: item?.ticket?.index ?? null,
        batchTotal: item?.ticket?.total ?? null,
        priority: item?.priority || null,
        profile: item?.profile || null,
        source: item?.ticket?.source || null,
        snapshotId: item?.ticket?.snapshotId || null,
        queueWaitMs: item ? Date.now() - item.queuedAt : null,
        permitWaitMs: item?.permitWaitMs || 0,
        ...extra,
      });
    } catch (_error) {
      // Queue telemetry must never block scheduled Ozon work.
    }
  }

  function activeReadCount(shopId) {
    return [...active.values()].filter(
      (item) => item.shopId === shopId && item.priority !== 'WRITE',
    ).length;
  }

  function activeWriteCount(shopId) {
    return [...active.values()].filter(
      (item) => item.shopId === shopId && item.priority === 'WRITE',
    ).length;
  }

  function activeGlobalWriteCount() {
    return [...active.values()].filter((item) => item.priority === 'WRITE').length;
  }

  function canRun(item) {
    if (canceledJobIds.has(item.jobId)) return true;
    if (pausedShops.has(item.shopId)) return false;
    if (pausedEndpoints.has(item.endpointKey || 'unknown')) return false;
    if (active.size >= globalConcurrency) return false;
    const profileGlobalConcurrency = profileLimit(item.profile, 'globalConcurrency');
    if (profileGlobalConcurrency != null && count(activeByProfile, item.profile) >= profileGlobalConcurrency) return false;

    if (item.priority === 'WRITE') {
      if (activeReadCount(item.shopId) > 0) return false;
      if (activeWriteCount(item.shopId) >= writeConcurrency) return false;
      if (activeGlobalWriteCount() >= writeConcurrency) return false;
      return true;
    }

    if (activeWriteCount(item.shopId) > 0) return false;
    if (count(activeByShop, item.shopId) >= shopConcurrency) return false;
    const endpointLimit = endpointSpecificConcurrency(item) ?? endpointConcurrency;
    if (count(activeByShopEndpoint, shopEndpointKey(item.shopId, item.endpointKey)) >= Math.min(endpointConcurrency, endpointLimit)) return false;
    const profileShopConcurrency = profileLimit(item.profile, 'shopConcurrency');
    if (profileShopConcurrency != null && count(activeByProfileShop, profileShopKey(item.profile, item.shopId)) >= profileShopConcurrency) return false;
    const profileEndpointConcurrency = profileLimit(item.profile, 'endpointConcurrency');
    if (profileEndpointConcurrency != null && count(activeByProfileShopEndpoint, profileShopEndpointKey(item.profile, item.shopId, item.endpointKey)) >= profileEndpointConcurrency) return false;
    return true;
  }

  function getPermit(item) {
    if (!permitController) return { allowed: true, waitMs: 0 };
    const method = permitController.reserve || permitController.acquirePermit || permitController.acquire;
    if (typeof method !== 'function') return { allowed: true, waitMs: 0 };
    return method.call(permitController, item.ticket) || { allowed: true, waitMs: 0 };
  }

  function rejectTimedOutItems() {
    const now = Date.now();
    let rejected = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index];
      if (now - item.queuedAt >= queueTimeoutMs) {
        queue.splice(index, 1);
        rejected += 1;
        const error = createQueueError('OZON_QUEUE_TIMEOUT', 'Queued Ozon request exceeded queueTimeoutMs.', {
          jobId: item.jobId,
          queueTimeoutMs,
        });
        emit('failed', item, { status: 'timeout', errorCode: error.code, errorMessage: error.message });
        item.reject(error);
      }
    }
    if (rejected > 0) rejectedCount += rejected;
  }

  function sortQueue() {
    queue.sort((a, b) => {
      const priorityDiff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      const aShop = a.shopId;
      const bShop = b.shopId;
      const aLastDispatch = lastDispatchByShop.get(aShop) ?? -1;
      const bLastDispatch = lastDispatchByShop.get(bShop) ?? -1;
      if (aLastDispatch !== bLastDispatch) return aLastDispatch - bLastDispatch;
      return a.sequence - b.sequence;
    });
  }

  function pump() {
    rejectTimedOutItems();
    sortQueue();
    let progressed = false;

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!canRun(item)) continue;

      let permit;
      try {
        permit = getPermit(item);
      } catch (error) {
        queue.splice(index, 1);
        index -= 1;
        emit('failed', item, {
          status: 'permit_failed',
          errorCode: error?.code || 'OZON_PERMIT_FAILED',
          errorMessage: error?.message || String(error),
        });
        item.reject(error);
        continue;
      }

      if (permit?.allowed === false) {
        const now = Date.now();
        if (!item.permitWaitStartedAt) item.permitWaitStartedAt = now;
        item.lastPermitWaitMs = Math.max(0, Number(permit.waitMs ?? permit.retryAfterMs ?? 100) || 100);
        item.nextPermitAt = new Date(now + item.lastPermitWaitMs).toISOString();
        item.ticket.permitWaitMs = item.permitWaitMs + (now - item.permitWaitStartedAt);
        item.ticket.nextPermitAt = item.nextPermitAt;
        const permitStatus = permit.status || 'waiting';
        const permitSignature = `${permitStatus}:${item.lastPermitWaitMs}:${permit.message || ''}`;
        if (
          !item.lastPermitWaitTraceAt ||
          item.lastPermitWaitSignature !== permitSignature ||
          now - item.lastPermitWaitTraceAt >= permitWaitTraceIntervalMs
        ) {
          item.lastPermitWaitTraceAt = now;
          item.lastPermitWaitSignature = permitSignature;
          emit('permit_wait', item, {
            status: permitStatus,
            permitWaitMs: item.ticket.permitWaitMs,
            retryAfterMs: permit.retryAfterMs ?? permit.waitMs ?? null,
            message: permit.message || null,
          });
        }
        schedulePump(item.lastPermitWaitMs);
        continue;
      }

      queue.splice(index, 1);
      index -= 1;

      if (canceledJobIds.has(item.jobId)) {
        const error = createQueueError('OZON_QUEUE_JOB_CANCELED', 'Queued job was canceled before execution.', { jobId: item.jobId });
        emit('canceled', item, { errorCode: error.code, errorMessage: error.message });
        item.reject(error);
        continue;
      }

      const now = Date.now();
      if (item.permitWaitStartedAt) {
        item.permitWaitMs += now - item.permitWaitStartedAt;
        item.permitWaitStartedAt = null;
      }
      item.ticket.queueWaitMs = now - item.queuedAt;
      item.ticket.permitWaitMs = item.permitWaitMs;
      item.ticket.permit = permit;
      active.set(item.id, item);
      increment(activeByShop, item.shopId);
      increment(activeByShopEndpoint, shopEndpointKey(item.shopId, item.endpointKey));
      increment(activeByProfile, item.profile);
      increment(activeByProfileShop, profileShopKey(item.profile, item.shopId));
      increment(activeByProfileShopEndpoint, profileShopEndpointKey(item.profile, item.shopId, item.endpointKey));
      lastDispatchByShop.set(item.shopId, dispatchSequence += 1);
      progressed = true;
      emit('running', item, { queueWaitMs: item.ticket.queueWaitMs, permitWaitMs: item.ticket.permitWaitMs });

      Promise.resolve()
        .then(() => item.handler(item.ticket))
        .then((value) => {
          emit('success', item);
          item.resolve(value);
        }, (error) => {
          emit('failed', item, {
            errorCode: error?.code || 'OZON_QUEUE_HANDLER_FAILED',
            errorMessage: error?.message || String(error),
          });
          item.reject(error);
        })
        .finally(() => {
          active.delete(item.id);
          decrement(activeByShop, item.shopId);
          decrement(activeByShopEndpoint, shopEndpointKey(item.shopId, item.endpointKey));
          decrement(activeByProfile, item.profile);
          decrement(activeByProfileShop, profileShopKey(item.profile, item.shopId));
          decrement(activeByProfileShopEndpoint, profileShopEndpointKey(item.profile, item.shopId, item.endpointKey));
          schedulePump(0);
        });
    }

    return progressed;
  }

  function enqueue(ticket = {}, handler) {
    if (typeof handler !== 'function') {
      return Promise.reject(createQueueError('OZON_QUEUE_HANDLER_REQUIRED', 'Request queue requires a handler function.'));
    }
    let normalizedShopId;
    try {
      normalizedShopId = requireShopId(ticket.shopId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (quiescedShops.has(normalizedShopId)) {
      rejectedCount += 1;
      return Promise.reject(createQueueError(
        'OZON_QUEUE_OWNER_QUIESCED',
        'Ozon request owner is fenced for account removal.',
        { jobId: ticket.jobId || null, shopId: normalizedShopId },
      ));
    }
    const queuedForShop = queue.filter((item) => item.shopId === normalizedShopId).length;
    if (queuedForShop >= maxQueueSizePerShop) {
      rejectedCount += 1;
      return Promise.reject(createQueueError('OZON_QUEUE_FULL', 'The shop Ozon request queue reached its safety limit.', {
        shopId: normalizedShopId,
        maxQueueSizePerShop,
      }));
    }
    const id = ticket.requestId || `queue_${Date.now()}_${sequence + 1}`;
    const item = {
      id,
      sequence: sequence += 1,
      priority: normalizePriority(ticket.priority),
      profile: normalizeProfile(ticket.profile),
      shopId: normalizedShopId,
      endpointKey: ticket.endpointKey || 'unknown',
      jobId: ticket.jobId || null,
      queuedAt: Date.now(),
      permitWaitMs: 0,
      permitWaitStartedAt: null,
      lastPermitWaitMs: null,
      lastPermitWaitTraceAt: 0,
      lastPermitWaitSignature: null,
      nextPermitAt: null,
      ticket,
      handler,
      resolve: null,
      reject: null,
    };
    item.ticket.profile = item.profile;

    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    queue.push(item);
    emit('queued', item);
    schedulePump(0);
    return promise;
  }

  function cancelJob(jobId) {
    if (!jobId) return { canceled: 0, jobId };
    canceledJobIds.add(jobId);
    let canceled = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index];
      if (item.jobId === jobId) {
        queue.splice(index, 1);
        const error = createQueueError('OZON_QUEUE_JOB_CANCELED', 'Queued job was canceled by request.', { jobId });
        emit('canceled', item, { errorCode: error.code, errorMessage: error.message });
        item.reject(error);
        canceled += 1;
      }
    }
    schedulePump(0);
    return { canceled, jobId, runningNotKilled: [...active.values()].some((item) => item.jobId === jobId) };
  }

  function cancelQueuedForShop(shopId) {
    const normalizedShopId = requireShopId(shopId);
    let canceled = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index];
      if (item.shopId !== normalizedShopId) continue;
      queue.splice(index, 1);
      const error = createQueueError(
        'OZON_QUEUE_OWNER_QUIESCED',
        'Queued Ozon request was canceled because its owner is being removed.',
        { jobId: item.jobId, shopId: normalizedShopId },
      );
      emit('canceled', item, { errorCode: error.code, errorMessage: error.message });
      item.reject(error);
      canceled += 1;
    }
    schedulePump(0);
    return canceled;
  }

  function ownerStatus(shopId) {
    const normalizedShopId = requireShopId(shopId);
    return {
      shopId: normalizedShopId,
      paused: pausedShops.has(normalizedShopId),
      fenced: quiescedShops.has(normalizedShopId),
      queued: queue.filter((item) => item.shopId === normalizedShopId).length,
      running: count(activeByShop, normalizedShopId),
    };
  }

  async function waitForShopIdle(shopId, timeoutMs = 30_000) {
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
    for (;;) {
      const status = ownerStatus(shopId);
      if (status.queued === 0 && status.running === 0) return { ok: true, ...status };
      if (Date.now() >= deadline) {
        throw createQueueError('OZON_QUEUE_OWNER_DRAIN_TIMEOUT', 'Timed out while draining owner-scoped Ozon requests.', status);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function queuedByPriority() {
    return queue.reduce((acc, item) => {
      acc[item.priority] = (acc[item.priority] || 0) + 1;
      return acc;
    }, {});
  }

  function queuedByProfile() {
    return queue.reduce((acc, item) => {
      acc[item.profile] = (acc[item.profile] || 0) + 1;
      return acc;
    }, {});
  }

  const api = {
    enqueue,
    cancelJob,
    pauseShop(shopId) {
      const normalizedShopId = requireShopId(shopId);
      pausedShops.add(normalizedShopId);
      return { ok: true, shopId: normalizedShopId, paused: true };
    },
    async quiesceShop(shopId, { timeoutMs = 30_000 } = {}) {
      const normalizedShopId = requireShopId(shopId);
      pausedShops.add(normalizedShopId);
      quiescedShops.add(normalizedShopId);
      const canceled = cancelQueuedForShop(normalizedShopId);
      const drained = await waitForShopIdle(normalizedShopId, timeoutMs);
      return { ...drained, canceled };
    },
    getShopStatus: ownerStatus,
    resumeShop(shopId) {
      const normalizedShopId = requireShopId(shopId);
      pausedShops.delete(normalizedShopId);
      quiescedShops.delete(normalizedShopId);
      schedulePump(0);
      return { ok: true, shopId: normalizedShopId, paused: false, fenced: false };
    },
    pauseEndpoint(endpointKey) {
      pausedEndpoints.add(endpointKey || 'unknown');
      return { ok: true, endpointKey: endpointKey || 'unknown', paused: true };
    },
    resumeEndpoint(endpointKey) {
      pausedEndpoints.delete(endpointKey || 'unknown');
      schedulePump(0);
      return { ok: true, endpointKey: endpointKey || 'unknown', paused: false };
    },
    sweepTimeouts() {
      rejectTimedOutItems();
      schedulePump(0);
      return { ok: true, queued: queue.length, rejectedCount };
    },
    getStatus() {
      const oldestQueuedAt = queue.length ? new Date(Math.min(...queue.map((item) => item.queuedAt))).toISOString() : null;
      return {
        ok: true,
        queued: queue.length,
        running: active.size,
        isolationMode: 'global-budget+per-shop',
        limits: {
          globalConcurrency,
          shopConcurrency,
          endpointConcurrency,
          writeConcurrency,
          maxQueueSizePerShop,
          queueTimeoutMs,
          permitWaitTraceIntervalMs,
        },
        profiles,
        activeByShop: Object.fromEntries(activeByShop.entries()),
        activeByShopEndpoint: Object.fromEntries(activeByShopEndpoint.entries()),
        activeByProfile: Object.fromEntries(activeByProfile.entries()),
        queuedByPriority: queuedByPriority(),
        queuedByProfile: queuedByProfile(),
        queuedItems: queue.slice(0, 50).map((item) => ({
          requestId: item.id,
          jobId: item.jobId,
          domain: item.ticket.domain || null,
          shopId: item.shopId,
          endpointKey: item.endpointKey,
          priority: item.priority,
          profile: item.profile,
          queuedAt: new Date(item.queuedAt).toISOString(),
          queueWaitMs: Date.now() - item.queuedAt,
          permitWaitMs: item.permitWaitStartedAt ? item.permitWaitMs + (Date.now() - item.permitWaitStartedAt) : item.permitWaitMs,
          nextPermitAt: item.nextPermitAt,
        })),
        oldestQueuedAt,
        rejectedCount,
        pausedShops: [...pausedShops],
        pausedEndpoints: [...pausedEndpoints],
        canceledJobs: [...canceledJobIds],
      };
    },
  };

  return api;
}
