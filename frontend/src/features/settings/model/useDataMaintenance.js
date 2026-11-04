import {
  confirmDatabaseCompaction,
  confirmManualShopScopeResolution,
  confirmShopScopeRepair,
  confirmTechnicalRetention,
  getDatabaseCompactionPreview,
  getLocalDataConsistencyAudit,
  getLocalStorageAudit,
  getManualShopScopeResolutionPreview,
  getShopScopeRepairPreview,
  getTechnicalRetentionPreview,
  getTechnicalRetentionStatus,
} from '../../../api/localApiClient.js';
import {
  confirmProfileDomainRebuild,
  confirmProfileSpaceRelease,
  getProfileMaintenanceContracts,
  prepareProfileDomainRebuildTicket,
  previewProfileDomainRebuild,
  previewProfileSpaceRelease,
} from '../services/profileMaintenanceClient.js';
import { requestProfileCacheMaintenanceRestart } from '../services/profileCacheMaintenanceDesktopClient.js';
import React from 'react';

function errorMessage(error) {
  const profileMaintenanceCode = error?.payload?.error?.code;
  if (profileMaintenanceCode === 'PROFILE_MAINTENANCE_PREVIEW_STALE') {
    return '维护预览后本地数据发生变化，已拒绝执行，请重新检查并确认。';
  }
  if (profileMaintenanceCode === 'PROFILE_MAINTENANCE_PROTECTED_DATA_CHANGED') {
    return '空间释放触及受保护数据，事务已回滚，商品、订单、设定和凭证保持不变。';
  }
  if (profileMaintenanceCode === 'PROFILE_MAINTENANCE_TRUSTED_SOURCE_UNAVAILABLE') {
    return '该领域没有可验证的内部来源，已拒绝重建，不会删除现有数据。';
  }
  if (profileMaintenanceCode?.startsWith('PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_')) {
    return '领域重建凭证已失效或不匹配，请重新检查可信来源。';
  }
  if (error?.payload?.code === 'SHOP_SCOPE_REPAIR_PREVIEW_STALE') {
    return '数据在确认前发生变化，已刷新预览，请重新确认。';
  }
  if (error?.payload?.code === 'SHOP_SCOPE_REPAIR_SCHEMA_DRIFT') {
    return '检测到本地表结构变化，已拒绝修复，请先处理结构问题。';
  }
  if (error?.payload?.code === 'SHOP_SCOPE_MANUAL_RESOLUTION_PREVIEW_STALE') {
    return '多店数据在确认前发生变化，已刷新预览，请重新选择归属。';
  }
  if (error?.payload?.code === 'SHOP_SCOPE_MANUAL_RESOLUTION_SCHEMA_DRIFT') {
    return '检测到多店数据表结构变化，已拒绝归属修复，请先处理结构问题。';
  }
  if (error?.payload?.code === 'TECHNICAL_RETENTION_PREVIEW_STALE') {
    return '技术数据在确认前发生变化，已刷新预览，请重新确认。';
  }
  if (error?.payload?.code === 'TECHNICAL_RETENTION_SCHEMA_DRIFT') {
    return '检测到技术表结构变化，已拒绝清理，请先处理结构问题。';
  }
  if (error?.payload?.code === 'TECHNICAL_RETENTION_ALREADY_RUNNING') {
    return '技术运行数据正在后台清理，请等待当前任务完成。';
  }
  if (error?.payload?.code === 'DATABASE_COMPACTION_PREVIEW_STALE') {
    return '数据库在确认前发生变化，已刷新压缩预览，请重新确认。';
  }
  if (error?.code === 'ACCOUNT_REMOVAL_PENDING') {
    return '存在尚未完成的账号永久删除，请先让删除流程回读完成。';
  }
  if (error?.code === 'PROFILE_DATABASE_RECOVERY_REQUIRED') {
    return '当前 profile 正在恢复模式，请先完成数据库恢复。';
  }
  return error instanceof Error ? error.message : String(error || '本地维护请求失败。');
}

