import { firstFilled } from "../entities/order/orderIdentityRules.jsx";
import { firstFiniteNumber } from "../entities/product/productAttributes.jsx";
import { stableRequestPayload } from "../shared/ozon/ozonRuntime.jsx";
import { readEveryCursorPage } from "./legacyCursorReadback.js";
import { readPurchaseOverrides } from "./purchaseOrderOverrideClient";

export const PURCHASE_ORDER_OVERRIDE_MIGRATION_CONCURRENCY = 8;

export function normalizePurchaseOverrideOwnerId(value) {
  return String(value ?? '').trim();
}

export function purchaseOverrideBelongsToShop(override, shopId) {
  return normalizePurchaseOverrideOwnerId(override?.shopId ?? override?.shop_id) === shopId;
}

export async function mapWithBoundedConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

export function normalizePurchaseOrderLocalOverrides(overrides = {}) {
  const safeOverrides = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  return safeOverrides;
}

export const PURCHASE_OVERRIDE_PROTECTED_FIELDS = new Set([
  'id',
  'order',
  'patch',
  'recordKey',
  'record_key',
  'orderKey',
  'order_key',
  'postingNumber',
  'posting_number',
  'orderId',
  'order_id',
  'ozonOrderId',
  'ozon_order_id',
  'softwareOrderId',
  'salesOrder',
  'shipmentNo',
  'returnNo',
  'shopId',
  'shop_id',
  'shopClientId',
  'shop',
  'shopName',
  'product',
  'productNo',
  'offerId',
  'offer_id',
  'sku',
  'ozonSku',
  'items',
  'amount',
  'products',
  'raw',
  'sourceOrder',
  'paymentDate',
  'paymentTime',
  'capturedAt',
  'ozonStatus',
  'ozonRawStatus',
  'rawStatus',
  'ozonStatusLabel',
  'status',
  'sourceStatus',
  'tone',
  'searchText',
]);

export const PURCHASE_CROSS_BORDER_OVERRIDE_FIELDS = [
  'actualCrossBorderBusFeeCny', 'actualCrossBorderBusFeeSource', 'crossBorderChargeEvidence',
  'crossBorderOrderFound',
  'crossBorderStatus',
  'crossBorderOrderCount',
  'packageOrderId',
  'crossBorderOrderId',
  'crossBorderOrderNumber',
  'packageOrderIds',
  'readStatus',
  'packageWeight',
  'packageSize',
  'volumeItems',
  'warehouse',
  'logistics',
  'deliveryMethod',
  'deliveryMethodId',
  'sheetOrderSn',
  'sheetUrl',
  'freightCostValue',
  'freightCost',
  'logisticsFreight',
  'guooFreight',
  'crossBorderUpdatedAt',
];

export function getPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function getPurchaseOverrideNestedSources(override = {}) {
  const raw = getPlainObject(override.raw);
  return [
    getPlainObject(override.patch),
    getPlainObject(override.order),
    getPlainObject(raw.patch),
    getPlainObject(raw.order),
  ];
}

export function promotePurchaseCrossBorderOverrideFields(target = {}, override = {}) {
  getPurchaseOverrideNestedSources(override).forEach((source) => {
    PURCHASE_CROSS_BORDER_OVERRIDE_FIELDS.forEach((field) => {
      if (hasMergeablePurchaseOverrideValue(target[field])) return;
      if (hasMergeablePurchaseOverrideValue(source[field])) target[field] = source[field];
    });
  });
  return target;
}

export function hasMergeablePurchaseOverrideValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
}

