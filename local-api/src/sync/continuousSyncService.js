import {
  DEFAULT_HOT_CACHE_POLICY,
  buildHotCacheSyncInput,
  listHotCachePolicy,
} from './hotCachePolicy.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const STATUS_LIMIT = 200;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function activeShopIds(shopRepository) {
  return (shopRepository?.listShops?.() || [])
    .filter((shop) => isShopReadyForContinuousSync(shop))
    .map((shop) => String(shop.id || '').trim())
    .filter(Boolean);
}

function isShopReadyForContinuousSync(shop) {
  if (String(shop?.status || 'active').toLowerCase() !== 'active') return false;
  // Unit/integration adapters that predate public credential flags remain compatible.
  return shop?.hasClientId !== false && shop?.hasApiKey !== false;
}

function isAccepted(result) {
  return result?.accepted === true || result?.ok === true;
}

function taskKey(shopId, policyEntry) {
  return `${shopId}::${policyEntry.id}`;
}

function publicTaskStatus(status, getSyncJob) {
  let job = null;
  const jobId = status.lastResult?.jobId;
  if (jobId && typeof getSyncJob === 'function') {
    try {
      job = getSyncJob(jobId) || null;
    } catch {
      job = null;
    }
  }
  return {
    shopId: status.shopId,
    policyId: status.policyId,
    domain: status.domain,
    cadenceMs: status.cadenceMs,
    lastQueuedAt: status.lastQueuedAt || null,
    lastResult: status.lastResult
      ? {
          ...status.lastResult,
          jobStatus: job?.status || status.lastResult.status || null,
          jobFinishedAt: job?.finishedAt || null,
          jobLastError: job?.lastError || null,
          jobRetryAt: job?.retry?.nextRetryAt || null,
        }
      : null,
    nextDueAt: status.nextDueAt || null,
  };
}

