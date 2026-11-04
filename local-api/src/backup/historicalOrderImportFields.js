import { createStableHash } from "../utils/stableHash.js";

export const IMPORT_SOURCE_TYPE = 'historical_order_import';

export const DEFAULT_PROFILE_ID = 'default';

export const MAX_IMPORT_ROWS = 20_000;

export const MAX_PREVIEW_ROWS = 200;

export const MONEY_FIELDS = Object.freeze({
  purchaseCostCny: 'purchaseCostMinor',
  crossBorderCostCny: 'crossBorderCostMinor',
  domesticFreightCny: 'domesticFreightMinor',
});

export const MEASURE_FIELDS = Object.freeze({
  lengthCm: Object.freeze({ target: 'lengthMm', factor: 10 }),
  widthCm: Object.freeze({ target: 'widthMm', factor: 10 }),
  heightCm: Object.freeze({ target: 'heightMm', factor: 10 }),
  weightKg: Object.freeze({ target: 'weightG', factor: 1000 }),
});

export const FACT_FIELD_TO_COLUMN = Object.freeze({
  purchaseCostMinor: 'purchase_cost_minor',
  crossBorderCostMinor: 'cross_border_cost_minor',
  domesticFreightMinor: 'domestic_freight_minor',
  packagingCostMinor: 'packaging_cost_minor',
  otherCostMinor: 'other_cost_minor',
  currencyCode: 'currency_code',
  lengthMm: 'length_mm',
  widthMm: 'width_mm',
  heightMm: 'height_mm',
  weightG: 'weight_g',
  sourcePlatform: 'source_platform',
  sourceUrl: 'source_url',
  purchaseOrderNumber: 'purchase_order_number',
  trackingNumber: 'tracking_number',
  note: 'note',
});

export const FACT_FIELDS = Object.freeze(Object.keys(FACT_FIELD_TO_COLUMN));

export const INTERNAL_MONEY_FIELDS = Object.freeze(Object.values(MONEY_FIELDS));

export function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

export function normalizeAlias(value) {
  return normalizeText(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\s_\-（）()【】\[\]：:/.]+/gu, '');
}

export function fail(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

export function normalizeProfileId(value) {
  return normalizeText(value) || DEFAULT_PROFILE_ID;
}

export function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

export function boundedText(value, field, maxLength) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length > maxLength || /[\u0000-\u001F\u007F]/u.test(text)) {
    fail(`HISTORICAL_ORDER_IMPORT_${field.toUpperCase()}_INVALID`);
  }
  return text;
}

export function normalizeIdentifier(value, field) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('HISTORICAL_ORDER_IMPORT_IDENTIFIER_INVALID', { field });
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    fail('HISTORICAL_ORDER_IMPORT_IDENTIFIER_INVALID', { field });
  }
  if (
    !text
    || text === '0'
    || text === '未返回'
    || text.length > 256
    || /[\u0000-\u001F\u007F]/u.test(text)
    || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/u.test(text)
  ) {
    fail('HISTORICAL_ORDER_IMPORT_IDENTIFIER_INVALID', { field });
  }
  return text;
}

export function moneyToMinor(value, field) {
  if (isBlank(value)) return null;
  const text = normalizeText(value).replace(/[￥¥,\s]/gu, '');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) {
    fail('HISTORICAL_ORDER_IMPORT_MONEY_INVALID', { field });
  }
  const [whole, fraction = ''] = text.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor < 0) {
    fail('HISTORICAL_ORDER_IMPORT_MONEY_OUT_OF_RANGE', { field });
  }
  return minor;
}

export function measureToBase(value, field, factor) {
  if (isBlank(value)) return null;
  const text = normalizeText(value).replace(/,/gu, '');
  if (!/^\d+(?:\.\d{1,6})?$/u.test(text)) {
    fail('HISTORICAL_ORDER_IMPORT_MEASURE_INVALID', { field });
  }
  const number = Number(text);
  const base = Math.round(number * factor);
  if (!Number.isFinite(number) || number <= 0 || !Number.isSafeInteger(base) || base <= 0) {
    fail('HISTORICAL_ORDER_IMPORT_MEASURE_MUST_BE_POSITIVE', { field });
  }
  return base;
}

export function minorToAmount(value) {
  return value === null || value === undefined ? null : Number(value) / 100;
}

export function baseToMeasure(value, factor) {
  if (value === null || value === undefined) return null;
  return Number((Number(value) / factor).toFixed(6));
}

