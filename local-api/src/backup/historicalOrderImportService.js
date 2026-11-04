import { randomUUID } from 'node:crypto';
import { createStableHash, stableStringify } from '../utils/stableHash.js';
import { createHistoricalImportStorage } from './historicalImportStorage.js';
import {
  DEFAULT_PROFILE_ID,
  FACT_FIELDS,
  IMPORT_SOURCE_TYPE,
  INTERNAL_MONEY_FIELDS,
  MAX_IMPORT_ROWS,
  MAX_PREVIEW_ROWS,
  MEASURE_FIELDS,
  MONEY_FIELDS,
  amountToMinor,
  boundedText,
  createStoredPreviewFingerprint,
  fail,
  fieldValuesEqual,
  isBlank,
  measureToBase,
  minorToAmount,
  moneyToMinor,
  normalizeAlias,
  normalizeCurrency,
  normalizeFileName,
  normalizeFileType,
  normalizeIdentifier,
  normalizeProfileId,
  normalizeSourceUrl,
  normalizeText,
  orderSnapshot,
  overrideSnapshot,
  previewCounters,
  publicFact,
  publicPreviewRow,
  publicRun,
  rowToFact,
  safeJsonParse,
} from "./historicalOrderImportFields.js";

const BUSINESS_FIELDS = new Set([
  ...Object.keys(MONEY_FIELDS),
  ...Object.keys(MEASURE_FIELDS),
  'currencyCode',
  'sourcePlatform',
  'sourceUrl',
  'purchaseOrderNumber',
  'trackingNumber',
  'note',
]);

const FIELD_ALIASES = new Map();

function alias(field, ...values) {
  [field, ...values].forEach((value) => FIELD_ALIASES.set(normalizeAlias(value), field));
}

alias(
  'orderNumber',
  'order_number',
  'ozonOrderNumber',
  'ozon_order_number',
  'postingNumber',
  'posting_number',
  'Ozon订单号',
  'Ozon 订单号',
  '订单号',
  '发货号',
);
alias(
  'selectedProductId',
  'selected_product_id',
  'productId',
  'product_id',
  'ozonProductId',
  'ozon_product_id',
  'Ozon商品ID',
  '商品ID',
);
alias('purchaseCostCny', 'purchase_cost_cny', 'sourceCostCny', 'source_cost_cny', '采购成本', '商品成本', '采购单价');
alias('crossBorderCostCny', 'cross_border_cost_cny', 'crossBorderBusFeeCny', '跨境巴士成本', '跨境巴士费用', '跨境费用');
alias('domesticFreightCny', 'domestic_freight_cny', 'logisticsFeeCny', '物流费用', '国内运费', '国内物流费');
alias('currencyCode', 'currency_code', '币种', '货币');
alias('lengthCm', 'length_cm', 'productLengthCm', '长cm', '长度cm', '长', '长度');
alias('widthCm', 'width_cm', 'productWidthCm', '宽cm', '宽度cm', '宽', '宽度');
alias('heightCm', 'height_cm', 'productHeightCm', '高cm', '高度cm', '高', '高度');
alias('weightKg', 'weight_kg', 'productWeightKg', '重量kg', '产品重量kg', '重量', '产品重量');
alias('sourcePlatform', 'source_platform', 'platform', '货源平台', '采购平台');
alias('sourceUrl', 'source_url', 'purchaseOrderUrl', 'purchase_order_url', 'url', 'link', '货源链接', '采购链接');
alias('purchaseOrderNumber', 'purchase_order_number', '采购单号', '采购订单号');
alias('trackingNumber', 'tracking_number', '运单号', '物流单号');
alias('note', 'remark', 'memo', '备注');

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
    const field = canonicalField(
      typeof entry === 'string' ? entry : entry?.field ?? entry?.targetField ?? entry?.target_field,
    );
    if (!sourceHeader || !field) return;
    if (sourceHeaders.has(sourceHeader) || targets.has(field)) {
      fail('HISTORICAL_ORDER_IMPORT_COLUMN_MAPPING_DUPLICATE');
    }
    sourceHeaders.add(sourceHeader);
    targets.add(field);
    output.push({ sourceHeader, field });
  });
  return output;
}

function mappedRow(rawRow, columns) {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    fail('HISTORICAL_ORDER_IMPORT_ROW_INVALID');
  }
  const result = {};
  if (columns.length) {
    columns.forEach(({ sourceHeader, field }) => {
      if (Object.prototype.hasOwnProperty.call(rawRow, field)) result[field] = rawRow[field];
      else if (Object.prototype.hasOwnProperty.call(rawRow, sourceHeader)) result[field] = rawRow[sourceHeader];
    });
    // Product selection is UI review state rather than a workbook column. A
    // client may add it after parsing a multi-product order, so retain the
    // canonical selection even when an Excel column mapping is present.
    if (
      !Object.prototype.hasOwnProperty.call(result, 'selectedProductId')
      && Object.prototype.hasOwnProperty.call(rawRow, 'selectedProductId')
    ) {
      result.selectedProductId = rawRow.selectedProductId;
    }
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
  const orderNumber = isBlank(mapped.orderNumber)
    ? ''
    : normalizeIdentifier(mapped.orderNumber, 'orderNumber');
  const selectedProductId = isBlank(mapped.selectedProductId)
    ? ''
    : normalizeIdentifier(mapped.selectedProductId, 'selectedProductId');
  const patch = {};
  for (const [field, value] of Object.entries(mapped)) {
    if (field === 'orderNumber' || field === 'selectedProductId' || isBlank(value) || !BUSINESS_FIELDS.has(field)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(MONEY_FIELDS, field)) {
      patch[MONEY_FIELDS[field]] = moneyToMinor(value, field);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(MEASURE_FIELDS, field)) {
      const config = MEASURE_FIELDS[field];
      patch[config.target] = measureToBase(value, field, config.factor);
      continue;
    }
    if (field === 'currencyCode') patch.currencyCode = normalizeCurrency(value);
    else if (field === 'sourceUrl') patch.sourceUrl = normalizeSourceUrl(value);
    else if (field === 'note') patch.note = boundedText(value, field, 2000);
    else patch[field] = boundedText(value, field, 500);
  }
  if (INTERNAL_MONEY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(patch, field))) {
    patch.currencyCode = normalizeCurrency(patch.currencyCode || 'CNY');
  } else {
    delete patch.currencyCode;
  }
  return { orderNumber, selectedProductId, patch };
}

