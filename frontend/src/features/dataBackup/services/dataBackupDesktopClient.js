import {
  normalizeBackupSummary,
  normalizeDataBackupDomains,
  normalizeDataBackupShopOption,
} from '../lib/dataBackupPresentation.js';
import { getDataBackupErrorMessage } from '../lib/dataBackupErrors.js';
import { dataBackupCount, dataBackupText } from '../lib/dataBackupValue.js';

function dataBackupBridge() {
  return globalThis.window?.wangzaiDesktop?.dataBackup?.command || null;
}

function bridgeError(result = {}) {
  const code = result?.error?.code
    || result?.data?.error?.code
    || (typeof result?.error === 'string' && /^[A-Z][A-Z0-9_:-]+$/u.test(result.error) ? result.error : '')
    || 'DATA_BACKUP_COMMAND_FAILED';
  const message = getDataBackupErrorMessage(code);
  const error = new Error(message);
  error.status = Number(result?.status || 0);
  error.code = code;
  return error;
}

function normalizeImportSummary(value = {}, container = {}) {
  return {
    totalRecords: dataBackupCount(value.totalRecords ?? value.total_records ?? value.total ?? container.totalRecords ?? container.total_records),
    incomingRecords: dataBackupCount(value.incomingRecords ?? value.incoming_records ?? value.incoming),
    newRecords: dataBackupCount(value.newRecords ?? value.new_records ?? value.added),
    updateRecords: dataBackupCount(value.updateRecords ?? value.update_records ?? value.updated),
    preservedRecords: dataBackupCount(value.preservedRecords ?? value.preserved_records ?? value.preserved),
    conflictRecords: dataBackupCount(value.conflictRecords ?? value.conflict_records ?? value.conflicts),
    skippedRecords: dataBackupCount(value.skippedRecords ?? value.skipped_records ?? value.skipped),
    failedRecords: dataBackupCount(value.failedRecords ?? value.failed_records ?? value.failed),
  };
}

function normalizeSoftwareBackupImportPreview(value = {}) {
  return {
    sessionId: dataBackupText(value.sessionId, value.session_id),
    importId: dataBackupText(value.importId, value.import_id),
    previewFingerprint: dataBackupText(value.previewFingerprint, value.preview_fingerprint),
    packageVersion: dataBackupText(value.packageVersion, value.package_version),
    exportedAt: dataBackupText(value.exportedAt, value.exported_at, value.createdAt, value.created_at),
    conflictMode: dataBackupText(value.conflictMode, value.conflict_mode, 'preserve'),
    summary: normalizeImportSummary(value.summary, value),
    domains: normalizeDataBackupDomains(value.domains),
    sourceShop: normalizeDataBackupShopOption(value.sourceShop || value.source_shop),
    targetShop: normalizeDataBackupShopOption(value.targetShop || value.target_shop),
    sourceOwner: value.sourceOwner || value.source_owner || null,
    targetOwner: value.targetOwner || value.target_owner || null,
    restoreSafety: value.restoreSafety ? {
      writeAllowed: value.restoreSafety.writeAllowed === true,
      atomicity: dataBackupText(value.restoreSafety.atomicity),
      errorCode: dataBackupText(value.restoreSafety.errorCode),
    } : null,
  };
}

export async function exportDataBackup({
  owner,
  shopId,
  expectedDataFingerprint,
  selectedDomains,
} = {}) {
  const command = dataBackupBridge();
  if (typeof command !== 'function') {
    const error = new Error('数据备份导出只能在桌面端使用。');
    error.code = 'DATA_BACKUP_DESKTOP_BRIDGE_REQUIRED';
    throw error;
  }
  const normalizedOwner = owner && typeof owner === 'object' && !Array.isArray(owner)
    ? {
        ownerType: String(owner.ownerType || '').trim(),
        ownerId: String(owner.ownerId || '').trim(),
      }
    : { ownerType: 'ozon_shop', ownerId: String(shopId || '').trim() };
  const fingerprint = String(expectedDataFingerprint || '').trim();
  if (!normalizedOwner.ownerType || !normalizedOwner.ownerId || !fingerprint) {
    const error = new Error('当前账号的数据快照尚未准备好，请刷新后重试。');
    error.code = 'DATA_BACKUP_PREVIEW_REQUIRED';
    throw error;
  }
  const result = await command({
    command: 'export',
    owner: normalizedOwner,
    expectedDataFingerprint: fingerprint,
    ...(Array.isArray(selectedDomains) ? { selectedDomains } : {}),
  });
  if (!result?.ok) throw bridgeError(result);
  if (result?.data?.canceled === true) return { canceled: true };

  const summary = normalizeBackupSummary(result?.data || {});
  if (!summary.verified) {
    const error = new Error('备份文件尚未通过完整性校验，未标记为导出完成。');
    error.code = 'DATA_BACKUP_EXPORT_NOT_VERIFIED';
    throw error;
  }
  return { canceled: false, ...summary };
}

