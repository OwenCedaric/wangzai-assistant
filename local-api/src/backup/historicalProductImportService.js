import { randomUUID } from 'node:crypto';
import { createStableHash, stableStringify } from '../utils/stableHash.js';
import { createHistoricalImportStorage } from './historicalImportStorage.js';

const IMPORT_SOURCE_TYPE = 'historical_import';
const DEFAULT_PROFILE_ID = 'default';
const MAX_IMPORT_ROWS = 20_000;
const MAX_PREVIEW_ROWS = 200;

const IDENTITY_FIELDS = new Set(['productId', 'offerId', 'sku', 'productKey']);
const MONEY_FIELDS = Object.freeze({
  purchaseCostCny: 'purchaseCostMinor',
  crossBorderCostCny: 'crossBorderCostMinor',
  domesticFreightCny: 'domesticFreightMinor',
  packagingCostCny: 'packagingCostMinor',
  otherCostCny: 'otherCostMinor',
});
const PROFILE_FIELD_TO_COLUMN = Object.freeze({
  purchaseCostMinor: 'purchase_cost_minor',
  crossBorderCostMinor: 'cross_border_cost_minor',
  domesticFreightMinor: 'domestic_freight_minor',
  packagingCostMinor: 'packaging_cost_minor',
  otherCostMinor: 'other_cost_minor',
  currencyCode: 'currency_code',
  sourcePlatform: 'source_platform',
  sourceUrl: 'source_url',
  purchaseOrderNumber: 'purchase_order_number',
  trackingNumber: 'tracking_number',
  note: 'note',
});
const BUSINESS_FIELDS = new Set([
  ...Object.keys(MONEY_FIELDS),
  'currencyCode',
  'sourcePlatform',
  'sourceUrl',
  'purchaseOrderNumber',
  'trackingNumber',
  'note',
]);
const INTERNAL_PROFILE_FIELDS = Object.freeze(Object.keys(PROFILE_FIELD_TO_COLUMN));
const INTERNAL_MONEY_FIELDS = Object.freeze(Object.values(MONEY_FIELDS));

const FIELD_ALIASES = new Map();

function alias(field, ...values) {
  [field, ...values].forEach((value) => FIELD_ALIASES.set(normalizeAlias(value), field));
}

alias('productId', 'product_id', 'ozonProductId', 'ozon_product_id', 'Ozon商品ID', '商品ID');
alias('offerId', 'offer_id', 'sellerSku', 'seller_sku', '商家编码', '商家SKU', '货号');
alias('sku', 'ozonSku', 'ozon_sku', 'sku_id', 'Ozon SKU', 'OzonSKU', 'SKU');
alias('productKey', 'product_key', '商品键');
alias('purchaseCostCny', 'purchase_cost_cny', 'sourceCostCny', 'source_cost_cny', '商品成本', '采购成本', '采购单价');
alias('crossBorderCostCny', 'cross_border_cost_cny', 'crossBorderBusFeeCny', '跨境巴士成本', '跨境巴士费用');
alias('domesticFreightCny', 'domestic_freight_cny', '国内运费', '国内物流费');
alias('packagingCostCny', 'packaging_cost_cny', '包装费', '包装成本');
alias('otherCostCny', 'other_cost_cny', '其他成本', '其他费用');
alias('currencyCode', 'currency_code', '币种', '货币');
alias('sourcePlatform', 'source_platform', 'platform', '货源平台', '采购平台');
alias('sourceUrl', 'source_url', 'url', 'link', '货源链接', '采购链接');
alias('purchaseOrderNumber', 'purchase_order_number', '采购单号', '采购订单号');
alias('trackingNumber', 'tracking_number', '运单号', '物流单号');
alias('note', 'remark', 'memo', '备注');

function fail(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeAlias(value) {
  return normalizeText(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\s_\-（）()]+/gu, '');
}

function normalizeProfileId(value) {
  return normalizeText(value) || DEFAULT_PROFILE_ID;
}

function normalizeConflictMode(value) {
  const mode = normalizeText(value).toLocaleLowerCase('en-US') || 'preserve';
  if (mode !== 'preserve' && mode !== 'overwrite') {
    fail('HISTORICAL_IMPORT_CONFLICT_MODE_INVALID');
  }
  return mode;
}

function normalizeFileName(value) {
  const name = normalizeText(value).split(/[\\/]/u).pop() || '';
  return name.slice(0, 255);
}

function normalizeFileType(value, fileName = '') {
  const explicit = normalizeText(value).toLocaleLowerCase('en-US').replace(/^\./u, '');
  const inferred = normalizeText(fileName).split('.').pop()?.toLocaleLowerCase('en-US') || '';
  const type = explicit || inferred;
  return ['csv', 'xlsx', 'xls'].includes(type) ? type : '';
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function boundedText(value, field, maxLength) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length > maxLength) fail(`HISTORICAL_IMPORT_${field.toUpperCase()}_TOO_LONG`);
  return text;
}

