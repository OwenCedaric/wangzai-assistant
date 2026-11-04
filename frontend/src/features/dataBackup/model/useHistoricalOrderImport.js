import React from 'react';
import { presentDataBackupError } from '../lib/dataBackupErrors.js';
import {
  HISTORICAL_ORDER_DIMENSION_FIELDS,
  buildHistoricalOrderImportRows,
} from '../lib/historicalOrderImportSchema.js';
import {
  confirmHistoricalOrderImport,
  getHistoricalOrderImportHistory,
  preflightHistoricalOrderImport,
} from '../services/historicalOrderImportClient.js';
import {
  downloadHistoricalOrderImportTemplate,
  parseHistoricalOrderImportFile,
} from '../services/historicalOrderSpreadsheetService.js';

function errorText(error, fallback) {
  if (error?.name === 'AbortError') return '';
  return presentDataBackupError(error, fallback);
}

function mergeConfirmedRows(previewRows = [], confirmedRows = []) {
  if (!confirmedRows.length) return previewRows;
  const previewByIndex = new Map(previewRows.map((row) => [row.rowIndex, row]));
  return confirmedRows.map((row) => {
    const preview = previewByIndex.get(row.rowIndex) || {};
    return {
      ...preview,
      ...row,
      values: Object.keys(row.values || {}).length ? row.values : preview.values || {},
      appliedValues: Object.keys(row.appliedValues || {}).length
        ? row.appliedValues
        : preview.appliedValues || preview.values || {},
      selectedProduct: row.selectedProduct || preview.selectedProduct,
      productCandidates: row.productCandidates?.length
        ? row.productCandidates
        : preview.productCandidates || [],
    };
  });
}

export function buildHistoricalDimensionSyncCandidates(rows = []) {
  const seen = new Set();
  return rows.flatMap((row) => {
    const product = row.selectedProduct
      || (row.productCandidates?.length === 1 ? row.productCandidates[0] : null);
    const values = row.appliedValues && Object.keys(row.appliedValues).length
      ? row.appliedValues
      : row.values || {};
    const dimensions = Object.fromEntries(HISTORICAL_ORDER_DIMENSION_FIELDS
      .filter((field) => Number(values[field]) > 0)
      .map((field) => [field, Number(values[field])]));
    if (row.committed !== true || !product || !Object.keys(dimensions).length) return [];
    const identity = String(product.productIdentityId || product.productId || '').trim();
    if (!identity) return [];
    const selectionKey = `${row.rowIndex}:${identity}`;
    if (seen.has(selectionKey)) return [];
    seen.add(selectionKey);
    return [{
      selectionKey,
      rowIndex: row.rowIndex,
      orderNumber: row.orderNumber,
      productIdentityId: product.productIdentityId,
      productId: product.productId,
      productName: product.name || '未命名商品',
      values: dimensions,
    }];
  });
}