export const PURCHASE_OVERRIDE_CLEAR_FIELD_ALIASES = {
  purchasePlatform: [
    'purchasePlatform',
    'purchase_platform',
    'platform',
    'manualBuyerPlatform',
    'buyerPlatform',
    'supplier',
  ],
  purchaseOrderNumber: [
    'purchaseOrderNumber',
    'purchase_order_number',
    'purchaseOrderNo',
    'purchase_order_no',
    'orderNo',
    'order_no',
    'manualPurchaseOrderNo',
  ],
  purchaseOrderUrl: [
    'purchaseOrderUrl',
    'purchase_order_url',
    'orderUrl',
    'order_url',
    'purchaseOrderLink',
    'purchase_order_link',
    'manualPurchaseOrderUrl',
    'url',
    'link',
  ],
  sourceCostCny: [
    'sourceCostCny',
    'source_cost_cny',
    'purchaseCostCny',
    'purchase_cost_cny',
    'cost',
    'manualPurchasePriceValue',
    'manualPurchasePrice',
    'purchasePriceValue',
    'purchasePrice',
  ],
  manualStatus: [
    'manualStatus',
    'manual_status',
    'purchaseOrderStatus',
    'purchase_order_status',
    'manualPurchaseOrderStatus',
  ],
};

export function normalizePurchaseOverrideClearFields(value) {
  return (Array.isArray(value) ? value : [])
    .map(getPurchaseOverrideLookupText)
    .filter((field, index, fields) => (
      PURCHASE_OVERRIDE_CLEAR_FIELD_ALIASES[field] && fields.indexOf(field) === index
    ));
}

export function hasPurchaseOverrideAliasValue(override = {}, field = '') {
  return (PURCHASE_OVERRIDE_CLEAR_FIELD_ALIASES[field] || [])
    .some((alias) => hasMergeablePurchaseOverrideValue(override?.[alias]));
}

export function applyPurchaseOverrideClearFields(override = {}, clearFields = []) {
  normalizePurchaseOverrideClearFields(clearFields).forEach((field) => {
    PURCHASE_OVERRIDE_CLEAR_FIELD_ALIASES[field].forEach((alias) => delete override[alias]);
  });
  return override;
}

export function sanitizePurchaseOrderLocalOverrideForMerge(override = {}) {
  const safeOverride = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  const next = {};
  Object.entries(safeOverride).forEach(([key, value]) => {
    if (PURCHASE_OVERRIDE_PROTECTED_FIELDS.has(key)) return;
    if (!hasMergeablePurchaseOverrideValue(value)) return;
    next[key] = value;
  });
  promotePurchaseCrossBorderOverrideFields(next, safeOverride);

  if (!hasMergeablePurchaseOverrideValue(next.manualBuyerPlatform)) {
    const platform = firstFilled(safeOverride.purchasePlatform, safeOverride.purchase_platform, safeOverride.platform);
    if (hasMergeablePurchaseOverrideValue(platform)) next.manualBuyerPlatform = platform;
  }
  if (!hasMergeablePurchaseOverrideValue(next.manualPurchaseOrderNo)) {
    const orderNo = firstFilled(
      safeOverride.purchaseOrderNumber,
      safeOverride.purchase_order_number,
      safeOverride.orderNo,
      safeOverride.order_no
    );
    if (hasMergeablePurchaseOverrideValue(orderNo)) next.manualPurchaseOrderNo = orderNo;
  }
  if (!hasMergeablePurchaseOverrideValue(next.manualPurchasePrice)) {
    const price = firstFilled(safeOverride.sourceCostCny, safeOverride.source_cost_cny, safeOverride.cost);
    if (hasMergeablePurchaseOverrideValue(price)) next.manualPurchasePrice = price;
  }
  if (!hasMergeablePurchaseOverrideValue(next.manualPurchasePriceValue)) {
    const priceValue = firstFiniteNumber(safeOverride.sourceCostCny, safeOverride.source_cost_cny, safeOverride.cost);
    if (priceValue !== null) next.manualPurchasePriceValue = priceValue;
  }
  if (!hasMergeablePurchaseOverrideValue(next.manualPurchaseOrderStatus)) {
    const manualStatus = firstFilled(safeOverride.manualStatus, safeOverride.manual_status);
    if (hasMergeablePurchaseOverrideValue(manualStatus)) next.manualPurchaseOrderStatus = manualStatus;
  }

  const clearFields = normalizePurchaseOverrideClearFields(safeOverride.clearFields);
  applyPurchaseOverrideClearFields(next, clearFields);
  if (clearFields.length) next.clearFields = clearFields;

  return next;
}

