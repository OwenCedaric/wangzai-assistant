import { requestLocalApi } from '../../../api/localApiClient.js';
import { getDataBackupErrorMessage } from '../lib/dataBackupErrors.js';
import { dataBackupCount, dataBackupText } from '../lib/dataBackupValue.js';

const FACT_FIELDS = Object.freeze([
  'purchaseCostCny',
  'crossBorderCostCny',
  'domesticFreightCny',
  'sourcePlatform',
  'sourceUrl',
  'purchaseOrderNumber',
  'trackingNumber',
  'lengthCm',
  'widthCm',
  'heightCm',
  'weightKg',
  'note',
]);

function rowIndex(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function assertSuccessfulPayload(payload) {
  if (payload?.ok === true) return payload;
  const code = payload?.error?.code
    || (typeof payload?.error === 'string' && /^[A-Z][A-Z0-9_:-]+$/u.test(payload.error)
      ? payload.error
      : 'HISTORICAL_ORDER_IMPORT_REQUEST_FAILED');
  const error = new Error(getDataBackupErrorMessage(code));
  error.code = code;
  throw error;
}

function normalizeFacts(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(FACT_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
    .map((field) => [field, value[field]]));
}

function normalizeProduct(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const productIdentityId = dataBackupText(
    value.productIdentityId,
    value.product_identity_id,
    value.identityId,
    value.identity_id,
  );
  const productId = dataBackupText(value.productId, value.product_id);
  const name = dataBackupText(value.name, value.productName, value.product_name);
  if (!productIdentityId && !productId && !name) return null;
  return { productIdentityId, productId, name: name || '未命名商品' };
}

function normalizeOrderImportRow(value = {}, fallbackIndex = 0) {
  const index = rowIndex(value.rowIndex ?? value.row_index, fallbackIndex);
  const status = dataBackupText(value.status, value.previewStatus, value.preview_status, 'unknown');
  const errorCode = dataBackupText(value.errorCode, value.error_code);
  const productCandidates = (Array.isArray(value.productCandidates)
    ? value.productCandidates
    : Array.isArray(value.product_candidates) ? value.product_candidates : [])
    .map(normalizeProduct)
    .filter(Boolean);
  const selectedProduct = normalizeProduct(value.selectedProduct || value.selected_product);
  const matchedOrder = value.matchedOrder || value.matched_order;
  return {
    rowIndex: index,
    rowNumber: index + 1,
    status,
    orderNumber: dataBackupText(value.orderNumber, value.order_number, value.postingNumber, value.posting_number),
    matchedOrder: matchedOrder && typeof matchedOrder === 'object' ? {
      orderNumber: dataBackupText(
        matchedOrder.orderNumber,
        matchedOrder.order_number,
        matchedOrder.postingNumber,
        matchedOrder.posting_number,
      ),
      status: dataBackupText(matchedOrder.status),
    } : null,
    productCandidates,
    selectedProduct,
    matchMode: dataBackupText(value.matchMode, value.match_mode),
    values: normalizeFacts(value.values || value.incomingValues || value.incoming_values),
    appliedValues: normalizeFacts(value.appliedValues || value.applied_values),
    errorCode,
    message: errorCode ? getDataBackupErrorMessage(errorCode) : dataBackupText(value.message),
    committed: value.committed === true,
    requiresSelection: status === 'selection_required'
      || (productCandidates.length > 1 && !selectedProduct),
  };
}

export function normalizeHistoricalOrderImportSummary(value = {}, container = {}) {
  const insertRows = dataBackupCount(value.insertRows ?? value.insert);
  const updateRows = dataBackupCount(value.updateRows ?? value.update);
  const unchangedRows = dataBackupCount(value.unchangedRows ?? value.unchanged);
  const selectionRequiredRows = dataBackupCount(
    value.selectionRequiredRows ?? value.selection_required ?? value.selectionRequired,
  );
  const readyRows = dataBackupCount(value.readyRows ?? value.ready ?? value.validRows)
    || insertRows + updateRows + unchangedRows;
  const matchedRows = dataBackupCount(value.matchedRows ?? value.matched)
    || readyRows + selectionRequiredRows;
  const unmatchedRows = dataBackupCount(value.unmatchedRows ?? value.unmatched)
    || dataBackupCount(value.orderNotFoundRows ?? value.orderNotFound)
    + dataBackupCount(value.productUnmatchedRows ?? value.productUnmatched);
  const invalidRows = dataBackupCount(value.invalidRows ?? value.invalid) + dataBackupCount(value.duplicateRows ?? value.duplicate);
  const importedRows = dataBackupCount(value.importedRows ?? value.committed ?? container?.result?.committed);
  const skippedRows = dataBackupCount(value.skippedRows ?? value.skipped ?? container?.result?.skipped)
    || dataBackupCount(value.noDataRows ?? value.noData) + unmatchedRows + invalidRows;
  const totalRows = dataBackupCount(value.totalRows ?? container.rowCount ?? container.row_count)
    || readyRows + selectionRequiredRows + unmatchedRows + invalidRows;
  return {
    totalRows,
    readyRows,
    matchedRows: matchedRows || readyRows + selectionRequiredRows,
    selectionRequiredRows,
    unmatchedRows,
    conflictRows: dataBackupCount(value.conflictRows ?? value.conflict),
    skippedRows,
    invalidRows,
    importedRows,
    failedRows: dataBackupCount(value.failedRows ?? value.failed),
  };
}

export function normalizeHistoricalOrderImportPreview(payload = {}) {
  const value = assertSuccessfulPayload(payload);
  const rows = (Array.isArray(value.rows) ? value.rows : []).map(normalizeOrderImportRow);
  const summary = normalizeHistoricalOrderImportSummary(value.summary, value);
  if (!summary.selectionRequiredRows) {
    summary.selectionRequiredRows = rows.filter((row) => row.requiresSelection).length;
  }
  return {
    importId: dataBackupText(value.importId, value.import_id),
    shopId: dataBackupText(value.shopId, value.shop_id),
    previewFingerprint: dataBackupText(value.previewFingerprint, value.preview_fingerprint),
    sourceType: dataBackupText(value.sourceType, value.source_type, 'historical_order_import'),
    restoreSafety: value.restoreSafety ? {
      writeAllowed: value.restoreSafety.writeAllowed === true,
      errorCode: dataBackupText(value.restoreSafety.errorCode),
    } : null,
    officialLookup: value.officialLookup && typeof value.officialLookup === 'object'
      ? {
          requestedCount: dataBackupCount(value.officialLookup.requestedCount),
          foundCount: dataBackupCount(value.officialLookup.foundCount),
          notFoundCount: dataBackupCount(value.officialLookup.notFoundCount),
          failedCount: dataBackupCount(value.officialLookup.failedCount),
        }
      : null,
    summary,
    rows,
    requiresSelection: summary.selectionRequiredRows > 0 || rows.some((row) => row.requiresSelection),
  };
}

export function normalizeHistoricalOrderImportHistory(payload = {}) {
  const value = assertSuccessfulPayload(payload);
  return (Array.isArray(value.imports) ? value.imports : []).map((record, index) => ({
    id: dataBackupText(record.importId, record.import_id, record.id, `historical-order-${index}`),
    importId: dataBackupText(record.importId, record.import_id, record.id),
    operationType: 'historical-order-import',
    shopId: dataBackupText(record.shopId, record.shop_id),
    fileName: dataBackupText(
      record.fileName,
      record.file_name,
      record.source?.fileName,
      record.source?.file_name,
      '历史订单数据',
    ),
    completedAt: dataBackupText(record.completedAt, record.completed_at, record.createdAt, record.created_at),
    status: dataBackupText(record.status) === 'completed_with_skips' ? 'partial' : dataBackupText(record.status, 'unknown'),
    verified: record.verified === true || record.result?.verified === true,
    summary: normalizeHistoricalOrderImportSummary(record.summary || record, record),
    rowsTruncated: record.rowsTruncated === true || record.rows_truncated === true,
    rows: (Array.isArray(record.rows) ? record.rows : []).map(normalizeOrderImportRow),
  }));
}

export async function preflightHistoricalOrderImport(input = {}, options = {}) {
  const payload = await requestLocalApi('/api/app/historical-order-import/preflight', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 120_000,
    signal: options.signal,
  });
  return normalizeHistoricalOrderImportPreview(payload);
}

export async function confirmHistoricalOrderImport(input = {}, options = {}) {
  const payload = await requestLocalApi('/api/app/historical-order-import/confirm', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 120_000,
    signal: options.signal,
  });
  const value = assertSuccessfulPayload(payload);
  const record = value.import && typeof value.import === 'object' ? value.import : value;
  return {
    importId: dataBackupText(record.importId, record.import_id, input.importId),
    completedAt: dataBackupText(record.completedAt, record.completed_at),
    status: dataBackupText(record.status) === 'completed_with_skips' ? 'partial' : dataBackupText(record.status, 'completed'),
    verified: value.verified === true || record.verified === true || record.result?.verified === true,
    summary: normalizeHistoricalOrderImportSummary(record.summary || value.summary, record),
    rows: (Array.isArray(value.rows) ? value.rows : []).map(normalizeOrderImportRow),
  };
}

export async function getHistoricalOrderImportHistory(shopId, options = {}) {
  const query = `?shopId=${encodeURIComponent(String(shopId || '').trim())}`;
  const payload = await requestLocalApi(`/api/app/historical-order-import/history${query}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs || 30_000,
    signal: options.signal,
  });
  return normalizeHistoricalOrderImportHistory(payload);
}