export function useHistoricalOrderImport({ shopId = '', isActive = true, onCompleted } = {}) {
  const [sheet, setSheet] = React.useState(null);
  const [mappings, setMappings] = React.useState([]);
  const [status, setStatus] = React.useState('idle');
  const [message, setMessage] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [history, setHistory] = React.useState([]);
  const [productSelections, setProductSelections] = React.useState({});
  const [completedImport, setCompletedImport] = React.useState(null);
  const parseRequestRef = React.useRef(0);

  const localResult = React.useMemo(
    () => buildHistoricalOrderImportRows({ rows: sheet?.rows || [], mappings }),
    [mappings, sheet?.rows],
  );

  const clearFile = React.useCallback(() => {
    parseRequestRef.current += 1;
    setSheet(null);
    setMappings([]);
    setPreview(null);
    setProductSelections({});
    setCompletedImport(null);
    setStatus('idle');
    setMessage(null);
  }, []);

  React.useEffect(() => {
    clearFile();
  }, [clearFile, shopId]);

  const loadHistory = React.useCallback(async ({ signal } = {}) => {
    if (!shopId) {
      setHistory([]);
      return [];
    }
    try {
      const records = await getHistoricalOrderImportHistory(shopId, { signal });
      const recordsWithCandidates = records.map((record) => ({
        ...record,
        dimensionCandidates: buildHistoricalDimensionSyncCandidates(record.rows || []),
      }));
      if (!signal?.aborted) {
        setHistory(recordsWithCandidates);
        setMessage((current) => (
          current?.severity === 'error' ? null : current
        ));
      }
      return recordsWithCandidates;
    } catch (error) {
      if (error?.name !== 'AbortError' && !signal?.aborted) {
        setMessage({ severity: 'error', text: errorText(error, '无法读取历史订单导入记录。') });
      }
      return [];
    }
  }, [shopId]);

  React.useEffect(() => {
    if (!isActive || !shopId) return undefined;
    const controller = new AbortController();
    loadHistory({ signal: controller.signal });
    return () => controller.abort();
  }, [isActive, loadHistory, shopId]);

  const selectFile = React.useCallback(async (file) => {
    const requestId = parseRequestRef.current + 1;
    parseRequestRef.current = requestId;
    setStatus('parsing');
    setMessage(null);
    setPreview(null);
    setProductSelections({});
    setCompletedImport(null);
    try {
      const parsed = await parseHistoricalOrderImportFile(file);
      if (parseRequestRef.current !== requestId) return null;
      setSheet(parsed);
      setMappings(parsed.mappings);
      setStatus('parsed');
      setMessage({ severity: 'info', text: '文件读取完成，请检查字段对应关系。' });
      return parsed;
    } catch (error) {
      if (parseRequestRef.current !== requestId) return null;
      setSheet(null);
      setMappings([]);
      setStatus('error');
      setMessage({ severity: 'error', text: errorText(error, '历史订单文件读取失败。') });
      return null;
    }
  }, []);

  const updateMapping = React.useCallback((columnIndex, field) => {
    setMappings((current) => current.map((mapping) => {
      if (mapping.columnIndex === columnIndex) return { ...mapping, field };
      if (field && mapping.field === field) return { ...mapping, field: '' };
      return mapping;
    }));
    setPreview(null);
    setProductSelections({});
    setCompletedImport(null);
    setStatus('parsed');
    setMessage(null);
  }, []);

  const updateProductSelection = React.useCallback((rowIndex, productIdentityId) => {
    setProductSelections((current) => ({
      ...current,
      [rowIndex]: String(productIdentityId || '').trim(),
    }));
    setStatus('selection-dirty');
    setMessage({ severity: 'info', text: '商品选择已更新，请重新预检后再导入。' });
  }, []);

  const resumeImport = React.useCallback((record) => {
    if (!record?.importId) return false;
    const rows = Array.isArray(record.rows) ? record.rows : [];
    const dimensionCandidates = Array.isArray(record.dimensionCandidates)
      ? record.dimensionCandidates
      : buildHistoricalDimensionSyncCandidates(rows);
    setCompletedImport({
      ...record,
      rows,
      dimensionCandidates,
    });
    setMessage({ severity: 'info', text: '已打开历史导入记录，可以继续选择并回传尺寸。' });
    return true;
  }, []);

  const downloadTemplate = React.useCallback(() => {
    try {
      downloadHistoricalOrderImportTemplate();
      setMessage({ severity: 'success', text: '历史订单模板已开始下载。' });
      return true;
    } catch (error) {
      setMessage({ severity: 'error', text: errorText(error, '历史订单模板下载失败。') });
      return false;
    }
  }, []);

  const runPreflight = React.useCallback(async () => {
    if (!shopId) {
      setMessage({ severity: 'error', text: '请先选择历史订单所属的 Ozon 店铺。' });
      return null;
    }
    if (!sheet || !localResult.rows.length) {
      setMessage({ severity: 'error', text: '没有可预检的订单，请检查文件和字段对应关系。' });
      return null;
    }
    if (status === 'preflighting' || status === 'confirming') return null;
    setStatus('preflighting');
    setMessage(null);
    try {
      const result = await preflightHistoricalOrderImport({
        shopId,
        columns: [
          ...mappings
            .filter((mapping) => mapping.field)
            .map(({ columnIndex, sourceHeader, field }) => ({ columnIndex, sourceHeader, field })),
          ...(Object.values(productSelections).some(Boolean)
            ? [{ sourceHeader: 'selectedProductId', field: 'selectedProductId' }]
            : []),
        ],
        rows: localResult.rows.map((row, index) => (
          productSelections[index]
            ? { ...row, selectedProductId: productSelections[index] }
            : row
        )),
        source: {
          fileName: sheet.fileName,
          fileType: sheet.fileType,
        },
      });
      if (!result.importId || !result.previewFingerprint) {
        throw new Error('预检结果缺少确认凭证。');
      }
      setPreview(result);
      if (result.restoreSafety?.writeAllowed === false) {
        setStatus('blocked');
        setMessage({ severity: 'warning', text: errorText({ code: result.restoreSafety.errorCode || 'HISTORICAL_ORDER_IMPORT_SAFE_RESTORE_REQUIRED' },
          '当前不能安全提交历史订单导入，尚未写入数据。') });
      } else if (result.requiresSelection) {
        setStatus('selection-required');
        setMessage({ severity: 'warning', text: '部分订单包含多个商品，请选择具体商品后重新预检。' });
      } else {
        setStatus('ready');
        const lookup = result.officialLookup;
        const lookupText = lookup?.requestedCount
          ? `已自动回查 Ozon ${lookup.foundCount}/${lookup.requestedCount} 个本地缺失订单。`
          : '';
        setMessage({
          severity: lookup?.failedCount || lookup?.notFoundCount ? 'warning' : 'success',
          text: `${lookupText}预检完成。确认导入只会保存本地，不会回传 Ozon。`,
        });
      }
      return result;
    } catch (error) {
      setStatus('error');
      setMessage({ severity: 'error', text: errorText(error, '历史订单预检失败。') });
      return null;
    }
  }, [localResult.rows, mappings, productSelections, sheet, shopId, status]);

  const runConfirm = React.useCallback(async () => {
    if (status !== 'ready' || !preview || !shopId || preview.restoreSafety?.writeAllowed === false) return null;
    setStatus('confirming');
    setMessage(null);
    try {
      const result = await confirmHistoricalOrderImport({
        shopId,
        importId: preview.importId,
        previewFingerprint: preview.previewFingerprint,
      });
      if (result.verified !== true) {
        const error = new Error('历史订单保存后未通过本地回读校验。');
        error.code = 'HISTORICAL_ORDER_IMPORT_READBACK_MISMATCH';
        throw error;
      }
      const rows = mergeConfirmedRows(preview.rows, result.rows);
      const completed = {
        ...result,
        rows,
        dimensionCandidates: buildHistoricalDimensionSyncCandidates(rows),
      };
      setCompletedImport(completed);
      setStatus('completed');
      setMessage({ severity: 'success', text: '历史订单已保存到本地，没有回传 Ozon。' });
      await Promise.all([loadHistory(), onCompleted?.(completed)]);
      return completed;
    } catch (error) {
      setStatus('error');
      setMessage({ severity: 'error', text: errorText(error, '历史订单导入失败。') });
      return null;
    }
  }, [loadHistory, onCompleted, preview, shopId, status]);

  return {
    sheet,
    mappings,
    localResult,
    preview,
    history,
    status,
    message,
    productSelections,
    completedImport,
    canPreflight: Boolean(
      shopId
      && sheet
      && localResult.rows.length
      && status !== 'parsing'
      && status !== 'preflighting'
      && status !== 'confirming',
    ),
    canConfirm: Boolean(
      shopId
      && preview?.importId
      && preview?.previewFingerprint
      && !preview?.requiresSelection
      && preview?.restoreSafety?.writeAllowed !== false
      && status === 'ready',
    ),
    selectFile,
    updateMapping,
    updateProductSelection,
    downloadTemplate,
    runPreflight,
    runConfirm,
    resumeImport,
    clearFile,
    refreshHistory: loadHistory,
  };
}