export function mapPurchaseOverrideRows(rows = []) {
  const mappedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      key: String(
        row?.orderKey ||
          row?.order_key ||
          row?.postingNumber ||
          row?.posting_number ||
          row?.ozonOrderId ||
          row?.ozon_order_id ||
          ''
      ).trim(),
      row,
    }))
    .filter(({ key }) => key);
  const keyCounts = mappedRows.reduce((counts, { key }) => {
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());

  return mappedRows.reduce((next, { key, row }) => {
    // A posting number is only unique inside one internal shop. Keep the
    // historical unscoped object key while it is unambiguous, but preserve
    // every shop row under its internal scoped identity when two shops share
    // the same posting number.
    const storageKey = keyCounts.get(key) > 1 ? getScopedPurchaseOverrideKey(key, row) : key;
    if (!storageKey) return next;
    next[storageKey] = {
      ...row,
      updatedAt: row.updatedAt || row.updated_at || row.savedAt || new Date().toISOString(),
    };
    return next;
  }, {});
}

export function getPurchaseOverrideLookupText(value) {
  const text = String(value ?? '').trim();
  return text && text !== '未返回' && text !== '-' ? text : '';
}

export function resolvePurchaseOverrideOwnerShop(order = {}, shop = null) {
  const safeOrder = order && typeof order === 'object' && !Array.isArray(order) ? order : {};
  const safeShop = shop && typeof shop === 'object' && !Array.isArray(shop) ? shop : {};
  return {
    id: getPurchaseOverrideLookupText(safeShop.id ?? safeShop.shopId ?? safeShop.shop_id ?? safeOrder.shopId),
    clientId: getPurchaseOverrideLookupText(
      safeShop.clientId ?? safeShop.client_id ?? safeOrder.shopClientId ?? safeOrder.clientId
    ),
  };
}

export function getVerifiedPurchaseOverrideShopId(order = {}, shop = null) {
  const safeOrder = order && typeof order === 'object' && !Array.isArray(order) ? order : {};
  const sourceOrder = getPlainObject(safeOrder.sourceOrder);
  const targetShopId = getPurchaseOverrideLookupText(shop?.id ?? shop?.shopId ?? shop?.shop_id);
  if (!targetShopId) return '';

  const orderShopIds = [safeOrder.shopId, safeOrder.shop_id, sourceOrder.shopId, sourceOrder.shop_id]
    .map(getPurchaseOverrideLookupText)
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const targetClientId = getPurchaseOverrideLookupText(shop?.clientId ?? shop?.client_id);
  const orderClientIds = [
    safeOrder.shopClientId,
    safeOrder.clientId,
    sourceOrder.shopClientId,
    sourceOrder.clientId,
  ]
    .map(getPurchaseOverrideLookupText)
    .filter((value, index, values) => value && values.indexOf(value) === index);

  // A client id can survive account removal/rebinding, so it is not an owner
  // boundary. Only the generation-aware internal shop id may authorize an
  // unscoped legacy posting lookup.
  if (!orderShopIds.includes(targetShopId)) return '';
  if (targetClientId && orderClientIds.length && !orderClientIds.includes(targetClientId)) return '';
  return targetShopId;
}

export function getPurchaseOverrideOrderLookupKeys(order = {}, shop = null) {
  const safeOrder = order && typeof order === 'object' && !Array.isArray(order) ? order : {};
  const sourceOrder = getPlainObject(safeOrder.sourceOrder);
  const keys = [
    safeOrder.recordKey,
    safeOrder.record_key,
    safeOrder.orderKey,
    safeOrder.order_key,
    safeOrder.posting,
    safeOrder.postingNumber,
    safeOrder.posting_number,
    safeOrder.id,
    safeOrder.salesOrder,
    safeOrder.shipmentNo,
    safeOrder.ozonOrderId,
    sourceOrder.recordKey,
    sourceOrder.orderKey,
    sourceOrder.posting,
    sourceOrder.postingNumber,
    sourceOrder.id,
  ]
    .map(getPurchaseOverrideLookupText)
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const prefixes = [
    shop?.id,
    shop?.shopId,
    shop?.clientId,
    safeOrder.shopId,
    safeOrder.shopClientId,
  ]
    .map(getPurchaseOverrideLookupText)
    .filter((value, index, values) => value && values.indexOf(value) === index);

  keys.slice().forEach((key) => {
    prefixes.forEach((prefix) => {
      const scopedPrefix = `${prefix}:`;
      if (!key.startsWith(scopedPrefix)) return;
      const unscopedKey = getPurchaseOverrideLookupText(key.slice(scopedPrefix.length));
      if (unscopedKey && !keys.includes(unscopedKey)) keys.push(unscopedKey);
    });
  });
  return keys;
}