export function createHistoricalOrderImportService({
  db,
  storageAdapter,
  profileId = DEFAULT_PROFILE_ID,
  now = () => new Date(),
  createImportId = () => `historical_order_import_${randomUUID()}`,
  assertShopWritable = () => undefined,
  invalidateOrderCache = () => undefined,
  refreshOrdersByPostingNumbers = null,
} = {}) {
  if (!db) throw new Error('createHistoricalOrderImportService requires db.');
  const scopedProfileId = normalizeProfileId(profileId);
  const storage = createHistoricalImportStorage({ db, storageAdapter, safetyErrorCode: 'HISTORICAL_ORDER_IMPORT_SAFE_RESTORE_REQUIRED' });

  const selectShop = db.prepare(`
    SELECT id, profile_id, shop_incarnation, status, disabled_at
    FROM shops WHERE id = ? LIMIT 1
  `);
  const selectOrders = storage.statement('orders', `
    SELECT id, shop_id, order_key, posting_number, order_id, products_json,
           raw_json, remote_hash, updated_at
    FROM ozon_orders
    WHERE shop_id = ? AND posting_number = ?
    ORDER BY updated_at DESC, id ASC
  `);
  const identityBase = `
    SELECT identity.product_identity_id, identity.shop_id, identity.product_id,
           identity.offer_id, identity.sku, COALESCE(detail.name, legacy.name, '') AS product_name
    FROM product_identities AS identity
    LEFT JOIN product_detail_facts AS detail
      ON detail.product_identity_id = identity.product_identity_id AND detail.shop_id = identity.shop_id
    LEFT JOIN ozon_products AS legacy
      ON legacy.id = identity.product_identity_id AND legacy.shop_id = identity.shop_id
  `;
  const selectIdentityByProductId = storage.statement('product-identities', `${identityBase} WHERE identity.shop_id = ? AND identity.product_id = ?`);
  const selectIdentityByOfferId = storage.statement('product-identities', `${identityBase} WHERE identity.shop_id = ? AND identity.offer_id = ?`);
  const selectIdentityBySku = storage.statement('product-identities', `${identityBase} WHERE identity.shop_id = ? AND identity.sku = ?`);
  const selectIdentityById = storage.statement('product-identities', `${identityBase} WHERE identity.shop_id = ? AND identity.product_identity_id = ?`);
  const selectFact = storage.statement('historical-order-facts', `
    SELECT * FROM historical_order_facts
    WHERE shop_id = ? AND posting_number = ? AND source_type = '${IMPORT_SOURCE_TYPE}'
    LIMIT 1
  `);
  const selectOverride = storage.statement('purchase-overrides', `
    SELECT * FROM purchase_order_overrides
    WHERE shop_id = ? AND (order_key = ? OR posting_number = ?)
    ORDER BY CASE WHEN order_key = ? THEN 0 ELSE 1 END, updated_at DESC, id ASC
    LIMIT 1
  `);
  const selectRun = db.prepare('SELECT * FROM historical_order_import_runs WHERE import_id = ? LIMIT 1');
  const selectRunRows = db.prepare('SELECT * FROM historical_order_import_rows WHERE import_id = ? ORDER BY row_index');
  const selectRunRowsForPublic = db.prepare(`
    SELECT * FROM historical_order_import_rows WHERE import_id = ? ORDER BY row_index LIMIT ?
  `);

  function timestampNow() {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  function requireShop(shopIdInput, { writable = true } = {}) {
    const shopId = normalizeText(shopIdInput);
    if (!shopId) fail('HISTORICAL_ORDER_IMPORT_SHOP_ID_REQUIRED');
    if (writable) assertShopWritable(shopId);
    const shop = selectShop.get(shopId);
    if (!shop) fail('HISTORICAL_ORDER_IMPORT_SHOP_NOT_FOUND');
    if (normalizeProfileId(shop.profile_id) !== scopedProfileId) fail('HISTORICAL_ORDER_IMPORT_SHOP_SCOPE_FORBIDDEN');
    if (!normalizeText(shop.shop_incarnation)) fail('HISTORICAL_ORDER_IMPORT_SHOP_INCARNATION_REQUIRED');
    if (shop.status === 'disabled' || shop.disabled_at) fail('HISTORICAL_ORDER_IMPORT_SHOP_DISABLED');
    return shop;
  }

  function readOrder(shopId, postingNumber) {
    const rows = selectOrders.all(shopId, postingNumber);
    if (!rows.length) return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_ORDER_NOT_FOUND' };
    if (rows.length !== 1) return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_ORDER_AMBIGUOUS' };
    return { ok: true, order: rows[0] };
  }

  function extractOrderProducts(order) {
    const products = safeJsonParse(order?.products_json, []);
    if (Array.isArray(products) && products.length) return products;
    const raw = safeJsonParse(order?.raw_json, {});
    for (const candidate of [raw.products, raw.items, raw.posting?.products]) {
      if (Array.isArray(candidate) && candidate.length) return candidate;
    }
    return [];
  }

  function candidateFromRow(row) {
    return {
      productIdentityId: row.product_identity_id,
      productId: row.product_id || '',
      offerId: row.offer_id || '',
      sku: row.sku || '',
      name: row.product_name || '',
    };
  }

  function uniqueIdentityRows(rows = []) {
    return [...new Map(rows.map((row) => [row.product_identity_id, row])).values()];
  }

  function resolveOrderProductLine(shopId, line = {}) {
    const source = line && typeof line === 'object' && !Array.isArray(line) ? line : {};
    const productId = normalizeText(source.product_id ?? source.productId);
    const offerId = normalizeText(source.offer_id ?? source.offerId);
    const sku = normalizeText(source.sku ?? source.sku_id ?? source.skuId ?? source.ozon_sku ?? source.ozonSku);
    if (!productId && !offerId && !sku) {
      return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_ORDER_PRODUCT_IDENTITY_MISSING' };
    }
    const strongRows = [];
    for (const [field, value, statement] of [
      ['productId', productId, selectIdentityByProductId],
      ['offerId', offerId, selectIdentityByOfferId],
    ]) {
      if (!value) continue;
      const rows = uniqueIdentityRows(statement.all(shopId, value));
      if (!rows.length) return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_NOT_FOUND', field };
      if (rows.length !== 1) return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_IDENTITY_AMBIGUOUS', field };
      strongRows.push(rows[0]);
    }
    if (new Set(strongRows.map((row) => row.product_identity_id)).size > 1) {
      return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_IDENTITY_CONFLICT' };
    }
    if (sku) {
      const skuRows = uniqueIdentityRows(selectIdentityBySku.all(shopId, sku));
      if (!skuRows.length) return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_NOT_FOUND', field: 'sku' };
      if (strongRows.length) {
        if (!skuRows.some((row) => row.product_identity_id === strongRows[0].product_identity_id)) {
          return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_IDENTITY_CONFLICT' };
        }
      } else if (skuRows.length !== 1) {
        return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_IDENTITY_AMBIGUOUS', field: 'sku' };
      } else {
        strongRows.push(skuRows[0]);
      }
    }
    if (!strongRows.length) return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_NOT_FOUND' };
    return { ok: true, candidate: candidateFromRow(strongRows[0]) };
  }

  function resolveOrderCandidates(shopId, order) {
    const lines = extractOrderProducts(order);
    if (!lines.length) return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_ORDER_PRODUCTS_MISSING' };
    const candidates = [];
    for (const line of lines) {
      const resolved = resolveOrderProductLine(shopId, line);
      if (!resolved.ok) return resolved;
      candidates.push(resolved.candidate);
    }
    const distinct = [...new Map(candidates.map((candidate) => [candidate.productIdentityId, candidate])).values()];
    return distinct.length
      ? { ok: true, candidates: distinct }
      : { ok: false, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_NOT_FOUND' };
  }

  function chooseCandidate(candidates, selectedProductId) {
    if (!selectedProductId) {
      if (candidates.length === 1) {
        return { ok: true, candidate: candidates[0], matchMode: 'automatic' };
      }
      return { ok: false, selectionRequired: true, code: 'HISTORICAL_ORDER_IMPORT_PRODUCT_SELECTION_REQUIRED' };
    }
    const matches = candidates.filter((candidate) => (
      candidate.productId === selectedProductId
      || candidate.productIdentityId === selectedProductId
    ));
    if (matches.length !== 1) {
      return { ok: false, code: 'HISTORICAL_ORDER_IMPORT_SELECTED_PRODUCT_NOT_IN_ORDER' };
    }
    return { ok: true, candidate: matches[0], matchMode: 'selected' };
  }

  function readOverride(order) {
    return selectOverride.get(order.shop_id, order.order_key, order.posting_number, order.order_key) || null;
  }

  function buildBeforeSnapshot(order) {
    return {
      order: orderSnapshot(order),
      fact: rowToFact(selectFact.get(order.shop_id, order.posting_number)),
      override: overrideSnapshot(readOverride(order)),
    };
  }

  function projectionMatches(field, value, override) {
    const raw = override?.raw || {};
    if (field === 'purchaseCostMinor') {
      return fieldValuesEqual(override?.sourceCostMinor, value)
        && fieldValuesEqual(amountToMinor(raw.manualProfitSourcePurchaseCostCny), value);
    }
    if (field === 'domesticFreightMinor') {
      return fieldValuesEqual(amountToMinor(raw.manualProfitLogisticsFeeCny), value);
    }
    if (field === 'crossBorderCostMinor') {
      return fieldValuesEqual(amountToMinor(raw.manualProfitCrossBorderBusFeeCny), value);
    }
    if (field === 'sourcePlatform') return normalizeText(override?.purchasePlatform) === normalizeText(value);
    if (field === 'purchaseOrderNumber') return normalizeText(override?.purchaseOrderNumber) === normalizeText(value);
    if (field === 'sourceUrl') return normalizeText(override?.purchaseOrderUrl) === normalizeText(value);
    if (field === 'note') return normalizeText(override?.note) === normalizeText(value);
    return true;
  }

  function buildAppliedPatch(existingFact, existingOverride, incoming) {
    const applied = {};
    for (const [field, value] of Object.entries(incoming)) {
      const factMatches = fieldValuesEqual(existingFact?.[field], value);
      if (!factMatches || !projectionMatches(field, value, existingOverride)) applied[field] = value;
    }
    return applied;
  }

  function buildPreviewRow(shopId, rawRow, columns, rowIndex, seenOrders) {
    const base = {
      rowIndex,
      previewStatus: 'invalid',
      orderNumber: '',
      orderId: '',
      productIdentityId: '',
      productId: '',
      offerId: '',
      sku: '',
      productName: '',
      matchMode: null,
      candidates: [],
      normalizedPatch: {},
      appliedPatch: {},
      before: {},
      beforeHash: createStableHash({}),
      errorCode: null,
    };
    let normalized;
    try {
      normalized = normalizeInputRow(rawRow, columns);
    } catch (error) {
      return { ...base, errorCode: error?.code || 'HISTORICAL_ORDER_IMPORT_ROW_INVALID' };
    }
    base.orderNumber = normalized.orderNumber;
    base.normalizedPatch = normalized.patch;
    if (!base.orderNumber) {
      return { ...base, errorCode: 'HISTORICAL_ORDER_IMPORT_ORDER_NUMBER_REQUIRED' };
    }
    if (seenOrders.has(base.orderNumber)) {
      return { ...base, previewStatus: 'duplicate', errorCode: 'HISTORICAL_ORDER_IMPORT_ORDER_DUPLICATE' };
    }
    seenOrders.add(base.orderNumber);
    if (!Object.keys(normalized.patch).length) {
      return { ...base, previewStatus: 'no_data', errorCode: 'HISTORICAL_ORDER_IMPORT_ROW_NO_DATA' };
    }
    const orderResolution = readOrder(shopId, base.orderNumber);
    if (!orderResolution.ok) {
      return {
        ...base,
        previewStatus: orderResolution.code === 'HISTORICAL_ORDER_IMPORT_ORDER_NOT_FOUND' ? 'order_not_found' : 'invalid',
        errorCode: orderResolution.code,
      };
    }
    const order = orderResolution.order;
    base.orderId = order.order_id || '';
    const candidateResolution = resolveOrderCandidates(shopId, order);
    if (!candidateResolution.ok) {
      return {
        ...base,
        previewStatus: candidateResolution.code.includes('NOT_FOUND') || candidateResolution.code.includes('MISSING')
          ? 'product_unmatched'
          : 'invalid',
        errorCode: candidateResolution.code,
      };
    }
    base.candidates = candidateResolution.candidates;
    const choice = chooseCandidate(base.candidates, normalized.selectedProductId);
    if (!choice.ok) {
      return {
        ...base,
        previewStatus: choice.selectionRequired ? 'selection_required' : 'invalid',
        errorCode: choice.code,
      };
    }
    Object.assign(base, {
      productIdentityId: choice.candidate.productIdentityId,
      productId: choice.candidate.productId,
      offerId: choice.candidate.offerId,
      sku: choice.candidate.sku,
      productName: choice.candidate.name,
      matchMode: choice.matchMode,
    });
    base.before = buildBeforeSnapshot(order);
    base.beforeHash = createStableHash(base.before);
    base.appliedPatch = buildAppliedPatch(base.before.fact, base.before.override, normalized.patch);
    const identityChanged = Boolean(
      base.before.fact
      && selectFact.get(shopId, base.orderNumber)?.product_identity_id !== base.productIdentityId,
    );
    if (!base.before.fact) base.previewStatus = 'ready_insert';
    else if (identityChanged || Object.keys(base.appliedPatch).length) base.previewStatus = 'ready_update';
    else base.previewStatus = 'unchanged';
    return base;
  }

  function insertPreview(run, rows) {
    const insertRun = db.prepare(`
      INSERT INTO historical_order_import_runs (
        import_id, shop_id, shop_incarnation, source_file_name, source_file_type,
        source_hash, columns_json, source_type, status, preview_fingerprint,
        row_count, insert_count, update_count, unchanged_count,
        selection_required_count, order_not_found_count, product_unmatched_count,
        invalid_count, duplicate_count, no_data_count, result_summary_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '${IMPORT_SOURCE_TYPE}', 'previewed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `);
    const insertRow = db.prepare(`
      INSERT INTO historical_order_import_rows (
        import_id, row_index, shop_id, preview_status, posting_number, order_id,
        product_identity_id, product_id, offer_id, sku, product_name, match_mode,
        candidates_json, normalized_patch_json, applied_patch_json, before_json,
        before_hash, error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        run.previewFingerprint,
        rows.length,
        run.summary.insert,
        run.summary.update,
        run.summary.unchanged,
        run.summary.selectionRequired,
        run.summary.orderNotFound,
        run.summary.productUnmatched,
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
        row.orderNumber || null,
        row.orderId || null,
        row.productIdentityId || null,
        row.productId || null,
        row.offerId || null,
        row.sku || null,
        row.productName || null,
        row.matchMode,
        stableStringify(row.candidates),
        stableStringify(row.normalizedPatch),
        stableStringify(row.appliedPatch),
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
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!rows.length) fail('HISTORICAL_ORDER_IMPORT_ROWS_REQUIRED');
    if (rows.length > MAX_IMPORT_ROWS) fail('HISTORICAL_ORDER_IMPORT_ROWS_LIMIT_EXCEEDED');
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
    const seenOrders = new Set();
    const previewRows = rows.map((row, index) => buildPreviewRow(shop.id, row, columns, index, seenOrders));
    const summary = previewCounters(previewRows);
    const importId = normalizeText(createImportId());
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,180}$/u.test(importId)) {
      fail('HISTORICAL_ORDER_IMPORT_ID_INVALID');
    }
    const createdAt = timestampNow();
    const sourceHash = createStableHash({ source, columns, rows });
    const fingerprintPayload = {
      importId,
      shopId: shop.id,
      shopIncarnation: shop.shop_incarnation,
      sourceHash,
      rows: previewRows.map((row) => ({
        rowIndex: row.rowIndex,
        previewStatus: row.previewStatus,
        postingNumber: row.orderNumber,
        productIdentityId: row.productIdentityId,
        matchMode: row.matchMode,
        candidates: row.candidates,
        normalizedPatch: row.normalizedPatch,
        appliedPatch: row.appliedPatch,
        beforeHash: row.beforeHash,
        errorCode: row.errorCode,
      })),
    };
    const previewFingerprint = createStableHash(fingerprintPayload);
    insertPreview({
      importId,
      shopId: shop.id,
      shopIncarnation: shop.shop_incarnation,
      source,
      sourceHash,
      columns,
      previewFingerprint,
      summary,
      createdAt,
    }, previewRows);
    return {
      ok: true,
      mode: 'staging-preview',
      importId,
      shopId: shop.id,
      sourceType: IMPORT_SOURCE_TYPE,
      source,
      previewFingerprint,
      rowCount: previewRows.length,
      rowsTruncated: previewRows.length > MAX_PREVIEW_ROWS,
      summary,
      restoreSafety: storage.safety(shop.id, previewRows.some((row) => ['ready_insert', 'ready_update'].includes(row.previewStatus))
        ? ['historical-order-facts', 'purchase-overrides'] : []),
      rows: previewRows.slice(0, MAX_PREVIEW_ROWS).map(publicPreviewRow),
    };
  }

  async function preflightWithOzon(input = {}) {
    const shop = requireShop(input.shopId ?? input.shop_id);
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!rows.length || rows.length > MAX_IMPORT_ROWS || typeof refreshOrdersByPostingNumbers !== 'function') {
      return storage.withScope(() => preflight(input));
    }
    const columns = normalizeColumns(input.columns ?? input.mapping);
    const postingNumbers = [...new Set(rows.flatMap((row) => {
      try {
        const mapped = mappedRow(row, columns);
        return isBlank(mapped.orderNumber)
          ? []
          : [normalizeIdentifier(mapped.orderNumber, 'orderNumber')];
      } catch {
        return [];
      }
    }))];
    const missingPostingNumbers = storage.withScope(() => postingNumbers.filter((postingNumber) => (
      !readOrder(shop.id, postingNumber).ok
    )));
    if (!missingPostingNumbers.length) return storage.withScope(() => preflight(input));

    let lookup;
    try {
      lookup = await refreshOrdersByPostingNumbers({
        shopId: shop.id,
        postingNumbers: missingPostingNumbers,
        requestedBy: 'historical-order-import-backfill',
        priority: 'P1',
      });
    } catch (error) {
      fail('HISTORICAL_ORDER_IMPORT_OZON_LOOKUP_FAILED', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (lookup?.ok === false) {
      fail('HISTORICAL_ORDER_IMPORT_OZON_LOOKUP_FAILED', lookup.error || lookup);
    }
    const preview = storage.withScope(() => preflight(input));
    return {
      ...preview,
      officialLookup: {
        requestedCount: missingPostingNumbers.length,
        foundCount: Number(lookup?.foundCount) || 0,
        notFoundCount: Number(lookup?.notFoundCount) || 0,
        failedCount: Number(lookup?.failedCount) || 0,
      },
    };
  }

  function mergeFact(existing, patch) {
    const next = {
      purchaseCostMinor: existing?.purchaseCostMinor ?? null,
      crossBorderCostMinor: existing?.crossBorderCostMinor ?? null,
      domesticFreightMinor: existing?.domesticFreightMinor ?? null,
      packagingCostMinor: existing?.packagingCostMinor ?? null,
      otherCostMinor: existing?.otherCostMinor ?? null,
      currencyCode: existing?.currencyCode || 'CNY',
      lengthMm: existing?.lengthMm ?? null,
      widthMm: existing?.widthMm ?? null,
      heightMm: existing?.heightMm ?? null,
      weightG: existing?.weightG ?? null,
      sourcePlatform: existing?.sourcePlatform || '',
      sourceUrl: existing?.sourceUrl || '',
      purchaseOrderNumber: existing?.purchaseOrderNumber || '',
      trackingNumber: existing?.trackingNumber || '',
      note: existing?.note || '',
      ...patch,
    };
    if (INTERNAL_MONEY_FIELDS.some((field) => next[field] !== null && next[field] !== undefined)) {
      next.currencyCode = 'CNY';
    }
    return next;
  }

  function writeFact(order, selectedProduct, patch, importId, timestamp) {
    const currentRow = selectFact.get(order.shop_id, order.posting_number) || null;
    const next = mergeFact(rowToFact(currentRow), patch);
    const rowHash = createStableHash({
      shopId: order.shop_id,
      postingNumber: order.posting_number,
      productIdentityId: selectedProduct.productIdentityId,
      sourceType: IMPORT_SOURCE_TYPE,
      ...Object.fromEntries(FACT_FIELDS.map((field) => [field, next[field] ?? null])),
    });
    const id = currentRow?.id || `historical_order_fact:${createStableHash({
      shopId: order.shop_id,
      postingNumber: order.posting_number,
      sourceType: IMPORT_SOURCE_TYPE,
    }, { length: 32 })}`;
    storage.databaseFor('historical-order-facts', order.shop_id).prepare(`
      INSERT INTO historical_order_facts (
        id, shop_id, posting_number, order_id, product_identity_id, product_id,
        offer_id, sku, product_name, source_type, purchase_cost_minor,
        cross_border_cost_minor, domestic_freight_minor, packaging_cost_minor,
        other_cost_minor, currency_code, length_mm, width_mm, height_mm, weight_g,
        source_platform, source_url, purchase_order_number, tracking_number, note,
        origin_import_id, row_hash, observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '${IMPORT_SOURCE_TYPE}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, posting_number, source_type) DO UPDATE SET
        order_id = excluded.order_id,
        product_identity_id = excluded.product_identity_id,
        product_id = excluded.product_id,
        offer_id = excluded.offer_id,
        sku = excluded.sku,
        product_name = excluded.product_name,
        purchase_cost_minor = excluded.purchase_cost_minor,
        cross_border_cost_minor = excluded.cross_border_cost_minor,
        domestic_freight_minor = excluded.domestic_freight_minor,
        packaging_cost_minor = excluded.packaging_cost_minor,
        other_cost_minor = excluded.other_cost_minor,
        currency_code = excluded.currency_code,
        length_mm = excluded.length_mm,
        width_mm = excluded.width_mm,
        height_mm = excluded.height_mm,
        weight_g = excluded.weight_g,
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
      order.shop_id,
      order.posting_number,
      order.order_id || null,
      selectedProduct.productIdentityId,
      selectedProduct.productId || null,
      selectedProduct.offerId || null,
      selectedProduct.sku || null,
      selectedProduct.name || null,
      next.purchaseCostMinor,
      next.crossBorderCostMinor,
      next.domesticFreightMinor,
      next.packagingCostMinor,
      next.otherCostMinor,
      next.currencyCode || 'CNY',
      next.lengthMm,
      next.widthMm,
      next.heightMm,
      next.weightG,
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
    const saved = selectFact.get(order.shop_id, order.posting_number);
    if (!saved || saved.source_type !== IMPORT_SOURCE_TYPE || saved.row_hash !== rowHash) {
      fail('HISTORICAL_ORDER_IMPORT_FACT_READBACK_MISMATCH');
    }
    return saved;
  }

  function writeProfitProjection(order, selectedProduct, patch, importId, timestamp) {
    const projectionFields = new Set([
      'purchaseCostMinor',
      'crossBorderCostMinor',
      'domesticFreightMinor',
      'sourcePlatform',
      'sourceUrl',
      'purchaseOrderNumber',
      'note',
    ]);
    if (!Object.keys(patch).some((field) => projectionFields.has(field))) return null;
    const existing = readOverride(order);
    const raw = safeJsonParse(existing?.raw_json, {});
    const nextRaw = { ...raw };
    if (Object.prototype.hasOwnProperty.call(patch, 'purchaseCostMinor')) {
      const amount = minorToAmount(patch.purchaseCostMinor);
      nextRaw.manualProfitSourcePurchaseCostCny = amount;
      nextRaw.manualProfitSourcePurchaseCostUpdatedAt = timestamp;
      nextRaw.manualPurchasePriceValue = amount;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'domesticFreightMinor')) {
      nextRaw.manualProfitLogisticsFeeCny = minorToAmount(patch.domesticFreightMinor);
      nextRaw.manualProfitLogisticsFeeUpdatedAt = timestamp;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'crossBorderCostMinor')) {
      nextRaw.manualProfitCrossBorderBusFeeCny = minorToAmount(patch.crossBorderCostMinor);
      nextRaw.manualProfitCrossBorderBusFeeUpdatedAt = timestamp;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sourcePlatform')) {
      nextRaw.manualBuyerPlatform = patch.sourcePlatform;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'purchaseOrderNumber')) {
      nextRaw.manualPurchaseOrderNo = patch.purchaseOrderNumber;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sourceUrl')) {
      nextRaw.manualPurchaseOrderUrl = patch.sourceUrl;
    }
    nextRaw.historicalOrderImport = {
      ...(nextRaw.historicalOrderImport && typeof nextRaw.historicalOrderImport === 'object'
        ? nextRaw.historicalOrderImport
        : {}),
      sourceType: IMPORT_SOURCE_TYPE,
      importId,
      updatedAt: timestamp,
    };
    const next = {
      id: existing?.id || `purchase_override_${createStableHash({
        shopId: order.shop_id,
        orderKey: order.order_key,
      }, { length: 32 })}`,
      purchasePlatform: Object.prototype.hasOwnProperty.call(patch, 'sourcePlatform')
        ? patch.sourcePlatform
        : existing?.purchase_platform || null,
      purchaseOrderNumber: Object.prototype.hasOwnProperty.call(patch, 'purchaseOrderNumber')
        ? patch.purchaseOrderNumber
        : existing?.purchase_order_number || null,
      purchaseOrderUrl: Object.prototype.hasOwnProperty.call(patch, 'sourceUrl')
        ? patch.sourceUrl
        : existing?.purchase_order_url || null,
      sourceCostCny: Object.prototype.hasOwnProperty.call(patch, 'purchaseCostMinor')
        ? minorToAmount(patch.purchaseCostMinor)
        : existing?.source_cost_cny ?? null,
      note: Object.prototype.hasOwnProperty.call(patch, 'note') ? patch.note : existing?.note || null,
    };
    if (existing) {
      storage.databaseFor('purchase-overrides', order.shop_id).prepare(`
        UPDATE purchase_order_overrides
        SET posting_number = ?, ozon_order_id = ?, offer_id = ?, sku = ?,
            purchase_platform = ?, purchase_order_number = ?, purchase_order_url = ?,
            source_cost_cny = ?, note = ?, raw_json = ?, updated_at = ?
        WHERE id = ? AND shop_id = ?
      `).run(
        order.posting_number,
        order.order_id || existing.ozon_order_id || null,
        selectedProduct.offerId || existing.offer_id || null,
        selectedProduct.sku || existing.sku || null,
        next.purchasePlatform,
        next.purchaseOrderNumber,
        next.purchaseOrderUrl,
        next.sourceCostCny,
        next.note,
        stableStringify(nextRaw),
        timestamp,
        existing.id,
        order.shop_id,
      );
    } else {
      storage.databaseFor('purchase-overrides', order.shop_id).prepare(`
        INSERT INTO purchase_order_overrides (
          id, shop_id, order_key, posting_number, ozon_order_id, offer_id, sku,
          purchase_platform, purchase_order_number, purchase_order_url,
          source_cost_cny, note, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        next.id,
        order.shop_id,
        order.order_key,
        order.posting_number,
        order.order_id || null,
        selectedProduct.offerId || null,
        selectedProduct.sku || null,
        next.purchasePlatform,
        next.purchaseOrderNumber,
        next.purchaseOrderUrl,
        next.sourceCostCny,
        next.note,
        stableStringify(nextRaw),
        timestamp,
        timestamp,
      );
    }
    const saved = storage.databaseFor('purchase-overrides', order.shop_id)
      .prepare('SELECT * FROM purchase_order_overrides WHERE id = ? AND shop_id = ?').get(next.id, order.shop_id);
    const savedRaw = safeJsonParse(saved?.raw_json, {});
    if (
      !saved
      || (Object.prototype.hasOwnProperty.call(patch, 'purchaseCostMinor')
        && amountToMinor(saved.source_cost_cny) !== patch.purchaseCostMinor)
      || (Object.prototype.hasOwnProperty.call(patch, 'purchaseCostMinor')
        && amountToMinor(savedRaw.manualProfitSourcePurchaseCostCny) !== patch.purchaseCostMinor)
      || (Object.prototype.hasOwnProperty.call(patch, 'domesticFreightMinor')
        && amountToMinor(savedRaw.manualProfitLogisticsFeeCny) !== patch.domesticFreightMinor)
      || (Object.prototype.hasOwnProperty.call(patch, 'crossBorderCostMinor')
        && amountToMinor(savedRaw.manualProfitCrossBorderBusFeeCny) !== patch.crossBorderCostMinor)
    ) {
      fail('HISTORICAL_ORDER_IMPORT_PROFIT_READBACK_MISMATCH');
    }
    return saved;
  }

  function confirm(input = {}) {
    const shop = requireShop(input.shopId ?? input.shop_id);
    const importId = normalizeText(input.importId ?? input.import_id);
    const previewFingerprint = normalizeText(input.previewFingerprint ?? input.preview_fingerprint);
    if (!importId) fail('HISTORICAL_ORDER_IMPORT_ID_REQUIRED');
    if (!/^[a-f0-9]{64}$/u.test(previewFingerprint)) {
      fail('HISTORICAL_ORDER_IMPORT_PREVIEW_FINGERPRINT_REQUIRED');
    }
    const initialRun = selectRun.get(importId);
    if (!initialRun) fail('HISTORICAL_ORDER_IMPORT_NOT_FOUND');
    if (initialRun.shop_id !== shop.id) fail('HISTORICAL_ORDER_IMPORT_SHOP_SCOPE_MISMATCH');
    if (initialRun.preview_fingerprint !== previewFingerprint) fail('HISTORICAL_ORDER_IMPORT_PREVIEW_STALE');
    if (initialRun.status === 'completed' || initialRun.status === 'completed_with_skips') {
      const publicImport = publicRun(initialRun);
      const rows = selectRunRowsForPublic.all(importId, MAX_PREVIEW_ROWS).map(publicPreviewRow);
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
        rows,
      };
    }
    if (initialRun.status !== 'previewed') fail('HISTORICAL_ORDER_IMPORT_NOT_CONFIRMABLE');

    const timestamp = timestampNow();
    let committedCount = 0;
    let skippedCount = 0;
    const writtenDomains = selectRunRows.all(importId).some((row) => ['ready_insert', 'ready_update'].includes(row.preview_status))
      ? ['historical-order-facts', 'purchase-overrides'] : [];
    const session = storage.openConfirmation(shop.id, writtenDomains);
    try {
      db.exec('BEGIN IMMEDIATE');
      const run = selectRun.get(importId);
      const currentShop = selectShop.get(shop.id);
      if (!run || run.status !== 'previewed') fail('HISTORICAL_ORDER_IMPORT_NOT_CONFIRMABLE');
      if (run.preview_fingerprint !== previewFingerprint) fail('HISTORICAL_ORDER_IMPORT_PREVIEW_STALE');
      if (!currentShop || currentShop.shop_incarnation !== run.shop_incarnation) {
        fail('HISTORICAL_ORDER_IMPORT_SHOP_INCARNATION_STALE');
      }
      const rows = selectRunRows.all(importId);
      if (createStoredPreviewFingerprint(run, rows) !== run.preview_fingerprint) {
        fail('HISTORICAL_ORDER_IMPORT_PREVIEW_STALE');
      }
      const updateRow = db.prepare(`
        UPDATE historical_order_import_rows
        SET committed = ?, after_json = ?, result_hash = ?, updated_at = ?
        WHERE import_id = ? AND row_index = ?
      `);
      for (const row of rows) {
        const confirmable = ['ready_insert', 'ready_update', 'unchanged'].includes(row.preview_status);
        if (confirmable && row.posting_number) {
          const currentOrder = readOrder(shop.id, row.posting_number);
          if (!currentOrder.ok) fail('HISTORICAL_ORDER_IMPORT_PREVIEW_STALE');
          const currentBefore = buildBeforeSnapshot(currentOrder.order);
          if (createStableHash(currentBefore) !== row.before_hash) {
            fail('HISTORICAL_ORDER_IMPORT_PREVIEW_STALE');
          }
        }
        if (!['ready_insert', 'ready_update'].includes(row.preview_status) || !row.product_identity_id) {
          skippedCount += 1;
          updateRow.run(0, null, null, timestamp, importId, row.row_index);
          continue;
        }
        const identity = selectIdentityById.get(shop.id, row.product_identity_id);
        const currentOrder = readOrder(shop.id, row.posting_number);
        if (!identity || !currentOrder.ok) fail('HISTORICAL_ORDER_IMPORT_PREVIEW_STALE');
        const selectedProduct = candidateFromRow(identity);
        const appliedPatch = safeJsonParse(row.applied_patch_json, {});
        const saved = writeFact(currentOrder.order, selectedProduct, appliedPatch, importId, timestamp);
        writeProfitProjection(currentOrder.order, selectedProduct, appliedPatch, importId, timestamp);
        const afterJson = stableStringify(publicFact(saved));
        const resultHash = createStableHash(publicFact(saved));
        updateRow.run(1, afterJson, resultHash, timestamp, importId, row.row_index);
        committedCount += 1;
      }
      const status = skippedCount > 0 ? 'completed_with_skips' : 'completed';
      const resultSummary = { committed: committedCount, skipped: skippedCount, verified: true };
      const updated = db.prepare(`
        UPDATE historical_order_import_runs
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
      if (Number(updated.changes || 0) !== 1) fail('HISTORICAL_ORDER_IMPORT_CONFIRM_RACE');
      session.markWritten(writtenDomains.map((domain) => ({ domain, inserted: committedCount, updated: 0 })));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* BEGIN may have failed before acquiring the write lock */ }
      throw error;
    } finally {
      session.dispose();
    }
    try {
      invalidateOrderCache(shop.id);
    } catch {
      // SQLite readback above is authoritative; hot-cache invalidation may be retried.
    }
    const completed = selectRun.get(importId);
    const publicImport = publicRun(completed);
    const rows = selectRunRowsForPublic.all(importId, MAX_PREVIEW_ROWS).map(publicPreviewRow);
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
      rows,
    };
  }

  function history(input = {}) {
    const shop = requireShop(input.shopId ?? input.shop_id, { writable: false });
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
    const imports = db.prepare(`
      SELECT * FROM historical_order_import_runs
      WHERE shop_id = ? ORDER BY created_at DESC, import_id DESC LIMIT ?
    `).all(shop.id, limit).map((row) => {
      const record = publicRun(row);
      const rows = selectRunRowsForPublic.all(record.importId, MAX_PREVIEW_ROWS).map(publicPreviewRow);
      return {
        ...record,
        rowsTruncated: record.rowCount > MAX_PREVIEW_ROWS,
        rows,
      };
    });
    return { ok: true, shopId: shop.id, sourceType: IMPORT_SOURCE_TYPE, imports };
  }

  return Object.freeze({
    preflight: (input = {}) => storage.withScope(() => preflight(input)),
    preflightWithOzon,
    confirm: (input = {}) => storage.withScope(() => confirm(input)),
    history,
  });
}