function normalizeIdentityValue(value, field) {
  let text;
  if (typeof value === 'string') {
    text = value.trim();
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('HISTORICAL_IMPORT_IDENTITY_VALUE_INVALID', { field });
    }
    text = String(value);
  } else {
    fail('HISTORICAL_IMPORT_IDENTITY_VALUE_INVALID', { field });
  }
  if (
    !text
    || text.length > 256
    || /[\u0000-\u001F\u007F]/u.test(text)
    || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/u.test(text)
  ) {
    fail('HISTORICAL_IMPORT_IDENTITY_VALUE_INVALID', { field });
  }
  if ((field === 'productId' || field === 'sku') && !/^\d+$/u.test(text)) {
    fail('HISTORICAL_IMPORT_IDENTITY_VALUE_INVALID', { field });
  }
  return text;
}

function moneyToMinor(value, field) {
  if (isBlank(value)) return null;
  const text = normalizeText(value).replace(/[￥¥,\s]/gu, '');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) {
    fail('HISTORICAL_IMPORT_MONEY_INVALID', { field });
  }
  const [whole, fraction = ''] = text.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor < 0) {
    fail('HISTORICAL_IMPORT_MONEY_OUT_OF_RANGE', { field });
  }
  return minor;
}

function minorToAmount(value) {
  return value === null || value === undefined ? null : Number(value) / 100;
}

function normalizeCurrency(value) {
  const input = normalizeText(value).toUpperCase();
  if (!input || ['￥', '¥', 'RMB', 'CNH'].includes(input)) return 'CNY';
  if (!/^[A-Z]{3}$/u.test(input)) fail('HISTORICAL_IMPORT_CURRENCY_INVALID');
  if (input !== 'CNY') fail('HISTORICAL_IMPORT_CURRENCY_UNSUPPORTED');
  return 'CNY';
}

function normalizeSourceUrl(value) {
  const text = boundedText(value, 'SOURCE_URL', 2048);
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail('HISTORICAL_IMPORT_SOURCE_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail('HISTORICAL_IMPORT_SOURCE_URL_INVALID');
  }
  return text;
}

function canonicalField(value) {
  return FIELD_ALIASES.get(normalizeAlias(value)) || '';
}

function normalizeColumns(value) {
  const entries = Array.isArray(value) ? value : [];
  const output = [];
  const sourceHeaders = new Set();
  const targets = new Set();
  entries.forEach((entry) => {
    const sourceHeader = normalizeText(
      typeof entry === 'string' ? entry : entry?.sourceHeader ?? entry?.source_header ?? entry?.header ?? entry?.name,
    );
    const field = canonicalField(typeof entry === 'string' ? entry : entry?.field ?? entry?.targetField ?? entry?.target_field);
    // Unknown target columns are deliberately ignored and never reach staging.
    if (!sourceHeader || !field) return;
    if (sourceHeaders.has(sourceHeader) || targets.has(field)) {
      fail('HISTORICAL_IMPORT_COLUMN_MAPPING_DUPLICATE');
    }
    sourceHeaders.add(sourceHeader);
    targets.add(field);
    output.push({ sourceHeader, field });
  });
  return output;
}

function mappedRow(rawRow, columns) {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    fail('HISTORICAL_IMPORT_ROW_INVALID');
  }
  const result = {};
  if (columns.length) {
    columns.forEach(({ sourceHeader, field }) => {
      // The renderer normalizes workbook cells to canonical field names but
      // keeps sourceHeader in columns for audit/review. Prefer that canonical
      // value, while still accepting raw source-header rows from direct API
      // clients and older importers.
      if (Object.prototype.hasOwnProperty.call(rawRow, field)) {
        result[field] = rawRow[field];
      } else if (Object.prototype.hasOwnProperty.call(rawRow, sourceHeader)) {
        result[field] = rawRow[sourceHeader];
      }
    });
    return result;
  }
  Object.entries(rawRow).forEach(([key, value]) => {
    const field = canonicalField(key);
    if (field && !Object.prototype.hasOwnProperty.call(result, field)) result[field] = value;
  });
  return result;
}

function normalizeInputRow(rawRow, columns) {
  const mapped = mappedRow(rawRow, columns);
  const identity = {};
  const patch = {};
  for (const [field, value] of Object.entries(mapped)) {
    if (isBlank(value)) continue;
    if (IDENTITY_FIELDS.has(field)) {
      identity[field] = normalizeIdentityValue(value, field);
      continue;
    }
    if (!BUSINESS_FIELDS.has(field)) continue;
    if (Object.prototype.hasOwnProperty.call(MONEY_FIELDS, field)) {
      patch[MONEY_FIELDS[field]] = moneyToMinor(value, field);
      continue;
    }
    if (field === 'currencyCode') patch.currencyCode = normalizeCurrency(value);
    else if (field === 'sourceUrl') patch.sourceUrl = normalizeSourceUrl(value);
    else if (field === 'note') patch.note = boundedText(value, field, 2000);
    else patch[field] = boundedText(value, field, 500);
  }
  if (INTERNAL_MONEY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(patch, field))) {
    patch.currencyCode = normalizeCurrency(patch.currencyCode || 'CNY');
  }
  return { identity, patch };
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    sourceType: row.source_type,
    purchaseCostMinor: row.purchase_cost_minor ?? null,
    crossBorderCostMinor: row.cross_border_cost_minor ?? null,
    domesticFreightMinor: row.domestic_freight_minor ?? null,
    packagingCostMinor: row.packaging_cost_minor ?? null,
    otherCostMinor: row.other_cost_minor ?? null,
    currencyCode: row.currency_code || 'CNY',
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

