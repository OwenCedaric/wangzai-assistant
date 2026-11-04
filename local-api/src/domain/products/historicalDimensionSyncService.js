import { createStableHash } from '../../utils/stableHash.js';

const DOMAIN = 'products';
const ACTION = 'product.updateInfo';
const ENDPOINT_KEY = 'products.import';
const DEFAULT_PROFILE_ID = 'default';
const MAX_TARGETS = 50;

const DIMENSION_FIELDS = Object.freeze({
  length: Object.freeze({ publicKey: 'lengthMm', itemKey: 'depth', unit: 'mm' }),
  width: Object.freeze({ publicKey: 'widthMm', itemKey: 'width', unit: 'mm' }),
  height: Object.freeze({ publicKey: 'heightMm', itemKey: 'height', unit: 'mm' }),
  weight: Object.freeze({ publicKey: 'weightG', itemKey: 'weight', unit: 'g' }),
});

const FIELD_ALIASES = Object.freeze({
  length: 'length',
  lengthmm: 'length',
  depth: 'length',
  depthmm: 'length',
  长: 'length',
  长度: 'length',
  width: 'width',
  widthmm: 'width',
  宽: 'width',
  宽度: 'width',
  height: 'height',
  heightmm: 'height',
  高: 'height',
  高度: 'height',
  weight: 'weight',
  weightg: 'weight',
  重量: 'weight',
});

export const HISTORICAL_DIMENSION_SYNC_SOURCE_PRIORITY = Object.freeze({
  cross_border_bus: 400,
  historical_order_import: 300,
  manual: 200,
  ozon: 100,
});

export const HISTORICAL_DIMENSION_SYNC_IMPORT_ITEM_FIELDS = Object.freeze([
  'offer_id',
  'name',
  'description_category_id',
  'type_id',
  'currency_code',
  'old_price',
  'price',
  'vat',
  'weight',
  'weight_unit',
  'depth',
  'width',
  'height',
  'dimension_unit',
  'primary_image',
  'images',
  'attributes',
]);

const IMPORT_ITEM_FIELD_SET = new Set(HISTORICAL_DIMENSION_SYNC_IMPORT_ITEM_FIELDS);
const EXTERNAL_DIMENSION_VALUE_FIELDS = new Set([
  'length', 'lengthMm', 'length_mm', 'depth', 'depthMm', 'depth_mm',
  'width', 'widthMm', 'width_mm', 'height', 'heightMm', 'height_mm',
  'weight', 'weightG', 'weight_g', 'weightKg', 'weight_kg',
]);

function fail(code, message = code, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeProfileId(value) {
  return normalizeText(value) || DEFAULT_PROFILE_ID;
}

function normalizeIdentifier(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
    fail('HISTORICAL_DIMENSION_SYNC_IDENTITY_INVALID', '商品标识无效。', { field });
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail('HISTORICAL_DIMENSION_SYNC_IDENTITY_INVALID', '商品标识无效。', { field });
  }
  const text = normalizeText(value);
  if (
    !text
    || text.length > 256
    || /[\u0000-\u001F\u007F]/u.test(text)
    || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/u.test(text)
  ) {
    fail('HISTORICAL_DIMENSION_SYNC_IDENTITY_INVALID', '商品标识无效。', { field });
  }
  return text;
}

function normalizeSelectedFields(value) {
  const source = value === undefined || value === null || value === ''
    ? Object.keys(DIMENSION_FIELDS)
    : Array.isArray(value)
      ? value
      : [value];
  const fields = [];
  for (const entry of source) {
    const alias = normalizeText(entry).toLocaleLowerCase('en-US').replace(/[\s_\-]/gu, '');
    const field = FIELD_ALIASES[alias];
    if (!field) {
      fail('HISTORICAL_DIMENSION_SYNC_FIELD_INVALID', '仅允许选择长、宽、高、重量。', { field: entry });
    }
    if (!fields.includes(field)) fields.push(field);
  }
  if (!fields.length) fail('HISTORICAL_DIMENSION_SYNC_FIELD_REQUIRED', '请至少选择一个回传字段。');
  return fields;
}

function safeJson(value, fallback, code) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    fail(code, '当前商品事实 JSON 无法安全解析。');
  }
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function positiveInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return Number.isSafeInteger(rounded) && rounded > 0 && rounded <= 1_000_000_000
    ? rounded
    : null;
}

function toBaseMeasure(value, factor) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return positiveInteger(number * factor);
}

function normalizePositiveDecimal(value, field) {
  const text = normalizeText(value);
  if (!/^\d+(?:\.\d+)?$/u.test(text) || Number(text) <= 0) {
    fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '当前 Ozon 商品事实缺少完整写回字段。', { field });
  }
  return text;
}

function normalizeNonNegativeDecimal(value, field) {
  const text = normalizeText(value);
  if (!/^\d+(?:\.\d+)?$/u.test(text) || Number(text) < 0) {
    fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '当前 Ozon 商品事实缺少完整写回字段。', { field });
  }
  return text;
}

function normalizePositiveId(value, field) {
  const text = normalizeText(value);
  if (!/^\d+$/u.test(text)) {
    fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '当前 Ozon 商品事实缺少完整写回字段。', { field });
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '当前 Ozon 商品事实缺少完整写回字段。', { field });
  }
  return number;
}

function normalizeCardText(value, field, { allowZero = false } = {}) {
  const text = normalizeText(value);
  if ((!text && !(allowZero && value === 0)) || text.length > 4_000 || /[\u0000-\u001F\u007F]/u.test(text)) {
    fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '当前 Ozon 商品事实缺少完整写回字段。', { field });
  }
  return text;
}