export function getPurchaseOverridePersistedOrderKeys(override = {}) {
  return [
    override?.orderKey,
    override?.order_key,
    override?.postingNumber,
    override?.posting_number,
    override?.ozonOrderId,
    override?.ozon_order_id,
  ]
    .map(getPurchaseOverrideLookupText)
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

export function purchaseOverrideMatchesLookupKeys(storageKey, override = {}, lookupKeys = [], directKeys = []) {
  const overrideKeys = [
    ...getPurchaseOverridePersistedOrderKeys(override),
  ];
  return overrideKeys.length
    ? overrideKeys.some((key) => lookupKeys.includes(key))
    : directKeys.includes(storageKey);
}

export function getPurchaseOrderLocalOverrideMatches(overrides = {}, order = {}, shop = null) {
  const safeOverrides = normalizePurchaseOrderLocalOverrides(overrides);
  const ownerShop = resolvePurchaseOverrideOwnerShop(order, shop);
  const targetShopId = getVerifiedPurchaseOverrideShopId(order, ownerShop);
  if (!targetShopId) return null;
  const lookupKeys = getPurchaseOverrideOrderLookupKeys(order, ownerShop);
  if (!lookupKeys.length) return null;
  const directKeys = [
    ...lookupKeys,
    ...lookupKeys.map((key) => `${targetShopId}:${key}`),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  const matches = Object.entries(safeOverrides).filter(([storageKey, override]) => (
    override &&
    typeof override === 'object' &&
    !Array.isArray(override) &&
    purchaseOverrideBelongsToShop(override, targetShopId) &&
    purchaseOverrideMatchesLookupKeys(storageKey, override, lookupKeys, directKeys)
  ));
  return { ownerShop, targetShopId, lookupKeys, directKeys, matches };
}

export function findPurchaseOrderLocalOverride(overrides = {}, order = {}, shop = null) {
  const matchContext = getPurchaseOrderLocalOverrideMatches(overrides, order, shop);
  return matchContext?.matches.length
    ? mergePurchaseOrderLocalOverrideMatches(matchContext.matches)
    : null;
}

// Preserve the canonical owner/alias matching rules while projecting only the
// current order's raw records; merging still happens at the original call site.
export function selectPurchaseOrderLocalOverridesForOrder(overrides = {}, order = {}, shop = null) {
  return Object.fromEntries(getPurchaseOrderLocalOverrideMatches(overrides, order, shop)?.matches ?? []);
}

export function getCanonicalPurchaseOverridePosting(order = {}, ownerShop = null) {
  const safeOrder = order && typeof order === 'object' && !Array.isArray(order) ? order : {};
  const sourceOrder = getPlainObject(safeOrder.sourceOrder);
  const prefixes = [ownerShop?.clientId, ownerShop?.id]
    .map(getPurchaseOverrideLookupText)
    .filter(Boolean);
  const candidates = [
    safeOrder.posting,
    safeOrder.postingNumber,
    safeOrder.posting_number,
    sourceOrder.posting,
    sourceOrder.postingNumber,
    sourceOrder.posting_number,
    safeOrder.id,
    safeOrder.salesOrder,
    safeOrder.shipmentNo,
    safeOrder.recordKey,
    safeOrder.record_key,
    safeOrder.orderKey,
    safeOrder.order_key,
  ].map(getPurchaseOverrideLookupText).filter(Boolean);
  for (const candidate of candidates) {
    let canonical = candidate;
    for (const prefix of prefixes) {
      if (canonical.startsWith(`${prefix}:`)) canonical = canonical.slice(prefix.length + 1);
    }
    canonical = getPurchaseOverrideLookupText(canonical);
    if (canonical) return canonical;
  }
  return '';
}

export function getCanonicalPurchaseOrderOverrideKey(order = {}, shop = null) {
  const ownerShop = resolvePurchaseOverrideOwnerShop(order, shop);
  if (!getVerifiedPurchaseOverrideShopId(order, ownerShop) || !ownerShop.clientId) return '';
  const posting = getCanonicalPurchaseOverridePosting(order, ownerShop);
  return posting ? `${ownerShop.clientId}:${posting}` : '';
}

export function mergePurchaseOrderLocalOverrideMatches(matches = []) {
  const clearFields = new Set();
  const merged = matches
    .slice()
    .sort(([, left], [, right]) => (
      getPurchaseOverrideUpdatedAtTimestamp(left) - getPurchaseOverrideUpdatedAtTimestamp(right)
    ))
    .reduce((next, [, override]) => {
      const overrideClearFields = normalizePurchaseOverrideClearFields(override.clearFields);
      overrideClearFields.forEach((field) => {
        clearFields.add(field);
        applyPurchaseOverrideClearFields(next, [field]);
      });
      Object.entries(override).forEach(([key, value]) => {
        if (key === 'clearFields' || !hasMergeablePurchaseOverrideValue(value)) return;
        const field = Object.keys(PURCHASE_OVERRIDE_CLEAR_FIELD_ALIASES).find((candidate) => (
          PURCHASE_OVERRIDE_CLEAR_FIELD_ALIASES[candidate].includes(key)
        ));
        if (field && overrideClearFields.includes(field)) return;
        if (field) clearFields.delete(field);
        next[key] = value;
      });
      return next;
    }, {});
  if (clearFields.size) merged.clearFields = [...clearFields];
  return merged;
}

export function getPurchaseOverrideAliasOrderKey(storageKey, override = {}, targetShopId = '') {
  const persistedKeys = getPurchaseOverridePersistedOrderKeys(override);
  if (persistedKeys.length) return persistedKeys[0];
  const normalizedStorageKey = getPurchaseOverrideLookupText(storageKey);
  return normalizedStorageKey && !normalizedStorageKey.startsWith(`${targetShopId}:`)
    ? normalizedStorageKey
    : '';
}

export function removePurchaseSourceRecordsFromLocalOverride(override = {}, sourceKeys = []) {
  const safeOverride = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  const keySet = new Set(sourceKeys.map(getPurchaseOverrideLookupText).filter(Boolean));
  if (!keySet.size) return { override: safeOverride, changed: false };
  const nextOverride = { ...safeOverride };
  let changed = false;
  if (nextOverride.manualSourceRecords && typeof nextOverride.manualSourceRecords === 'object') {
    const nextRecords = { ...nextOverride.manualSourceRecords };
    keySet.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(nextRecords, key)) return;
      delete nextRecords[key];
      changed = true;
    });
    if (Object.keys(nextRecords).length) nextOverride.manualSourceRecords = nextRecords;
    else delete nextOverride.manualSourceRecords;
  }
  if (Object.prototype.hasOwnProperty.call(nextOverride, 'manualSourceRecord')) {
    delete nextOverride.manualSourceRecord;
    changed = true;
  }
  return { override: nextOverride, changed };
}