function publicProfile(profile, identity = {}) {
  if (!profile) return null;
  return {
    ...identity,
    sourceType: profile.sourceType || IMPORT_SOURCE_TYPE,
    purchaseCostCny: minorToAmount(profile.purchaseCostMinor),
    crossBorderCostCny: minorToAmount(profile.crossBorderCostMinor),
    domesticFreightCny: minorToAmount(profile.domesticFreightMinor),
    packagingCostCny: minorToAmount(profile.packagingCostMinor),
    otherCostCny: minorToAmount(profile.otherCostMinor),
    currencyCode: profile.currencyCode || 'CNY',
    sourcePlatform: profile.sourcePlatform || '',
    sourceUrl: profile.sourceUrl || '',
    purchaseOrderNumber: profile.purchaseOrderNumber || '',
    trackingNumber: profile.trackingNumber || '',
    note: profile.note || '',
    originImportId: profile.originImportId || '',
    updatedAt: profile.updatedAt || '',
  };
}

function publicPatch(patch = {}) {
  return {
    ...(Object.prototype.hasOwnProperty.call(patch, 'purchaseCostMinor')
      ? { purchaseCostCny: minorToAmount(patch.purchaseCostMinor) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'crossBorderCostMinor')
      ? { crossBorderCostCny: minorToAmount(patch.crossBorderCostMinor) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'domesticFreightMinor')
      ? { domesticFreightCny: minorToAmount(patch.domesticFreightMinor) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'packagingCostMinor')
      ? { packagingCostCny: minorToAmount(patch.packagingCostMinor) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'otherCostMinor')
      ? { otherCostCny: minorToAmount(patch.otherCostMinor) }
      : {}),
    ...Object.fromEntries(
      ['currencyCode', 'sourcePlatform', 'sourceUrl', 'purchaseOrderNumber', 'trackingNumber', 'note']
        .filter((field) => Object.prototype.hasOwnProperty.call(patch, field))
        .map((field) => [field, patch[field]]),
    ),
  };
}

function fieldHasValue(profile, field) {
  if (!profile) return false;
  if (INTERNAL_MONEY_FIELDS.includes(field)) return profile[field] !== null && profile[field] !== undefined;
  if (field === 'currencyCode') {
    return INTERNAL_MONEY_FIELDS.some((moneyField) => fieldHasValue(profile, moneyField));
  }
  return normalizeText(profile[field]) !== '';
}

function fieldValuesEqual(left, right) {
  return left === right || (left == null && right == null);
}

function buildDecision({ existing, incoming, conflictMode }) {
  const manual = existing.manual;
  const historical = existing.historical;
  const applied = {};
  const conflicts = [];
  const incomingMoneyFields = INTERNAL_MONEY_FIELDS.filter((field) => (
    Object.prototype.hasOwnProperty.call(incoming, field)
  ));
  const incompatibleCurrencyProfile = [manual, historical].find((profile) => (
    profile
    && INTERNAL_MONEY_FIELDS.some((field) => fieldHasValue(profile, field))
    && normalizeText(profile.currencyCode).toUpperCase() !== 'CNY'
  ));
  const currencyBlockedFields = incompatibleCurrencyProfile
    ? new Set([...incomingMoneyFields, 'currencyCode'])
    : new Set();
  for (const [field, incomingValue] of Object.entries(incoming)) {
    if (currencyBlockedFields.has(field)) {
      conflicts.push({ field, reason: 'existing_currency_incompatible' });
      continue;
    }
    if (fieldHasValue(manual, field)) {
      if (!fieldValuesEqual(manual[field], incomingValue)) {
        conflicts.push({ field, reason: 'manual_value_has_priority' });
      }
      continue;
    }
    if (!fieldHasValue(historical, field)) {
      applied[field] = incomingValue;
      continue;
    }
    if (fieldValuesEqual(historical[field], incomingValue)) continue;
    if (conflictMode === 'overwrite') applied[field] = incomingValue;
    else conflicts.push({ field, reason: 'existing_value_preserved' });
  }
  return { applied, conflicts };
}

function mergeProfile(profile, patch, identity, sourceType = IMPORT_SOURCE_TYPE) {
  return {
    sourceType,
    purchaseCostMinor: profile?.purchaseCostMinor ?? null,
    crossBorderCostMinor: profile?.crossBorderCostMinor ?? null,
    domesticFreightMinor: profile?.domesticFreightMinor ?? null,
    packagingCostMinor: profile?.packagingCostMinor ?? null,
    otherCostMinor: profile?.otherCostMinor ?? null,
    currencyCode: profile?.currencyCode || 'CNY',
    sourcePlatform: profile?.sourcePlatform || '',
    sourceUrl: profile?.sourceUrl || '',
    purchaseOrderNumber: profile?.purchaseOrderNumber || '',
    trackingNumber: profile?.trackingNumber || '',
    note: profile?.note || '',
    ...patch,
    productKey: identity.productKey,
    productId: identity.productId || '',
    offerId: identity.offerId || '',
    sku: identity.sku || '',
  };
}