function normalizeRemoteImages(rows) {
  const images = [];
  for (const value of rows) {
    const url = normalizeText(value);
    if (!/^https?:\/\//iu.test(url)) {
      fail('HISTORICAL_DIMENSION_SYNC_CARD_IMAGE_INVALID', '当前商品图片不是可安全回传的远程地址。');
    }
    if (!images.includes(url)) images.push(url);
  }
  if (!images.length) {
    fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '当前 Ozon 商品事实缺少完整写回字段。', { field: 'images' });
  }
  return images;
}

function assertImportItemSafe(item) {
  const keys = Object.keys(item);
  if (keys.some((key) => !IMPORT_ITEM_FIELD_SET.has(key))) {
    fail('HISTORICAL_DIMENSION_SYNC_IMPORT_ITEM_UNSAFE', '商品回传载荷包含未授权字段。');
  }
  const serialized = JSON.stringify(item).toLocaleLowerCase('en-US');
  if (/"(?:commission|commissions|acquiring|fee|fees|cost|costs|profit|stock|stocks)"\s*:/u.test(serialized)) {
    fail('HISTORICAL_DIMENSION_SYNC_FEE_FIELD_FORBIDDEN', '历史费用、佣金、收单费和库存绝不能进入尺寸回传。');
  }
}

function sourceCandidate({ sourceType, sourceName = sourceType, priority, subRank = 0, recordId, updatedAt, dimensions }) {
  return {
    sourceType,
    sourceName,
    priority,
    subRank: Number(subRank) || 0,
    recordId: normalizeText(recordId) || null,
    updatedAt: normalizeText(updatedAt) || null,
    dimensions: {
      length: positiveInteger(dimensions?.length),
      width: positiveInteger(dimensions?.width),
      height: positiveInteger(dimensions?.height),
      weight: positiveInteger(dimensions?.weight),
    },
  };
}

function compareCandidates(left, right) {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.subRank !== right.subRank) return right.subRank - left.subRank;
  const time = Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '');
  if (Number.isFinite(time) && time !== 0) return time;
  return normalizeText(left.recordId).localeCompare(normalizeText(right.recordId), 'en');
}

function selectDimensionFields(candidates, selectedFields) {
  const sorted = [...candidates].sort(compareCandidates);
  const selected = {};
  for (const field of selectedFields) {
    const source = sorted.find((candidate) => candidate.dimensions[field] !== null);
    if (source) selected[field] = { value: source.dimensions[field], source };
  }
  return selected;
}

function normalizeTargetRequests(input = {}) {
  const rawTargets = Array.isArray(input.items)
    ? input.items
    : Array.isArray(input.products)
      ? input.products
      : [input.target && typeof input.target === 'object' ? input.target : input];
  if (!rawTargets.length) fail('HISTORICAL_DIMENSION_SYNC_TARGET_REQUIRED', '缺少待回传商品。');
  if (rawTargets.length > MAX_TARGETS) fail('HISTORICAL_DIMENSION_SYNC_TARGET_LIMIT', '单次最多处理 50 个商品。');
  const defaultFields = input.selectedFields ?? input.fields;
  const defaultImportId = normalizeIdentifier(input.importId ?? input.import_id, 'importId');
  return rawTargets.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('HISTORICAL_DIMENSION_SYNC_TARGET_INVALID', '待回传商品格式无效。', { index });
    }
    for (const field of EXTERNAL_DIMENSION_VALUE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(raw, field)) {
        fail('HISTORICAL_DIMENSION_SYNC_EXTERNAL_VALUE_FORBIDDEN', '尺寸值只能来自本地可信事实，不能由请求直接提交。', { index, field });
      }
    }
    if (raw.dimensions !== undefined) {
      fail('HISTORICAL_DIMENSION_SYNC_EXTERNAL_VALUE_FORBIDDEN', '尺寸值只能来自本地可信事实，不能由请求直接提交。', { index, field: 'dimensions' });
    }
    const target = {
      productIdentityId: normalizeIdentifier(raw.productIdentityId ?? raw.product_identity_id, 'productIdentityId'),
      productId: normalizeIdentifier(raw.productId ?? raw.product_id, 'productId'),
      offerId: normalizeIdentifier(raw.offerId ?? raw.offer_id, 'offerId'),
      sku: normalizeIdentifier(raw.sku ?? raw.ozonSku ?? raw.ozon_sku, 'sku'),
      productKey: normalizeIdentifier(raw.productKey ?? raw.product_key, 'productKey'),
      postingNumber: normalizeIdentifier(raw.postingNumber ?? raw.posting_number ?? raw.orderNumber ?? raw.order_number, 'postingNumber'),
      importId: normalizeIdentifier(raw.importId ?? raw.import_id ?? defaultImportId, 'importId'),
      rowIndex: raw.rowIndex === undefined && raw.row_index === undefined
        ? null
        : Number(raw.rowIndex ?? raw.row_index),
      selectedFields: normalizeSelectedFields(raw.selectedFields ?? raw.fields ?? defaultFields),
    };
    if (target.rowIndex !== null && (!Number.isSafeInteger(target.rowIndex) || target.rowIndex < 0)) {
      fail('HISTORICAL_DIMENSION_SYNC_ROW_INDEX_INVALID', '历史导入行号无效。', { index });
    }
    if (!target.productIdentityId && !target.productId && !target.offerId && !target.sku && !target.productKey && !target.postingNumber) {
      fail('HISTORICAL_DIMENSION_SYNC_IDENTITY_REQUIRED', '每个回传项必须包含商品或历史订单标识。', { index });
    }
    return target;
  });
}

function publicDimensions(dimensions = {}) {
  return {
    lengthMm: dimensions.length ?? null,
    widthMm: dimensions.width ?? null,
    heightMm: dimensions.height ?? null,
    weightG: dimensions.weight ?? null,
  };
}

