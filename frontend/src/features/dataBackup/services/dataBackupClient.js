import { requestLocalApi } from '../../../api/localApiClient.js';
import {
  normalizeDataBackupHistory,
  normalizeDataBackupImportHistory,
  normalizeDataBackupPreview,
} from '../lib/dataBackupPresentation.js';

function queryForShop(shopId) {
  return `?shopId=${encodeURIComponent(String(shopId || '').trim())}`;
}

function queryForOwner(owner = {}) {
  const ownerType = String(owner.ownerType || '').trim();
  const ownerId = String(owner.ownerId || '').trim();
  return `?ownerType=${encodeURIComponent(ownerType)}&ownerId=${encodeURIComponent(ownerId)}`;
}

function assertSuccessfulPayload(payload, fallbackMessage) {
  if (payload?.ok === true) return payload;
  const error = new Error(payload?.error?.message || payload?.error || fallbackMessage);
  error.code = payload?.error?.code || 'DATA_BACKUP_REQUEST_FAILED';
  throw error;
}

export async function getAllDataBackupPreviews(options = {}) {
  const payload = await requestLocalApi('/api/app/data-backup-preview', {
    method: 'GET',
    timeoutMs: options.timeoutMs || 120_000,
    signal: options.signal,
  });
  return normalizeDataBackupPreview(assertSuccessfulPayload(payload, '无法读取数据备份概览。'));
}

export async function getDataBackupOwnerHistory(owner, options = {}) {
  const payload = await requestLocalApi(`/api/app/data-backup-history${queryForOwner(owner)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30_000,
    signal: options.signal,
  });
  return normalizeDataBackupHistory(assertSuccessfulPayload(payload, '无法读取数据备份记录。'));
}

export async function getDataBackupOwnerImportHistory(owner, options = {}) {
  const payload = await requestLocalApi(`/api/app/data-backup-import-history${queryForOwner(owner)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30_000,
    signal: options.signal,
  });
  return normalizeDataBackupImportHistory(assertSuccessfulPayload(payload, '无法读取账号备份恢复记录。'));
}

export async function getDataBackupHistory(shopId, options = {}) {
  const payload = await requestLocalApi(`/api/app/data-backup-history${queryForShop(shopId)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30_000,
    signal: options.signal,
  });
  return normalizeDataBackupHistory(assertSuccessfulPayload(payload, '无法读取数据备份记录。'));
}

export async function getDataBackupImportHistory(shopId, options = {}) {
  const payload = await requestLocalApi(`/api/app/data-backup-import-history${queryForShop(shopId)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30_000,
    signal: options.signal,
  });
  return normalizeDataBackupImportHistory(assertSuccessfulPayload(payload, '无法读取软件备份恢复记录。'));
}