export async function exportDataBackupBatch(items = []) {
  const command = dataBackupBridge();
  if (typeof command !== 'function') {
    const error = new Error('数据备份导出只能在桌面端使用。');
    error.code = 'DATA_BACKUP_DESKTOP_BRIDGE_REQUIRED';
    throw error;
  }
  const normalized = (Array.isArray(items) ? items : []).map((item) => ({
    owner: {
      ownerType: String(item?.owner?.ownerType || '').trim(),
      ownerId: String(item?.owner?.ownerId || '').trim(),
    },
    expectedDataFingerprint: String(item?.expectedDataFingerprint || '').trim(),
    selectedDomains: Array.isArray(item?.selectedDomains) ? item.selectedDomains : undefined,
  }));
  if (normalized.length < 2 || normalized.some((item) => (
    !item.owner.ownerType || !item.owner.ownerId || !item.expectedDataFingerprint
  ))) {
    const error = new Error('批量备份快照尚未准备完成，请刷新后重试。');
    error.code = 'DATA_BACKUP_BATCH_PREVIEW_REQUIRED';
    throw error;
  }
  const result = await command({ command: 'export-batch', items: normalized });
  if (!result?.ok) throw bridgeError(result);
  if (result?.data?.canceled === true) return { canceled: true, backups: [] };
  const backups = (Array.isArray(result?.data?.backups) ? result.data.backups : [])
    .map((backup, index) => normalizeBackupSummary(backup, index));
  if (result?.data?.verified !== true || backups.length !== normalized.length
    || backups.some((backup) => backup.verified !== true)) {
    const error = new Error('批量备份未全部通过完整性校验。');
    error.code = 'DATA_BACKUP_BATCH_EXPORT_NOT_VERIFIED';
    throw error;
  }
  return { canceled: false, backups };
}


export async function preflightSoftwareBackupImport({
  targetShopId,
  conflictMode = 'preserve',
  legacyPassphrase = '',
} = {}) {
  const command = dataBackupBridge();
  if (typeof command !== 'function') {
    const error = new Error('恢复软件备份只能在桌面端使用。');
    error.code = 'DATA_BACKUP_DESKTOP_BRIDGE_REQUIRED';
    throw error;
  }
  const passphrase = String(legacyPassphrase || '').trim();
  const result = await command({
    command: 'preflight-import',
    targetShopId: String(targetShopId || '').trim(),
    conflictMode: conflictMode === 'overwrite' ? 'overwrite' : 'preserve',
    ...(passphrase ? { passphrase } : {}),
  });
  if (!result?.ok) throw bridgeError(result);
  if (result?.data?.canceled === true) return { canceled: true };
  const preview = normalizeSoftwareBackupImportPreview(result?.data || {});
  if (!preview.sessionId || !preview.previewFingerprint) {
    const error = new Error('软件备份未生成有效的预检结果。');
    error.code = 'DATA_BACKUP_IMPORT_PREFLIGHT_INVALID';
    throw error;
  }
  return { canceled: false, ...preview };
}

export async function commitSoftwareBackupImport({
  sessionId,
  importId,
  previewFingerprint,
  targetShopId,
  conflictMode = 'preserve',
} = {}) {
  const command = dataBackupBridge();
  if (typeof command !== 'function') {
    const error = new Error('恢复软件备份只能在桌面端使用。');
    error.code = 'DATA_BACKUP_DESKTOP_BRIDGE_REQUIRED';
    throw error;
  }
  const normalizedImportId = String(importId || '').trim();
  const input = {
    command: 'commit-import',
    sessionId: String(sessionId || '').trim(),
    ...(normalizedImportId ? { importId: normalizedImportId } : {}),
    previewFingerprint: String(previewFingerprint || '').trim(),
    targetShopId: String(targetShopId || '').trim(),
    conflictMode: conflictMode === 'overwrite' ? 'overwrite' : 'preserve',
  };
  if (!input.sessionId || !input.previewFingerprint) {
    const error = new Error('请先完成备份预检和账号映射。');
    error.code = 'DATA_BACKUP_IMPORT_PREFLIGHT_REQUIRED';
    throw error;
  }
  const result = await command(input);
  if (!result?.ok) throw bridgeError(result);
  return {
    importId: dataBackupText(result?.data?.importId, result?.data?.import_id, normalizedImportId),
    completedAt: dataBackupText(result?.data?.completedAt, result?.data?.completed_at),
    verified: result?.data?.verified === true,
    summary: normalizeImportSummary(result?.data?.summary, result?.data),
  };
}
