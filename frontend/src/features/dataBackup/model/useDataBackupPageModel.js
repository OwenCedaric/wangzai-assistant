import React from 'react';
import {
  createDataBackupOwnerKey,
  normalizeDataBackupShopOption,
  parseDataBackupOwnerKey,
} from '../lib/dataBackupPresentation.js';
import {
  getAllDataBackupPreviews,
  getDataBackupHistory,
  getDataBackupImportHistory,
  getDataBackupOwnerHistory,
  getDataBackupOwnerImportHistory,
} from '../services/dataBackupClient.js';
import {
  exportDataBackup,
  exportDataBackupBatch,
} from '../services/dataBackupDesktopClient.js';

function errorMessage(error, fallback) {
  if (error?.name === 'AbortError') return '';
  return error instanceof Error ? error.message : String(error || fallback);
}

function initialShopId(shops, activeShopId) {
  const options = shops.map(normalizeDataBackupShopOption).filter((shop) => shop.shopId);
  const active = String(activeShopId || '').trim();
  return options.some((shop) => shop.shopId === active) ? active : options[0]?.shopId || '';
}

function initialOwnerKey(activeShopId) {
  const ownerId = String(activeShopId || '').trim();
  return ownerId ? createDataBackupOwnerKey({ ownerType: 'ozon_shop', ownerId }) : '';
}