function publicTarget(target) {
  return {
    productIdentityId: target.product.productIdentityId,
    productId: target.product.productId || null,
    offerId: target.product.offerId,
    sku: target.product.sku || null,
    productKey: target.product.productKey,
    productName: target.product.name,
    orderNumber: target.request.postingNumber || null,
    importId: target.request.importId || null,
    rowIndex: target.request.rowIndex,
    selectedFields: target.request.selectedFields,
    before: publicDimensions(target.before),
    after: publicDimensions(target.after),
    changes: target.changes.map((change) => ({
      field: change.field,
      unit: DIMENSION_FIELDS[change.field].unit,
      before: change.before,
      after: change.after,
      sourceType: change.source.sourceType,
      sourceName: change.source.sourceName,
      sourcePriority: change.source.priority,
      sourceUpdatedAt: change.source.updatedAt,
    })),
  };
}

function frontendDimensions(dimensions = {}) {
  const decimal = (value, divisor) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Number((number / divisor).toFixed(3));
  };
  return {
    lengthCm: decimal(dimensions.length, 10),
    widthCm: decimal(dimensions.width, 10),
    heightCm: decimal(dimensions.height, 10),
    weightKg: decimal(dimensions.weight, 1000),
  };
}

function sourceLabel(sourceTypes = []) {
  const labels = {
    cross_border_bus: '跨境巴士资料',
    historical_order_import: '历史订单导入',
    manual: '其他人工资料',
    ozon: 'Ozon 当前资料',
  };
  return [...new Set(sourceTypes)].map((type) => labels[type] || type).join(' / ') || '历史订单本地数据';
}

function frontendItem(target, { readback = null, readbackStatus = 'not_started' } = {}) {
  const sourceTypes = target.changes.map((change) => change.source.sourceType);
  const verified = readbackStatus === 'verified';
  return {
    selectionKey: target.request.rowIndex === null
      ? target.product.productIdentityId
      : `${target.request.rowIndex}:${target.product.productIdentityId}`,
    product: {
      productIdentityId: target.product.productIdentityId,
      productId: target.product.productId || null,
      offerId: target.product.offerId,
      sku: target.product.sku || null,
      name: target.product.name,
    },
    productIdentityId: target.product.productIdentityId,
    productId: target.product.productId || null,
    productName: target.product.name,
    orderNumber: target.request.postingNumber || null,
    source: {
      type: sourceTypes.length === 1 ? sourceTypes[0] : 'mixed',
      importId: target.request.importId || null,
      orderNumber: target.request.postingNumber || null,
      label: sourceLabel(sourceTypes),
    },
    fieldSources: Object.fromEntries(target.changes.map((change) => [change.field, {
      type: change.source.sourceType,
      name: change.source.sourceName,
      priority: change.source.priority,
    }])),
    currentValues: frontendDimensions(target.before),
    proposedValues: frontendDimensions(target.after),
    readbackValues: readback ? frontendDimensions(readback) : {},
    status: verified ? 'completed' : readbackStatus === 'not_started' ? 'ready' : readbackStatus,
    readbackStatus,
    readbackVerified: verified,
  };
}

function statusFromGuardResult(result) {
  if (result?.readBack?.status === 'merged' && result?.readBack?.verification?.ok === true) return 'completed';
  if (result?.readBack?.status === 'mismatch') return 'readback_mismatch';
  if (result?.accepted === true || result?.pending === true || result?.readBack?.status === 'pending') return 'pending_readback';
  if (result?.blocked === true) return 'blocked';
  return result?.ok === false ? 'failed' : 'pending_readback';
}

/**
 * Explicit-only historical dimension writeback. Merely constructing this
 * service or calling preview never schedules an Ozon request. confirm delegates
 * the immutable payload to the existing products write guard and waits for its
 * official Ozon readback verdict.
 */
