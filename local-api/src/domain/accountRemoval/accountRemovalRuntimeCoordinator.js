import { createAccountRemovalEvidenceHash } from './accountRemovalEvidence.js';
import { ACCOUNT_REMOVAL_ERROR_CODES, failAccountRemovalContract } from './accountRemovalErrors.js';

function observation(resourceId, count, details = {}) {
  const normalizedCount = Math.max(0, Number(count) || 0);
  if (normalizedCount === 0) return { resourceId, state: 'absent' };
  return {
    resourceId,
    state: 'observed',
    count: normalizedCount,
    hash: createAccountRemovalEvidenceHash(details),
  };
}

function requireMethod(target, method) {
  if (typeof target?.[method] !== 'function') {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.QUIESCE_TIMEOUT);
  }
  return target[method].bind(target);
}

export function createAccountRemovalRuntimeCoordinator({
  writeGuardService,
  ozonScheduler,
  catalogCacheService,
  continuousSyncService,
  domainServices,
  recoveryBackupRuntime,
  recoveryStagingRuntime,
  performanceRuntime,
  purchaseBrowserRuntime,
  timeoutMs = 30_000,
} = {}) {
  function shopStatus(shopId) {
    const scheduler = ozonScheduler?.getAccountRemovalShopRuntimeStatus?.(shopId) || {
      queue: { queued: 0, running: 0, paused: false },
      schedulerInFlight: 0,
      hotCacheEntries: 0,
      trafficStateCount: 0,
      rateLimitMemoryCount: 0,
    };
    const catalog = catalogCacheService?.getOwnerRuntimeStatus?.(shopId) || { active: 0, fenced: false };
    const continuous = continuousSyncService?.getOwnerStatus?.(shopId) || { paused: false, taskCount: 0 };
    const productHotCacheEntries = Number(domainServices?.countOwnerHotCache?.(shopId) || 0);
    const writeGuardPreviews = Number(writeGuardService?.countOwnerPreviews?.(shopId) || 0);
    const storage = domainServices?.getOwnerStorageStatus?.(shopId) || null;
    return { scheduler, catalog, continuous, productHotCacheEntries, writeGuardPreviews, storage };
  }

  function backupStatus() {
    return recoveryBackupRuntime?.getAccountRemovalStatus?.() || { fenced: false, active: 0 };
  }

  function verifyBackup() {
    const status = backupStatus();
    return {
      ok: status.fenced === true && Number(status.active || 0) === 0,
      status,
    };
  }

  function stagingStatus() {
    return recoveryStagingRuntime?.getAccountRemovalStatus?.() || { fenced: false, active: 0 };
  }

  function purchaseBrowserStatus(owner) {
    return purchaseBrowserRuntime?.getAccountRemovalStatus?.(owner) || { fenced: false, active: 0 };
  }

  function verifyStaging() {
    const status = stagingStatus();
    return {
      ok: status.fenced === true && Number(status.active || 0) === 0,
      status,
    };
  }

  function observeResource(owner, resourceId) {
    if (owner.ownerType === 'purchase_account' && resourceId === 'runtime:purchase-task-queue') {
      const status = purchaseBrowserStatus(owner);
      return observation(resourceId, status.active, status);
    }
    if (owner.ownerType === 'promotion_account') {
      const status = performanceRuntime?.getPerformanceAccountRemovalStatus?.(owner.ownerId) || {};
      switch (resourceId) {
        case 'runtime:local-api-performance-request-queue':
          return observation(resourceId, Number(status.queued || 0) + Number(status.active || 0), status);
        case 'memory:performance-access-token-cache':
          return observation(resourceId, status.tokenCount, status);
        case 'memory:performance-inflight-request-cache':
          return observation(resourceId, status.inFlightReads, status);
        default:
          return { resourceId, state: 'unobserved' };
      }
    }
    if (owner.ownerType !== 'ozon_shop') return { resourceId, state: 'unobserved' };
    const status = shopStatus(owner.ownerId);
    switch (resourceId) {
      case 'memory:local-api-write-guard-previews':
        return observation(resourceId, status.writeGuardPreviews, { count: status.writeGuardPreviews });
      case 'logical:local-api-rate-limit-shop-state':
        return observation(resourceId, status.scheduler.rateLimitMemoryCount, status.scheduler);
      case 'logical:local-api-traffic-controller-shop-state':
        return observation(resourceId, status.scheduler.trafficStateCount, status.scheduler);
      case 'memory:local-api-hot-cache-l1':
      case 'memory:local-api-hot-cache-shop-tag': {
        const count = Number(status.scheduler.hotCacheEntries || 0) + status.productHotCacheEntries;
        return observation(resourceId, count, { scheduler: status.scheduler.hotCacheEntries, domains: status.productHotCacheEntries });
      }
      case 'memory:catalog-cache-active-jobs':
        return observation(resourceId, status.catalog.active, status.catalog);
      case 'runtime:ozon-scheduler-active-queue':
        return observation(resourceId, status.scheduler.schedulerInFlight, status.scheduler);
      case 'runtime:ozon-request-queue': {
        const count = Number(status.scheduler.queue?.queued || 0) + Number(status.scheduler.queue?.running || 0);
        return observation(resourceId, count, status.scheduler.queue);
      }
      case 'runtime:continuous-sync-owner-state': {
        const count = Number(status.continuous.taskCount || 0) + (status.continuous.paused ? 1 : 0);
        return observation(resourceId, count, status.continuous);
      }
      default:
        return { resourceId, state: 'unobserved' };
    }
  }

  async function quiesceOwnerWrites(owner) {
    if (owner.ownerType === 'ozon_shop') {
      requireMethod(continuousSyncService, 'pauseOwner')(owner.ownerId);
      await requireMethod(catalogCacheService, 'quiesceOwner')(owner.ownerId, { timeoutMs });
      await requireMethod(ozonScheduler, 'quiesceAccountRemovalShop')(owner.ownerId, { timeoutMs });
      try {
        await domainServices?.quiesceOwnerStorage?.(owner.ownerId, { timeoutMs });
      } catch (cause) {
        const error = new Error('店铺后台存储任务仍在停止，请稍后继续删除。');
        error.code = ACCOUNT_REMOVAL_ERROR_CODES.QUIESCE_TIMEOUT;
        error.cause = cause;
        throw error;
      }
      writeGuardService?.invalidateOwnerPreviews?.(owner.ownerId);
      domainServices?.invalidateOwnerHotCache?.(owner.ownerId);
      ozonScheduler.clearAccountRemovalShopRuntime?.(owner.ownerId);
      continuousSyncService?.forgetOwner?.(owner.ownerId);
      return { ok: true, ownerType: owner.ownerType, status: shopStatus(owner.ownerId) };
    }
    if (owner.ownerType === 'promotion_account') {
      await requireMethod(performanceRuntime, 'quiescePerformanceAccount')(owner.ownerId, { timeoutMs });
      performanceRuntime?.clearPerformanceAccountRuntime?.(owner.ownerId);
      return { ok: true, ownerType: owner.ownerType, status: performanceRuntime.getPerformanceAccountRemovalStatus?.(owner.ownerId) };
    }
    if (owner.ownerType === 'purchase_account') {
      await requireMethod(purchaseBrowserRuntime, 'quiesceAccountRemoval')(owner, { timeoutMs });
      return { ok: true, ownerType: owner.ownerType, status: purchaseBrowserStatus(owner) };
    }
    return { ok: true, ownerType: owner.ownerType, status: {} };
  }

  async function quiesce(owner) {
    await requireMethod(recoveryBackupRuntime, 'quiesceAccountRemoval')(owner, { timeoutMs });
    await requireMethod(recoveryStagingRuntime, 'quiesceAccountRemoval')(owner, { timeoutMs });
    const result = await quiesceOwnerWrites(owner);
    domainServices?.suspendReadConnections?.(owner);
    return result;
  }

  function verify(owner) {
    const backup = verifyBackup();
    const staging = verifyStaging();
    if (owner.ownerType === 'ozon_shop') {
      const status = shopStatus(owner.ownerId);
      const failures = [];
      if (status.writeGuardPreviews !== 0) failures.push('write-guard');
      if (status.productHotCacheEntries !== 0) failures.push('domain-hot-cache');
      if (status.catalog.active !== 0 || status.catalog.fenced !== true) failures.push('catalog-jobs');
      if (status.scheduler.schedulerInFlight !== 0) failures.push('scheduler');
      if (Number(status.scheduler.queue?.queued || 0) !== 0 || Number(status.scheduler.queue?.running || 0) !== 0 || status.scheduler.queue?.paused !== true) failures.push('request-queue');
      if (status.scheduler.hotCacheEntries !== 0) failures.push('scheduler-hot-cache');
      if (status.scheduler.trafficStateCount !== 0) failures.push('traffic');
      if (status.scheduler.rateLimitMemoryCount !== 0) failures.push('rate-limit');
      if (status.continuous.paused !== true || status.continuous.taskCount !== 0) failures.push('continuous-sync');
      if (status.storage?.products && (status.storage.products.fenced !== true || status.storage.products.active || status.storage.products.queued)) failures.push('shop-product-storage');
      if (status.storage?.orderBackfill && (status.storage.orderBackfill.paused !== true || status.storage.orderBackfill.active || status.storage.orderBackfill.queued)) failures.push('shop-order-backfill');
      if (!backup.ok) failures.push('recovery-backup');
      if (!staging.ok) failures.push('recovery-staging');
      return { ok: failures.length === 0, failures, status: { ...status, recoveryBackup: backup.status, recoveryStaging: staging.status } };
    }
    if (owner.ownerType === 'promotion_account') {
      const status = performanceRuntime?.getPerformanceAccountRemovalStatus?.(owner.ownerId) || {};
      const ok = status.fenced === true
        && Number(status.queued || 0) === 0
        && Number(status.active || 0) === 0
        && Number(status.inFlightReads || 0) === 0
        && Number(status.tokenCount || 0) === 0;
      const failures = [];
      if (!ok) failures.push('performance-runtime');
      if (!backup.ok) failures.push('recovery-backup');
      if (!staging.ok) failures.push('recovery-staging');
      return { ok: failures.length === 0, failures, status: { ...status, recoveryBackup: backup.status, recoveryStaging: staging.status } };
    }
    if (owner.ownerType === 'purchase_account') {
      const status = purchaseBrowserStatus(owner);
      const failures = [];
      if (status.fenced !== true || Number(status.active || 0) !== 0) failures.push('purchase-browser-runtime');
      if (!backup.ok) failures.push('recovery-backup');
      if (!staging.ok) failures.push('recovery-staging');
      return {
        ok: failures.length === 0,
        failures,
        status: { ...status, recoveryBackup: backup.status, recoveryStaging: staging.status },
      };
    }
    return {
      ok: backup.ok && staging.ok,
      failures: [
        ...(backup.ok ? [] : ['recovery-backup']),
        ...(staging.ok ? [] : ['recovery-staging']),
      ],
      status: { recoveryBackup: backup.status, recoveryStaging: staging.status },
    };
  }

  function complete(owner) {
    if (owner.ownerType === 'ozon_shop') domainServices?.completeOwnerStorageRemoval?.(owner.ownerId);
    recoveryBackupRuntime?.releaseAccountRemovalFence?.();
    recoveryStagingRuntime?.releaseAccountRemovalFence?.();
    purchaseBrowserRuntime?.releaseAccountRemovalFence?.(owner);
    return { ok: true };
  }

  function releaseOwner(owner) {
    if (owner.ownerType === 'ozon_shop') domainServices?.releaseOwnerStorage?.(owner.ownerId);
    recoveryBackupRuntime?.releaseAccountRemovalFence?.();
    recoveryStagingRuntime?.releaseAccountRemovalFence?.();
    if (owner.ownerType === 'ozon_shop') {
      ozonScheduler?.releaseAccountRemovalShopFence?.(owner.ownerId);
      catalogCacheService?.releaseOwnerFence?.(owner.ownerId);
      continuousSyncService?.releaseOwner?.(owner.ownerId);
    } else if (owner.ownerType === 'promotion_account') {
      performanceRuntime?.releasePerformanceAccountFence?.(owner.ownerId);
    } else if (owner.ownerType === 'purchase_account') {
      purchaseBrowserRuntime?.releaseAccountRemovalFence?.(owner);
    }
    return { ok: true };
  }

  function releaseTransientResources(owner) {
    return domainServices?.releaseTransientResources?.(owner) || { released: true };
  }

  return { complete, observeResource, quiesce, quiesceOwnerWrites, releaseOwner, releaseTransientResources, verify };
}