function findPreviewShopId(previewShops = [], sourceShops = [], preferredShopId = '') {
  const preferred = String(preferredShopId || '').trim();
  if (!previewShops.length) return preferred;
  if (previewShops.some((shop) => shop.shopId === preferred)) return preferred;
  const source = sourceShops.find((shop) => shop.shopId === preferred) || null;
  const externalId = String(source?.shopExternalId || '').trim();
  const byExternalId = externalId
    ? previewShops.find((shop) => shop.shopExternalId === externalId)
    : null;
  if (byExternalId) return byExternalId.shopId;
  const names = new Set([
    source?.displayName,
    source?.shopName,
    source?.shopAlias,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  const byName = previewShops.find((shop) => [
    shop.displayName,
    shop.shopName,
    shop.shopAlias,
  ].some((value) => names.has(String(value || '').trim())));
  return byName?.shopId || previewShops[0]?.shopId || '';
}

function mergePreviewShopOptions(previewShops = [], sourceShops = []) {
  if (!previewShops.length) return sourceShops;
  return previewShops.map((previewShop) => {
    const names = new Set([
      previewShop.displayName,
      previewShop.shopName,
      previewShop.shopAlias,
    ].map((value) => String(value || '').trim()).filter(Boolean));
    const source = sourceShops.find((shop) => (
      shop.shopId === previewShop.shopId
      || (
        previewShop.shopExternalId
        && shop.shopExternalId === previewShop.shopExternalId
      )
      || [shop.displayName, shop.shopName, shop.shopAlias]
        .some((value) => names.has(String(value || '').trim()))
    ));
    if (!source) return previewShop;
    return {
      ...previewShop,
      shopExternalId: previewShop.shopExternalId || source.shopExternalId,
      shopName: source.shopName || previewShop.shopName,
      shopAlias: source.shopAlias || previewShop.shopAlias,
      displayName: source.displayName || previewShop.displayName,
    };
  });
}

function ownerHistoryReaders(owner, options) {
  return owner?.ownerType === 'ozon_shop'
    ? [
        getDataBackupHistory(owner.ownerId, options),
        getDataBackupImportHistory(owner.ownerId, options),
      ]
    : [
        getDataBackupOwnerHistory(owner, options),
        getDataBackupOwnerImportHistory(owner, options),
      ];
}

export function useDataBackupPageModel({ shops = [], activeShopId = '', isActive = true } = {}) {
  const shopOptionsSignature = JSON.stringify(
    shops.map(normalizeDataBackupShopOption).filter((shop) => shop.shopId),
  );
  const shopOptions = React.useMemo(
    () => JSON.parse(shopOptionsSignature),
    [shopOptionsSignature],
  );
  const [shopId, setShopId] = React.useState(() => initialShopId(shopOptions, activeShopId));
  const [backupOwnerKey, setBackupOwnerKey] = React.useState(() => initialOwnerKey(activeShopId));
  const [preview, setPreview] = React.useState({ owners: [], shops: [] });
  const [history, setHistory] = React.useState([]);
  const [status, setStatus] = React.useState('idle');
  const [error, setError] = React.useState('');
  const [warning, setWarning] = React.useState('');
  const [exportStatus, setExportStatus] = React.useState('idle');
  const [exportMessage, setExportMessage] = React.useState(null);
  const [exportConfirmationMode, setExportConfirmationMode] = React.useState('');
  const [domainSelections, setDomainSelections] = React.useState({});
  const requestIdRef = React.useRef(0);
  const previousActiveShopIdRef = React.useRef(String(activeShopId || '').trim());

  React.useEffect(() => {
    const active = String(activeShopId || '').trim();
    const activeChanged = previousActiveShopIdRef.current !== active;
    previousActiveShopIdRef.current = active;
    const nextShopId = initialShopId(shopOptions, active);
    setShopId((current) => {
      if (activeChanged) return nextShopId;
      if (shopOptions.some((shop) => shop.shopId === current)) return current;
      return nextShopId;
    });
    if (!activeChanged) return;
    requestIdRef.current += 1;
    setBackupOwnerKey(initialOwnerKey(nextShopId));
    setPreview({ owners: [], shops: [] });
    setHistory([]);
    setStatus(isActive ? 'loading' : 'idle');
    setError('');
    setWarning('');
    setExportStatus('idle');
    setExportMessage(null);
    setExportConfirmationMode('');
  }, [activeShopId, isActive, shopOptions]);

  const load = React.useCallback(async ({ signal, quiet = false } = {}) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!quiet) setStatus('loading');
    setError('');
    setWarning('');
    try {
      const nextPreview = await getAllDataBackupPreviews({ signal });
      if (requestId !== requestIdRef.current || signal?.aborted) return false;
      const previewShopOptions = nextPreview.shops || [];
      const nextShopId = findPreviewShopId(
        previewShopOptions,
        shopOptions,
        shopId || activeShopId,
      );
      if (nextShopId && nextShopId !== shopId) setShopId(nextShopId);
      const requestedOwner = parseDataBackupOwnerKey(backupOwnerKey);
      const activeOwnerKey = initialOwnerKey(activeShopId);
      const selected = nextPreview.owners.find((owner) => (
        owner.ownerType === requestedOwner?.ownerType && owner.ownerId === requestedOwner?.ownerId
      )) || nextPreview.owners.find((owner) => owner.ownerKey === activeOwnerKey)
        || nextPreview.owners[0]
        || null;
      setPreview(nextPreview);
      if (!selected) {
        setBackupOwnerKey('');
        setHistory([]);
        setStatus('empty');
        return false;
      }
      if (selected.ownerKey !== backupOwnerKey) setBackupOwnerKey(selected.ownerKey);
      const [historyResult, restoreHistoryResult] = await Promise.allSettled(
        ownerHistoryReaders(selected.owner, { signal }),
      );
      if (requestId !== requestIdRef.current || signal?.aborted) return false;
      const failures = [historyResult, restoreHistoryResult]
        .filter((result) => result.status === 'rejected');
      setHistory([
        ...(historyResult.status === 'fulfilled' ? historyResult.value : []),
        ...(restoreHistoryResult.status === 'fulfilled' ? restoreHistoryResult.value : []),
      ]);
      setWarning(failures.length
        ? '备份与恢复记录暂时无法全部读取，备份概览和导出仍可正常使用。'
        : '');
      setStatus('ready');
      return true;
    } catch (reason) {
      if (requestId !== requestIdRef.current || reason?.name === 'AbortError' || signal?.aborted) return false;
      setPreview({ owners: [], shops: [] });
      setHistory([]);
      setWarning('');
      setStatus('error');
      setError(errorMessage(reason, '无法读取数据备份信息。'));
      return false;
    }
  }, [activeShopId, backupOwnerKey, shopId, shopOptions]);

  const resolvedShopOptions = React.useMemo(
    () => mergePreviewShopOptions(preview.shops, shopOptions),
    [preview.shops, shopOptions],
  );

  React.useEffect(() => {
    if (!isActive) return undefined;
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => controller.abort();
  }, [isActive, load]);

  const selectedPreview = React.useMemo(
    () => preview.owners.find((owner) => owner.ownerKey === backupOwnerKey) || null,
    [backupOwnerKey, preview.owners],
  );
  const backupOwnerOptions = React.useMemo(() => preview.owners.map((owner) => {
    const shop = owner.ownerType === 'ozon_shop'
      ? shopOptions.find((item) => item.shopId === owner.ownerId)
      : null;
    return {
      shopId: owner.ownerKey,
      shopExternalId: shop?.shopExternalId || owner.ownerId,
      shopName: `${owner.ownerTypeLabel} · ${shop?.shopName || owner.displayName}`,
      shopAlias: shop?.shopAlias || '',
      displayName: shop?.displayName || owner.displayName,
    };
  }), [preview.owners, shopOptions]);
  const availableDomains = React.useMemo(() => selectedPreview?.domains || [], [selectedPreview]);
  const selectedDomains = React.useMemo(() => {
    const available = new Set(availableDomains.map((domain) => domain.domain));
    const mandatory = availableDomains.filter((domain) => domain.requiredForRestore).map((domain) => domain.domain);
    const saved = Object.prototype.hasOwnProperty.call(domainSelections, backupOwnerKey)
      ? domainSelections[backupOwnerKey]
      : availableDomains.map((domain) => domain.domain);
    return [...new Set([...mandatory, ...saved])].filter((domain) => available.has(domain)).sort();
  }, [availableDomains, backupOwnerKey, domainSelections]);

  const updateDomainSelection = React.useCallback((updater) => {
    setDomainSelections((current) => {
      const available = availableDomains.map((domain) => domain.domain);
      const mandatory = availableDomains.filter((domain) => domain.requiredForRestore).map((domain) => domain.domain);
      const previous = Object.prototype.hasOwnProperty.call(current, backupOwnerKey)
        ? current[backupOwnerKey]
        : available;
      const next = updater(previous, { available, mandatory });
      return { ...current, [backupOwnerKey]: [...new Set([...mandatory, ...next])].sort() };
    });
    setExportConfirmationMode('');
    setExportStatus('idle');
    setExportMessage(null);
  }, [availableDomains, backupOwnerKey]);

  const toggleDomain = React.useCallback((domain) => {
    const target = String(domain || '').trim();
    if (!target || availableDomains.some((item) => item.domain === target && item.requiredForRestore)) return;
    updateDomainSelection((previous) => (
      previous.includes(target) ? previous.filter((item) => item !== target) : [...previous, target]
    ));
  }, [availableDomains, updateDomainSelection]);

  const selectAllDomains = React.useCallback(() => {
    updateDomainSelection((_previous, { available }) => available);
  }, [updateDomainSelection]);
  const selectRequiredDomainsOnly = React.useCallback(() => {
    updateDomainSelection((_previous, { mandatory }) => mandatory);
  }, [updateDomainSelection]);

  const selectShop = React.useCallback((nextShopId) => {
    setShopId(String(nextShopId || '').trim());
  }, []);
  const selectBackupOwner = React.useCallback((nextOwnerKey) => {
    setBackupOwnerKey(String(nextOwnerKey || ''));
    setExportConfirmationMode('');
    setExportStatus('idle');
    setExportMessage(null);
  }, []);

  const requestExport = React.useCallback(() => {
    if (!selectedPreview?.dataFingerprint) {
      setExportMessage({ severity: 'error', text: '当前数据快照尚未准备好，请刷新后重试。' });
      return false;
    }
    setExportMessage(null);
    setExportConfirmationMode('single');
    return true;
  }, [selectedPreview]);

  const requestBatchExport = React.useCallback(() => {
    if (preview.owners.length < 2 || preview.owners.some((owner) => !owner.dataFingerprint)) {
      setExportMessage({ severity: 'error', text: '全部账号快照尚未准备完成，请刷新后重试。' });
      return false;
    }
    setExportMessage(null);
    setExportConfirmationMode('batch');
    return true;
  }, [preview.owners]);

  const cancelExport = React.useCallback(() => {
    if (exportStatus !== 'exporting') setExportConfirmationMode('');
  }, [exportStatus]);

  const runExport = React.useCallback(async () => {
    if (exportStatus === 'exporting' || !exportConfirmationMode) return null;
    setExportConfirmationMode('');
    setExportStatus('exporting');
    setExportMessage(null);
    try {
      const result = exportConfirmationMode === 'batch'
        ? await exportDataBackupBatch(preview.owners.map((owner) => ({
            owner: owner.owner,
            expectedDataFingerprint: owner.dataFingerprint,
            selectedDomains: owner.domains.map((domain) => domain.domain),
          })))
        : await exportDataBackup({
            owner: selectedPreview.owner,
            expectedDataFingerprint: selectedPreview.dataFingerprint,
            selectedDomains,
          });
      if (result.canceled) {
        setExportStatus('idle');
        setExportMessage({ severity: 'info', text: '已取消导出，没有创建备份文件。' });
        return result;
      }
      setExportStatus('completed');
      setExportMessage({
        severity: 'success',
        text: exportConfirmationMode === 'batch'
          ? `已完成 ${result.backups.length} 个账号/店铺的批量备份并通过校验。`
          : '备份文件已落盘并通过完整性校验。',
      });
      await load({ quiet: true });
      return result;
    } catch (reason) {
      setExportStatus('error');
      setExportMessage({ severity: 'error', text: errorMessage(reason, '数据备份导出失败。') });
      return null;
    }
  }, [exportConfirmationMode, exportStatus, load, preview.owners, selectedDomains, selectedPreview]);

  return {
    shopOptions: resolvedShopOptions,
    shopId,
    backupOwnerOptions,
    backupOwnerKey,
    preview,
    selectedPreview,
    availableDomains,
    selectedDomains,
    history,
    status,
    error,
    warning,
    exportStatus,
    exportMessage,
    exportConfirmationOpen: Boolean(exportConfirmationMode),
    exportConfirmationMode,
    canExport: Boolean(selectedPreview?.dataFingerprint && selectedDomains.length),
    canBatchExport: preview.owners.length > 1 && preview.owners.every((owner) => owner.dataFingerprint),
    selectShop,
    selectBackupOwner,
    refresh: () => load(),
    requestExport,
    requestBatchExport,
    cancelExport,
    runExport,
    toggleDomain,
    selectAllDomains,
    selectRequiredDomainsOnly,
  };
}
