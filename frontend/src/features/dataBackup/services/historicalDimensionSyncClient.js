import { requestLocalApi } from '../../../api/localApiClient.js';
import { getDataBackupErrorMessage } from '../lib/dataBackupErrors.js';
import { dataBackupCount, dataBackupText } from '../lib/dataBackupValue.js';

const DIMENSION_FIELDS = Object.freeze(['lengthCm', 'widthCm', 'heightCm', 'weightKg']);

const SOURCE_LABELS = Object.freeze({
  cross_border_bus: '跨境巴士',
  historical_order_import: '历史订单导入',
  manual: '本地人工数据',
  ozon: 'Ozon 当前数据',
});

function assertSuccessfulPayload(payload) {
  if (payload?.ok === true) return payload;
  const code = payload?.error?.code
    || (typeof payload?.error === 'string' && /^[A-Z][A-Z0-9_:-]+$/u.test(payload.error)
      ? payload.error
      : 'HISTORICAL_DIMENSION_SYNC_REQUEST_FAILED');
  const error = new Error(getDataBackupErrorMessage(code));
  error.code = code;
  throw error;
}

function finiteMeasure(value, divisor = 1) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number / divisor : undefined;
}

function normalizeDimensions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const dimensions = {
    lengthCm: finiteMeasure(value.lengthCm ?? value.length_cm),
    widthCm: finiteMeasure(value.widthCm ?? value.width_cm),
    heightCm: finiteMeasure(value.heightCm ?? value.height_cm),
    weightKg: finiteMeasure(value.weightKg ?? value.weight_kg),
  };
  if (dimensions.lengthCm === undefined) {
    dimensions.lengthCm = finiteMeasure(value.lengthMm ?? value.length_mm ?? value.depthMm ?? value.depth_mm, 10);
  }
  if (dimensions.widthCm === undefined) {
    dimensions.widthCm = finiteMeasure(value.widthMm ?? value.width_mm, 10);
  }
  if (dimensions.heightCm === undefined) {
    dimensions.heightCm = finiteMeasure(value.heightMm ?? value.height_mm, 10);
  }
  if (dimensions.weightKg === undefined) {
    dimensions.weightKg = finiteMeasure(value.weightG ?? value.weight_g, 1_000);
  }
  return Object.fromEntries(DIMENSION_FIELDS.flatMap((field) => (
    dimensions[field] === undefined ? [] : [[field, dimensions[field]]]
  )));
}

function normalizeSource(value = {}, fallback = {}) {
  const source = value.source && typeof value.source === 'object' ? value.source : {};
  const changes = Array.isArray(value.changes) ? value.changes : [];
  const sourceTypes = [...new Set(changes
    .map((change) => dataBackupText(change?.sourceType, change?.source_type))
    .filter(Boolean))];
  const sourceNames = [...new Set(changes
    .map((change) => dataBackupText(change?.sourceName, change?.source_name))
    .filter(Boolean))];
  const label = dataBackupText(
    source.label,
    sourceNames.map((name, index) => SOURCE_LABELS[sourceTypes[index]] || name).join(' / '),
    sourceTypes.map((type) => SOURCE_LABELS[type] || type).join(' / '),
    fallback.label,
    '历史订单本地数据',
  );
  return {
    type: dataBackupText(source.type, source.sourceType, source.source_type, sourceTypes[0], fallback.type, 'historical_order_import'),
    importId: dataBackupText(source.importId, source.import_id, value.importId, value.import_id, fallback.importId),
    orderNumber: dataBackupText(
      source.orderNumber,
      source.order_number,
      value.orderNumber,
      value.order_number,
      value.postingNumber,
      value.posting_number,
      fallback.orderNumber,
    ),
    label,
  };
}