export function createPurchaseOrderLocalOverrideUpsert(
  overrides = {},
  order = {},
  shop = null,
  update = {},
) {
  const safeOverrides = normalizePurchaseOrderLocalOverrides(overrides);
  const matchContext = getPurchaseOrderLocalOverrideMatches(safeOverrides, order, shop);
  if (!matchContext?.ownerShop.clientId) return null;
  const canonicalKey = getCanonicalPurchaseOrderOverrideKey(order, matchContext.ownerShop);
  if (!canonicalKey) return null;
  const merged = mergePurchaseOrderLocalOverrideMatches(matchContext.matches);
  const updated = typeof update === 'function'
    ? update({ ...merged })
    : { ...merged, ...(update && typeof update === 'object' && !Array.isArray(update) ? update : {}) };
  if (!updated || typeof updated !== 'object' || Array.isArray(updated)) return null;
  const inheritedClearFields = new Set(normalizePurchaseOverrideClearFields(merged.clearFields));
  const clearFields = normalizePurchaseOverrideClearFields(updated.clearFields).filter((field) => !(
    inheritedClearFields.has(field) &&
    !hasPurchaseOverrideAliasValue(merged, field) &&
    hasPurchaseOverrideAliasValue(updated, field)
  ));

  const nextOverrides = { ...safeOverrides };
  matchContext.matches.forEach(([storageKey]) => delete nextOverrides[storageKey]);
  const displaced = nextOverrides[canonicalKey];
  if (displaced && typeof displaced === 'object' && !Array.isArray(displaced)) {
    const displacedKey = getScopedPurchaseOverrideKey(canonicalKey, displaced);
    if (!displacedKey || displacedKey === canonicalKey || nextOverrides[displacedKey]) return null;
    nextOverrides[displacedKey] = displaced;
    delete nextOverrides[canonicalKey];
  }

  const canonicalOverride = { ...updated };
  for (const field of ['id', 'shop_id', 'order_key', 'posting_number']) {
    delete canonicalOverride[field];
  }
  applyPurchaseOverrideClearFields(canonicalOverride, clearFields);
  if (clearFields.length) canonicalOverride.clearFields = clearFields;
  else delete canonicalOverride.clearFields;
  canonicalOverride.shopId = matchContext.targetShopId;
  canonicalOverride.orderKey = canonicalKey;
  canonicalOverride.postingNumber = canonicalKey;
  canonicalOverride.updatedAt = new Date().toISOString();
  nextOverrides[canonicalKey] = canonicalOverride;

  const aliasDeletions = matchContext.matches
    .map(([storageKey, override]) => ({
      shopId: matchContext.targetShopId,
      orderKey: getPurchaseOverrideAliasOrderKey(storageKey, override, matchContext.targetShopId),
      storageKey,
    }))
    .filter(({ orderKey }) => orderKey && orderKey !== canonicalKey)
    .filter((entry, index, values) => (
      values.findIndex((candidate) => (
        candidate.shopId === entry.shopId && candidate.orderKey === entry.orderKey
      )) === index
    ));
  return {
    overrides: nextOverrides,
    override: canonicalOverride,
    canonicalKey,
    clearFields,
    aliasDeletions,
    shopId: matchContext.targetShopId,
  };
}