/** 只调度领域 service；不直接访问 Ozon 或写业务表。 */
export function createContinuousSyncService({
  shopRepository,
  domainServices,
  policies = DEFAULT_HOT_CACHE_POLICY,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => new Date(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, admissionPollIntervalMs = 500,
  maxOutstandingTasks = 4, maxOutstandingTasksPerShop = 1,
  maxOutstandingTasksByDomain = { products: 1 }, maxAdmissionRuntimeMs = 4 * 60 * 60 * 1000,
  longPauseThresholdMs = Math.max(intervalMs * 2, 10 * 60 * 1000),
  recoveryReconcileState = null,
  getSyncJob = null,
  logger = () => {},
} = {}) {
  let timer = null;
  let running = false;
  let lastRun = null;
  let lastPassAtMs = null;
  const lastQueuedAtByTask = new Map();
  const taskStatuses = new Map();
  const ADMISSION_HISTORY_LIMIT = 500;
  const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'rate_limited', 'circuit_open']);
  let admissionTimer = null;
  const pausedShopIds = new Set();
  const pendingAdmissions = [];
  const activeAdmissions = new Map();
  const completedAdmissions = new Map();
  const admittedTaskKeys = new Set();
  let admissionSequence = 0;
  const admissionEnabled = typeof getSyncJob === 'function';
  const admissionGlobalLimit = Math.max(1, Math.floor(Number(maxOutstandingTasks) || 4));
  const admissionPerShopLimit = Math.max(1, Math.floor(Number(maxOutstandingTasksPerShop) || 1));
  const admissionDomainLimits = new Map(
    Object.entries(maxOutstandingTasksByDomain || {})
      .map(([domain, limit]) => [domain, Math.max(1, Math.floor(Number(limit) || 1))]),
  );
  const admissionPollMs = Math.max(50, Math.min(Number(admissionPollIntervalMs) || 500, 5_000));
  const admissionRuntimeLimitMs = Math.max(60_000, Number(maxAdmissionRuntimeMs) || 4 * 60 * 60 * 1000);

  function trigger(policyEntry, input) {
    const service = domainServices?.get?.(policyEntry.domain);
    if (!service?.startSync) {
      return {
        accepted: false,
        result: { domain: policyEntry.domain, accepted: false, reason: 'service_not_connected' },
      };
    }
    try {
      const result = service.startSync(input);
      return { accepted: isAccepted(result), result };
    } catch (error) {
      return {
        accepted: false,
        result: { domain: policyEntry.domain, accepted: false, reason: error?.message || String(error) },
      };
    }
  }

  function resultJobId(result) {
    return String(result?.jobId || result?.job?.jobId || result?.job?.id || '').trim() || null;
  }

  function admissionStatus(result) {
    return String(result?.status || result?.job?.status || '').trim().toLowerCase();
  }

  function activeAdmissionCount(predicate) {
    let total = 0;
    for (const admission of activeAdmissions.values()) {
      if (predicate(admission)) total += 1;
    }
    return total;
  }

  function canDispatchAdmission(admission) {
    if (pausedShopIds.has(admission.shopId)) return false;
    if (activeAdmissions.size >= admissionGlobalLimit) return false;
    if (activeAdmissionCount((item) => item.shopId === admission.shopId) >= admissionPerShopLimit) {
      return false;
    }
    const domainLimit = admissionDomainLimits.get(admission.policyEntry.domain);
    if (
      domainLimit != null &&
      activeAdmissionCount((item) => item.policyEntry.domain === admission.policyEntry.domain) >= domainLimit
    ) {
      return false;
    }
    return true;
  }

  function clearAdmissionTimer() {
    if (!admissionTimer) return;
    clearTimeoutImpl(admissionTimer);
    admissionTimer = null;
  }

  function scheduleAdmissionPass(delayMs = admissionPollMs) {
    if (!admissionEnabled || admissionTimer || (!pendingAdmissions.length && !activeAdmissions.size)) return;
    admissionTimer = setTimeoutImpl(() => {
      admissionTimer = null;
      drainAdmissions();
    }, Math.max(0, Number(delayMs) || 0));
    admissionTimer?.unref?.();
  }

  function rememberCompletedAdmission(admission, job) {
    const completed = {
      ...(job || {}),
      id: admission.admissionId,
      jobId: admission.admissionId,
      sourceJobId: admission.jobId || job?.jobId || job?.id || null,
      domain: admission.policyEntry.domain,
      shopId: admission.shopId,
      status: admissionStatus(job) || 'failed',
      finishedAt: job?.finishedAt || job?.finished_at || new Date().toISOString(),
    };
    completedAdmissions.delete(admission.admissionId);
    completedAdmissions.set(admission.admissionId, completed);
    while (completedAdmissions.size > ADMISSION_HISTORY_LIMIT) {
      completedAdmissions.delete(completedAdmissions.keys().next().value);
    }
    return completed;
  }

  function releaseAdmission(admission, job = null) {
    activeAdmissions.delete(admission.admissionId);
    admittedTaskKeys.delete(admission.key);
    if (job) rememberCompletedAdmission(admission, job);
  }

  function reapAdmissions() {
    if (!admissionEnabled || !activeAdmissions.size) return 0;
    let released = 0;
    const currentTime = Date.now();
    for (const admission of [...activeAdmissions.values()]) {
      let job = null;
      let readFailed = false;
      try {
        job = admission.jobId ? getSyncJob(admission.jobId) : null;
      } catch {
        readFailed = true;
      }
      if (!job && !readFailed) admission.missingPollCount = (admission.missingPollCount || 0) + 1;
      else if (job) admission.missingPollCount = 0;
      const status = admissionStatus(job);
      const expired = currentTime - admission.dispatchedAt >= admissionRuntimeLimitMs;
      const finished = Boolean(job?.finishedAt || job?.finished_at);
      const missing = admission.missingPollCount >= 20;
      if (finished || (status && !ACTIVE_JOB_STATUSES.has(status)) || expired || missing) {
        const terminalJob = job || {
          status: 'failed',
          lastError: expired ? 'CONTINUOUS_SYNC_ADMISSION_TIMEOUT' : 'CONTINUOUS_SYNC_JOB_NOT_FOUND',
        };
        releaseAdmission(admission, terminalJob);
        released += 1;
      }
    }
    return released;
  }

  function dispatchAdmission(admission) {
    const { accepted, result } = trigger(admission.policyEntry, admission.input);
    if (admission.resultRef) {
      Object.assign(admission.resultRef, result || {}, {
        accepted,
        admissionPending: false,
        reason: result?.reason || null,
      });
    }
    recordTaskStatus({
      shopId: admission.shopId,
      policyEntry: admission.policyEntry,
      at: admission.at,
      accepted,
      result,
    });
    if (!accepted) {
      admittedTaskKeys.delete(admission.key);
      lastQueuedAtByTask.delete(admission.key);
      rememberCompletedAdmission(admission, {
        status: 'failed',
        lastError: result?.reason || result?.error?.code || 'CONTINUOUS_SYNC_DISPATCH_REJECTED',
      });
      return { accepted, result, recoveryQueued: 0 };
    }

    const jobId = resultJobId(result);
    const status = admissionStatus(result);
    const recoveryQueued = admission.recovery
      ? markRecoveryQueued(admission.recovery, admission.shopId, [{
        shopId: admission.shopId,
        policyId: admission.policyEntry.id,
        domain: admission.policyEntry.domain,
        accepted,
        result,
      }])
      : 0;
    if (!jobId || (status && !ACTIVE_JOB_STATUSES.has(status))) {
      admittedTaskKeys.delete(admission.key);
      rememberCompletedAdmission(admission, jobId
        ? result
        : {
            status: status || 'failed',
            lastError: result?.reason || 'CONTINUOUS_SYNC_JOB_REFERENCE_MISSING',
          });
      return { accepted, result, recoveryQueued };
    }
    activeAdmissions.set(admission.admissionId, {
      ...admission,
      jobId,
      dispatchedAt: Date.now(),
    });
    return { accepted, result, recoveryQueued };
  }

  function drainAdmissions() {
    if (!admissionEnabled) return { dispatched: 0, pending: 0, active: 0, recoveryQueued: 0 };
    clearAdmissionTimer();
    reapAdmissions();
    let dispatched = 0;
    let recoveryQueued = 0;
    for (;;) {
      if (activeAdmissions.size >= admissionGlobalLimit) break;
      const index = pendingAdmissions.findIndex(canDispatchAdmission);
      if (index < 0) break;
      const [admission] = pendingAdmissions.splice(index, 1);
      const result = dispatchAdmission(admission);
      recoveryQueued += Number(result?.recoveryQueued) || 0;
      dispatched += 1;
    }
    scheduleAdmissionPass();
    return {
      dispatched,
      pending: pendingAdmissions.length,
      active: activeAdmissions.size,
      recoveryQueued,
    };
  }

  function admit(policyEntry, input, context) {
    if (!admissionEnabled) return trigger(policyEntry, input);
    const key = taskKey(context.shopId, policyEntry);
    if (admittedTaskKeys.has(key)) {
      const active = [...activeAdmissions.values()].find((item) => item.key === key);
      return {
        accepted: true,
        result: {
          domain: policyEntry.domain,
          accepted: true,
          status: active ? 'running' : 'waiting_admission',
          jobId: active?.jobId || null,
          reason: 'already_admitted',
          admissionPending: true,
        },
      };
    }
    const result = {
      domain: policyEntry.domain,
      accepted: true,
      status: 'waiting_admission',
      reason: 'admitted',
      admissionPending: true,
    };
    const admission = {
      admissionId: `continuous_admission_${admissionSequence += 1}`,
      key,
      shopId: context.shopId,
      policyEntry,
      input,
      at: context.at,
      recovery: context.recovery || null,
      queuedAt: Date.now(),
      resultRef: result,
    };
    result.admissionId = admission.admissionId;
    admittedTaskKeys.add(key);
    pendingAdmissions.push(admission);
    return {
      accepted: true,
      result,
    };
  }

  function recordTaskStatus({ shopId, policyEntry, at, accepted, result }) {
    const key = taskKey(shopId, policyEntry);
    const nextDueAt = new Date(at.getTime() + policyEntry.cadenceMs).toISOString();
    const status = {
      shopId,
      policyId: policyEntry.id,
      domain: policyEntry.domain,
      cadenceMs: policyEntry.cadenceMs,
      lastQueuedAt: accepted ? at.toISOString() : taskStatuses.get(key)?.lastQueuedAt || null,
      lastResult: {
        accepted,
        status: result?.status || null,
        jobId: result?.jobId || result?.job?.jobId || null,
        reason: result?.reason || result?.error?.code || null,
      },
      nextDueAt: accepted ? nextDueAt : null,
    };
    taskStatuses.delete(key);
    taskStatuses.set(key, status);
    while (taskStatuses.size > STATUS_LIMIT) taskStatuses.delete(taskStatuses.keys().next().value);
  }

  function isDue(shopId, policyEntry, nowMs, force) {
    if (force) return true;
    const lastQueuedAt = lastQueuedAtByTask.get(taskKey(shopId, policyEntry));
    return !lastQueuedAt || nowMs - lastQueuedAt >= policyEntry.cadenceMs;
  }

  function queueShopPolicies({
    shopId,
    at,
    force = false,
    startup = false,
    startupDomains = null,
    recovery = null,
  }) {
    if (pausedShopIds.has(shopId)) return { results: [], skippedNotDue: policies.length };
    const nowMs = at.getTime();
    const results = [];
    let skippedNotDue = 0;
    for (const policyEntry of policies) {
      if (!isDue(shopId, policyEntry, nowMs, force)) {
        skippedNotDue += 1;
        continue;
      }
      const useStartupPayload = startup || startupDomains?.has?.(policyEntry.domain) === true;
      const input = buildHotCacheSyncInput(policyEntry, {
        shopId,
        now: at,
        startup: useStartupPayload,
        recoveryReconcile: recovery,
      });
      const { accepted, result } = admit(policyEntry, input, {
        shopId,
        at,
        recovery,
      });
      if (accepted) lastQueuedAtByTask.set(taskKey(shopId, policyEntry), nowMs);
      recordTaskStatus({ shopId, policyEntry, at, accepted, result });
      results.push({
        shopId,
        policyId: policyEntry.id,
        domain: policyEntry.domain,
        accepted,
        result,
      });
    }
    return { results, skippedNotDue };
  }

  function summarizeRun({ at, startup, triggerName, shopCount, results, skippedNotDue, recoveryQueued = 0, recoveryFinalized = 0 }) {
    lastRun = {
      at: at.toISOString(),
      startup,
      ...(triggerName ? { trigger: triggerName } : {}),
      shopCount,
      due: results.length,
      accepted: results.filter((item) => item.accepted).length,
      rejected: results.filter((item) => !item.accepted).length,
      skippedNotDue,
      recoveryQueued,
      recoveryFinalized,
    };
    logger('[local-api][continuous-sync] queued', lastRun);
    return { ok: true, skipped: false, ...lastRun, results };
  }

  function markRecoveryQueued(recovery, shopId, queuedResults) {
    if (!recovery) return 0;
    const dispatchedResults = queuedResults.filter((item) => !item.result?.admissionPending);
    if (!dispatchedResults.length) return 0;
    const accepted = dispatchedResults.filter((item) => item.accepted).length;
    const firstReason = dispatchedResults.find((item) => !item.accepted)?.result?.reason || null;
    const jobIds = dispatchedResults
      .filter((item) => item.accepted)
      .map((item) => item.result?.jobId || item.result?.job?.jobId || item.result?.job?.id)
      .filter(Boolean);
    try {
      recoveryReconcileState.markQueued({
        restoreId: recovery.restoreId,
        shopId,
        queuedPolicyCount: accepted,
        jobIds,
        lastError: firstReason,
      });
      return accepted > 0 ? 1 : 0;
    } catch (error) {
      logger('[local-api][continuous-sync] recovery reconcile state failed', error);
      return 0;
    }
  }

  function runOnce({ force = false, startup = false, startupDomains = null, resume = false } = {}) {
    if (running) return { ok: true, skipped: true, reason: 'already_running', lastRun };
    running = true;
    try {
      if (admissionEnabled) drainAdmissions();
      const at = toDate(now());
      const currentPassAtMs = at.getTime();
      const elapsedSincePassMs = lastPassAtMs == null ? 0 : Math.max(0, currentPassAtMs - lastPassAtMs);
      lastPassAtMs = currentPassAtMs;
      const recoveryFinalized = recoveryReconcileState?.reconcileQueuedJobs?.({ getJob: getSyncJob }) || [];
      const shopIds = activeShopIds(shopRepository).filter((shopId) => !pausedShopIds.has(shopId));
      const recoveryByShop = new Map(
        (recoveryReconcileState?.listPending?.() || []).map((item) => [item.shopId, item]),
      );
      const recoveredFromLongPause = resume || (
        !force &&
        !startup &&
        elapsedSincePassMs >= Math.max(1, Number(longPauseThresholdMs) || 1)
      );
      const forceCurrentPass = force || recoveredFromLongPause;
      const results = [];
      let skippedNotDue = 0;
      let recoveryQueued = 0;

      for (const shopId of shopIds) {
        const recovery = recoveryByShop.get(shopId) || null;
        const queued = queueShopPolicies({
          shopId,
          at,
          force: forceCurrentPass,
          startup,
          startupDomains,
          recovery,
        });
        results.push(...queued.results);
        skippedNotDue += queued.skippedNotDue;
        recoveryQueued += markRecoveryQueued(recovery, shopId, queued.results);
      }

      const admission = drainAdmissions();
      const summary = summarizeRun({
        at,
        startup,
        triggerName: recoveredFromLongPause ? 'resume-after-suspend' : undefined,
        shopCount: shopIds.length,
        results,
        skippedNotDue,
        recoveryQueued: recoveryQueued + admission.recoveryQueued,
        recoveryFinalized: recoveryFinalized.length,
      });
      return { ...summary, admission };
    } finally {
      running = false;
    }
  }

  function buildAdmissionSnapshot() {
    const admission = drainAdmissions();
    return {
      enabled: admissionEnabled,
      pending: admission.pending,
      active: admission.active,
      limits: {
        global: admissionGlobalLimit,
        perShop: admissionPerShopLimit,
        byDomain: Object.fromEntries(admissionDomainLimits.entries()),
      },
      pendingByShop: pendingAdmissions.reduce((output, item) => {
        output[item.shopId] = (output[item.shopId] || 0) + 1;
        return output;
      }, {}),
      activeByShop: [...activeAdmissions.values()].reduce((output, item) => {
        output[item.shopId] = (output[item.shopId] || 0) + 1;
        return output;
      }, {}),
      activeByDomain: [...activeAdmissions.values()].reduce((output, item) => {
        const domain = item.policyEntry.domain;
        output[domain] = (output[domain] || 0) + 1;
        return output;
      }, {}),
      completedHistory: completedAdmissions.size,
    };
  }

  function getAdmissionTask(admissionId) {
    const normalizedId = String(admissionId || '').trim();
    if (!normalizedId || !admissionEnabled) return null;
    drainAdmissions();
    const pending = pendingAdmissions.find((item) => item.admissionId === normalizedId);
    if (pending) {
      return {
        id: normalizedId,
        jobId: normalizedId,
        domain: pending.policyEntry.domain,
        shopId: pending.shopId,
        status: 'queued',
        stage: 'continuous-sync-admission',
      };
    }
    const active = activeAdmissions.get(normalizedId);
    if (active) {
      try {
        const job = getSyncJob(active.jobId);
        if (job) return { ...job, sourceJobId: active.jobId, id: normalizedId, jobId: normalizedId };
      } catch {
        // The durable job can be read again on the next lifecycle poll.
      }
      return {
        id: normalizedId,
        jobId: normalizedId,
        sourceJobId: active.jobId,
        domain: active.policyEntry.domain,
        shopId: active.shopId,
        status: 'running',
        stage: 'continuous-sync-admission',
      };
    }
    return completedAdmissions.get(normalizedId) || null;
  }

  return {
    start() {
      if (timer) return { ok: true, started: false, reason: 'already_started' };
      timer = setIntervalImpl(() => runOnce(), intervalMs);
      timer?.unref?.();
      // Every shop owns an independent scheduler lane. Product inventory uses
      // its complete bootstrap payload once per local-api process so SQLite is
      // already a durable, full product-list cache before the renderer needs
      // it. Other domains keep their bounded steady payloads and cannot be
      // inflated by the product bootstrap.
      const initial = runOnce({
        force: true,
        startup: false,
        startupDomains: new Set(['products']),
      });
      return { ok: true, started: true, initial };
    },
    stop() {
      const hadInterval = Boolean(timer);
      if (timer) clearIntervalImpl(timer);
      timer = null;
      clearAdmissionTimer();
      for (const admission of pendingAdmissions.splice(0, pendingAdmissions.length)) {
        admittedTaskKeys.delete(admission.key);
      }
      return {
        ok: true,
        stopped: hadInterval,
      };
    },
    runOnce,
    resumeAfterSuspend() {
      return runOnce({ force: true, startup: false, resume: true });
    },
    bootstrapShop(shopId) {
      const normalizedShopId = String(shopId || '').trim();
      if (pausedShopIds.has(normalizedShopId)) {
        return { ok: false, skipped: true, reason: 'shop_owner_paused' };
      }
      const shop = (shopRepository?.listShops?.() || [])
        .find((item) => String(item?.id || '').trim() === normalizedShopId);
      if (!normalizedShopId || !shop || !isShopReadyForContinuousSync(shop)) {
        return { ok: false, skipped: true, reason: 'shop_not_active_or_credentials_missing' };
      }
      if (running) return { ok: true, skipped: true, reason: 'already_running', lastRun };
      running = true;
      try {
        const at = toDate(now());
        // A newly bound shop has no durable product inventory yet. Queue the
        // complete product bootstrap in that shop's own background scheduler
        // lane while every other domain stays on its bounded steady payload.
        const queued = queueShopPolicies({
          shopId: normalizedShopId,
          at,
          force: true,
          startup: false,
          startupDomains: new Set(['products']),
        });
        const summary = summarizeRun({
          at,
          startup: true,
          triggerName: 'shop-credentials-saved',
          shopCount: 1,
          results: queued.results,
          skippedNotDue: queued.skippedNotDue,
        });
        return { ...summary, admission: drainAdmissions() };
      } finally {
        running = false;
      }
    },
    getStatus() {
      const admission = buildAdmissionSnapshot();
      return {
        ok: true,
        enabled: Boolean(timer),
        intervalMs,
        policy: listHotCachePolicy(policies),
        running,
        pausedShopIds: [...pausedShopIds].sort(),
        lastRun,
        targets: [...taskStatuses.values()].map((status) =>
          publicTaskStatus(status, getSyncJob),
        ),
        admission,
        recovery: recoveryReconcileState?.getStatus?.() || { pending: 0, queued: 0, rows: [] },
      };
    },
    getAdmissionStatus: buildAdmissionSnapshot,
    getAdmissionTask,
    pauseOwner(shopId) {
      const ownerId = String(shopId || '').trim();
      if (!ownerId) return { ok: false, paused: false };
      pausedShopIds.add(ownerId);
      for (let index = pendingAdmissions.length - 1; index >= 0; index -= 1) {
        const admission = pendingAdmissions[index];
        if (admission.shopId !== ownerId) continue;
        pendingAdmissions.splice(index, 1);
        admittedTaskKeys.delete(admission.key);
        rememberCompletedAdmission(admission, {
          status: 'canceled',
          lastError: 'CONTINUOUS_SYNC_OWNER_PAUSED',
        });
      }
      return {
        ok: true,
        paused: true,
        shopId: ownerId,
      };
    },
    releaseOwner(shopId) {
      const ownerId = String(shopId || '').trim();
      const released = pausedShopIds.delete(ownerId);
      if (released) scheduleAdmissionPass(0);
      return { ok: true, released, shopId: ownerId };
    },
    forgetOwner(shopId) {
      const ownerId = String(shopId || '').trim();
      let removed = 0;
      for (const key of [...lastQueuedAtByTask.keys()]) {
        if (!key.startsWith(`${ownerId}::`)) continue;
        lastQueuedAtByTask.delete(key);
        removed += 1;
      }
      for (const [key, status] of [...taskStatuses.entries()]) {
        if (status.shopId !== ownerId) continue;
        taskStatuses.delete(key);
        removed += 1;
      }
      for (let index = pendingAdmissions.length - 1; index >= 0; index -= 1) {
        const admission = pendingAdmissions[index];
        if (admission.shopId !== ownerId) continue;
        pendingAdmissions.splice(index, 1);
        admittedTaskKeys.delete(admission.key);
        removed += 1;
      }
      for (const [admissionId, admission] of [...completedAdmissions.entries()]) {
        if (admission.shopId !== ownerId) continue;
        completedAdmissions.delete(admissionId);
        removed += 1;
      }
      return { ok: true, removed, paused: pausedShopIds.has(ownerId) };
    },
    getOwnerStatus(shopId) {
      const ownerId = String(shopId || '').trim();
      return {
        paused: pausedShopIds.has(ownerId),
        taskCount: [...taskStatuses.values()].filter((status) => status.shopId === ownerId).length,
        pendingAdmissionCount: pendingAdmissions.filter((item) => item.shopId === ownerId).length,
        activeAdmissionCount: activeAdmissionCount((item) => item.shopId === ownerId),
        running,
      };
    },
  };
}
