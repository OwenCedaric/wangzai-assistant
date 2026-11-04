import React from 'react';
import { presentDataBackupError } from '../lib/dataBackupErrors.js';
import {
  commitSoftwareBackupImport,
  preflightSoftwareBackupImport,
} from '../services/dataBackupDesktopClient.js';

function errorText(error, fallback) {
  return presentDataBackupError(error, fallback);
}

export function useSoftwareBackupRestore({
  shopOptions = [],
  defaultShopId = '',
  onCompleted,
} = {}) {
  const [targetShopId, setTargetShopId] = React.useState(() => String(defaultShopId || '').trim());
  const [status, setStatus] = React.useState('idle');
  const [message, setMessage] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [legacyPassphraseRequired, setLegacyPassphraseRequired] = React.useState(false);
  const [legacyPassphrase, setLegacyPassphrase] = React.useState('');

  React.useEffect(() => {
    const available = new Set(shopOptions.map((shop) => shop.shopId));
    setTargetShopId((current) => {
      if (current && available.has(current)) return current;
      const preferred = String(defaultShopId || '').trim();
      return available.has(preferred) ? preferred : shopOptions[0]?.shopId || '';
    });
  }, [defaultShopId, shopOptions]);

  const invalidatePreview = React.useCallback(() => {
    setPreview(null);
    setStatus('idle');
    setMessage(null);
    setLegacyPassphraseRequired(false);
    setLegacyPassphrase('');
  }, []);

  const selectTargetShop = React.useCallback((shopId) => {
    setTargetShopId(String(shopId || '').trim());
    invalidatePreview();
  }, [invalidatePreview]);

  const runPreflight = React.useCallback(async () => {
    if (status === 'preflighting' || status === 'committing') return null;
    setStatus('preflighting');
    setMessage(null);
    setPreview(null);
    try {
      const result = await preflightSoftwareBackupImport({
        targetShopId,
        conflictMode: 'preserve',
        ...(legacyPassphraseRequired ? { legacyPassphrase } : {}),
      });
      if (result.canceled) {
        setStatus('idle');
        setMessage({ severity: 'info', text: '已取消选择，没有读取备份文件。' });
        return result;
      }
      setPreview(result);
      if (result.restoreSafety?.writeAllowed === false) {
        setStatus('blocked');
        setMessage({ severity: 'warning', text: errorText(
          { code: result.restoreSafety.errorCode || 'DATA_BACKUP_IMPORT_SAFE_RESTORE_REQUIRED' },
          '当前无法安全提交恢复，尚未写入数据。',
        ) });
        return result;
      }
      setStatus('ready');
      setLegacyPassphraseRequired(false);
      setLegacyPassphrase('');
      setMessage({ severity: 'success', text: '备份包校验通过，请核对映射后确认恢复。' });
      return result;
    } catch (error) {
      if (error?.code === 'DATA_BACKUP_LEGACY_PASSPHRASE_REQUIRED') {
        setLegacyPassphraseRequired(true);
        setStatus('idle');
        setMessage({ severity: 'warning', text: errorText(error, '请输入旧版备份口令。') });
        return null;
      }
      setStatus('error');
      setMessage({ severity: 'error', text: errorText(error, '软件备份预检失败。') });
      return null;
    }
  }, [legacyPassphrase, legacyPassphraseRequired, status, targetShopId]);

  const runCommit = React.useCallback(async () => {
    if (status !== 'ready' || !preview || preview.restoreSafety?.writeAllowed === false) return null;
    setStatus('committing');
    setMessage(null);
    try {
      const result = await commitSoftwareBackupImport({
        sessionId: preview.sessionId,
        importId: preview.importId,
        previewFingerprint: preview.previewFingerprint,
        targetShopId,
        conflictMode: 'preserve',
      });
      if (result.verified !== true) {
        const error = new Error('恢复结果尚未通过数据回读校验。');
        error.code = 'DATA_BACKUP_COMMIT_NOT_VERIFIED';
        throw error;
      }
      setStatus('completed');
      setMessage({ severity: 'success', text: '软件备份已恢复并通过数据回读校验。' });
      await onCompleted?.(result);
      return result;
    } catch (error) {
      setStatus('error');
      setMessage({ severity: 'error', text: errorText(error, '软件备份恢复失败。') });
      return null;
    }
  }, [onCompleted, preview, status, targetShopId]);

  return {
    targetShopId,
    status,
    message,
    preview,
    legacyPassphraseRequired,
    legacyPassphrase,
    canPreflight: Boolean(
      status !== 'preflighting'
      && status !== 'committing'
      && (!legacyPassphraseRequired || legacyPassphrase.trim().length >= 12),
    ),
    canCommit: Boolean(
      preview?.sessionId
      && preview.restoreSafety?.writeAllowed !== false
      && preview?.previewFingerprint
      && status === 'ready',
    ),
    selectTargetShop,
    setLegacyPassphrase,
    runPreflight,
    runCommit,
    reset: invalidatePreview,
  };
}