function normalizeSyncItem(value = {}, index = 0, context = {}) {
  const product = value.product && typeof value.product === 'object' ? value.product : value;
  const source = normalizeSource(value, context.source);
  const productIdentityId = dataBackupText(
    product.productIdentityId,
    product.product_identity_id,
    value.productIdentityId,
    value.product_identity_id,
  );
  const productId = dataBackupText(product.productId, product.product_id, value.productId, value.product_id);
  const orderNumber = dataBackupText(
    source.orderNumber,
    source.order_number,
    value.orderNumber,
    value.order_number,
  );
  const normalizedReadbackStatus = dataBackupText(
    value.readbackStatus,
    value.readback_status,
    value.readback?.status,
    context.readbackStatus,
    'not_started',
  );
  const readbackVerified = value.readbackVerified === true
    || value.readback_verified === true
    || value.readback?.verified === true
    || context.readbackVerified === true
    || ['verified', 'success', 'completed', 'merged'].includes(normalizedReadbackStatus.toLowerCase());
  const proposedValues = normalizeDimensions(
    value.proposedValues || value.proposed_values || value.proposed || value.newValues || value.new_values || value.after,
  );
  const explicitReadbackValues = normalizeDimensions(
    value.readbackValues || value.readback_values || value.readback?.values || context.readbackValues,
  );
  return {
    selectionKey: dataBackupText(
      value.selectionKey,
      value.selection_key,
      productIdentityId,
      `${orderNumber}:${productId || index}`,
    ),
    productIdentityId,
    productId,
    productName: dataBackupText(product.name, product.productName, product.product_name, productId ? `Ozon 商品 ${productId}` : '未命名商品'),
    orderNumber: dataBackupText(orderNumber, source.orderNumber),
    source,
    currentValues: normalizeDimensions(
      value.currentValues || value.current_values || value.current || value.oldValues || value.old_values || value.before,
    ),
    proposedValues,
    readbackValues: Object.keys(explicitReadbackValues).length
      ? explicitReadbackValues
      : readbackVerified ? proposedValues : {},
    status: dataBackupText(value.status, 'unknown'),
    readbackStatus: normalizedReadbackStatus,
    readbackVerified,
    errorCode: dataBackupText(value.errorCode, value.error_code),
  };
}

function normalizeSummary(value = {}, items = []) {
  return {
    totalProducts: dataBackupCount(value.totalProducts ?? value.total ?? items.length),
    changedProducts: dataBackupCount(value.changedProducts ?? value.changed),
    unchangedProducts: dataBackupCount(value.unchangedProducts ?? value.unchanged),
    invalidProducts: dataBackupCount(value.invalidProducts ?? value.invalid),
    verifiedProducts: dataBackupCount(value.verifiedProducts ?? value.verified),
    failedProducts: dataBackupCount(value.failedProducts ?? value.failed),
  };
}

export function normalizeHistoricalDimensionSyncPreview(payload = {}) {
  const value = assertSuccessfulPayload(payload);
  const sourceItems = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.products)
      ? value.products
      : Array.isArray(value.rows)
        ? value.rows
        : Array.isArray(value.targets) ? value.targets : [];
  const items = sourceItems.map(normalizeSyncItem);
  return {
    operationId: dataBackupText(value.operationId, value.operation_id, value.previewId, value.preview_id),
    previewFingerprint: dataBackupText(value.previewFingerprint, value.preview_fingerprint),
    summary: normalizeSummary(value.summary, items),
    items,
  };
}

export function normalizeHistoricalDimensionSyncResult(payload = {}) {
  const value = assertSuccessfulPayload(payload);
  const readBack = value.readBack && typeof value.readBack === 'object'
    ? value.readBack
    : value.readback && typeof value.readback === 'object' ? value.readback : {};
  const sourceItems = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.products)
      ? value.products
      : Array.isArray(value.rows)
        ? value.rows
        : Array.isArray(value.targets) ? value.targets : [];
  const topReadbackVerified = readBack.verified === true
    || readBack.verification?.ok === true
    || value.readbackVerified === true
    || value.readback_verified === true;
  const readbackStatus = dataBackupText(readBack.status, value.readbackStatus, value.readback_status);
  const items = sourceItems.map((item, index) => normalizeSyncItem(item, index, {
    readbackStatus,
    readbackVerified: topReadbackVerified,
  }));
  const verified = value.verified === true
    || topReadbackVerified
    || (items.length > 0 && items.every((item) => item.readbackVerified));
  return {
    operationId: dataBackupText(value.operationId, value.operation_id, value.previewId, value.preview_id),
    status: dataBackupText(value.status, verified ? 'completed' : 'partial'),
    verified,
    summary: normalizeSummary(value.summary, items),
    items,
  };
}

export async function previewHistoricalDimensionSync(input = {}, options = {}) {
  const payload = await requestLocalApi('/api/products/historical-dimension-sync/preview', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 120_000,
    signal: options.signal,
  });
  return normalizeHistoricalDimensionSyncPreview(payload);
}

export async function confirmHistoricalDimensionSync(input = {}, options = {}) {
  const payload = await requestLocalApi('/api/products/historical-dimension-sync/confirm', {
    method: 'POST',
    body: input,
    timeoutMs: options.timeoutMs || 120_000,
    signal: options.signal,
  });
  return normalizeHistoricalDimensionSyncResult(payload);
}