function snapshotHash(snapshot) {
  return createStableHash({ manual: snapshot.manual, historical: snapshot.historical });
}

function publicPreviewRow(row) {
  return {
    rowIndex: Number(row.row_index ?? row.rowIndex),
    status: row.preview_status ?? row.previewStatus,
    identity: safeJsonParse(row.identity_json, row.identity || {}),
    matchedProduct: row.product_key || row.productKey
      ? {
          productKey: row.product_key ?? row.productKey,
          productId: row.product_id ?? row.productId ?? '',
          offerId: row.offer_id ?? row.offerId ?? '',
          sku: row.sku ?? '',
        }
      : null,
    values: publicPatch(safeJsonParse(row.normalized_patch_json, row.normalizedPatch || {})),
    appliedValues: publicPatch(safeJsonParse(row.applied_patch_json, row.appliedPatch || {})),
    conflicts: safeJsonParse(row.conflicts_json, row.conflicts || []),
    errorCode: row.error_code ?? row.errorCode ?? null,
    committed: Boolean(row.committed),
  };
}

function publicRun(row) {
  if (!row) return null;
  return {
    importId: row.import_id,
    shopId: row.shop_id,
    source: {
      fileName: row.source_file_name || '',
      fileType: row.source_file_type || '',
    },
    conflictMode: row.conflict_mode,
    status: row.status,
    previewFingerprint: row.preview_fingerprint,
    rowCount: Number(row.row_count) || 0,
    summary: {
      insert: Number(row.insert_count) || 0,
      update: Number(row.update_count) || 0,
      unchanged: Number(row.unchanged_count) || 0,
      conflict: Number(row.conflict_count) || 0,
      unmatched: Number(row.unmatched_count) || 0,
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

function previewCounters(rows) {
  const counts = {
    insert: 0,
    update: 0,
    unchanged: 0,
    conflict: 0,
    unmatched: 0,
    invalid: 0,
    duplicate: 0,
    noData: 0,
  };
  rows.forEach((row) => {
    const key = {
      ready_insert: 'insert',
      ready_update: 'update',
      unchanged: 'unchanged',
      conflict: 'conflict',
      unmatched: 'unmatched',
      invalid: 'invalid',
      duplicate: 'duplicate',
      no_data: 'noData',
    }[row.previewStatus];
    if (key) counts[key] += 1;
  });
  return counts;
}

function createStoredPreviewFingerprint(run, rows) {
  return createStableHash({
    importId: run.import_id,
    shopId: run.shop_id,
    shopIncarnation: run.shop_incarnation,
    conflictMode: run.conflict_mode,
    sourceHash: run.source_hash,
    rows: rows.map((row) => ({
      rowIndex: Number(row.row_index),
      previewStatus: row.preview_status,
      productKey: row.product_key || '',
      normalizedPatch: safeJsonParse(row.normalized_patch_json, {}),
      appliedPatch: safeJsonParse(row.applied_patch_json, {}),
      conflicts: safeJsonParse(row.conflicts_json, []),
      beforeHash: row.before_hash,
      errorCode: row.error_code || null,
    })),
  });
}

export function createHistoricalProductImportService({
  db,
  storageAdapter,
  profileId = DEFAULT_PROFILE_ID,
  now = () => new Date(),
  createImportId = () => `historical_import_${randomUUID()}`,
  assertShopWritable = () => undefined,
  invalidateProductCache = () => undefined,
} = {}) {
  if (!db) throw new Error('createHistoricalProductImportService requires db.');
  const scopedProfileId = normalizeProfileId(profileId);
  const storage = createHistoricalImportStorage({ db, storageAdapter, safetyErrorCode: 'HISTORICAL_IMPORT_SAFE_RESTORE_REQUIRED' });

  const selectShop = db.prepare(`
    SELECT id, profile_id, shop_incarnation, status, disabled_at
    FROM shops WHERE id = ? LIMIT 1
  `);
  const identityBase = `
    SELECT identity.product_identity_id, identity.shop_id, identity.product_id,
           identity.offer_id, identity.sku, legacy.product_key
    FROM product_identities AS identity
    LEFT JOIN ozon_products AS legacy
      ON legacy.id = identity.product_identity_id AND legacy.shop_id = identity.shop_id
  `;
  const selectIdentityByProductId = storage.statement('product-identities', `${identityBase} WHERE identity.shop_id = ? AND identity.product_id = ?`);
  const selectIdentityByOfferId = storage.statement('product-identities', `${identityBase} WHERE identity.shop_id = ? AND identity.offer_id = ?`);
  const selectIdentityBySku = storage.statement('product-identities', `${identityBase} WHERE identity.shop_id = ? AND identity.sku = ?`);
  const selectIdentityByProductKey = storage.statement('product-identities', `${identityBase} WHERE identity.shop_id = ? AND legacy.product_key = ?`);
  const selectCostProfiles = storage.statement('product-manual-cost-profiles', `
    SELECT * FROM product_manual_cost_profiles
    WHERE shop_id = ? AND product_key = ?
    ORDER BY CASE source_type WHEN 'manual' THEN 0 ELSE 1 END
  `);
  const selectRun = db.prepare('SELECT * FROM historical_import_runs WHERE import_id = ? LIMIT 1');
  const selectRunRows = db.prepare('SELECT * FROM historical_import_rows WHERE import_id = ? ORDER BY row_index');
  const selectRunRowsForPublic = db.prepare(`
    SELECT * FROM historical_import_rows
    WHERE import_id = ? ORDER BY row_index LIMIT ?
  `);

  function timestampNow() {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  function requireShop(shopIdInput, { writable = true } = {}) {
    const shopId = normalizeText(shopIdInput);
    if (!shopId) fail('HISTORICAL_IMPORT_SHOP_ID_REQUIRED');
    if (writable) assertShopWritable(shopId);
    const shop = selectShop.get(shopId);
    if (!shop) fail('HISTORICAL_IMPORT_SHOP_NOT_FOUND');
    if (normalizeProfileId(shop.profile_id) !== scopedProfileId) fail('HISTORICAL_IMPORT_SHOP_SCOPE_FORBIDDEN');
    if (!normalizeText(shop.shop_incarnation)) fail('HISTORICAL_IMPORT_SHOP_INCARNATION_REQUIRED');
    if (shop.status === 'disabled' || shop.disabled_at) fail('HISTORICAL_IMPORT_SHOP_DISABLED');
    return shop;
  }

  function resolveIdentity(shopId, input = {}) {
    const provided = Object.entries(input).filter(([, value]) => normalizeText(value));
    if (!provided.length) {
      return { ok: false, kind: 'invalid', code: 'HISTORICAL_IMPORT_IDENTITY_REQUIRED' };
    }
    const resolved = [];
    for (const [field, value] of provided) {
      const text = normalizeText(value);
      const rows = field === 'productId'
        ? selectIdentityByProductId.all(shopId, text)
        : field === 'offerId'
          ? selectIdentityByOfferId.all(shopId, text)
          : field === 'sku'
            ? selectIdentityBySku.all(shopId, text)
            : field === 'productKey'
              ? selectIdentityByProductKey.all(shopId, text)
              : [];
      if (!rows.length) {
        return { ok: false, kind: 'unmatched', code: 'HISTORICAL_IMPORT_PRODUCT_NOT_FOUND' };
      }
      if (rows.length > 1) {
        return { ok: false, kind: 'invalid', code: 'HISTORICAL_IMPORT_PRODUCT_IDENTITY_AMBIGUOUS' };
      }
      resolved.push(rows[0]);
    }
    const ids = new Set(resolved.map((row) => row.product_identity_id));
    if (ids.size !== 1) {
      return { ok: false, kind: 'invalid', code: 'HISTORICAL_IMPORT_PRODUCT_IDENTITY_CONFLICT' };
    }
    const row = resolved[0];
    const productKey = normalizeText(row.product_key)
      || (row.product_id ? `product:${row.product_id}` : row.offer_id ? `offer:${row.offer_id}` : `sku:${row.sku}`);
    return {
      ok: true,
      identity: {
        productIdentityId: row.product_identity_id,
        productKey,
        productId: row.product_id || '',
        offerId: row.offer_id || '',
        sku: row.sku || '',
      },
    };
  }

  function readExisting(shopId, productKey) {
    const rows = selectCostProfiles.all(shopId, productKey);
    return {
      manual: rowToProfile(rows.find((row) => row.source_type === 'manual')),
      historical: rowToProfile(rows.find((row) => row.source_type === IMPORT_SOURCE_TYPE)),
    };
  }

  function buildPreviewRow(shopId, rawRow, columns, rowIndex, conflictMode, seenProducts) {
    const base = {
      rowIndex,
      shopId,
      previewStatus: 'invalid',
      productKey: '',
      productId: '',
      offerId: '',
      sku: '',
      identity: {},
      normalizedPatch: {},
      appliedPatch: {},
      conflicts: [],
      before: { manual: null, historical: null },
      beforeHash: createStableHash({}),
      errorCode: null,
    };
    let normalized;
    try {
      normalized = normalizeInputRow(rawRow, columns);
    } catch (error) {
      return { ...base, errorCode: error?.code || 'HISTORICAL_IMPORT_ROW_INVALID' };
    }
    base.identity = normalized.identity;
    base.normalizedPatch = normalized.patch;
    if (!Object.keys(normalized.patch).length) {
      return { ...base, previewStatus: 'no_data', errorCode: 'HISTORICAL_IMPORT_ROW_NO_DATA' };
    }
    const resolution = resolveIdentity(shopId, normalized.identity);
    if (!resolution.ok) {
      return {
        ...base,
        previewStatus: resolution.kind === 'unmatched' ? 'unmatched' : 'invalid',
        errorCode: resolution.code,
      };
    }
    Object.assign(base, resolution.identity);
    if (seenProducts.has(base.productKey)) {
      return { ...base, previewStatus: 'duplicate', errorCode: 'HISTORICAL_IMPORT_PRODUCT_DUPLICATE' };
    }
    seenProducts.add(base.productKey);
    const existing = readExisting(shopId, base.productKey);
    base.before = existing;
    base.beforeHash = snapshotHash(existing);
    const decision = buildDecision({ existing, incoming: normalized.patch, conflictMode });
    base.appliedPatch = decision.applied;
    base.conflicts = decision.conflicts;
    if (decision.conflicts.length) base.previewStatus = 'conflict';
    else if (!Object.keys(decision.applied).length) base.previewStatus = 'unchanged';
    else base.previewStatus = existing.historical ? 'ready_update' : 'ready_insert';
    return base;
  }

  function insertPreview(run, rows) {
    const insertRun = db.prepare(`
      INSERT INTO historical_import_runs (
        import_id, shop_id, shop_incarnation, source_file_name, source_file_type,
        source_hash, columns_json, conflict_mode, status, preview_fingerprint,
        row_count, insert_count, update_count, unchanged_count, conflict_count,
        unmatched_count, invalid_count, duplicate_count, no_data_count,
        result_summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `);
    const insertRow = db.prepare(`
      INSERT INTO historical_import_rows (
        import_id, row_index, shop_id, preview_status, product_key, product_id,
        offer_id, sku, identity_json, normalized_patch_json, applied_patch_json,
        conflicts_json, before_json, before_hash, error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      insertRun.run(
        run.importId,
        run.shopId,
        run.shopIncarnation,
        run.source.fileName || null,
        run.source.fileType || null,
        run.sourceHash,
        stableStringify(run.columns),
        run.conflictMode,
        run.previewFingerprint,
        rows.length,
        run.summary.insert,
        run.summary.update,
        run.summary.unchanged,
        run.summary.conflict,
        run.summary.unmatched,
        run.summary.invalid,
        run.summary.duplicate,
        run.summary.noData,
        run.createdAt,
        run.createdAt,
      );
      rows.forEach((row) => insertRow.run(
        run.importId,
        row.rowIndex,
        run.shopId,
        row.previewStatus,
        row.productKey || null,
        row.productId || null,
        row.offerId || null,
        row.sku || null,
        stableStringify(row.identity),
        stableStringify(row.normalizedPatch),
        stableStringify(row.appliedPatch),
        stableStringify(row.conflicts),
        stableStringify(row.before),
        row.beforeHash,
        row.errorCode,
        run.createdAt,
        run.createdAt,
      ));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function preflight(input = {}) {
    const shop = requireShop(input.shopId ?? input.shop_id);
    const conflictMode = normalizeConflictMode(input.conflictMode ?? input.conflict_mode);
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!rows.length) fail('HISTORICAL_IMPORT_ROWS_REQUIRED');
    if (rows.length > MAX_IMPORT_ROWS) fail('HISTORICAL_IMPORT_ROWS_LIMIT_EXCEEDED');
    const columns = normalizeColumns(input.columns ?? input.mapping);
    const sourceInput = input.source && typeof input.source === 'object' && !Array.isArray(input.source)
      ? input.source
      : {};
    const source = {
      fileName: normalizeFileName(sourceInput.fileName ?? sourceInput.file_name ?? input.fileName ?? input.file_name),
      fileType: '',
    };
    source.fileType = normalizeFileType(
      sourceInput.fileType ?? sourceInput.file_type ?? input.fileType ?? input.file_type,
      source.fileName,
    );
    const seenProducts = new Set();
    const previewRows = rows.map((row, index) => (
      buildPreviewRow(shop.id, row, columns, index, conflictMode, seenProducts)
    ));
    const summary = previewCounters(previewRows);
    const importId = normalizeText(createImportId());
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,180}$/u.test(importId)) {
      fail('HISTORICAL_IMPORT_ID_INVALID');
    }
    const createdAt = timestampNow();
    const sourceHash = createStableHash({ source, columns, rows });
    const fingerprintPayload = {
      importId,
      shopId: shop.id,
      shopIncarnation: shop.shop_incarnation,
      conflictMode,
      sourceHash,
      rows: previewRows.map((row) => ({
        rowIndex: row.rowIndex,
        previewStatus: row.previewStatus,
        productKey: row.productKey,
        normalizedPatch: row.normalizedPatch,
        appliedPatch: row.appliedPatch,
        conflicts: row.conflicts,
        beforeHash: row.beforeHash,
        errorCode: row.errorCode,
      })),
    };
    const previewFingerprint = createStableHash(fingerprintPayload);
    const run = {
      importId,
      shopId: shop.id,
      shopIncarnation: shop.shop_incarnation,
      source,
      sourceHash,
      columns,
      conflictMode,
      previewFingerprint,
      summary,
      createdAt,
    };
    insertPreview(run, previewRows);
    return {
      ok: true,
      mode: 'staging-preview',
      importId,
      shopId: shop.id,
      conflictMode,
      source,
      previewFingerprint,
      rowCount: previewRows.length,
      rowsTruncated: previewRows.length > MAX_PREVIEW_ROWS,
      summary,
      restoreSafety: storage.safety(shop.id, previewRows.some((row) => Object.keys(row.appliedPatch || {}).length)
        ? ['product-manual-cost-profiles'] : []),
      rows: previewRows.slice(0, MAX_PREVIEW_ROWS).map((row) => publicPreviewRow(row)),
    };
  }

  function writeHistoricalProfile(shopId, identity, appliedPatch, importId, timestamp) {
    const currentRows = selectCostProfiles.all(shopId, identity.productKey);
    const currentRow = currentRows.find((row) => row.source_type === IMPORT_SOURCE_TYPE) || null;
    const current = rowToProfile(currentRow);
    const next = mergeProfile(current, appliedPatch, identity);
    const rowHash = createStableHash({
      shopId,
      productKey: identity.productKey,
      sourceType: IMPORT_SOURCE_TYPE,
      ...Object.fromEntries(INTERNAL_PROFILE_FIELDS.map((field) => [field, next[field] ?? null])),
    });
    const id = currentRow?.id || `manual_cost:${createStableHash({ shopId, productKey: identity.productKey, sourceType: IMPORT_SOURCE_TYPE }, { length: 32 })}`;
    storage.databaseFor('product-manual-cost-profiles', shopId).prepare(`
      INSERT INTO product_manual_cost_profiles (
        id, shop_id, product_key, product_id, offer_id, sku, source_type,
        purchase_cost_minor, cross_border_cost_minor, domestic_freight_minor,
        packaging_cost_minor, other_cost_minor, currency_code, source_platform,
        source_url, purchase_order_number, tracking_number, note, origin_import_id,
        row_hash, observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, product_key, source_type) DO UPDATE SET
        product_id = COALESCE(excluded.product_id, product_manual_cost_profiles.product_id),
        offer_id = COALESCE(excluded.offer_id, product_manual_cost_profiles.offer_id),
        sku = COALESCE(excluded.sku, product_manual_cost_profiles.sku),
        purchase_cost_minor = excluded.purchase_cost_minor,
        cross_border_cost_minor = excluded.cross_border_cost_minor,
        domestic_freight_minor = excluded.domestic_freight_minor,
        packaging_cost_minor = excluded.packaging_cost_minor,
        other_cost_minor = excluded.other_cost_minor,
        currency_code = excluded.currency_code,
        source_platform = excluded.source_platform,
        source_url = excluded.source_url,
        purchase_order_number = excluded.purchase_order_number,
        tracking_number = excluded.tracking_number,
        note = excluded.note,
        origin_import_id = excluded.origin_import_id,
        row_hash = excluded.row_hash,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `).run(
      id,
      shopId,
      identity.productKey,
      identity.productId || null,
      identity.offerId || null,
      identity.sku || null,
      IMPORT_SOURCE_TYPE,
      next.purchaseCostMinor,
      next.crossBorderCostMinor,
      next.domesticFreightMinor,
      next.packagingCostMinor,
      next.otherCostMinor,
      next.currencyCode || 'CNY',
      next.sourcePlatform || null,
      next.sourceUrl || null,
      next.purchaseOrderNumber || null,
      next.trackingNumber || null,
      next.note || null,
      importId,
      rowHash,
      timestamp,
      currentRow?.created_at || timestamp,
      timestamp,
    );
    const saved = rowToProfile(
      selectCostProfiles.all(shopId, identity.productKey)
        .find((row) => row.source_type === IMPORT_SOURCE_TYPE),
    );
    for (const [field, expected] of Object.entries(appliedPatch)) {
      if (!fieldValuesEqual(saved?.[field], expected)) fail('HISTORICAL_IMPORT_READBACK_MISMATCH');
    }
    return saved;
  }

  function confirm(input = {}) {
    const shop = requireShop(input.shopId ?? input.shop_id);
    const importId = normalizeText(input.importId ?? input.import_id);
    const previewFingerprint = normalizeText(input.previewFingerprint ?? input.preview_fingerprint);
    const conflictMode = normalizeConflictMode(input.conflictMode ?? input.conflict_mode);
    if (!importId) fail('HISTORICAL_IMPORT_ID_REQUIRED');
    if (!/^[a-f0-9]{64}$/u.test(previewFingerprint)) fail('HISTORICAL_IMPORT_PREVIEW_FINGERPRINT_REQUIRED');
    const initialRun = selectRun.get(importId);
    if (!initialRun) fail('HISTORICAL_IMPORT_NOT_FOUND');
    if (initialRun.shop_id !== shop.id) fail('HISTORICAL_IMPORT_SHOP_SCOPE_MISMATCH');
    if (initialRun.preview_fingerprint !== previewFingerprint) fail('HISTORICAL_IMPORT_PREVIEW_STALE');
    if (initialRun.conflict_mode !== conflictMode) fail('HISTORICAL_IMPORT_CONFLICT_MODE_MISMATCH');
    if (initialRun.status === 'completed' || initialRun.status === 'completed_with_skips') {
      const publicImport = publicRun(initialRun);
      const publicRows = selectRunRowsForPublic.all(importId, MAX_PREVIEW_ROWS);
      return {
        ok: true,
        verified: publicImport.result?.verified === true,
        idempotent: true,
        importId,
        previewFingerprint,
        summary: publicImport.summary,
        import: publicImport,
        rowCount: publicImport.rowCount,
        rowsTruncated: publicImport.rowCount > MAX_PREVIEW_ROWS,
        rows: publicRows.map(publicPreviewRow),
      };
    }
    if (initialRun.status !== 'previewed') fail('HISTORICAL_IMPORT_NOT_CONFIRMABLE');

    const timestamp = timestampNow();
    let committedCount = 0;
    let skippedCount = 0;
    const writtenDomains = selectRunRows.all(importId).some((row) => Object.keys(safeJsonParse(row.applied_patch_json, {})).length)
      ? ['product-manual-cost-profiles'] : [];
    const session = storage.openConfirmation(shop.id, writtenDomains);
    try {
      db.exec('BEGIN IMMEDIATE');
      const run = selectRun.get(importId);
      const currentShop = selectShop.get(shop.id);
      if (!run || run.status !== 'previewed') fail('HISTORICAL_IMPORT_NOT_CONFIRMABLE');
      if (run.preview_fingerprint !== previewFingerprint) fail('HISTORICAL_IMPORT_PREVIEW_STALE');
      if (!currentShop || currentShop.shop_incarnation !== run.shop_incarnation) {
        fail('HISTORICAL_IMPORT_SHOP_INCARNATION_STALE');
      }
      const rows = selectRunRows.all(importId);
      if (createStoredPreviewFingerprint(run, rows) !== run.preview_fingerprint) {
        fail('HISTORICAL_IMPORT_PREVIEW_STALE');
      }
      const updateRow = db.prepare(`
        UPDATE historical_import_rows
        SET committed = ?, after_json = ?, result_hash = ?, updated_at = ?
        WHERE import_id = ? AND row_index = ?
      `);
      for (const row of rows) {
        const matchedStatus = ['ready_insert', 'ready_update', 'unchanged', 'conflict'].includes(row.preview_status);
        if (matchedStatus && row.product_key) {
          const current = readExisting(shop.id, row.product_key);
          if (snapshotHash(current) !== row.before_hash) fail('HISTORICAL_IMPORT_PREVIEW_STALE');
        }
        const appliedPatch = safeJsonParse(row.applied_patch_json, {});
        if (!row.product_key || !Object.keys(appliedPatch).length) {
          skippedCount += 1;
          updateRow.run(0, null, null, timestamp, importId, row.row_index);
          continue;
        }
        const identity = {
          productKey: row.product_key,
          productId: row.product_id || '',
          offerId: row.offer_id || '',
          sku: row.sku || '',
        };
        const saved = writeHistoricalProfile(shop.id, identity, appliedPatch, importId, timestamp);
        const afterJson = stableStringify(saved);
        const resultHash = createStableHash(saved);
        updateRow.run(1, afterJson, resultHash, timestamp, importId, row.row_index);
        committedCount += 1;
      }
      const status = skippedCount > 0 ? 'completed_with_skips' : 'completed';
      const resultSummary = {
        committed: committedCount,
        skipped: skippedCount,
        verified: true,
      };
      const updated = db.prepare(`
        UPDATE historical_import_runs
        SET status = ?, committed_count = ?, skipped_count = ?, result_summary_json = ?,
            confirmed_at = ?, completed_at = ?, updated_at = ?
        WHERE import_id = ? AND status = 'previewed'
      `).run(
        status,
        committedCount,
        skippedCount,
        stableStringify(resultSummary),
        timestamp,
        timestamp,
        timestamp,
        importId,
      );
      if (Number(updated.changes || 0) !== 1) fail('HISTORICAL_IMPORT_CONFIRM_RACE');
      session.markWritten(writtenDomains.map((domain) => ({ domain, inserted: committedCount, updated: 0 })));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* BEGIN may have failed before acquiring the write lock */ }
      throw error;
    } finally {
      session.dispose();
    }
    try {
      invalidateProductCache(shop.id);
    } catch {
      // The committed SQLite facts remain authoritative; a hot-cache failure
      // may delay visibility only until the short cache TTL expires.
    }
    const completed = selectRun.get(importId);
    const publicImport = publicRun(completed);
    const publicRows = selectRunRowsForPublic.all(importId, MAX_PREVIEW_ROWS);
    return {
      ok: true,
      verified: publicImport.result?.verified === true,
      idempotent: false,
      importId,
      previewFingerprint,
      summary: publicImport.summary,
      import: publicImport,
      rowCount: publicImport.rowCount,
      rowsTruncated: publicImport.rowCount > MAX_PREVIEW_ROWS,
      rows: publicRows.map(publicPreviewRow),
    };
  }

  function history(input = {}) {
    const shop = requireShop(input.shopId ?? input.shop_id, { writable: false });
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
    const imports = db.prepare(`
      SELECT * FROM historical_import_runs
      WHERE shop_id = ?
      ORDER BY created_at DESC, import_id DESC
      LIMIT ?
    `).all(shop.id, limit).map(publicRun);
    return { ok: true, shopId: shop.id, imports };
  }

  return Object.freeze({
    preflight: (input = {}) => storage.withScope(() => preflight(input)),
    confirm: (input = {}) => storage.withScope(() => confirm(input)),
    history,
  });
}