export function normalizeCurrency(value) {
  const input = normalizeText(value).toUpperCase();
  if (!input || ['￥', '¥', 'RMB', 'CNH'].includes(input)) return 'CNY';
  if (input !== 'CNY') fail('HISTORICAL_ORDER_IMPORT_CURRENCY_UNSUPPORTED');
  return 'CNY';
}

export function normalizeSourceUrl(value) {
  const text = boundedText(value, 'SOURCE_URL', 2048);
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail('HISTORICAL_ORDER_IMPORT_SOURCE_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail('HISTORICAL_ORDER_IMPORT_SOURCE_URL_INVALID');
  }
  return text;
}

export function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function normalizeFileName(value) {
  return normalizeText(value).split(/[\\/]/u).pop()?.slice(0, 255) || '';
}

export function normalizeFileType(value, fileName = '') {
  const explicit = normalizeText(value).toLocaleLowerCase('en-US').replace(/^\./u, '');
  const inferred = normalizeText(fileName).split('.').pop()?.toLocaleLowerCase('en-US') || '';
  const type = explicit || inferred;
  return ['csv', 'xlsx', 'xls'].includes(type) ? type : '';
}

export function publicPatch(patch = {}) {
  const output = {};
  Object.entries(MONEY_FIELDS).forEach(([publicField, internalField]) => {
    if (Object.prototype.hasOwnProperty.call(patch, internalField)) {
      output[publicField] = minorToAmount(patch[internalField]);
    }
  });
  Object.entries(MEASURE_FIELDS).forEach(([publicField, config]) => {
    if (Object.prototype.hasOwnProperty.call(patch, config.target)) {
      output[publicField] = baseToMeasure(patch[config.target], config.factor);
    }
  });
  ['currencyCode', 'sourcePlatform', 'sourceUrl', 'purchaseOrderNumber', 'trackingNumber', 'note']
    .forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(patch, field)) output[field] = patch[field];
    });
  return output;
}

export function rowToFact(row) {
  if (!row) return null;
  return {
    sourceType: row.source_type,
    purchaseCostMinor: row.purchase_cost_minor ?? null,
    crossBorderCostMinor: row.cross_border_cost_minor ?? null,
    domesticFreightMinor: row.domestic_freight_minor ?? null,
    packagingCostMinor: row.packaging_cost_minor ?? null,
    otherCostMinor: row.other_cost_minor ?? null,
    currencyCode: row.currency_code || 'CNY',
    lengthMm: row.length_mm ?? null,
    widthMm: row.width_mm ?? null,
    heightMm: row.height_mm ?? null,
    weightG: row.weight_g ?? null,
    sourcePlatform: row.source_platform || '',
    sourceUrl: row.source_url || '',
    purchaseOrderNumber: row.purchase_order_number || '',
    trackingNumber: row.tracking_number || '',
    note: row.note || '',
    originImportId: row.origin_import_id || '',
    rowHash: row.row_hash || '',
    observedAt: row.observed_at || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

export function publicCandidate(candidate = {}) {
  return {
    productIdentityId: candidate.productIdentityId || candidate.product_identity_id || '',
    productId: candidate.productId || candidate.product_id || '',
    offerId: candidate.offerId || candidate.offer_id || '',
    sku: candidate.sku || '',
    name: candidate.name || candidate.product_name || '',
  };
}

export function publicFact(row) {
  if (!row) return null;
  return {
    orderNumber: row.posting_number || '',
    orderId: row.order_id || '',
    selectedProduct: publicCandidate(row),
    sourceType: row.source_type || IMPORT_SOURCE_TYPE,
    ...publicPatch(rowToFact(row)),
    originImportId: row.origin_import_id || '',
    updatedAt: row.updated_at || '',
  };
}

export function fieldValuesEqual(left, right) {
  return left === right || (left == null && right == null);
}

export function amountToMinor(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

export function orderSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderKey: row.order_key,
    postingNumber: row.posting_number,
    orderId: row.order_id || '',
    remoteHash: row.remote_hash || '',
    productsHash: createStableHash({ products: row.products_json || '', raw: row.raw_json || '' }),
    updatedAt: row.updated_at || '',
  };
}

export function overrideSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderKey: row.order_key,
    postingNumber: row.posting_number || '',
    sourceCostMinor: amountToMinor(row.source_cost_cny),
    purchasePlatform: row.purchase_platform || '',
    purchaseOrderNumber: row.purchase_order_number || '',
    purchaseOrderUrl: row.purchase_order_url || '',
    note: row.note || '',
    raw: safeJsonParse(row.raw_json, {}),
    updatedAt: row.updated_at || '',
  };
}