export function createHistoricalDimensionSyncService({
  db,
  writeGuardService,
  profileId = DEFAULT_PROFILE_ID,
  assertShopWritable = () => undefined,
  now = () => new Date(),
} = {}) {
  if (!db) throw new Error('createHistoricalDimensionSyncService requires db.');
  if (!writeGuardService?.previewWrite || !writeGuardService?.confirmWrite) {
    throw new Error('createHistoricalDimensionSyncService requires writeGuardService.');
  }
  const scopedProfileId = normalizeProfileId(profileId);
  const previews = new Map();

  const requiredTables = [
    'shops', 'ozon_products', 'product_identities', 'product_detail_facts',
    'product_dimension_facts', 'product_attribute_facts', 'product_image_facts',
    'product_material_profiles', 'cross_border_order_records', 'historical_order_facts',
    'historical_order_import_runs', 'historical_order_import_rows',
  ];
  const hasTable = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1");
  const missingTable = requiredTables.find((table) => !hasTable.get(table)?.found);
  if (missingTable) {
    fail('HISTORICAL_DIMENSION_SYNC_NOT_CONNECTED', '历史订单尺寸回传所需 SQLite 数据域尚未连接。', { table: missingTable });
  }

  const selectShop = db.prepare(`
    SELECT id, profile_id, shop_incarnation, status, disabled_at
    FROM shops WHERE id = ? LIMIT 1
  `);
  const productBase = `
    SELECT identity.product_identity_id,
           COALESCE(identity.product_id, product.product_id) AS product_id,
           COALESCE(identity.offer_id, product.offer_id) AS offer_id,
           COALESCE(identity.sku, product.sku) AS sku,
           product.product_key, product.id AS product_row_id,
           product.is_stale, product.raw_json, product.price_json,
           product.images_json, product.attributes_json,
           product.name AS legacy_name, product.category_id AS legacy_category_id,
           product.type_id AS legacy_type_id, product.currency_code AS legacy_currency_code,
           product.weight_kg, product.depth_cm, product.width_cm, product.height_cm,
           product.updated_at AS product_updated_at
    FROM product_identities AS identity
    JOIN ozon_products AS product
      ON product.id = identity.product_identity_id AND product.shop_id = identity.shop_id
  `;
  const selectByIdentity = db.prepare(`${productBase} WHERE identity.shop_id = ? AND identity.product_identity_id = ?`);
  const selectByProductId = db.prepare(`${productBase} WHERE identity.shop_id = ? AND identity.product_id = ?`);
  const selectByOfferId = db.prepare(`${productBase} WHERE identity.shop_id = ? AND identity.offer_id = ?`);
  const selectBySku = db.prepare(`${productBase} WHERE identity.shop_id = ? AND identity.sku = ?`);
  const selectByProductKey = db.prepare(`${productBase} WHERE identity.shop_id = ? AND product.product_key = ?`);
  const selectByPosting = db.prepare(`
    ${productBase}
    JOIN historical_order_facts AS history
      ON history.product_identity_id = identity.product_identity_id
     AND history.shop_id = identity.shop_id
    WHERE identity.shop_id = ? AND history.posting_number = ?
  `);
  const selectDetail = db.prepare(`
    SELECT name, category_id, type_id, updated_at
    FROM product_detail_facts WHERE shop_id = ? AND product_identity_id = ? LIMIT 1
  `);
  const selectAttributes = db.prepare(`
    SELECT attributes_json, updated_at
    FROM product_attribute_facts WHERE shop_id = ? AND product_identity_id = ? LIMIT 1
  `);
  const selectImages = db.prepare(`
    SELECT image_url, is_primary, image_index, updated_at
    FROM product_image_facts WHERE shop_id = ? AND product_identity_id = ?
    ORDER BY is_primary DESC, image_index ASC
  `);
  const selectDimensionFacts = db.prepare(`
    SELECT source_type, source_priority, weight_g, length_mm, width_mm, height_mm,
           observed_at, updated_at, row_hash
    FROM product_dimension_facts
    WHERE shop_id = ? AND product_identity_id = ?
    ORDER BY source_priority DESC, updated_at DESC
  `);
  const selectMaterials = db.prepare(`
    SELECT id, source, source_rank, weight_kg, depth_cm, width_cm, height_cm,
           apply_to_product, is_confirmed, updated_at
    FROM product_material_profiles
    WHERE shop_id = ? AND product_key = ? AND apply_to_product = 1
      AND (is_confirmed = 1 OR source_rank > 10)
    ORDER BY source_rank DESC, updated_at DESC, id ASC
  `);
  const selectHistory = db.prepare(`
    SELECT id, posting_number, product_name, origin_import_id,
           weight_g, length_mm, width_mm, height_mm, updated_at
    FROM historical_order_facts
    WHERE shop_id = ? AND product_identity_id = ?
      AND source_type = 'historical_order_import'
      AND (? = '' OR posting_number = ?)
      AND (? = '' OR origin_import_id = ?)
    ORDER BY updated_at DESC, id ASC
  `);
  const selectImportRun = db.prepare(`
    SELECT import_id, shop_id, shop_incarnation, status
    FROM historical_order_import_runs WHERE import_id = ? LIMIT 1
  `);
  const selectImportRow = db.prepare(`
    SELECT import_id, row_index, shop_id, posting_number, product_identity_id,
           product_id, offer_id, sku, product_name, committed
    FROM historical_order_import_rows
    WHERE import_id = ? AND row_index = ? LIMIT 1
  `);
  const selectImportFact = db.prepare(`
    SELECT posting_number, product_identity_id, origin_import_id
    FROM historical_order_facts
    WHERE shop_id = ? AND posting_number = ? AND source_type = 'historical_order_import'
    LIMIT 1
  `);

  function timestampNow() {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  function requireShop(shopIdInput) {
    const shopId = normalizeIdentifier(shopIdInput, 'shopId');
    if (!shopId) fail('HISTORICAL_DIMENSION_SYNC_SHOP_ID_REQUIRED', '缺少 Ozon 店铺 ID。');
    assertShopWritable(shopId);
    const shop = selectShop.get(shopId);
    if (!shop) fail('HISTORICAL_DIMENSION_SYNC_SHOP_NOT_FOUND', 'Ozon 店铺不存在。');
    if (normalizeProfileId(shop.profile_id) !== scopedProfileId) {
      fail('HISTORICAL_DIMENSION_SYNC_SHOP_SCOPE_FORBIDDEN', '店铺不属于当前软件资料。');
    }
    if (shop.status === 'disabled' || shop.disabled_at) {
      fail('HISTORICAL_DIMENSION_SYNC_SHOP_DISABLED', 'Ozon 店铺已停用。');
    }
    if (!normalizeText(shop.shop_incarnation)) {
      fail('HISTORICAL_DIMENSION_SYNC_SHOP_INCARNATION_REQUIRED', '店铺身份代次缺失。');
    }
    return shop;
  }

  function uniqueProducts(rows = []) {
    return [...new Map(rows.map((row) => [row.product_identity_id, row])).values()];
  }

  function resolveProduct(shopId, request) {
    const selectors = [
      ['productIdentityId', request.productIdentityId, selectByIdentity],
      ['productId', request.productId, selectByProductId],
      ['offerId', request.offerId, selectByOfferId],
      ['sku', request.sku, selectBySku],
      ['productKey', request.productKey, selectByProductKey],
      ['postingNumber', request.postingNumber, selectByPosting],
    ];
    const resolved = [];
    for (const [field, value, statement] of selectors) {
      if (!value) continue;
      const rows = uniqueProducts(statement.all(shopId, value));
      if (!rows.length) {
        fail('HISTORICAL_DIMENSION_SYNC_PRODUCT_NOT_FOUND', '没有找到唯一对应的当前 Ozon 商品。', { field });
      }
      if (rows.length !== 1) {
        fail('HISTORICAL_DIMENSION_SYNC_PRODUCT_AMBIGUOUS', '一个标识匹配到多个商品，已停止回传。', { field, count: rows.length });
      }
      resolved.push(rows[0]);
    }
    const ids = new Set(resolved.map((row) => row.product_identity_id));
    if (ids.size !== 1) {
      fail('HISTORICAL_DIMENSION_SYNC_PRODUCT_IDENTITY_CONFLICT', '请求中的商品标识指向不同商品，已停止回传。');
    }
    const product = resolved[0];
    if (!product || Number(product.is_stale) === 1) {
      fail('HISTORICAL_DIMENSION_SYNC_PRODUCT_STALE', '当前商品事实已失效，请先重新读取 Ozon。');
    }
    const detail = selectDetail.get(shopId, product.product_identity_id);
    return {
      ...product,
      productIdentityId: product.product_identity_id,
      productId: normalizeText(product.product_id),
      offerId: normalizeText(product.offer_id),
      sku: normalizeText(product.sku),
      productKey: normalizeText(product.product_key),
      name: normalizeText(detail?.name || product.legacy_name) || '未命名商品',
    };
  }

  function assertImportSelection(shop, request, product) {
    if (!request.importId) return;
    if (request.rowIndex === null || !request.postingNumber) {
      fail(
        'HISTORICAL_DIMENSION_SYNC_IMPORT_SELECTION_REQUIRED',
        '历史订单回传必须绑定导入批次、行号和订单号。',
      );
    }
    const run = selectImportRun.get(request.importId);
    if (!run || run.shop_id !== shop.id) {
      fail('HISTORICAL_DIMENSION_SYNC_IMPORT_NOT_FOUND', '历史订单导入记录不存在或不属于当前店铺。');
    }
    if (!['completed', 'completed_with_skips'].includes(run.status)) {
      fail('HISTORICAL_DIMENSION_SYNC_IMPORT_NOT_COMPLETED', '历史订单导入尚未完成，不能回传尺寸。');
    }
    if (run.shop_incarnation !== shop.shop_incarnation) {
      fail('HISTORICAL_DIMENSION_SYNC_IMPORT_STALE', '历史订单导入属于旧店铺身份，不能回传尺寸。');
    }
    const row = selectImportRow.get(request.importId, request.rowIndex);
    if (
      !row
      || row.shop_id !== shop.id
      || Number(row.committed) !== 1
      || row.product_identity_id !== product.productIdentityId
      || (request.postingNumber && row.posting_number !== request.postingNumber)
    ) {
      fail('HISTORICAL_DIMENSION_SYNC_IMPORT_SELECTION_MISMATCH', '所选历史订单行与当前商品不一致，已停止回传。');
    }
    const fact = selectImportFact.get(shop.id, request.postingNumber);
    if (
      !fact
      || fact.origin_import_id !== request.importId
      || fact.product_identity_id !== product.productIdentityId
    ) {
      fail('HISTORICAL_DIMENSION_SYNC_IMPORT_FACT_STALE', '历史订单事实已被更新或不一致，请重新选择最新导入记录。');
    }
  }

  function currentOzonDimensions(shopId, product) {
    const fact = selectDimensionFacts.all(shopId, product.productIdentityId)
      .find((row) => row.source_type === 'ozon');
    return {
      length: positiveInteger(fact?.length_mm) ?? toBaseMeasure(product.depth_cm, 10),
      width: positiveInteger(fact?.width_mm) ?? toBaseMeasure(product.width_cm, 10),
      height: positiveInteger(fact?.height_mm) ?? toBaseMeasure(product.height_cm, 10),
      weight: positiveInteger(fact?.weight_g) ?? toBaseMeasure(product.weight_kg, 1000),
    };
  }

  function buildFullCurrentItem(shopId, product, targetDimensions) {
    const detail = selectDetail.get(shopId, product.productIdentityId);
    const attributeFact = selectAttributes.get(shopId, product.productIdentityId);
    const imageRows = selectImages.all(shopId, product.productIdentityId);
    const raw = safeJson(product.raw_json, {}, 'HISTORICAL_DIMENSION_SYNC_CARD_JSON_INVALID');
    const price = safeJson(product.price_json, {}, 'HISTORICAL_DIMENSION_SYNC_CARD_JSON_INVALID');
    const attributes = attributeFact
      ? safeJson(attributeFact.attributes_json, null, 'HISTORICAL_DIMENSION_SYNC_CARD_JSON_INVALID')
      : null;
    if (!Array.isArray(attributes)) {
      fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '当前 Ozon 商品事实缺少完整写回字段。', { field: 'attributes' });
    }
    const images = normalizeRemoteImages(imageRows.map((row) => row.image_url));
    const primaryImage = normalizeText(imageRows.find((row) => Number(row.is_primary) === 1)?.image_url) || images[0];
    const priceContainer = price?.price && typeof price.price === 'object' ? price.price : {};
    const rawPriceContainer = raw?.price && typeof raw.price === 'object' ? raw.price : {};
    const item = {
      offer_id: normalizeCardText(firstPresent(product.offerId, raw.offer_id, raw.offerId), 'offer_id'),
      name: normalizeCardText(firstPresent(detail?.name, product.legacy_name, raw.name, raw.title), 'name'),
      description_category_id: normalizePositiveId(firstPresent(
        detail?.category_id,
        product.legacy_category_id,
        raw.description_category_id,
        raw.category_id,
        raw.category?.id,
      ), 'description_category_id'),
      type_id: normalizePositiveId(firstPresent(
        detail?.type_id,
        product.legacy_type_id,
        raw.type_id,
        raw.category?.type_id,
      ), 'type_id'),
      currency_code: normalizeCardText(firstPresent(
        price.currency_code,
        priceContainer.currency_code,
        rawPriceContainer.currency_code,
        raw.currency_code,
        product.legacy_currency_code,
      ), 'currency_code').toUpperCase(),
      old_price: normalizeNonNegativeDecimal(firstPresent(
        price.old_price,
        priceContainer.old_price,
        rawPriceContainer.old_price,
        raw.old_price,
      ), 'old_price'),
      price: normalizePositiveDecimal(firstPresent(
        price.price,
        priceContainer.price,
        price.marketing_seller_price,
        priceContainer.marketing_seller_price,
        typeof raw.price === 'object' ? null : raw.price,
        rawPriceContainer.price,
        raw.marketing_seller_price,
      ), 'price'),
      vat: normalizeCardText(firstPresent(raw.vat, raw.vat_rate, raw.vatRate), 'vat', { allowZero: true }),
      weight: positiveInteger(targetDimensions.weight),
      weight_unit: 'g',
      depth: positiveInteger(targetDimensions.length),
      width: positiveInteger(targetDimensions.width),
      height: positiveInteger(targetDimensions.height),
      dimension_unit: 'mm',
      primary_image: primaryImage,
      images,
      attributes: structuredClone(attributes),
    };
    for (const field of ['weight', 'depth', 'width', 'height']) {
      if (item[field] === null) {
        fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '完整商品卡缺少必需尺寸，不能部分覆盖 Ozon 商品。', { field });
      }
    }
    if (!/^[A-Z]{3}$/u.test(item.currency_code)) {
      fail('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING', '当前 Ozon 商品事实缺少有效币种。', { field: 'currency_code' });
    }
    assertImportItemSafe(item);
    return item;
  }

  function crossBorderRows(shopId, product, postingNumbers) {
    const productConditions = [];
    const orderConditions = [];
    const params = [shopId];
    const add = (target, column, values) => {
      const clean = [...new Set(values.map(normalizeText).filter(Boolean))];
      if (!clean.length) return;
      target.push(`${column} IN (${clean.map(() => '?').join(',')})`);
      params.push(...clean);
    };
    add(productConditions, 'offer_id', [product.offerId]);
    add(productConditions, 'sku', [product.sku]);
    add(orderConditions, 'platform_order', postingNumbers);
    add(orderConditions, 'sheet_order_sn', postingNumbers);
    // A bus record is trusted only when both its order and product evidence
    // match. An OR across these groups can silently select another parcel.
    if (!productConditions.length || !orderConditions.length) return [];
    return db.prepare(`
      SELECT id, package_weight_kg, length_cm, width_cm, height_cm, updated_at
      FROM cross_border_order_records
      WHERE shop_id = ? AND is_stale = 0
        AND (${productConditions.join(' OR ')})
        AND (${orderConditions.join(' OR ')})
      ORDER BY updated_at DESC, id ASC
    `).all(...params);
  }

  function collectDimensionCandidates(shopId, product, request, before) {
    const historyRows = selectHistory.all(
      shopId,
      product.productIdentityId,
      request.postingNumber,
      request.postingNumber,
      request.importId,
      request.importId,
    );
    const postingNumbers = request.postingNumber
      ? [request.postingNumber]
      : historyRows.map((row) => row.posting_number);
    const candidates = [];

    for (const row of crossBorderRows(shopId, product, postingNumbers)) {
      candidates.push(sourceCandidate({
        sourceType: 'cross_border_bus',
        sourceName: 'cross-border-order-record',
        priority: HISTORICAL_DIMENSION_SYNC_SOURCE_PRIORITY.cross_border_bus,
        subRank: 100,
        recordId: row.id,
        updatedAt: row.updated_at,
        dimensions: {
          length: toBaseMeasure(row.length_cm, 10),
          width: toBaseMeasure(row.width_cm, 10),
          height: toBaseMeasure(row.height_cm, 10),
          weight: toBaseMeasure(row.package_weight_kg, 1000),
        },
      }));
    }

    const materialRows = selectMaterials.all(shopId, product.productKey);
    for (const row of materialRows) {
      const source = normalizeText(row.source).toLocaleLowerCase('en-US').replaceAll('_', '-');
      const crossBorder = ['cross-border-bus', 'crossborderbus', 'cross-border'].includes(source);
      const ozon = source.startsWith('ozon-') || source === 'ozon';
      if (ozon) continue;
      candidates.push(sourceCandidate({
        sourceType: crossBorder ? 'cross_border_bus' : 'manual',
        sourceName: normalizeText(row.source) || (crossBorder ? 'cross-border-bus' : 'manual'),
        priority: crossBorder
          ? HISTORICAL_DIMENSION_SYNC_SOURCE_PRIORITY.cross_border_bus
          : HISTORICAL_DIMENSION_SYNC_SOURCE_PRIORITY.manual,
        subRank: row.source_rank,
        recordId: row.id,
        updatedAt: row.updated_at,
        dimensions: {
          length: toBaseMeasure(row.depth_cm, 10),
          width: toBaseMeasure(row.width_cm, 10),
          height: toBaseMeasure(row.height_cm, 10),
          weight: toBaseMeasure(row.weight_kg, 1000),
        },
      }));
    }

    for (const row of historyRows) {
      candidates.push(sourceCandidate({
        sourceType: 'historical_order_import',
        sourceName: 'historical-order-import',
        priority: HISTORICAL_DIMENSION_SYNC_SOURCE_PRIORITY.historical_order_import,
        recordId: row.id,
        updatedAt: row.updated_at,
        dimensions: {
          length: row.length_mm,
          width: row.width_mm,
          height: row.height_mm,
          weight: row.weight_g,
        },
      }));
    }

    for (const row of selectDimensionFacts.all(shopId, product.productIdentityId)) {
      if (row.source_type === 'ozon' || row.source_type === 'cross_border') continue;
      candidates.push(sourceCandidate({
        sourceType: 'manual',
        sourceName: row.source_type,
        priority: HISTORICAL_DIMENSION_SYNC_SOURCE_PRIORITY.manual,
        subRank: row.source_priority,
        recordId: row.row_hash,
        updatedAt: row.updated_at || row.observed_at,
        dimensions: {
          length: row.length_mm,
          width: row.width_mm,
          height: row.height_mm,
          weight: row.weight_g,
        },
      }));
    }

    const crossFact = selectDimensionFacts.all(shopId, product.productIdentityId)
      .find((row) => row.source_type === 'cross_border');
    if (crossFact) {
      candidates.push(sourceCandidate({
        sourceType: 'cross_border_bus',
        sourceName: 'canonical-cross-border',
        priority: HISTORICAL_DIMENSION_SYNC_SOURCE_PRIORITY.cross_border_bus,
        subRank: crossFact.source_priority,
        recordId: crossFact.row_hash,
        updatedAt: crossFact.updated_at || crossFact.observed_at,
        dimensions: {
          length: crossFact.length_mm,
          width: crossFact.width_mm,
          height: crossFact.height_mm,
          weight: crossFact.weight_g,
        },
      }));
    }

    candidates.push(sourceCandidate({
      sourceType: 'ozon',
      sourceName: 'ozon-current-fact',
      priority: HISTORICAL_DIMENSION_SYNC_SOURCE_PRIORITY.ozon,
      recordId: product.productIdentityId,
      updatedAt: product.product_updated_at,
      dimensions: before,
    }));
    return candidates;
  }

  function buildPlan(shop, requests) {
    const targets = [];
    const seen = new Set();
    for (const request of requests) {
      const product = resolveProduct(shop.id, request);
      assertImportSelection(shop, request, product);
      if (seen.has(product.productIdentityId)) {
        fail('HISTORICAL_DIMENSION_SYNC_DUPLICATE_TARGET', '同一商品不能在一次回传中重复出现。');
      }
      seen.add(product.productIdentityId);
      const before = currentOzonDimensions(shop.id, product);
      const selected = selectDimensionFields(
        collectDimensionCandidates(shop.id, product, request, before),
        request.selectedFields,
      );
      const after = { ...before };
      const changes = [];
      for (const field of request.selectedFields) {
        const resolved = selected[field];
        if (!resolved) continue;
        after[field] = resolved.value;
        if (resolved.source.sourceType !== 'ozon' && resolved.value !== before[field]) {
          changes.push({ field, before: before[field], after: resolved.value, source: resolved.source });
        }
      }
      const importItem = buildFullCurrentItem(shop.id, product, after);
      targets.push({ request, product, before, after, changes, importItem });
    }
    const changedTargets = targets.filter((target) => target.changes.length > 0);
    if (!changedTargets.length) {
      fail('HISTORICAL_DIMENSION_SYNC_NO_CHANGES', '所选历史尺寸与当前 Ozon 尺寸一致，或没有可回传字段。');
    }
    const payload = { items: changedTargets.map((target) => target.importItem) };
    const fingerprint = createStableHash({
      shopId: shop.id,
      shopIncarnation: shop.shop_incarnation,
      payload,
      targets: targets.map((target) => ({
        request: target.request,
        productIdentityId: target.product.productIdentityId,
        before: target.before,
        after: target.after,
        changes: target.changes.map((change) => ({
          field: change.field,
          sourceType: change.source.sourceType,
          sourceName: change.source.sourceName,
          sourcePriority: change.source.priority,
          sourceRecordId: change.source.recordId,
          sourceUpdatedAt: change.source.updatedAt,
        })),
      })),
    });
    return { shop, requests, targets, changedTargets, payload, fingerprint };
  }

  function preview(input = {}) {
    const shop = requireShop(input.shopId ?? input.shop_id);
    const requests = normalizeTargetRequests(input);
    const plan = buildPlan(shop, requests);
    const before = {
      operation: 'historical-dimension-sync',
      items: plan.changedTargets.map((target) => ({
        product_id: target.product.productId || null,
        offer_id: target.product.offerId,
        ...publicDimensions(target.before),
      })),
    };
    const after = {
      operation: 'historical-dimension-sync',
      previewFingerprint: plan.fingerprint,
      items: plan.changedTargets.map((target) => ({
        product_id: target.product.productId || null,
        offer_id: target.product.offerId,
        ...publicDimensions(target.after),
      })),
    };
    const guard = writeGuardService.previewWrite(DOMAIN, {
      shopId: shop.id,
      action: ACTION,
      endpointKey: ENDPOINT_KEY,
      payload: plan.payload,
      before,
      after,
      idempotencyKey: `historical-dimension-sync:${shop.id}:${plan.fingerprint}`,
      requestedBy: normalizeText(input.requestedBy) || 'historical-dimension-sync',
    });
    if (!guard?.ok || !normalizeText(guard.previewId)) {
      fail('HISTORICAL_DIMENSION_SYNC_WRITE_GUARD_PREVIEW_FAILED', '商品写入安全门未能生成预览。');
    }
    previews.set(guard.previewId, {
      shopId: shop.id,
      shopIncarnation: shop.shop_incarnation,
      fingerprint: plan.fingerprint,
      requests,
      publicTargets: plan.targets.map(publicTarget),
      changedTargets: plan.changedTargets,
      createdAt: timestampNow(),
      status: 'ready',
    });
    const items = plan.changedTargets.map((target) => frontendItem(target));
    return {
      ok: true,
      previewId: guard.previewId,
      operationId: guard.previewId,
      previewFingerprint: plan.fingerprint,
      diffHash: guard.diffHash,
      auditId: guard.auditId,
      endpointKey: ENDPOINT_KEY,
      action: ACTION,
      automatic: false,
      requiresConfirmation: true,
      selectedFieldCount: plan.changedTargets.reduce((total, target) => total + target.changes.length, 0),
      productCount: plan.changedTargets.length,
      summary: {
        totalProducts: plan.targets.length,
        changedProducts: plan.changedTargets.length,
        unchangedProducts: plan.targets.length - plan.changedTargets.length,
        invalidProducts: 0,
        verifiedProducts: 0,
        failedProducts: 0,
      },
      items,
      targets: plan.targets.map(publicTarget),
      sourcePriority: [
        'cross_border_bus', 'historical_order_import', 'manual', 'ozon',
      ],
      createdAt: previews.get(guard.previewId).createdAt,
    };
  }

  async function confirm(input = {}) {
    const previewId = normalizeText(
      input.previewId ?? input.preview_id ?? input.operationId ?? input.operation_id,
    );
    if (!previewId || input.confirm !== true) {
      fail('HISTORICAL_DIMENSION_SYNC_CONFIRMATION_REQUIRED', '必须确认有效的尺寸回传预览。');
    }
    const state = previews.get(previewId);
    if (!state || state.status !== 'ready') {
      fail('HISTORICAL_DIMENSION_SYNC_PREVIEW_NOT_FOUND', '尺寸回传预览不存在、已使用或已失效。');
    }
    const shopId = normalizeIdentifier(input.shopId ?? input.shop_id, 'shopId');
    if (!shopId || shopId !== state.shopId) {
      fail('HISTORICAL_DIMENSION_SYNC_PREVIEW_SCOPE_MISMATCH', '确认店铺与预览店铺不一致。');
    }
    const fingerprint = normalizeText(
      input.previewFingerprint ?? input.preview_fingerprint ?? input.fingerprint,
    );
    if (!fingerprint || fingerprint !== state.fingerprint) {
      fail('HISTORICAL_DIMENSION_SYNC_PREVIEW_FINGERPRINT_MISMATCH', '确认指纹与预览不一致。');
    }
    for (const forbidden of ['payload', 'after', 'before', 'readBackRows', 'realWrite', 'dryRun', 'fastAck', 'asyncWrite']) {
      if (Object.prototype.hasOwnProperty.call(input, forbidden)) {
        fail('HISTORICAL_DIMENSION_SYNC_CONFIRM_OVERRIDE_FORBIDDEN', '确认请求不能覆盖预览载荷或执行方式。', { field: forbidden });
      }
    }
    const shop = requireShop(shopId);
    if (shop.shop_incarnation !== state.shopIncarnation) {
      fail('HISTORICAL_DIMENSION_SYNC_PREVIEW_STALE', '店铺身份已变化，请重新预览。');
    }
    const current = buildPlan(shop, state.requests);
    if (current.fingerprint !== state.fingerprint) {
      fail('HISTORICAL_DIMENSION_SYNC_PREVIEW_STALE', '商品或历史尺寸事实已变化，请重新预览。');
    }
    state.status = 'confirming';
    let result;
    try {
      result = await writeGuardService.confirmWrite(DOMAIN, {
        previewId,
        confirm: true,
        shopId: state.shopId,
        action: ACTION,
        endpointKey: ENDPOINT_KEY,
        realWrite: true,
        dryRun: false,
        fastAck: false,
        asyncWrite: false,
        waitForResult: true,
        requestedBy: normalizeText(input.requestedBy) || 'historical-dimension-sync-confirm',
      });
    } finally {
      previews.delete(previewId);
    }
    const status = statusFromGuardResult(result);
    const completed = status === 'completed';
    const hasOfficialReadback = Number(result?.readBack?.rows) > 0
      && ['merged', 'mismatch'].includes(result?.readBack?.status);
    const items = state.changedTargets.map((target) => {
      const readback = hasOfficialReadback
        ? currentOzonDimensions(state.shopId, target.product)
        : null;
      const exact = readback && Object.keys(DIMENSION_FIELDS)
        .every((field) => readback[field] === target.after[field]);
      const itemReadbackStatus = completed || exact
        ? 'verified'
        : hasOfficialReadback
          ? 'mismatch'
          : status === 'pending_readback'
            ? 'pending'
            : 'failed';
      return frontendItem(target, { readback, readbackStatus: itemReadbackStatus });
    });
    const verifiedProducts = items.filter((item) => item.readbackVerified).length;
    return {
      ok: result?.ok === true,
      completed,
      verified: completed && verifiedProducts === items.length,
      status,
      previewId,
      operationId: previewId,
      previewFingerprint: state.fingerprint,
      endpointKey: ENDPOINT_KEY,
      action: ACTION,
      automatic: false,
      summary: {
        totalProducts: items.length,
        changedProducts: items.length,
        unchangedProducts: 0,
        invalidProducts: 0,
        verifiedProducts,
        failedProducts: items.length - verifiedProducts,
      },
      items,
      targets: state.publicTargets,
      writeStatus: result?.writeStatus || null,
      writeSubmitted: result?.schedulerResult?.realWrite === true,
      scheduler: result?.schedulerResult
        ? {
            jobId: result.schedulerResult.jobId || null,
            status: result.schedulerResult.status || null,
            realWrite: result.schedulerResult.realWrite === true,
            dryRun: result.schedulerResult.dryRun !== false,
          }
        : null,
      readBack: result?.readBack
        ? {
            status: result.readBack.status || null,
            rows: Number(result.readBack.rows) || 0,
            verified: result.readBack.verification?.ok === true,
            reason: result.readBack.verification?.reason || null,
          }
        : null,
      error: result?.error
        ? { code: result.error.code || 'HISTORICAL_DIMENSION_SYNC_CONFIRM_FAILED', message: result.error.message || '尺寸回传失败。' }
        : null,
      requiresRefresh: completed,
      completedAt: completed ? timestampNow() : null,
      message: completed
        ? 'Ozon 已回读到完全一致的长宽高和重量，尺寸回传完成。'
        : result?.message || result?.error?.message || '已确认，但尚未取得一致的 Ozon 回读，不能标记完成。',
    };
  }

  return Object.freeze({
    domain: 'historical-dimension-sync',
    preview,
    confirm,
  });
}