export function useDataMaintenance() {
  const [audit, setAudit] = React.useState(null);
  const [consistencyAudit, setConsistencyAudit] = React.useState(null);
  const [compactionPreview, setCompactionPreview] = React.useState(null);
  const [scopePreview, setScopePreview] = React.useState(null);
  const [manualResolutionPreview, setManualResolutionPreview] = React.useState(null);
  const [retentionPreview, setRetentionPreview] = React.useState(null);
  const [profileMaintenanceContracts, setProfileMaintenanceContracts] = React.useState(null);
  const [spaceReleasePreview, setSpaceReleasePreview] = React.useState(null);
  const [domainRebuildPreparation, setDomainRebuildPreparation] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [checkingConsistency, setCheckingConsistency] = React.useState(false);
  const [repairing, setRepairing] = React.useState(false);
  const [resolving, setResolving] = React.useState(false);
  const [retaining, setRetaining] = React.useState(false);
  const [compacting, setCompacting] = React.useState(false);
  const [releasingSpace, setReleasingSpace] = React.useState(false);
  const [preparingDomainRebuild, setPreparingDomainRebuild] = React.useState(false);
  const [rebuildingDomain, setRebuildingDomain] = React.useState(false);
  const [startingCacheMaintenance, setStartingCacheMaintenance] = React.useState(false);
  const [error, setError] = React.useState('');
  const [lastResult, setLastResult] = React.useState(null);
  const [lastManualResolutionResult, setLastManualResolutionResult] = React.useState(null);
  const [lastRetentionResult, setLastRetentionResult] = React.useState(null);
  const [retentionJob, setRetentionJob] = React.useState(null);
  const [lastCompactionResult, setLastCompactionResult] = React.useState(null);
  const [lastSpaceReleaseResult, setLastSpaceReleaseResult] = React.useState(null);
  const [lastDomainRebuildResult, setLastDomainRebuildResult] = React.useState(null);
  const controllerRef = React.useRef(null);
  const consistencyControllerRef = React.useRef(null);
  const domainRebuildControllerRef = React.useRef(null);

  const refresh = React.useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const [nextAudit, nextCompactionPreview, nextPreview, nextManualResolutionPreview, nextRetentionPreview, nextProfileMaintenanceContracts, nextSpaceReleasePreview] = await Promise.all([
        getLocalStorageAudit({ timeoutMs: 15000, signal: controller.signal }),
        getDatabaseCompactionPreview({ timeoutMs: 15000, signal: controller.signal }),
        getShopScopeRepairPreview({ timeoutMs: 15000, signal: controller.signal }),
        getManualShopScopeResolutionPreview({ timeoutMs: 15000, signal: controller.signal }),
        getTechnicalRetentionPreview({ timeoutMs: 15000, signal: controller.signal }),
        getProfileMaintenanceContracts({ timeoutMs: 15000, signal: controller.signal }),
        previewProfileSpaceRelease({ timeoutMs: 30000, signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return null;
      setAudit(nextAudit || null);
      setCompactionPreview(nextCompactionPreview || null);
      setScopePreview(nextPreview || null);
      setManualResolutionPreview(nextManualResolutionPreview || null);
      setRetentionPreview(nextRetentionPreview || null);
      setProfileMaintenanceContracts(nextProfileMaintenanceContracts || null);
      setSpaceReleasePreview(nextSpaceReleasePreview || null);
      return {
        audit: nextAudit,
        compactionPreview: nextCompactionPreview,
        scopePreview: nextPreview,
        manualResolutionPreview: nextManualResolutionPreview,
        retentionPreview: nextRetentionPreview,
        profileMaintenanceContracts: nextProfileMaintenanceContracts,
        spaceReleasePreview: nextSpaceReleasePreview,
      };
    } catch (requestError) {
      if (requestError?.name !== 'AbortError') setError(errorMessage(requestError));
      return null;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    refresh();
    return () => {
      controllerRef.current?.abort();
      consistencyControllerRef.current?.abort();
      domainRebuildControllerRef.current?.abort();
    };
  }, [refresh]);

  React.useEffect(() => {
    if (!retentionJob?.active) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const status = await getTechnicalRetentionStatus({ timeoutMs: 45000 });
        if (cancelled) return;
        setRetentionJob(status || null);
        if (status?.active) {
          timer = globalThis.setTimeout(poll, 750);
          return;
        }
        if (status?.status === 'completed') {
          setLastRetentionResult({ ok: true, deleted: status.deleted || [], mode: 'background-retention' });
          setConsistencyAudit(null);
          await refresh();
          return;
        }
        setError(status?.code || '技术运行数据后台清理失败。');
      } catch (requestError) {
        if (!cancelled) timer = globalThis.setTimeout(poll, 1500);
      }
    };
    timer = globalThis.setTimeout(poll, 750);
    return () => {
      cancelled = true;
      if (timer) globalThis.clearTimeout(timer);
    };
  }, [refresh, retentionJob?.active, retentionJob?.id]);

  const runConsistencyAudit = React.useCallback(async () => {
    consistencyControllerRef.current?.abort();
    const controller = new AbortController();
    consistencyControllerRef.current = controller;
    setCheckingConsistency(true);
    setError('');
    try {
      const result = await getLocalDataConsistencyAudit({ timeoutMs: 30000, signal: controller.signal });
      if (controller.signal.aborted) return null;
      setConsistencyAudit(result || null);
      return result;
    } catch (requestError) {
      if (requestError?.name !== 'AbortError') setError(errorMessage(requestError));
      return null;
    } finally {
      if (consistencyControllerRef.current === controller) {
        consistencyControllerRef.current = null;
        setCheckingConsistency(false);
      }
    }
  }, []);

  const repairSafeScopeRows = React.useCallback(async () => {
    const previewFingerprint = scopePreview?.previewFingerprint;
    if (!previewFingerprint) {
      setError('请先完成数据归属检查，再确认修复。');
      return null;
    }
    setRepairing(true);
    setError('');
    try {
      const result = await confirmShopScopeRepair(previewFingerprint, { timeoutMs: 30000 });
      setLastResult(result || null);
      setConsistencyAudit(null);
      await refresh();
      return result;
    } catch (requestError) {
      setError(errorMessage(requestError));
      await refresh();
      return null;
    } finally {
      setRepairing(false);
    }
  }, [refresh, scopePreview?.previewFingerprint]);

  const retainTechnicalRows = React.useCallback(async () => {
    const previewFingerprint = retentionPreview?.previewFingerprint;
    if (!previewFingerprint) {
      setError('请先完成技术数据检查，再确认清理。');
      return null;
    }
    setRetaining(true);
    setError('');
    try {
      const result = await confirmTechnicalRetention(previewFingerprint, {
        backupAcknowledged: true,
        timeoutMs: 30000,
      });
      if (result?.active) {
        setRetentionJob(result);
        setLastRetentionResult(null);
        return result;
      }
      setLastRetentionResult(result || null);
      setConsistencyAudit(null);
      await refresh();
      return result;
    } catch (requestError) {
      setError(errorMessage(requestError));
      await refresh();
      return null;
    } finally {
      setRetaining(false);
    }
  }, [refresh, retentionPreview?.previewFingerprint]);

  const compactDatabase = React.useCallback(async () => {
    const previewFingerprint = compactionPreview?.previewFingerprint;
    if (!previewFingerprint) {
      setError('请先完成数据库压缩检查，再确认压缩。');
      return null;
    }
    setCompacting(true);
    setError('');
    try {
      const result = await confirmDatabaseCompaction(previewFingerprint, {
        backupAcknowledged: true,
        timeoutMs: 120000,
      });
      setLastCompactionResult(result || null);
      setConsistencyAudit(null);
      await refresh();
      return result;
    } catch (requestError) {
      setError(errorMessage(requestError));
      await refresh();
      return null;
    } finally {
      setCompacting(false);
    }
  }, [compactionPreview?.previewFingerprint, refresh]);

  const releaseProfileSpace = React.useCallback(async () => {
    const humanConfirmationToken = spaceReleasePreview?.humanConfirmationToken;
    if (!humanConfirmationToken) {
      setError('请先完成派生缓存空间检查，再确认释放。');
      return null;
    }
    setReleasingSpace(true);
    setError('');
    try {
      const result = await confirmProfileSpaceRelease({
        humanConfirmationToken,
        humanConfirmed: true,
      }, { timeoutMs: 120000 });
      setLastSpaceReleaseResult(result || null);
      setConsistencyAudit(null);
      await refresh();
      return result;
    } catch (requestError) {
      setError(errorMessage(requestError));
      await refresh();
      return null;
    } finally {
      setReleasingSpace(false);
    }
  }, [refresh, spaceReleasePreview?.humanConfirmationToken]);

  const prepareDomainRebuild = React.useCallback(async (rawDomain) => {
    const domain = String(rawDomain || '').trim();
    if (!domain) {
      setError('请先选择一个允许重建的领域。');
      return null;
    }
    domainRebuildControllerRef.current?.abort();
    const controller = new AbortController();
    domainRebuildControllerRef.current = controller;
    setPreparingDomainRebuild(true);
    setDomainRebuildPreparation(null);
    setError('');
    try {
      const preview = await previewProfileDomainRebuild(domain, {
        timeoutMs: 30000,
        signal: controller.signal,
      });
      const humanConfirmationToken = String(preview?.humanConfirmationToken || '').trim();
      if (!humanConfirmationToken) throw new Error('领域重建预览缺少人工确认凭证。');
      const trustedSource = await prepareProfileDomainRebuildTicket({
        domain,
        humanConfirmationToken,
      }, {
        timeoutMs: 30000,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return null;
      const trustedSourceTicket = String(trustedSource?.trustedSourceTicket || '').trim();
      if (!trustedSourceTicket || String(trustedSource?.domain || '') !== domain) {
        throw new Error('可信来源返回的领域或一次性凭证无效。');
      }
      const preparation = { domain, humanConfirmationToken, preview, trustedSource };
      setDomainRebuildPreparation(preparation);
      return preparation;
    } catch (requestError) {
      if (requestError?.name !== 'AbortError') setError(errorMessage(requestError));
      return null;
    } finally {
      if (domainRebuildControllerRef.current === controller) {
        domainRebuildControllerRef.current = null;
        setPreparingDomainRebuild(false);
      }
    }
  }, []);

  const rebuildPreparedDomain = React.useCallback(async () => {
    const preparation = domainRebuildPreparation;
    if (!preparation?.trustedSource?.trustedSourceTicket) {
      setError('请先重新检查领域及可信来源。');
      return null;
    }
    setRebuildingDomain(true);
    setError('');
    try {
      const result = await confirmProfileDomainRebuild({
        domain: preparation.domain,
        humanConfirmationToken: preparation.humanConfirmationToken,
        humanConfirmed: true,
        trustedSourceTicket: preparation.trustedSource.trustedSourceTicket,
      }, { timeoutMs: 120000 });
      setLastDomainRebuildResult(result || null);
      setDomainRebuildPreparation(null);
      setConsistencyAudit(null);
      await refresh();
      return result;
    } catch (requestError) {
      setDomainRebuildPreparation(null);
      setError(errorMessage(requestError));
      await refresh();
      return null;
    } finally {
      setRebuildingDomain(false);
    }
  }, [domainRebuildPreparation, refresh]);

  const cancelDomainRebuild = React.useCallback(() => {
    domainRebuildControllerRef.current?.abort();
    domainRebuildControllerRef.current = null;
    setDomainRebuildPreparation(null);
    setPreparingDomainRebuild(false);
  }, []);

  const startProfileCacheMaintenance = React.useCallback(async () => {
    setStartingCacheMaintenance(true);
    setError('');
    try {
      return await requestProfileCacheMaintenanceRestart();
    } catch (requestError) {
      setError(errorMessage(requestError));
      return null;
    } finally {
      setStartingCacheMaintenance(false);
    }
  }, []);

  const resolveManualScopeRows = React.useCallback(async (assignments) => {
    const previewFingerprint = manualResolutionPreview?.previewFingerprint;
    if (!previewFingerprint) {
      setError('请先完成多店数据归属检查，再确认处理。');
      return null;
    }
    setResolving(true);
    setError('');
    try {
      const result = await confirmManualShopScopeResolution(previewFingerprint, assignments, { timeoutMs: 30000 });
      setLastManualResolutionResult(result || null);
      setConsistencyAudit(null);
      await refresh();
      return result;
    } catch (requestError) {
      setError(errorMessage(requestError));
      await refresh();
      return null;
    } finally {
      setResolving(false);
    }
  }, [manualResolutionPreview?.previewFingerprint, refresh]);

  return {
    audit,
    consistencyAudit,
    compactionPreview,
    scopePreview,
    manualResolutionPreview,
    retentionPreview,
    profileMaintenanceContracts,
    spaceReleasePreview,
    domainRebuildPreparation,
    loading,
    checkingConsistency,
    repairing,
    resolving,
    retaining,
    compacting,
    releasingSpace,
    preparingDomainRebuild,
    rebuildingDomain,
    startingCacheMaintenance,
    error,
    lastResult,
    lastManualResolutionResult,
    lastRetentionResult,
    retentionJob,
    lastCompactionResult,
    lastSpaceReleaseResult,
    lastDomainRebuildResult,
    refresh,
    runConsistencyAudit,
    repairSafeScopeRows,
    resolveManualScopeRows,
    retainTechnicalRows,
    compactDatabase,
    releaseProfileSpace,
    prepareDomainRebuild,
    rebuildPreparedDomain,
    cancelDomainRebuild,
    startProfileCacheMaintenance,
  };
}
