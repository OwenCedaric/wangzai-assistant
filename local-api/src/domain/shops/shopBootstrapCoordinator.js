import { createStableHash } from '../../utils/stableHash.js';
import { ShopIdentityError } from '../../db/repositories/shopIdentityRepository.js';

const ACTIVE_TASK_STATUSES = new Set([
  'accepted',
  'pending',
  'queued',
  'running',
  'rate_limited',
  'circuit_open',
]);
const SUCCESS_TASK_STATUSES = new Set(['success', 'completed', 'succeeded', 'cache_hit']);
const SOURCE_GAP_TASK_STATUSES = new Set(['partial', 'completed_with_source_gaps']);
const FAILED_TASK_STATUSES = new Set([
  'failed',
  'canceled',
  'cancelled',
  'blocked',
  'invalid',
  'interrupted',
]);
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'completed_with_source_gaps',
  'failed',
  'partial',
  'cancelled',
  'invalid',
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function scopeTokenOf(run) {
  return Object.freeze({
    profileId: run.profileId,
    shopId: run.shopId,
    shopIncarnation: run.shopIncarnation,
    credentialRevision: run.credentialRevision,
  });
}

function taskIdsFromResult(result) {
  const ids = new Set();
  const seen = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return;
    seen.add(value);
    const directId = normalizeText(value.jobId ?? value.job_id);
    if (directId) ids.add(directId);
    if (Array.isArray(value.jobIds)) {
      value.jobIds.map(normalizeText).filter(Boolean).forEach((id) => ids.add(id));
    }
    if (value.job) visit(value.job, depth + 1);
    if (Array.isArray(value.jobs)) value.jobs.forEach((item) => visit(item, depth + 1));
    seen.delete(value);
  }
  visit(result);
  return [...ids];
}

function taskErrorCode(value, fallback) {
  const code = normalizeText(
    value?.error?.code
      || value?.reason
      || value?.code
      || (value instanceof Error ? value.code || value.message : ''),
  );
  return /^[A-Z][A-Z0-9_:-]{2,127}$/u.test(code) ? code : fallback;
}

function normalizeTask(task) {
  const domain = normalizeText(task?.domain);
  const taskId = normalizeText(task?.taskId ?? task?.jobId ?? task?.id);
  const kind = normalizeText(task?.kind) || 'ozon';
  if (!domain || !taskId) return null;
  return Object.freeze({ domain, taskId, kind });
}

function classifyTaskStatus(job) {
  if (!job) return Object.freeze({ state: 'failed', status: 'missing' });
  const status = normalizeText(job.status).toLowerCase();
  if (SUCCESS_TASK_STATUSES.has(status)) return Object.freeze({ state: 'success', status });
  if (SOURCE_GAP_TASK_STATUSES.has(status)) return Object.freeze({ state: 'source_gap', status });
  if (FAILED_TASK_STATUSES.has(status)) return Object.freeze({ state: 'failed', status });
  if (ACTIVE_TASK_STATUSES.has(status) || !status) return Object.freeze({ state: 'active', status: status || 'pending' });
  return Object.freeze({ state: 'active', status });
}

function domainProof(run, domain, observations) {
  return createStableHash({
    runId: run.runId,
    profileId: run.profileId,
    shopId: run.shopId,
    shopIncarnation: run.shopIncarnation,
    credentialRevision: run.credentialRevision,
    domain,
    tasks: observations.map(({ task, job, classification }) => ({
      taskId: task.taskId,
      kind: task.kind,
      status: classification.status,
      snapshotId: normalizeText(job?.snapshotId ?? job?.snapshot_id) || null,
      changedCount: Number.isFinite(Number(job?.changedCount)) ? Number(job.changedCount) : null,
      finishedAt: normalizeText(job?.finishedAt ?? job?.finished_at) || null,
    })),
  });
}

function taskSnapshotReference(tasks) {
  if (tasks.length === 1) return tasks[0].taskId;
  return `bootstrap_tasks_${createStableHash(tasks.map((task) => task.taskId), { length: 32 })}`;
}

/**
 * Adapter between the lifecycle state machine and the existing domain queues.
 * Queue acceptance only yields task references; it never yields bootstrap
 * completion. Completion is decided later by polling the corresponding durable
 * sync job records (or catalog job record) and persisting a domain proof.
 */
