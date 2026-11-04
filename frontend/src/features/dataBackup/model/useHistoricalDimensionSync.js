import React from 'react';
import { presentDataBackupError } from '../lib/dataBackupErrors.js';
import {
  confirmHistoricalDimensionSync,
  previewHistoricalDimensionSync,
} from '../services/historicalDimensionSyncClient.js';

export function useHistoricalDimensionSync({ shopId = '', completedImport = null } = {}) {
  const [selectedKeys, setSelectedKeys] = React.useState([]);
  const [status, setStatus] = React.useState('idle');
  const [message, setMessage] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const candidates = React.useMemo(
    () => Array.isArray(completedImport?.dimensionCandidates)
      ? completedImport.dimensionCandidates
      : [],
    [completedImport?.dimensionCandidates],
  );

  React.useEffect(() => {
    setSelectedKeys([]);
    setStatus('idle');
    setMessage(null);
    setPreview(null);
    setResult(null);
  }, [completedImport?.importId, shopId]);

  const toggleCandidate = React.useCallback((selectionKey) => {
    const key = String(selectionKey || '').trim();
    if (!key) return;
    setSelectedKeys((current) => (
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    ));
    setStatus('idle');
    setMessage(null);
    setPreview(null);
    setResult(null);
  }, []);

  const runPreview = React.useCallback(async () => {
    if (!shopId || !completedImport?.importId || !selectedKeys.length) {
      setMessage({ severity: 'error', text: '请先选择需要回传长宽高或重量的商品。' });
      return null;
    }
    if (status === 'previewing' || status === 'confirming') return null;
    const selected = candidates.filter((candidate) => selectedKeys.includes(candidate.selectionKey));
    setStatus('previewing');
    setMessage(null);
    setPreview(null);
    setResult(null);
    try {
      const nextPreview = await previewHistoricalDimensionSync({
        shopId,
        importId: completedImport.importId,
        items: selected.map((candidate) => ({
          rowIndex: candidate.rowIndex,
          orderNumber: candidate.orderNumber,
          productIdentityId: candidate.productIdentityId,
          productId: candidate.productId,
        })),
      });
      if (!nextPreview.previewFingerprint) {
        throw new Error('尺寸回传预览缺少确认凭证。');
      }
      setPreview(nextPreview);
      setStatus('ready');
      setMessage({ severity: 'info', text: '请核对 Ozon 当前值、拟回传值和历史订单来源，再人工确认。' });
      return nextPreview;
    } catch (error) {
      setStatus('error');
      setMessage({ severity: 'error', text: presentDataBackupError(error, '尺寸回传预览失败。') });
      return null;
    }
  }, [candidates, completedImport?.importId, selectedKeys, shopId, status]);

  const runConfirm = React.useCallback(async () => {
    if (status !== 'ready' || !preview?.previewFingerprint || !shopId) return null;
    setStatus('confirming');
    setMessage(null);
    try {
      const nextResult = await confirmHistoricalDimensionSync({
        shopId,
        ...(preview.operationId ? { previewId: preview.operationId } : {}),
        previewFingerprint: preview.previewFingerprint,
        confirm: true,
      });
      setResult(nextResult);
      if (nextResult.verified === true) {
        setStatus('completed');
        setMessage({ severity: 'success', text: '已回传 Ozon，并通过长宽高/重量回读校验。' });
      } else {
        setStatus('partial');
        setMessage({ severity: 'warning', text: '回传已提交，但仍有商品未通过 Ozon 回读，请查看结果。' });
      }
      return nextResult;
    } catch (error) {
      setStatus('error');
      setMessage({ severity: 'error', text: presentDataBackupError(error, '尺寸回传失败。') });
      return null;
    }
  }, [preview, shopId, status]);

  return {
    candidates,
    selectedKeys,
    status,
    message,
    preview,
    result,
    canPreview: Boolean(
      shopId
      && completedImport?.importId
      && selectedKeys.length
      && status !== 'previewing'
      && status !== 'confirming',
    ),
    canConfirm: Boolean(status === 'ready' && preview?.previewFingerprint),
    toggleCandidate,
    runPreview,
    runConfirm,
  };
}