export function getScopedPurchaseOverrideKey(orderKey, override = {}) {
  const shopId = String(override?.shopId ?? override?.shop_id ?? '').trim();
  const normalizedOrderKey = String(
    override?.orderKey ?? override?.order_key ?? override?.postingNumber ?? orderKey ?? ''
  ).trim();
  return shopId && normalizedOrderKey ? `${shopId}:${normalizedOrderKey}` : '';
}

export function getPurchaseOverrideUpdatedAtTimestamp(override = {}) {
  const value = override?.updatedAt ?? override?.updated_at ?? override?.savedAt ?? '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mapPurchaseOverrideRowsByScopedIdentity(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((next, row) => {
    const scopedKey = getScopedPurchaseOverrideKey('', row);
    if (!scopedKey) return next;
    next[scopedKey] = {
      ...row,
      updatedAt: row.updatedAt || row.updated_at || row.savedAt || '',
    };
    return next;
  }, {});
}

export async function readPurchaseOrderOverrideReadbackFromLocalApi() {
  const readback = await readEveryCursorPage(
    (pageQuery) => readPurchaseOverrides(pageQuery),
    { pageSize: 1000 },
  );
  if (!readback.complete) {
    const error = new Error(readback.reason || 'PURCHASE_OVERRIDE_CURSOR_READBACK_INCOMPLETE');
    error.code = 'PURCHASE_OVERRIDE_CURSOR_READBACK_INCOMPLETE';
    error.readback = readback;
    throw error;
  }
  return {
    ...readback,
    byOrderKey: mapPurchaseOverrideRows(readback.rows),
    byScopedIdentity: mapPurchaseOverrideRowsByScopedIdentity(readback.rows),
  };
}