export function createDefaultShopBootstrapTaskDriver({
  continuousSyncService,
  catalogCacheService,
  ozonScheduler,
} = {}) {
  return Object.freeze({
    async enqueue(run) {
      const tasks = [];
      const rejections = [];
      const required = new Set(run.requiredDomains);
      const continuousDomains = new Set(run.requiredDomains.filter((domain) => domain !== 'catalog_mappings'));

      if (continuousDomains.size) {
        let queued;
        try {
          queued = await Promise.resolve(continuousSyncService?.bootstrapShop?.(run.shopId));
        } catch (error) {
          queued = { ok: false, error };
        }
        const results = Array.isArray(queued?.results) ? queued.results : [];
        for (const item of results) {
          const domain = normalizeText(item?.domain ?? item?.result?.domain);
          if (!continuousDomains.has(domain)) continue;
          const ids = taskIdsFromResult(item?.result);
          if (item?.accepted !== false && ids.length) {
            ids.forEach((taskId) => tasks.push({ domain, kind: 'ozon', taskId }));
          } else if (item?.accepted !== false && normalizeText(item?.result?.admissionId)) {
            tasks.push({
              domain,
              kind: 'continuous-admission',
              taskId: normalizeText(item.result.admissionId),
            });
          } else {
            rejections.push({
              domain,
              code: taskErrorCode(item?.result, 'SHOP_BOOTSTRAP_TASK_REFERENCE_MISSING'),
            });
          }
        }
        for (const domain of continuousDomains) {
          if (!tasks.some((task) => task.domain === domain)
            && !rejections.some((item) => item.domain === domain)) {
            rejections.push({
              domain,
              code: taskErrorCode(queued, 'SHOP_BOOTSTRAP_TASK_REFERENCE_MISSING'),
            });
          }
        }
      }

      if (required.has('catalog_mappings')) {
        try {
          const queued = await Promise.resolve(catalogCacheService?.startCatalogSync?.({
            shopId: run.shopId,
            source: 'shop-identity-bootstrap',
            bootstrapRunId: run.runId,
          }));
          const ids = taskIdsFromResult(queued);
          if (queued?.accepted !== false && ids.length) {
            ids.forEach((taskId) => tasks.push({
              domain: 'catalog_mappings',
              kind: 'catalog',
              taskId,
            }));
          } else {
            rejections.push({
              domain: 'catalog_mappings',
              code: taskErrorCode(queued, 'SHOP_BOOTSTRAP_CATALOG_TASK_REFERENCE_MISSING'),
            });
          }
        } catch (error) {
          rejections.push({
            domain: 'catalog_mappings',
            code: taskErrorCode(error, 'SHOP_BOOTSTRAP_CATALOG_ENQUEUE_FAILED'),
          });
        }
      }

      return Object.freeze({
        tasks: Object.freeze(tasks.map(normalizeTask).filter(Boolean)),
        rejections: Object.freeze(rejections),
      });
    },

    async getTask(task) {
      if (task.kind === 'catalog') {
        return catalogCacheService?.getCatalogSyncJob?.(task.taskId) || null;
      }
      if (task.kind === 'continuous-admission') {
        return continuousSyncService?.getAdmissionTask?.(task.taskId) || null;
      }
      return ozonScheduler?.getJob?.(task.taskId) || null;
    },
  });
}