export function previewCounters(rows) {
  const counts = {
    insert: 0,
    update: 0,
    unchanged: 0,
    selectionRequired: 0,
    orderNotFound: 0,
    productUnmatched: 0,
    invalid: 0,
    duplicate: 0,
    noData: 0,
  };
  const keys = {
    ready_insert: 'insert',
    ready_update: 'update',
    unchanged: 'unchanged',
    selection_required: 'selectionRequired',
    order_not_found: 'orderNotFound',
    product_unmatched: 'productUnmatched',
    invalid: 'invalid',
    duplicate: 'duplicate',
    no_data: 'noData',
  };
  rows.forEach((row) => {
    const key = keys[row.previewStatus];
    if (key) counts[key] += 1;
  });
  return counts;
}

export function publicPreviewRow(row) {
  const candidateSource = row.candidates_json === undefined ? row.candidates || [] : safeJsonParse(row.candidates_json, []);
  const selected = row.product_identity_id || row.productIdentityId
    ? publicCandidate({
        productIdentityId: row.product_identity_id ?? row.productIdentityId,
        productId: row.product_id ?? row.productId,
        offerId: row.offer_id ?? row.offerId,
        sku: row.sku,
        name: row.product_name ?? row.productName,
      })
    : null;
  return {
    rowIndex: Number(row.row_index ?? row.rowIndex),
    status: row.preview_status ?? row.previewStatus,
    orderNumber: row.posting_number ?? row.orderNumber ?? '',
    matchedOrder: row.posting_number || row.orderNumber
      ? {
          postingNumber: row.posting_number ?? row.orderNumber,
          orderId: row.order_id ?? row.orderId ?? '',
        }
      : null,
    productCandidates: candidateSource.map(publicCandidate),
    selectedProduct: selected,
    matchMode: row.match_mode ?? row.matchMode ?? null,
    values: publicPatch(safeJsonParse(row.normalized_patch_json, row.normalizedPatch || {})),
    appliedValues: publicPatch(safeJsonParse(row.applied_patch_json, row.appliedPatch || {})),
    errorCode: row.error_code ?? row.errorCode ?? null,
    committed: Boolean(row.committed),
  };
}

export function publicRun(row) {
  if (!row) return null;
  return {
    importId: row.import_id,
    shopId: row.shop_id,
    sourceType: row.source_type || IMPORT_SOURCE_TYPE,
    source: { fileName: row.source_file_name || '', fileType: row.source_file_type || '' },
    status: row.status,
    previewFingerprint: row.preview_fingerprint,
    rowCount: Number(row.row_count) || 0,
    summary: {
      insert: Number(row.insert_count) || 0,
      update: Number(row.update_count) || 0,
      unchanged: Number(row.unchanged_count) || 0,
      selectionRequired: Number(row.selection_required_count) || 0,
      orderNotFound: Number(row.order_not_found_count) || 0,
      productUnmatched: Number(row.product_unmatched_count) || 0,
      invalid: Number(row.invalid_count) || 0,
      duplicate: Number(row.duplicate_count) || 0,
      noData: Number(row.no_data_count) || 0,
      committed: Number(row.committed_count) || 0,
      skipped: Number(row.skipped_count) || 0,
    },
    result: safeJsonParse(row.result_summary_json, {}),
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at || null,
    completedAt: row.completed_at || null,
  };
}

export function createStoredPreviewFingerprint(run, rows) {
  return createStableHash({
    importId: run.import_id,
    shopId: run.shop_id,
    shopIncarnation: run.shop_incarnation,
    sourceHash: run.source_hash,
    rows: rows.map((row) => ({
      rowIndex: Number(row.row_index),
      previewStatus: row.preview_status,
      postingNumber: row.posting_number || '',
      productIdentityId: row.product_identity_id || '',
      matchMode: row.match_mode || null,
      candidates: safeJsonParse(row.candidates_json, []),
      normalizedPatch: safeJsonParse(row.normalized_patch_json, {}),
      appliedPatch: safeJsonParse(row.applied_patch_json, {}),
      beforeHash: row.before_hash,
      errorCode: row.error_code || null,
    })),
  });
}