export function normalizePurchaseOverrideReadbackValue(override = {}, options = {}) {
  const comparable = sanitizePurchaseOrderLocalOverrideForMerge(override);
  const platform = firstFilled(
    comparable.manualBuyerPlatform,
    comparable.purchasePlatform,
    comparable.purchase_platform,
    comparable.platform,
    comparable.buyerPlatform
  );
  const orderNumber = firstFilled(
    comparable.manualPurchaseOrderNo,
    comparable.purchaseOrderNumber,
    comparable.purchase_order_number,
    comparable.orderNo,
    comparable.order_no
  );
  const price = firstFilled(
    comparable.manualPurchasePriceValue,
    comparable.manualPurchasePrice,
    comparable.sourceCostCny,
    comparable.source_cost_cny,
    comparable.cost
  );
  const status = firstFilled(
    comparable.manualPurchaseOrderStatus,
    comparable.manualStatus,
    comparable.manual_status
  );
  const purchaseOrderUrl = firstFilled(
    comparable.manualPurchaseOrderUrl,
    comparable.purchaseOrderUrl,
    comparable.purchase_order_url,
    comparable.orderUrl,
    comparable.order_url,
    comparable.purchaseOrderLink,
    comparable.purchase_order_link,
    comparable.url,
    comparable.link
  );
  [
    'purchasePlatform',
    'purchase_platform',
    'platform',
    'buyerPlatform',
    'purchaseOrderNumber',
    'purchase_order_number',
    'orderNo',
    'order_no',
    'purchase_order_url',
    'orderUrl',
    'order_url',
    'purchaseOrderLink',
    'purchase_order_link',
    'url',
    'link',
    'sourceCostCny',
    'source_cost_cny',
    'cost',
    'manualStatus',
    'manual_status',
    'createdAt',
    'created_at',
  ].forEach((key) => delete comparable[key]);
  if (hasMergeablePurchaseOverrideValue(platform)) comparable.manualBuyerPlatform = platform;
  if (hasMergeablePurchaseOverrideValue(orderNumber)) comparable.manualPurchaseOrderNo = orderNumber;
  if (hasMergeablePurchaseOverrideValue(price)) comparable.manualPurchasePrice = price;
  if (hasMergeablePurchaseOverrideValue(status)) comparable.manualPurchaseOrderStatus = status;
  if (hasMergeablePurchaseOverrideValue(purchaseOrderUrl)) comparable.purchaseOrderUrl = purchaseOrderUrl;
  const updatedAt = firstFilled(override.updatedAt, override.updated_at, override.savedAt);
  if (options.includeUpdatedAt && updatedAt) {
    const parsed = Date.parse(updatedAt);
    comparable.updatedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(updatedAt);
  }
  return stableRequestPayload(comparable);
}

export function hasMappablePurchaseOrderOverride(orderKey, override = {}) {
  const shopId = String(override?.shopId ?? override?.shop_id ?? '').trim();
  return Boolean(
    String(orderKey || '').trim() &&
    shopId &&
    !['all', 'default', '*'].includes(shopId.toLowerCase())
  );
}

export function purchaseOrderOverrideReadbackMatches(orderKey, legacyOverride, canonicalOverride) {
  if (!hasMappablePurchaseOrderOverride(orderKey, legacyOverride)) return false;
  if (!canonicalOverride || typeof canonicalOverride !== 'object') return false;
  const legacyShopId = String(legacyOverride.shopId ?? legacyOverride.shop_id ?? '').trim();
  const canonicalShopId = String(canonicalOverride.shopId ?? canonicalOverride.shop_id ?? '').trim();
  const canonicalOrderKey = String(
    canonicalOverride.orderKey ?? canonicalOverride.order_key ?? canonicalOverride.postingNumber ?? ''
  ).trim();
  return (
    legacyShopId === canonicalShopId &&
    String(orderKey || '').trim() === canonicalOrderKey &&
    JSON.stringify(
      normalizePurchaseOverrideReadbackValue(legacyOverride, {
        includeUpdatedAt: Boolean(firstFilled(legacyOverride.updatedAt, legacyOverride.updated_at, legacyOverride.savedAt)),
      })
    ) ===
      JSON.stringify(
        normalizePurchaseOverrideReadbackValue(canonicalOverride, {
          includeUpdatedAt: Boolean(firstFilled(legacyOverride.updatedAt, legacyOverride.updated_at, legacyOverride.savedAt)),
        })
      )
  );
}