export function createShopBootstrapCoordinator(options = {}) {
  const lifecycleService = options.lifecycleService;
  const lifecycleRepository = options.lifecycleRepository;
  const taskDriver = options.taskDriver;
  if (!lifecycleService) throw new Error('SHOP_BOOTSTRAP_LIFECYCLE_SERVICE_REQUIRED');
  if (!lifecycleRepository) throw new Error('SHOP_BOOTSTRAP_LIFECYCLE_REPOSITORY_REQUIRED');
  if (!taskDriver?.enqueue || !taskDriver?.getTask) {
    throw new Error('SHOP_BOOTSTRAP_TASK_DRIVER_REQUIRED');
  }
  const pollIntervalMs = Math.max(Number(options.pollIntervalMs) || 5_000, 100);
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  // External queue handles are deliberately ephemeral. The authoritative run
  // and per-domain facts live in SQLite; restart recovery interrupts and
  // requeues any work whose process-local handles disappeared.
  const internals = {
    executions: new Map(),
    interval: null,
    sweeping: false,
  };

  function getRun(runId) {
    const run = lifecycleRepository.getBootstrapRun(runId);
    if (!run) throw new ShopIdentityError('SHOP_BOOTSTRAP_RUN_NOT_FOUND');
    return run;
  }

  function currentStatus(shopId) {
    return Object.freeze({ ok: true, ...lifecycleService.getLifecycleStatus(shopId) });
  }

  function runStatus(shopId, runId) {
    return Object.freeze({ ok: true, ...lifecycleService.getBootstrapRunStatus(shopId, runId) });
  }

  function transition(run, nextStatus, lastErrorCode = null) {
    return lifecycleRepository.transitionBootstrapRun({
      runId: run.runId,
      scopeToken: scopeTokenOf(run),
      expectedStatus: run.status,
      nextStatus,
      lastErrorCode,
    });
  }

  async function startRun(runId, { allowRetry = false } = {}) {
    let run = getRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status) && !(allowRetry && ['failed', 'partial'].includes(run.status))) {
      return runStatus(run.shopId, run.runId);
    }
    lifecycleService.assertTaskMayActivate(scopeTokenOf(run));
    if (['interrupted', 'failed', 'partial'].includes(run.status)) {
      if (!allowRetry) return runStatus(run.shopId, run.runId);
      run = transition(run, 'queued');
    }
    if (run.status === 'verifying') return reconcileRun(run.runId);
    if (run.status === 'queued') run = lifecycleService.activateBootstrap(run.runId, scopeTokenOf(run));
    if (run.status !== 'running') return runStatus(run.shopId, run.runId);
    if (internals.executions.has(run.runId)) return runStatus(run.shopId, run.runId);

    let enqueueResult;
    try {
      enqueueResult = await Promise.resolve(taskDriver.enqueue(run));
    } catch (error) {
      enqueueResult = {
        tasks: [],
        rejections: run.requiredDomains.map((domain) => ({
          domain,
          code: taskErrorCode(error, 'SHOP_BOOTSTRAP_ENQUEUE_FAILED'),
        })),
      };
    }
    lifecycleService.assertTaskMayActivate(scopeTokenOf(run));
    const tasks = (Array.isArray(enqueueResult?.tasks) ? enqueueResult.tasks : [])
      .map(normalizeTask)
      .filter((task) => task && run.requiredDomains.includes(task.domain));
    const rejections = Array.isArray(enqueueResult?.rejections) ? enqueueResult.rejections : [];
    internals.executions.set(run.runId, Object.freeze(tasks));

    let missingDomain = false;
    for (const domain of run.requiredDomains) {
      const domainTasks = tasks.filter((task) => task.domain === domain);
      const rejection = rejections.find((item) => normalizeText(item?.domain) === domain);
      if (!domainTasks.length || rejection) {
        missingDomain = true;
        lifecycleService.recordBootstrapDomain({
          runId: run.runId,
          scopeToken: scopeTokenOf(run),
          domain,
          status: 'failed',
          lastErrorCode: taskErrorCode(rejection, 'SHOP_BOOTSTRAP_TASK_REFERENCE_MISSING'),
        });
        continue;
      }
      lifecycleService.recordBootstrapDomain({
        runId: run.runId,
        scopeToken: scopeTokenOf(run),
        domain,
        status: 'syncing',
        activeSnapshotId: taskSnapshotReference(domainTasks),
      });
    }
    if (missingDomain) {
      internals.executions.delete(run.runId);
      transition(getRun(run.runId), 'failed', 'SHOP_BOOTSTRAP_DOMAIN_ENQUEUE_INCOMPLETE');
    }
    return runStatus(run.shopId, run.runId);
  }

  async function completeVerifyingRun(run) {
    const states = lifecycleRepository.listBootstrapDomainStates(run.runId);
    const byDomain = new Map(states.map((state) => [state.domain, state]));
    const complete = run.requiredDomains.every((domain) => (
      ['completed', 'completed_with_source_gaps'].includes(byDomain.get(domain)?.status)
      && /^[a-f0-9]{64}$/u.test(byDomain.get(domain)?.proofHash || '')
    ));
    if (!complete) {
      const interrupted = transition(run, 'interrupted', 'SHOP_BOOTSTRAP_VERIFY_COVERAGE_INCOMPLETE');
      return runStatus(interrupted.shopId, interrupted.runId);
    }
    const domainProofHashes = Object.fromEntries(
      run.requiredDomains.map((domain) => [domain, byDomain.get(domain).proofHash]),
    );
    const sourceGaps = run.requiredDomains
      .filter((domain) => byDomain.get(domain).status === 'completed_with_source_gaps')
      .map((domain) => Object.freeze({
        domain,
        code: byDomain.get(domain).lastErrorCode || 'SHOP_BOOTSTRAP_SOURCE_GAP',
      }));
    const proofHash = lifecycleRepository.createBootstrapProof({
      ...scopeTokenOf(run),
      domains: run.requiredDomains,
      domainProofHashes,
    });
    lifecycleService.completeBootstrap({
      runId: run.runId,
      scopeToken: scopeTokenOf(run),
      proofHash,
      sourceGaps,
    });
    internals.executions.delete(run.runId);
    return runStatus(run.shopId, run.runId);
  }

  async function reconcileRun(runId) {
    let run = getRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      internals.executions.delete(run.runId);
      return runStatus(run.shopId, run.runId);
    }
    lifecycleService.assertTaskMayActivate(scopeTokenOf(run));
    if (run.status === 'queued') return startRun(run.runId);
    if (run.status === 'interrupted') return runStatus(run.shopId, run.runId);
    if (run.status === 'verifying') return completeVerifyingRun(run);
    if (run.status !== 'running') return runStatus(run.shopId, run.runId);

    const tasks = internals.executions.get(run.runId);
    if (!tasks?.length) {
      run = transition(run, 'interrupted', 'SHOP_BOOTSTRAP_TASK_HANDLES_LOST');
      return runStatus(run.shopId, run.runId);
    }

    let anyActive = false;
    let anyFailed = false;
    for (const domain of run.requiredDomains) {
      const domainTasks = tasks.filter((task) => task.domain === domain);
      if (!domainTasks.length) {
        anyFailed = true;
        lifecycleService.recordBootstrapDomain({
          runId: run.runId,
          scopeToken: scopeTokenOf(run),
          domain,
          status: 'failed',
          lastErrorCode: 'SHOP_BOOTSTRAP_TASK_REFERENCE_MISSING',
        });
        continue;
      }
      const observations = await Promise.all(domainTasks.map(async (task) => {
        const job = await Promise.resolve(taskDriver.getTask(task));
        return Object.freeze({ task, job, classification: classifyTaskStatus(job) });
      }));
      lifecycleService.assertTaskMayActivate(scopeTokenOf(run));
      if (observations.some((item) => item.classification.state === 'failed')) {
        anyFailed = true;
        lifecycleService.recordBootstrapDomain({
          runId: run.runId,
          scopeToken: scopeTokenOf(run),
          domain,
          status: 'failed',
          lastErrorCode: 'SHOP_BOOTSTRAP_DOMAIN_TASK_FAILED',
        });
        continue;
      }
      if (observations.some((item) => item.classification.state === 'active')) {
        anyActive = true;
        continue;
      }
      const sourceGap = observations.some((item) => item.classification.state === 'source_gap');
      lifecycleService.recordBootstrapDomain({
        runId: run.runId,
        scopeToken: scopeTokenOf(run),
        domain,
        status: sourceGap ? 'completed_with_source_gaps' : 'completed',
        activeSnapshotId: taskSnapshotReference(domainTasks),
        proofHash: domainProof(run, domain, observations),
        lastErrorCode: sourceGap ? 'SHOP_BOOTSTRAP_SOURCE_GAP' : null,
      });
    }

    if (anyFailed) {
      internals.executions.delete(run.runId);
      run = transition(getRun(run.runId), 'failed', 'SHOP_BOOTSTRAP_DOMAIN_TASK_FAILED');
      return runStatus(run.shopId, run.runId);
    }
    if (anyActive) return runStatus(run.shopId, run.runId);
    run = lifecycleService.beginBootstrapVerification(run.runId, scopeTokenOf(run));
    return completeVerifyingRun(run);
  }

  async function recoverNow() {
    const recoveries = lifecycleRepository.recoverBootstrapRuns();
    const results = [];
    for (const item of recoveries) {
      if (item.recoveryAction === 'invalidated') {
        results.push(runStatus(item.run.shopId, item.run.runId));
        continue;
      }
      if (item.recoveryAction === 'verify') {
        let result = await reconcileRun(item.run.runId);
        if (result.run?.status === 'interrupted') {
          result = await startRun(item.run.runId, { allowRetry: true });
        }
        results.push(result);
        continue;
      }
      results.push(await startRun(item.run.runId, { allowRetry: item.run.status !== 'queued' }));
    }
    return Object.freeze({ ok: true, count: results.length, results: Object.freeze(results) });
  }

  async function reconcileActiveRuns() {
    if (internals.sweeping) return Object.freeze({ ok: true, skipped: true });
    internals.sweeping = true;
    try {
      const runIds = [...internals.executions.keys()];
      const results = [];
      for (const runId of runIds) {
        try {
          results.push(await reconcileRun(runId));
        } catch (error) {
          const run = lifecycleRepository.getBootstrapRun(runId);
          if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
            lifecycleRepository.recoverBootstrapRuns();
          } else if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
            internals.executions.delete(runId);
          }
          results.push(Object.freeze({
            ok: false,
            runId,
            error: taskErrorCode(error, 'SHOP_BOOTSTRAP_RECONCILE_FAILED'),
          }));
        }
      }
      return Object.freeze({ ok: true, count: results.length, results: Object.freeze(results) });
    } finally {
      internals.sweeping = false;
    }
  }

  return Object.freeze({
    profileId: lifecycleService.profileId,

    async saveBinding(input = {}, {
      enqueue = true,
      deletedRebind = false,
      onBindingSaved = null,
    } = {}) {
      const binding = lifecycleService.saveBinding(input, { deletedRebind });
      if (typeof onBindingSaved === 'function') {
        await Promise.resolve(onBindingSaved(binding));
      }
      if (enqueue && binding.bootstrapRun?.status === 'queued') {
        await startRun(binding.bootstrapRun.runId);
      }
      const readiness = lifecycleService.getBindingReadiness(binding.shop.id);
      return Object.freeze({ ...binding, ...readiness });
    },

    async rebind(input = {}, { enqueue = true, onBindingSaved = null } = {}) {
      const binding = lifecycleService.rebind(input);
      if (typeof onBindingSaved === 'function') {
        await Promise.resolve(onBindingSaved(binding));
      }
      if (enqueue && binding.bootstrapRun?.status === 'queued') {
        await startRun(binding.bootstrapRun.runId);
      }
      const readiness = lifecycleService.getBindingReadiness(binding.shop.id);
      return Object.freeze({ ...binding, ...readiness });
    },

    async requestBootstrap(shopId, input = {}, { enqueue = true } = {}) {
      const requested = lifecycleService.requestBootstrap(shopId, input);
      if (enqueue && requested.bootstrapRun?.status === 'queued') {
        await startRun(requested.bootstrapRun.runId);
      }
      return currentStatus(requested.scopeToken.shopId);
    },

    async getShopStatus(shopId, { reconcile = true } = {}) {
      const readiness = lifecycleService.getBindingReadiness(shopId);
      if (reconcile && ['queued', 'running', 'verifying'].includes(readiness.bootstrapRun?.status)) {
        await reconcileRun(readiness.bootstrapRun.runId);
      }
      return currentStatus(shopId);
    },

    async getRunStatus(shopId, runId, { reconcile = true } = {}) {
      const status = lifecycleService.getBootstrapRunStatus(shopId, runId);
      if (reconcile && ['queued', 'running', 'verifying'].includes(status.run.status)) {
        await reconcileRun(status.run.runId);
      }
      return runStatus(shopId, runId);
    },

    startRun,
    reconcileRun,
    recoverNow,
    reconcileActiveRuns,

    start() {
      if (internals.interval) return Object.freeze({ ok: true, started: false });
      Promise.resolve(recoverNow()).catch(() => undefined);
      internals.interval = setIntervalImpl(() => {
        Promise.resolve(reconcileActiveRuns()).catch(() => undefined);
      }, pollIntervalMs);
      internals.interval?.unref?.();
      return Object.freeze({ ok: true, started: true });
    },

    stop() {
      if (!internals.interval) return Object.freeze({ ok: true, stopped: false });
      clearIntervalImpl(internals.interval);
      internals.interval = null;
      return Object.freeze({ ok: true, stopped: true });
    },
  });
}
