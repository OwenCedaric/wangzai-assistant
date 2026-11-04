import {
  calculateEstimatedProfitCny,
  calculateRefundLossCny,
  convertFeeAmountToCny,
  sumRequiredFees,
  toFeeNumber,
} from './feeCalculationService.js';
import { normalizeOrderExchangeRatePayload } from './orderExchangeRateRules.js';
import { isPartialCompensationSale } from './profitPartialCompensation.js';
import { usesPrivateProfitExecution } from './privateProfitMode.js';

export const PROFIT_LEDGER_SCHEMA_VERSION = 1;
// User-approved v16 extension: partial buyer compensation reduces income once.
// Older snapshots keep all confirmed amounts during migration; only a complete
// finance read may populate the new compensation evidence.
export const PROFIT_LEDGER_CALCULATION_VERSION =
  'profit-ledger-v16-partial-compensation-net-income';
export const PROFIT_LEDGER_MIGRATABLE_CALCULATION_VERSIONS = Object.freeze([
  'profit-ledger-v16-per-order-finance-exchange-rate',
  'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge',
  'profit-ledger-v14-final-cross-border-charge-evidence',
  'profit-ledger-v13-rfbs-finance-commission',
  'profit-ledger-v12-explicit-no-forecast-evidence',
  'profit-ledger-v11-parent-finance-canonical-key',
  'profit-ledger-v10-cross-border-source-authority',
  'profit-ledger-v9-cross-border-recharge-cash-converted',
  'profit-ledger-v8-finance-metadata-monotonic',
  'profit-ledger-v8-finance-metadata-monotonic-shop-isolated',
]);
export const PROFIT_LEDGER_CACHE_GROUP = 'ozon-profit-ledger-v1';
// 利润台账快照是可从本地实体/Ozon 重建的派生缓存。按日期滚动的同一查询
// 不能无限累积，否则每次自然日变更都会复制整份台账。保留每个逻辑查询的最新
// 快照，并给不同店铺/筛选条件的查询留出有限槽位。
const MAX_PROFIT_LEDGER_LOGICAL_SCOPES = 12;

const PLACEHOLDER_VALUES = new Set([
  '',
  '未返回',
  '待确认',
  '读取失败',
  '未读取',
  '读取中',
  'null',
  'undefined',
  'nan',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getSnapshotTimeMs(snapshot = {}) {
  const time = Date.parse(normalizeText(snapshot.updatedAt || snapshot.fetchedAt || snapshot.createdAt));
  return Number.isFinite(time) ? time : 0;
}

function getProfitLedgerSnapshotLogicalScope(snapshotKey = '') {
  return normalizeText(snapshotKey).replace(/:range:[^:]+(?=:|$)/g, ':range:current');
}

function trimProfitLedgerSnapshots(snapshots = {}, options = {}) {
  if (!isPlainObject(snapshots)) return {};
  const entries = Object.entries(snapshots);
  if (!entries.length) return snapshots;

  const preferredSnapshotKey = normalizeText(options.preferredSnapshotKey);
  const preferredScope = preferredSnapshotKey ? getProfitLedgerSnapshotLogicalScope(preferredSnapshotKey) : '';

  const newestEntryByScope = new Map();
  for (const entry of entries) {
    const [key, snapshot] = entry;
    const scope = getProfitLedgerSnapshotLogicalScope(key);
    const current = newestEntryByScope.get(scope);
    const isPreferredEntry = scope === preferredScope && key === preferredSnapshotKey;
    const currentIsPreferredEntry = current?.[0] === preferredSnapshotKey;
    const shouldReplace =
      !current ||
      isPreferredEntry ||
      (!currentIsPreferredEntry &&
        (getSnapshotTimeMs(snapshot) > getSnapshotTimeMs(current[1]) ||
          (getSnapshotTimeMs(snapshot) === getSnapshotTimeMs(current[1]) && key.localeCompare(current[0]) > 0)));
    if (shouldReplace) newestEntryByScope.set(scope, entry);
  }

  const retainedEntries = [...newestEntryByScope.values()]
    .sort((left, right) => {
      const timeDelta = getSnapshotTimeMs(right[1]) - getSnapshotTimeMs(left[1]);
      return timeDelta || right[0].localeCompare(left[0]);
    })
    .slice(0, MAX_PROFIT_LEDGER_LOGICAL_SCOPES);
  const preferredEntry = preferredScope ? newestEntryByScope.get(preferredScope) : null;
  if (preferredEntry && !retainedEntries.some(([key]) => key === preferredEntry[0])) {
    retainedEntries[retainedEntries.length - 1] = preferredEntry;
  }
  if (retainedEntries.length === entries.length) return snapshots;
  return Object.fromEntries(retainedEntries);
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value === false) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = normalizeText(value);
    if (text && !PLACEHOLDER_VALUES.has(text.toLowerCase()) && !PLACEHOLDER_VALUES.has(text)) return value;
  }
  return '';
}

function readExplicitBooleanFlag(...values) {
  for (const value of values) {
    if (value === true || value === false) return value;
    const text = normalizeText(value).toLowerCase();
    if (['true', '1', 'yes'].includes(text)) return true;
    if (['false', '0', 'no'].includes(text)) return false;
  }
  return null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = toFeeNumber(value);
    if (number !== null && number > 0) return number;
  }
  return null;
}

function normalizeCurrencyCode(value = 'CNY') {
  const code = normalizeText(value).toUpperCase();
  if (!code) return 'CNY';
  if (['¥', '￥', 'RMB', 'CNH'].includes(code)) return 'CNY';
  if (['₽', 'RUR'].includes(code)) return 'RUB';
  return code;
}

function resolveProfitLedgerExchangeRates(context = {}) {
  const estimated =
    normalizeOrderExchangeRatePayload(
      firstFilled(context.estimatedExchangeRate, context.exchangeRates?.estimated, context.exchangeRate),
      { role: 'estimated' }
    ) ||
    normalizeOrderExchangeRatePayload(
      context.rubToCnyRate === null || context.rubToCnyRate === undefined
        ? null
        : { mode: 'unknown', base: 'RUB', quote: 'CNY', rubToCnyRate: context.rubToCnyRate },
      { role: 'estimated' }
    );
  const actual = normalizeOrderExchangeRatePayload(
    firstFilled(context.actualExchangeRate, context.exchangeRates?.actual),
    { role: 'actual' }
  );
  return { estimated, actual };
}

function amountToCny(value, currencyCode = 'CNY', options = {}) {
  const direct = toFeeNumber(value);
  if (direct === null) return null;
  return convertFeeAmountToCny(direct, normalizeCurrencyCode(currencyCode), {
    rubToCnyRate: options.rubToCnyRate,
  });
}

function normalizeOzonId(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function getPostingBaseKey(value) {
  const text = normalizeOzonId(value);
  const match = text.match(/^(\d{6,}-\d{3,})-\d+$/);
  return match ? match[1] : '';
}

function getPostingKeyCandidate(value) {
  const text = normalizeOzonId(value);
  if (!text) return '';
  const scopedPart = text.includes(':') ? text.split(':').pop() : text;
  return normalizeOzonId(scopedPart);
}

function uniqueValues(values = []) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

export function getProfitLedgerOrderKey(order = {}) {
  return firstFilled(
    order.profitRecordKey,
    order.recordKey,
    order.id,
    order.salesOrder,
    order.shipmentNo,
    order.postingNumber,
    order.posting_number,
    order.ozonOrderId,
    order.orderNumber,
    order.raw?.posting_number,
    order.raw?.postingNumber,
    order.raw?.order_number,
    order.raw?.orderNumber
  );
}

function getProfitLedgerPostingIdentity(row = {}) {
  const snapshot = isPlainObject(row.orderSnapshot) ? row.orderSnapshot : {};
  return normalizeOzonId(
    firstFilled(
      getPostingKeyCandidate(row.ledgerKey),
      getPostingKeyCandidate(row.orderKey),
      snapshot.posting,
      snapshot.id,
      row.posting,
      row.postingNumber,
      row.posting_number,
      row.id
    )
  );
}

export function getProfitLedgerCanonicalRowKey(row = {}) {
  const snapshot = isPlainObject(row.orderSnapshot) ? row.orderSnapshot : {};
  const ownerKey = normalizeOzonId(
    firstFilled(row.shopId, snapshot.shopId, row.shopClientId, snapshot.shopClientId)
  );
  const postingKey = getProfitLedgerPostingIdentity(row);
  if (ownerKey && postingKey) return `${ownerKey}:${postingKey}`;
  return normalizeText(firstFilled(row.ledgerKey, row.orderKey));
}

export function canonicalizeProfitLedgerRowKey(row = {}) {
  if (!isPlainObject(row)) return row;
  const canonicalKey = getProfitLedgerCanonicalRowKey(row);
  if (!canonicalKey) return row;
  const snapshot = isPlainObject(row.orderSnapshot) ? row.orderSnapshot : null;
  return {
    ...row,
    ledgerKey: canonicalKey,
    orderKey: canonicalKey,
    ...(snapshot
      ? {
          orderSnapshot: {
            ...snapshot,
            recordKey: canonicalKey,
            profitRecordKey: canonicalKey,
          },
        }
      : {}),
  };
}

export function getProfitLedgerOrderLookupKeys(order = {}) {
  const keys = uniqueValues(
    [
      getProfitLedgerOrderKey(order),
      order.id,
      order.recordKey,
      order.salesOrder,
      order.shipmentNo,
      order.postingNumber,
      order.posting_number,
      order.ozonOrderId,
      order.orderNumber,
      order.raw?.posting_number,
      order.raw?.postingNumber,
      order.raw?.order_number,
      order.raw?.orderNumber,
    ]
      .map(normalizeOzonId)
      .filter(Boolean)
  );
  const baseKeys = keys.map(getPostingBaseKey).filter(Boolean);
  return uniqueValues([...keys, ...baseKeys]);
}

function getProductLookupKeys(product = {}, order = {}) {
  return uniqueValues(
    [
      product.offerId,
      product.offer_id,
      product.sellerSku,
      product.seller_sku,
      product.sku,
      product.skuId,
      product.sku_id,
      product.productId,
      product.product_id,
      order.offerId,
      order.sku,
      order.skuId,
    ]
      .map(normalizeOzonId)
      .filter(Boolean)
  );
}

function getPurchaseAmountCandidate(source = {}) {
  return firstFilled(
    source.sourcePurchaseCostCny,
    source.sourceCostCny,
    source.source_cost_cny,
    source.purchaseTotalValue,
    source.purchaseTotal,
    source.productCostValue,
    source.productCost,
    source.manualPurchasePriceValue,
    source.manualPurchasePrice,
    source.purchasePriceValue,
    source.purchasePrice,
    source.cost
  );
}

function createProfitProductSnapshot(product = {}) {
  const images = Array.isArray(product.images) ? product.images.map(normalizeText).filter(Boolean).slice(0, 4) : [];
  const image = firstFilled(
    product.image,
    product.skuImage,
    product.primaryImage,
    product.photo,
    product.picture,
    images[0],
    product.raw?.image,
    product.raw?.images?.[0]
  );
  return {
    name: normalizeText(firstFilled(product.name, product.product, product.title, product.productName)),
    qty: firstFilled(product.qty, product.quantity, product.count, product.itemCount),
    salesAmountValue: firstFilled(
      product.salesAmountValue,
      product.sales_amount_value,
      product.amountValue,
      product.priceValue,
      product.price
    ),
    currencyCode: normalizeCurrencyCode(firstFilled(product.currencyCode, product.currency_code, 'CNY')),
    commissionPercent: firstFilled(
      product.commissionPercent,
      product.commission_percent,
      product.raw?.commissionPercent,
      product.raw?.commission_percent
    ),
    commissionMode: normalizeText(firstFilled(product.commissionMode, product.commissionRateMode)),
    offerId: normalizeText(firstFilled(product.offerId, product.offer_id, product.sellerSku, product.seller_sku)),
    sku: normalizeText(firstFilled(product.sku, product.skuId, product.sku_id)),
    skuId: normalizeText(firstFilled(product.skuId, product.sku_id, product.raw?.sku, product.financialRaw?.sku)),
    productId: normalizeText(firstFilled(product.productId, product.product_id, product.raw?.product_id)),
    weight: normalizeText(firstFilled(product.weight, product.materialProfile?.weight)),
    length: normalizeText(firstFilled(product.length, product.materialProfile?.length)),
    width: normalizeText(firstFilled(product.width, product.materialProfile?.width)),
    height: normalizeText(firstFilled(product.height, product.materialProfile?.height)),
    materialProfile: isPlainObject(product.materialProfile)
      ? {
          weight: normalizeText(product.materialProfile.weight),
          length: normalizeText(product.materialProfile.length),
          width: normalizeText(product.materialProfile.width),
          height: normalizeText(product.materialProfile.height),
          source: normalizeText(product.materialProfile.source),
          applyToProduct: product.materialProfile.applyToProduct,
        }
      : null,
    image: normalizeText(image),
    skuImage: normalizeText(firstFilled(product.skuImage, image)),
    primaryImage: normalizeText(firstFilled(product.primaryImage, images[0], image)),
    images,
  };
}

function createProfitLedgerOrderSnapshot(order = {}, context = {}) {
  const ledgerKey = normalizeText(context.ledgerKey || context.orderKey || getProfitLedgerOrderKey(order));
  const exchangeRates = resolveProfitLedgerExchangeRates({
    ...order,
    ...context,
    exchangeRates: {
      ...(isPlainObject(order.exchangeRates) ? order.exchangeRates : {}),
      ...(isPlainObject(context.exchangeRates) ? context.exchangeRates : {}),
    },
  });
  const sourceProducts = Array.isArray(order.products) ? order.products : [];
  const productSnapshots = sourceProducts
    .map(createProfitProductSnapshot)
    .filter(isEffectiveProfitLedgerValue)
    .slice(0, 6);
  const firstProduct = productSnapshots[0] ?? {};
  const amountValue = firstFilled(order.amountValue, order.salesAmountValue, order.orderAmountValue);
  const salesAmount = firstFilled(order.salesAmount, order.amount, order.price, amountValue);
  const override = findOverrideForOrder(order, context.purchaseOverrides ?? context.purchaseLocalOverrides) ?? {};
  const sourceRecords = normalizeSourceRecords(context.sourceRecords).slice(0, 6);
  const sourcePurchaseCost = firstFilled(
    order.sourcePurchaseCostCny,
    order.purchaseCostCny,
    order.purchasePriceValue,
    getPurchaseAmountCandidate(override)
  );
  const rawCancellation = isPlainObject(order.raw?.cancellation) ? order.raw.cancellation : {};
  const cancelledAfterShip = readExplicitBooleanFlag(
    order.cancelledAfterShip,
    order.cancelled_after_ship,
    order.cancellation?.cancelled_after_ship,
    order.cancellation?.canceled_after_ship,
    order.cancellation?.cancelledAfterShip,
    order.cancellation?.canceledAfterShip,
    rawCancellation.cancelled_after_ship,
    rawCancellation.canceled_after_ship,
    rawCancellation.cancelledAfterShip,
    rawCancellation.canceledAfterShip
  );
  return {
    id: normalizeText(firstFilled(order.id, order.posting, order.salesOrder, order.shipmentNo, ledgerKey)),
    posting: normalizeText(firstFilled(order.posting, order.postingNumber, order.posting_number, order.id)),
    salesOrder: normalizeText(firstFilled(order.salesOrder, order.id, order.shipmentNo, order.postingNumber)),
    softwareOrderId: normalizeText(firstFilled(order.softwareOrderId, order.purchaseOrderNo, order.busOrderNo)),
    recordKey: normalizeText(firstFilled(order.recordKey, ledgerKey)),
    profitRecordKey: normalizeText(firstFilled(order.profitRecordKey, ledgerKey)),
    shop: normalizeText(firstFilled(order.shop, order.shopName, context.shopName)),
    shopId: normalizeText(firstFilled(order.shopId, context.shopId)),
    shopClientId: normalizeText(firstFilled(order.shopClientId, context.shopClientId)),
    status: normalizeText(firstFilled(order.status, order.statusLabel, order.ozonStatusLabel)),
    statusLabel: normalizeText(firstFilled(order.statusLabel, order.status, order.ozonStatusLabel)),
    detailStatus: normalizeText(order.detailStatus),
    ozonStatus: normalizeText(firstFilled(order.ozonStatus, order.rawStatus, order.raw?.status)),
    ozonStatusLabel: normalizeText(firstFilled(order.ozonStatusLabel, order.statusLabel, order.status)),
    rawStatus: normalizeText(firstFilled(order.rawStatus, order.ozonRawStatus, order.raw?.status)),
    rawSubstatus: normalizeText(firstFilled(order.rawSubstatus, order.substatus, order.raw?.substatus)),
    rawPostingStatus: normalizeText(
      firstFilled(order.rawPostingStatus, order.raw?.posting_status, order.raw?.postingStatus)
    ),
    afterSalesStatus: normalizeText(order.afterSalesStatus),
    cancelledAfterShip,
    hasAfterSalesRefund: order.hasAfterSalesRefund === true,
    hasFinanceRefund: order.hasFinanceRefund === true,
    partialCompensationOnly: order.partialCompensationOnly === true,
    product: normalizeText(firstFilled(order.product, order.productName, order.title, firstProduct.name)),
    qty: firstFilled(order.qty, order.quantity, order.count, firstProduct.qty),
    offerId: normalizeText(firstFilled(order.offerId, order.offer_id, firstProduct.offerId)),
    sku: normalizeText(firstFilled(order.sku, firstProduct.sku)),
    skuId: normalizeText(firstFilled(order.skuId, order.sku_id, firstProduct.skuId)),
    paymentTime: normalizeText(
      firstFilled(order.paymentTime, order.paymentDate, order.paidAt, order.raw?.in_process_at)
    ),
    paymentDate: normalizeText(
      firstFilled(order.paymentDate, order.paymentTime, order.paidAt, order.raw?.in_process_at)
    ),
    fulfillment: normalizeText(firstFilled(order.fulfillment, order.deliveryMethod, order.raw?.delivery_method)),
    crossBorderOrderFound:
      order.crossBorderOrderFound === true ||
      context.crossBorderOrderFound === true ||
      override.crossBorderOrderFound === true,
    crossBorderOrderCount: Math.max(
      0,
      Number(
        firstFilled(order.crossBorderOrderCount, context.crossBorderOrderCount, override.crossBorderOrderCount)
      ) || 0
    ),
    packageOrderId: normalizeText(
      firstFilled(order.packageOrderId, context.packageOrderId, override.packageOrderId)
    ),
    packageOrderIds: uniqueValues(
      [
        ...(Array.isArray(order.packageOrderIds) ? order.packageOrderIds : []),
        ...(Array.isArray(context.packageOrderIds) ? context.packageOrderIds : []),
        ...(Array.isArray(override.packageOrderIds) ? override.packageOrderIds : []),
      ].map(normalizeText)
    ),
    crossBorderOrderId: normalizeText(
      firstFilled(order.crossBorderOrderId, context.crossBorderOrderId, override.crossBorderOrderId)
    ),
    crossBorderOrderNumber: normalizeText(
      firstFilled(order.crossBorderOrderNumber, context.crossBorderOrderNumber, override.crossBorderOrderNumber)
    ),
    sheetOrderSn: normalizeText(firstFilled(order.sheetOrderSn, context.sheetOrderSn, override.sheetOrderSn)),
    crossBorderStatus: normalizeText(
      firstFilled(order.crossBorderStatus, context.crossBorderStatus, override.crossBorderStatus)
    ),
    crossBorderReadStatus: normalizeText(
      firstFilled(order.crossBorderReadStatus, order.readStatus, context.crossBorderReadStatus, override.readStatus)
    ),
    purchasePlatform: normalizeText(
      firstFilled(
        order.purchasePlatform,
        order.manualBuyerPlatform,
        order.buyerPlatform,
        order.supplier,
        override.purchasePlatform,
        override.purchase_platform,
        override.manualBuyerPlatform,
        override.buyerPlatform,
        override.platform
      )
    ),
    purchaseOrderNo: normalizeText(
      firstFilled(
        order.purchaseOrderNo,
        order.purchaseOrderNumber,
        order.manualPurchaseOrderNo,
        override.purchaseOrderNo,
        override.purchase_order_no,
        override.purchaseOrderNumber,
        override.purchase_order_number,
        override.manualPurchaseOrderNo
      )
    ),
    purchaseOrderUrl: normalizeText(
      firstFilled(order.purchaseOrderUrl, order.orderUrl, override.purchaseOrderUrl, override.orderUrl)
    ),
    sourcePurchaseCostCny: sourcePurchaseCost,
    sourceRecords,
    searchText: normalizeText(firstFilled(order.searchText, order.afterSalesSearchText, order.linkedSearchText)),
    afterSalesSearchText: normalizeText(firstFilled(order.afterSalesSearchText, order.linkedSearchText)),
    afterSalesSearchValues: Array.isArray(order.afterSalesSearchValues)
      ? order.afterSalesSearchValues.map(normalizeText).filter(Boolean).slice(0, 20)
      : [],
    currencyCode: normalizeCurrencyCode(firstFilled(order.currencyCode, context.currencyCode, 'CNY')),
    sourceCurrencyCode: normalizeCurrencyCode(
      firstFilled(order.sourceCurrencyCode, order.currencyCode, context.currencyCode, 'CNY')
    ),
    amountValue,
    salesAmount,
    amount: salesAmount,
    exchangeRate: exchangeRates.estimated,
    estimatedExchangeRate: exchangeRates.estimated,
    actualExchangeRate: exchangeRates.actual,
    exchangeRates,
    products: productSnapshots,
  };
}

function findOverrideForOrder(order = {}, purchaseOverrides = null, onSelected = null) {
  if (!isPlainObject(purchaseOverrides)) return null;
  const shopId = normalizeOzonId(firstFilled(order.shopId, order.shop_id, order.sourceOrder?.shopId));
  const clientId = normalizeOzonId(firstFilled(order.shopClientId, order.clientId, order.sourceOrder?.shopClientId));
  const owners = uniqueValues([shopId, clientId]);
  const originalKeys = uniqueValues([...getProfitLedgerOrderLookupKeys(order), normalizeOzonId(order.posting)]);
  const postingKeys = uniqueValues(originalKeys.map((key) => {
    let posting = key;
    for (const owner of owners) if (posting.startsWith(`${owner}:`)) posting = posting.slice(owner.length + 1);
    return posting;
  }));
  // The ledger moved to internal shop ids; persisted purchase records still use
  // client:posting (or shop:client:posting on collisions). Resolve both without
  // changing the purchase amount rule or borrowing another shop's record.
  const scopedKeys = owners.flatMap((owner) => postingKeys.map((posting) => `${owner}:${posting}`));
  const collisionKeys = shopId && clientId ? postingKeys.map((posting) => `${shopId}:${clientId}:${posting}`) : [];
  for (const key of uniqueValues([...collisionKeys, ...scopedKeys, ...originalKeys, ...postingKeys])) {
    const override = purchaseOverrides[key];
    if (!isPlainObject(override)) continue;
    const overrideShopId = normalizeOzonId(firstFilled(override.shopId, override.shop_id));
    if (overrideShopId && overrideShopId !== shopId) continue;
    onSelected?.(key, override);
    return override;
  }
  return null;
}

// Read-only projection uses exactly the existing lookup precedence, including
// legacy keys. No second identity matcher or financial calculation is needed.
export function selectProfitLedgerPurchaseOverrides(order = {}, purchaseOverrides = null) {
  const selected = [];
  findOverrideForOrder(order, purchaseOverrides, (key, value) => selected.push([key, value]));
  return Object.fromEntries(selected);
}

function normalizeSourceRecords(sourceRecords = []) {
  if (Array.isArray(sourceRecords)) return sourceRecords.filter(isPlainObject);
  if (isPlainObject(sourceRecords)) return Object.values(sourceRecords).filter(isPlainObject);
  return [];
}

function findSourceRecordForProduct(product = {}, order = {}, sourceRecords = []) {
  const records = normalizeSourceRecords(sourceRecords);
  if (!records.length) return null;
  const orderKeys = new Set(getProfitLedgerOrderLookupKeys(order));
  const productKeys = new Set(getProductLookupKeys(product, order));
  return (
    records.find((record) => {
      const recordOrderKeys = getProfitLedgerOrderLookupKeys(record);
      if (recordOrderKeys.some((key) => orderKeys.has(key))) return true;
      const recordProductKeys = getProductLookupKeys(record, record);
      return recordProductKeys.some((key) => productKeys.has(key));
    }) || null
  );
}

function resolveProductPurchaseCost(order = {}, context = {}) {
  const products = Array.isArray(order.products) ? order.products : [];
  if (!products.length) return null;

  let total = 0;
  const evidence = [];
  for (const product of products) {
    const sourceRecord = findSourceRecordForProduct(product, order, context.sourceRecords);
    const unitCost = firstPositiveNumber(
      product.sourcePurchaseCostCny,
      product.manualPurchasePriceValue,
      product.manualPurchasePrice,
      product.purchasePriceValue,
      product.purchasePrice,
      product.productCostValue,
      product.productCost,
      sourceRecord?.sourcePurchaseCostCny,
      sourceRecord?.manualPurchasePriceValue,
      sourceRecord?.manualPurchasePrice,
      sourceRecord?.purchasePriceValue,
      sourceRecord?.purchasePrice,
      sourceRecord?.productCostValue,
      sourceRecord?.productCost
    );
    if (unitCost === null) return null;
    const quantity = firstPositiveNumber(product.qty, product.quantity, product.count, product.itemCount) ?? 1;
    total += unitCost * quantity;
    evidence.push({
      source: sourceRecord ? 'source-record-product' : 'order-product',
      key: getProductLookupKeys(product, order)[0] || '',
      unitCost,
      quantity,
    });
  }

  return {
    value: total,
    source: 'order-products',
    evidence,
  };
}

function resolveOrderPurchaseCost(order = {}, context = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const override = findOverrideForOrder(order, context.purchaseOverrides ?? context.purchaseLocalOverrides);
  const directValue = firstPositiveNumber(
    context.amounts?.sourcePurchaseCostCny,
    getPurchaseAmountCandidate(override ?? {}),
    getPurchaseAmountCandidate(order),
    getPurchaseAmountCandidate(sourceOrder)
  );
  if (directValue === null) return null;
  return {
    value: directValue,
    source: override ? 'purchase-override' : 'order-total',
    evidence: {
      source: override ? 'purchase-override' : 'order-total',
      key: getProfitLedgerOrderKey(order),
      value: directValue,
    },
  };
}

export function resolveProfitPurchaseCost(order = {}, context = {}) {
  const explicitSourceCost = toFeeNumber(context.amounts?.sourcePurchaseCostCny);
  const productCost = resolveProductPurchaseCost(order, context);
  const resolved = productCost ?? resolveOrderPurchaseCost(order, context);
  if (!resolved && explicitSourceCost === 0 && context.allowZeroPurchaseCost === true) {
    return createLedgerAmount(0, {
      source: 'confirmed-no-purchase',
      reason: '',
      allowZero: true,
      evidence: context.purchaseCostEvidence ?? [],
    });
  }
  if (!resolved) {
    return createLedgerAmount(0, {
      source: 'missing-purchase-cost-zero',
      reason: '',
      allowZero: true,
      evidence: [],
    });
  }
  return createLedgerAmount(resolved.value, {
    source: resolved.source,
    reason: '',
    allowZero: false,
    evidence: resolved.evidence,
  });
}

function resolveAmountValue(order = {}, context = {}, keys = [], options = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  for (const key of keys) {
    const direct = firstFilled(context.amounts?.[key], order[key], sourceOrder[key]);
    const currencyCode = firstFilled(
      context.currencyCode,
      context.amounts?.[`${key}Currency`],
      order[`${key}Currency`],
      order.currencyCode,
      sourceOrder[`${key}Currency`],
      sourceOrder.currencyCode,
      options.currencyCode,
      'CNY'
    );
    const amount = amountToCny(direct, currencyCode, context);
    if (amount !== null) return amount;
  }
  return null;
}

function getProductQuantity(product = {}) {
  const quantity = toFeeNumber(firstFilled(product.qty, product.quantity, product.count));
  return quantity === null || quantity <= 0 ? 1 : quantity;
}

function getProductSalesAmountValue(product = {}) {
  const price = toFeeNumber(
    firstFilled(
      product.price,
      product.priceValue,
      product.amount,
      product.amountValue,
      product.salesAmount,
      product.salesAmountValue,
      product.raw?.price,
      product.raw?.priceValue
    )
  );
  if (price === null) return null;
  return price * getProductQuantity(product);
}

function resolveProductsSalesAmount(order = {}, context = {}) {
  const products = Array.isArray(order.products)
    ? order.products
    : Array.isArray(order.sourceOrder?.products)
      ? order.sourceOrder.products
      : [];
  if (!products.length) return null;
  const values = products.map((product) => {
    const amount = getProductSalesAmountValue(product);
    if (amount === null) return null;
    const currencyCode = firstFilled(
      product.currencyCode,
      product.currency_code,
      product.raw?.currencyCode,
      product.raw?.currency_code,
      order.currencyCode,
      context.currencyCode,
      'CNY'
    );
    return amountToCny(amount, currencyCode, context);
  });
  if (!values.some((value) => value !== null)) return null;
  return values.reduce((sum, value) => sum + (value ?? 0), 0);
}

function resolveSalesAmount(order = {}, context = {}) {
  return (
    resolveAmountValue(
      order,
      context,
      ['salesAmountCny', 'orderPaymentCny', 'amountValue', 'amount', 'salesAmountValue', 'priceValue'],
      { currencyCode: 'CNY' }
    ) ?? resolveProductsSalesAmount(order, context)
  );
}

function resolveContextFeeAmount(order = {}, context = {}, key, fallbackKeys = [], options = {}) {
  const direct = firstFilled(context.amounts?.[key], ...fallbackKeys.map((field) => order[field]));
  const currencyCode = firstFilled(
    context.currencyCode,
    context.amounts?.[`${key}Currency`],
    order.currencyCode,
    options.currencyCode,
    'CNY'
  );
  return amountToCny(direct, currencyCode, context);
}

export function createLedgerAmount(value, options = {}) {
  const number = toFeeNumber(value);
  const allowZero = options.allowZero !== false;
  const ready = number !== null && (allowZero || number > 0);
  const requestedStatus = normalizeText(options.status);
  const status = ready ? (requestedStatus === 'provisional' ? 'provisional' : 'ready') : 'pending';
  return {
    value: ready ? number : null,
    status,
    source: normalizeText(options.source),
    reason: status === 'ready' ? '' : normalizeText(options.reason || '缺少有效金额'),
    updatedAt: normalizeText(options.updatedAt),
    evidence: options.evidence ?? null,
  };
}

function createLedgerResult(value, options = {}) {
  const number = toFeeNumber(value);
  return {
    value: number,
    status: number === null ? 'pending' : 'ready',
    reason: number === null ? normalizeText(options.reason || '字段不完整') : '',
    missing: Array.isArray(options.missing) ? options.missing : [],
    formula: normalizeText(options.formula),
    updatedAt: normalizeText(options.updatedAt),
  };
}

function normalizePenaltyDetailRecord(record = {}) {
  if (!isPlainObject(record)) return null;
  const dedupeKey = normalizeText(record.dedupeKey || record.operationId || record.operation_id);
  if (!dedupeKey) return null;
  const amountCny = toFeeNumber(record.amountCny);
  return {
    schemaVersion: Number(record.schemaVersion) || 1,
    dedupeKey,
    status: normalizeText(record.status) || (amountCny === null ? 'pending' : 'ready'),
    operationId: normalizeText(record.operationId || record.operation_id),
    postingNumber: normalizeText(record.postingNumber || record.posting_number),
    orderId: normalizeText(record.orderId || record.order_id),
    shopId: normalizeText(record.shopId),
    shopClientId: normalizeText(record.shopClientId),
    operationType: normalizeText(record.operationType || record.operation_type),
    operationName: normalizeText(record.operationName || record.operation_type_name || record.name),
    operationDate: normalizeText(record.operationDate || record.operation_date || record.date),
    amountCny,
    currencyCode: normalizeText(record.currencyCode || 'CNY'),
    rawAmount: normalizeText(record.rawAmount),
    amountPath: normalizeText(record.amountPath),
    reason: normalizeText(record.reason),
    source: normalizeText(record.source || 'ozon-finance-penalty-detail'),
  };
}

function normalizePenaltyDetailRecords(records = []) {
  if (!Array.isArray(records)) return [];
  const byKey = new Map();
  records
    .map(normalizePenaltyDetailRecord)
    .filter(Boolean)
    .forEach((record) => {
      const current = byKey.get(record.dedupeKey);
      if (!current || (record.status === 'ready' && current.status !== 'ready')) {
        byKey.set(record.dedupeKey, record);
      }
    });
  return [...byKey.values()];
}

function getPenaltyDetailPostingKey(record = {}) {
  return normalizeOzonId(firstFilled(record.postingNumber, record.posting_number));
}

function getLedgerRowExactPostingKeys(row = {}) {
  const snapshot = isPlainObject(row.orderSnapshot) ? row.orderSnapshot : {};
  const keys = [
    snapshot.posting,
    snapshot.id,
    row.posting,
    row.postingNumber,
    row.posting_number,
    row.id,
    row.ledgerKey,
    row.orderKey,
  ]
    .map(getPostingKeyCandidate)
    .filter(Boolean);
  return new Set(keys.filter((key) => Boolean(getPostingBaseKey(key))));
}

function filterPenaltyDetailsForLedgerRow(records = [], row = {}) {
  const normalized = normalizePenaltyDetailRecords(records);
  if (!normalized.length) return [];
  const exactKeys = getLedgerRowExactPostingKeys(row);
  if (!exactKeys.size) return normalized;
  return normalized.filter((record) => exactKeys.has(getPenaltyDetailPostingKey(record)));
}

function getLedgerRowScopedPenaltyDetails(row = {}) {
  const records = normalizePenaltyDetailRecords([
    ...(Array.isArray(row?.penaltyDetails) ? row.penaltyDetails : []),
    ...(Array.isArray(row?.amounts?.actualPenaltyFeeCny?.evidence?.records)
      ? row.amounts.actualPenaltyFeeCny.evidence.records
      : []),
    ...(Array.isArray(row?.amounts?.actualPenaltyFeeCny?.evidence?.summary?.records)
      ? row.amounts.actualPenaltyFeeCny.evidence.summary.records
      : []),
  ]);
  return filterPenaltyDetailsForLedgerRow(records, row);
}

function isReadyPenaltyDetail(record = {}) {
  return record?.status === 'ready' && toFeeNumber(record.amountCny) !== null;
}

function mergePenaltyDetailRecord(current = null, fresh = null) {
  if (!fresh) return current;
  if (!current) return fresh;
  if (isReadyPenaltyDetail(fresh)) return fresh;
  if (isReadyPenaltyDetail(current) && !isReadyPenaltyDetail(fresh)) return current;
  return {
    ...current,
    ...fresh,
  };
}

function extractPenaltyDetailsFromRows(rows = []) {
  const details = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    getLedgerRowScopedPenaltyDetails(row).forEach((record) => {
      details[record.dedupeKey] = mergePenaltyDetailRecord(details[record.dedupeKey], record);
    });
  });
  return details;
}

function getReadyPenaltyDetailsTotal(records = []) {
  const normalized = normalizePenaltyDetailRecords(records);
  if (!normalized.length) return null;
  if (normalized.some((record) => !isReadyPenaltyDetail(record))) return null;
  return normalized.reduce((sum, record) => sum + (toFeeNumber(record.amountCny) ?? 0), 0);
}

function getPendingReasons(entries = []) {
  return entries
    .filter((entry) => entry?.status !== 'ready')
    .map((entry) => entry?.reason)
    .filter(Boolean);
}

function calculateActualProfitWithDetailFees({
  orderPaymentCny,
  sourcePurchaseCostCny,
  actualCommissionFeeCny,
  actualPenaltyFeeCny,
  actualAcquiringFeeCny,
  actualDeliveryServiceFeeCny,
  actualLogisticsFeeCny,
  crossBorderBusFeeCny,
} = {}) {
  return sumRequiredFees([
    orderPaymentCny,
    sourcePurchaseCostCny === null || sourcePurchaseCostCny === undefined ? null : -sourcePurchaseCostCny,
    actualCommissionFeeCny === null || actualCommissionFeeCny === undefined ? null : -actualCommissionFeeCny,
    actualPenaltyFeeCny === null || actualPenaltyFeeCny === undefined ? null : -actualPenaltyFeeCny,
    actualAcquiringFeeCny === null || actualAcquiringFeeCny === undefined ? null : -actualAcquiringFeeCny,
    actualDeliveryServiceFeeCny === null || actualDeliveryServiceFeeCny === undefined
      ? null
      : -actualDeliveryServiceFeeCny,
    actualLogisticsFeeCny === null || actualLogisticsFeeCny === undefined ? null : -actualLogisticsFeeCny,
    crossBorderBusFeeCny === null || crossBorderBusFeeCny === undefined ? null : -crossBorderBusFeeCny,
  ]);
}

export function createProfitLedgerRow(order = {}, context = {}) {
  const updatedAt = normalizeText(context.updatedAt || context.fetchedAt || new Date().toISOString());
  const ledgerKey = normalizeText(context.orderKey || getProfitLedgerOrderKey(order));
  const actualFinanceStatus = normalizeText(context.actualFinanceStatus);
  const actualFinanceChecked = actualFinanceStatus === 'confirmed' || context.financeLookupChecked === true;
  const actualAmountStatus = actualFinanceStatus === 'provisional' ? 'provisional' : '';
  const actualZeroFallbackValue = ['confirmed', 'provisional'].includes(actualFinanceStatus) ? 0 : null;
  const actualPenaltyZeroFallbackValue = context.actualPenaltyFeeRequiresDirectAmount ? null : actualZeroFallbackValue;
  const penaltyDetails = filterPenaltyDetailsForLedgerRow(context.penaltyDetails, {
    ...order,
    ledgerKey,
    orderKey: ledgerKey,
  });
  const readyPenaltyDetailsTotal = getReadyPenaltyDetailsTotal(penaltyDetails);
  const penaltyEvidence =
    penaltyDetails.length || context.penaltySummary
      ? {
          summary: context.penaltySummary ?? null,
          records: penaltyDetails,
        }
      : null;
  const salesAmount = createLedgerAmount(resolveSalesAmount(order, context), {
    source: 'ozon-order',
    reason: '缺销售金额',
    updatedAt,
  });
  const finalZeroActualStatus = !isPartialCompensationSale(order) && isProfitLedgerFinalZeroActualStatus(getProfitLedgerOrderStatusText(order));
  const buyerCompensationValue = toFeeNumber(context.buyerCompensationCny ?? context.amounts?.buyerCompensationCny?.value
    ?? context.amounts?.buyerCompensationCny ?? order.buyerCompensationCny ?? order.profitLedger?.amounts?.buyerCompensationCny?.value);
  const resolvedActualSalesAmount = resolveContextFeeAmount(order, context, 'actualSalesAmountCny', [
    'actualSalesAmountCny',
    'actualOrderPaymentCny',
  ]);
  const actualSalesAmount = createLedgerAmount(
    resolvedActualSalesAmount ?? (isPartialCompensationSale(order)
      ? (salesAmount.value != null && buyerCompensationValue != null ? salesAmount.value - buyerCompensationValue : null)
      : finalZeroActualStatus && actualFinanceChecked ? 0 : salesAmount.value),
    {
      source: 'actual-order-income',
      reason: 'missing actual order income',
      updatedAt,
    }
  );
  const sourcePurchaseCost = resolveProfitPurchaseCost(order, context);
  const estimatedCommissionFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'estimatedCommissionFeeCny', [
      'estimatedCommissionValueCny',
      'commissionFeeCny',
    ]),
    { source: 'ozon-product-price', reason: '缺预估佣金', updatedAt }
  );
  const estimatedAcquiringFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'estimatedAcquiringFeeCny', [
      'estimatedAcquiringValueCny',
      'acquiringFeeCny',
    ]),
    { source: 'order-card-acquiring', reason: '缺收单费', updatedAt }
  );
  const estimatedDeliveryServiceFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'estimatedDeliveryServiceFeeCny', [
      'estimatedDeliveryValueCny',
      'deliveryServiceFeeCny',
    ]),
    { source: 'ozon-mileage-fee', reason: '缺配送服务费', updatedAt }
  );
  const estimatedCrossBorderBusFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'estimatedCrossBorderBusFeeCny', [
      'estimatedCrossBorderFeeValue',
      'estimatedCrossBorderBusFeeValueCny',
      'crossBorderFeeValue',
      'crossBorderBusFeeCny',
      'busFeeCny',
    ]),
    { source: 'cross-border-bus-settings', reason: '缺巴士费用', updatedAt }
  );
  const rawActualCrossBorderBusFee = context.amounts?.actualCrossBorderBusFeeCny;
  const resolvedActualCrossBorderBusFeeValue = isLedgerEntryObject(rawActualCrossBorderBusFee)
    ? amountToCny(rawActualCrossBorderBusFee.value, context.currencyCode || order.currencyCode || 'CNY', context)
    : resolveContextFeeAmount(order, context, 'actualCrossBorderBusFeeCny', [
        'actualCrossBorderFeeValue',
        'actualCrossBorderBusFeeValueCny',
      ]);
  const actualCrossBorderChargeEvidence = [
    context.crossBorderChargeEvidence,
    rawActualCrossBorderBusFee?.evidence,
    order.crossBorderChargeEvidence,
    order.orderSnapshot?.crossBorderChargeEvidence,
  ].find(isPlainObject) ?? null;
  const actualCrossBorderBusFeeSource = normalizeText(
    firstFilled(
      context.actualCrossBorderBusFeeSource,
      rawActualCrossBorderBusFee?.source,
      order.actualCrossBorderBusFeeSource,
      order.orderSnapshot?.actualCrossBorderBusFeeSource,
      actualCrossBorderChargeEvidence?.source
    )
  );
  const actualCrossBorderChargeUpdatedAt = normalizeText(
    firstFilled(
      context.crossBorderChargeUpdatedAt,
      rawActualCrossBorderBusFee?.updatedAt,
      order.crossBorderUpdatedAt,
      order.orderSnapshot?.crossBorderUpdatedAt,
      actualCrossBorderChargeEvidence?.updatedAt,
      updatedAt
    )
  );
  const authoritativeActualCrossBorderCharge = isAuthoritativeActualCrossBorderLedgerEntry(
    createLedgerAmount(resolvedActualCrossBorderBusFeeValue, {
      source: actualCrossBorderBusFeeSource,
      evidence: actualCrossBorderChargeEvidence,
      updatedAt: actualCrossBorderChargeUpdatedAt,
    })
  );
  const zeroActualCrossBorderBusFeeForNoForecast =
    !authoritativeActualCrossBorderCharge && shouldZeroActualCrossBorderBusFeeForNoForecast(order, context);
  const zeroFinalActualCrossBorderBusFeeWithoutExactCharge =
    !authoritativeActualCrossBorderCharge &&
    !zeroActualCrossBorderBusFeeForNoForecast &&
    finalZeroActualStatus &&
    (actualFinanceChecked || actualFinanceStatus === 'provisional' || context.hasActualFinance === true);
  // 实际巴士费必须来自精确匹配的巴士流水。固定费用和手工配置只服务于
  // 预估，不能在缺少真实流水时回退成“实际扣费”，否则取消/退款订单会被
  // 凭空记成亏损。终态取消/退款订单完成财务回查仍无精确流水时确认 0；
  // 未完成回查时保持待确认，后续精确流水始终优先覆盖这份 0 结论。
  const actualCrossBorderBusFeeValue = authoritativeActualCrossBorderCharge
    ? resolvedActualCrossBorderBusFeeValue
    : zeroActualCrossBorderBusFeeForNoForecast
      ? 0
      : zeroFinalActualCrossBorderBusFeeWithoutExactCharge
        ? 0
        : finalZeroActualStatus
          ? null
          : (resolvedActualCrossBorderBusFeeValue ??
            resolveContextFeeAmount(order, context, 'crossBorderBusFeeCny', [
              'crossBorderFeeValue',
              'crossBorderBusFeeCny',
              'busFeeCny',
            ]) ??
            estimatedCrossBorderBusFee.value);
  const actualCrossBorderBusFee = createLedgerAmount(actualCrossBorderBusFeeValue, {
    source: authoritativeActualCrossBorderCharge
      ? actualCrossBorderBusFeeSource
      : zeroActualCrossBorderBusFeeForNoForecast
        ? 'cross-border-no-forecast'
        : zeroFinalActualCrossBorderBusFeeWithoutExactCharge
          ? 'cross-border-final-no-exact-charge'
          : finalZeroActualStatus
            ? 'cross-border-charge-pending'
            : actualCrossBorderBusFeeSource || 'cross-border-bus-settings',
    reason:
      authoritativeActualCrossBorderCharge ||
      zeroActualCrossBorderBusFeeForNoForecast ||
      zeroFinalActualCrossBorderBusFeeWithoutExactCharge ||
      !finalZeroActualStatus
        ? ''
        : '缺跨境巴士实际扣费流水',
    updatedAt: actualCrossBorderChargeUpdatedAt,
    status:
      finalZeroActualStatus &&
      !authoritativeActualCrossBorderCharge &&
      !zeroActualCrossBorderBusFeeForNoForecast &&
      !zeroFinalActualCrossBorderBusFeeWithoutExactCharge
        ? 'pending'
        : actualAmountStatus,
    evidence: actualCrossBorderChargeEvidence,
  });
  const logisticsFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'logisticsFeeCny', [
      'logisticsFeeValueCny',
      'freightCostValue',
      'freightCost',
      'shippingFeeValue',
      'shippingFee',
    ]),
    { source: 'local-logistics', reason: '缺物流费用', updatedAt }
  );
  const actualOzonFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'actualOzonFeeCny', [
      'actualOzonFeeValueCny',
      'platformRealDeductionTotalCny',
    ]) ?? actualZeroFallbackValue,
    { source: 'ozon-finance', reason: '缺财务流水扣费', updatedAt, status: actualAmountStatus }
  );
  const actualCommissionFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'actualCommissionFeeCny', [
      'actualCommissionFeeValueCny',
      'salesCommissionFeeCny',
    ]) ?? actualZeroFallbackValue,
    { source: 'ozon-finance-detail', reason: 'missing actual commission fee', updatedAt, status: actualAmountStatus }
  );
  const actualPenaltyFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'actualPenaltyFeeCny', ['actualPenaltyFeeValueCny', 'penaltyFeeCny']) ??
      readyPenaltyDetailsTotal ??
      actualPenaltyZeroFallbackValue,
    {
      source: penaltyDetails.length ? 'ozon-finance-penalty-detail' : 'ozon-finance-detail',
      reason: 'missing actual penalty fee',
      updatedAt,
      status: actualAmountStatus,
      evidence: penaltyEvidence,
    }
  );
  const actualAcquiringFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'actualAcquiringFeeCny', [
      'actualAcquiringFeeValueCny',
      'acquiringFeeCny',
    ]) ?? actualZeroFallbackValue,
    { source: 'ozon-finance-detail', reason: 'missing actual acquiring fee', updatedAt, status: actualAmountStatus }
  );
  const actualDeliveryServiceFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'actualDeliveryServiceFeeCny', [
      'actualDeliveryServiceFeeValueCny',
      'deliveryServiceFeeCny',
    ]) ?? actualZeroFallbackValue,
    {
      source: 'ozon-finance-detail',
      reason: 'missing actual delivery service fee',
      updatedAt,
      status: actualAmountStatus,
    }
  );
  const actualLogisticsFee = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'actualLogisticsFeeCny', [
      'actualLogisticsFeeValueCny',
      'actualDeliveryFeeCny',
    ]) ?? actualZeroFallbackValue,
    { source: 'ozon-finance-detail', reason: 'missing actual logistics fee', updatedAt, status: actualAmountStatus }
  );
  const actualFeeEntries = [
    actualCommissionFee,
    actualPenaltyFee,
    actualAcquiringFee,
    actualDeliveryServiceFee,
    actualLogisticsFee,
  ];
  const actualOzonFeeFromDetails = actualFeeEntries.every((entry) => entry?.status === 'ready')
    ? sumRequiredFees(actualFeeEntries.map((entry) => entry.value))
    : null;
  const actualOzonFeeValue = toFeeNumber(actualOzonFee.value);
  const effectiveActualOzonFee =
    actualOzonFeeFromDetails !== null &&
    (actualOzonFeeValue === null || Math.abs(actualOzonFeeValue - actualOzonFeeFromDetails) > 0.005)
      ? createLedgerAmount(actualOzonFeeFromDetails, {
          source: 'ozon-finance',
          reason: 'missing actual ozon fee',
          updatedAt,
          status: actualAmountStatus,
        })
      : actualOzonFee;
  const platformNet = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'platformNetCny', ['platformNetValueCny', 'platformNetAmountCny']),
    { source: 'ozon-finance-detail', reason: 'missing platform net amount', updatedAt }
  );
  const refundOrderDeduction = createLedgerAmount(
    resolveContextFeeAmount(order, context, 'refundOrderDeductionFeeCny', [
      'refundOrderDeductionValueCny',
      'orderDeductionFeeCny',
    ]) ?? 0,
    { source: 'ozon-finance-refund', reason: '', updatedAt }
  );

  const estimatedOzonFeeValue = sumRequiredFees([
    estimatedCommissionFee.value,
    estimatedAcquiringFee.value,
    estimatedDeliveryServiceFee.value,
  ]);
  const estimatedOzonFee = createLedgerAmount(estimatedOzonFeeValue, {
    source: 'estimated-ozon-fees',
    reason: getPendingReasons([estimatedCommissionFee, estimatedAcquiringFee, estimatedDeliveryServiceFee]).join('；'),
    updatedAt,
  });
  const estimatedMissing = getPendingReasons([
    actualSalesAmount,
    sourcePurchaseCost,
    estimatedCommissionFee,
    estimatedAcquiringFee,
    estimatedDeliveryServiceFee,
    estimatedCrossBorderBusFee,
    logisticsFee,
  ]);
  const estimatedProfitValue = calculateEstimatedProfitCny({
    orderPaymentCny: salesAmount.value,
    sourcePurchaseCostCny: sourcePurchaseCost.value,
    commissionFeeCny: estimatedCommissionFee.value,
    acquiringFeeCny: estimatedAcquiringFee.value,
    deliveryServiceFeeCny: estimatedDeliveryServiceFee.value,
    crossBorderBusFeeCny: estimatedCrossBorderBusFee.value,
    logisticsFeeCny: logisticsFee.value,
  });
  const estimatedProfit = createLedgerResult(estimatedProfitValue, {
    missing: estimatedMissing,
    reason: estimatedMissing.join('；'),
    formula: '销售收入-采购成本-预估佣金-收单费-配送服务费-巴士费-物流费',
    updatedAt,
  });

  const hasActualFinance =
    context.hasActualFinance ??
    (['ready', 'confirmed', 'provisional'].includes(actualFinanceStatus) || effectiveActualOzonFee.status === 'ready');
  const actualInputs = [
    salesAmount,
    sourcePurchaseCost,
    actualCommissionFee,
    actualPenaltyFee,
    actualAcquiringFee,
    actualDeliveryServiceFee,
    actualLogisticsFee,
    actualCrossBorderBusFee,
  ];
  const forceActualProfitPendingByStatus = shouldForceActualProfitPendingByOrderStatus(order);
  const actualMissing = hasActualFinance
    ? [
        ...getPendingReasons(actualInputs),
        ...(forceActualProfitPendingByStatus ? ['order is not final or completed'] : []),
      ]
    : ['缺财务流水扣费'];
  const actualReady =
    hasActualFinance &&
    context.forceActualProfitPending !== true &&
    !forceActualProfitPendingByStatus &&
    actualInputs.every((entry) => entry?.status === 'ready');
  const actualProfitValue = actualReady
    ? calculateActualProfitWithDetailFees({
        orderPaymentCny: actualSalesAmount.value,
        sourcePurchaseCostCny: sourcePurchaseCost.value,
        actualCommissionFeeCny: actualCommissionFee.value,
        actualPenaltyFeeCny: actualPenaltyFee.value,
        actualAcquiringFeeCny: actualAcquiringFee.value,
        actualDeliveryServiceFeeCny: actualDeliveryServiceFee.value,
        actualLogisticsFeeCny: actualLogisticsFee.value,
        crossBorderBusFeeCny: actualCrossBorderBusFee.value,
      })
    : null;
  const actualProfit = createLedgerResult(actualProfitValue, {
    missing: actualMissing,
    reason: actualMissing.join('；'),
    formula: '销售收入-货源成本-佣金扣费-罚款扣费-收单扣费-配送服务-物流扣费-巴士费用',
    updatedAt,
  });

  const hasRefundLoss = Boolean(context.hasRefundLoss ?? context.refundLossStatus ?? order.signedRefundLoss);
  const refundMissing = hasRefundLoss
    ? getPendingReasons([sourcePurchaseCost, actualCrossBorderBusFee, refundOrderDeduction])
    : ['非拒收/退款损失订单'];
  const refundLossValue = hasRefundLoss
    ? calculateRefundLossCny({
        sourcePurchaseCostCny: sourcePurchaseCost.value,
        crossBorderBusFeeCny: actualCrossBorderBusFee.value,
        orderDeductionFeeCny: refundOrderDeduction.value,
      })
    : null;
  const refundLoss = createLedgerResult(refundLossValue, {
    missing: refundMissing,
    reason: refundMissing.join('；'),
    formula: '采购成本+巴士费+退款相关扣费',
    updatedAt,
  });

  const bestProfitValue =
    refundLoss.status === 'ready'
      ? -refundLoss.value
      : actualProfit.status === 'ready'
        ? actualProfit.value
        : estimatedProfit.status === 'ready'
          ? estimatedProfit.value
          : null;
  const bestProfit = createLedgerResult(bestProfitValue, {
    missing:
      refundLoss.status === 'ready'
        ? []
        : actualProfit.status === 'ready'
          ? []
          : hasActualFinance
            ? actualMissing
            : estimatedMissing,
    reason: hasActualFinance ? actualMissing.join('；') : estimatedMissing.join('；'),
    formula:
      refundLoss.status === 'ready'
        ? '退款损失优先'
        : hasActualFinance
          ? actualProfit.formula
          : estimatedProfit.formula,
    updatedAt,
  });

  const exchangeRates = resolveProfitLedgerExchangeRates(context);
  const row = {
    schemaVersion: PROFIT_LEDGER_SCHEMA_VERSION,
    calculationVersion: PROFIT_LEDGER_CALCULATION_VERSION,
    ledgerKey,
    orderKey: ledgerKey,
    shopId: normalizeText(order.shopId || context.shopId),
    shopClientId: normalizeText(order.shopClientId || context.shopClientId),
    actualFinanceStatus,
    hasActualFinance: hasActualFinance === true,
    financeOperationCount: Math.max(0, Number(context.financeOperationCount ?? order.financeOperationCount) || 0),
    afterSalesCount: Math.max(0, Number(context.afterSalesCount ?? order.afterSalesCount) || 0),
    profitFinanceVersion: normalizeText(context.profitFinanceVersion || order.profitFinanceVersion),
    financeLookupChecked:
      context.financeLookupChecked === true || order.financeLookupChecked === true || actualFinanceChecked,
    updatedAt,
    sourceUpdatedAt: normalizeText(context.sourceUpdatedAt || order.fetchedAt || order.updatedAt),
    exchangeRate: exchangeRates.estimated,
    estimatedExchangeRate: exchangeRates.estimated,
    actualExchangeRate: exchangeRates.actual,
    exchangeRates,
    orderSnapshot: createProfitLedgerOrderSnapshot(order, { ...context, ledgerKey }),
    amounts: {
      ...(buyerCompensationValue !== null || isPartialCompensationSale(order) ? { buyerCompensationCny: createLedgerAmount(buyerCompensationValue, {
        source: 'ozon-buyer-partial-compensation', reason: '部分补偿金额待核实', updatedAt,
      }) } : {}),
      salesAmountCny: salesAmount,
      actualSalesAmountCny: actualSalesAmount,
      sourcePurchaseCostCny: sourcePurchaseCost,
      estimatedCommissionFeeCny: estimatedCommissionFee,
      estimatedAcquiringFeeCny: estimatedAcquiringFee,
      estimatedDeliveryServiceFeeCny: estimatedDeliveryServiceFee,
      estimatedOzonFeeCny: estimatedOzonFee,
      actualOzonFeeCny: effectiveActualOzonFee,
      actualCommissionFeeCny: actualCommissionFee,
      actualPenaltyFeeCny: actualPenaltyFee,
      actualAcquiringFeeCny: actualAcquiringFee,
      actualDeliveryServiceFeeCny: actualDeliveryServiceFee,
      actualLogisticsFeeCny: actualLogisticsFee,
      platformNetCny: platformNet,
      estimatedCrossBorderBusFeeCny: estimatedCrossBorderBusFee,
      actualCrossBorderBusFeeCny: actualCrossBorderBusFee,
      crossBorderBusFeeCny: estimatedCrossBorderBusFee,
      logisticsFeeCny: logisticsFee,
      refundOrderDeductionFeeCny: refundOrderDeduction,
    },
    results: {
      estimatedProfitCny: estimatedProfit,
      actualProfitCny: actualProfit,
      refundLossCny: refundLoss,
      bestProfitCny: bestProfit,
    },
    penaltyDetails,
    status: bestProfit.status === 'ready' ? (bestProfit.value >= 0 ? 'profit' : 'loss') : 'pending',
  };
  return {
    ...row,
    fieldHash: createProfitLedgerHash(row),
  };
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isPlainObject(value)) return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortObject(value[key]);
      return result;
    }, {});
}

const PROFIT_LEDGER_HASH_VOLATILE_KEYS = new Set([
  'createdAt',
  'fetchedAt',
  'fieldHash',
  'localUpdatedAt',
  'readAt',
  'signature',
  'sourceUpdatedAt',
  'updatedAt',
  'verifiedAt',
]);

function sanitizeProfitLedgerHashValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeProfitLedgerHashValue);
  if (!isPlainObject(value)) return value;
  return Object.keys(value)
    .filter((key) => !PROFIT_LEDGER_HASH_VOLATILE_KEYS.has(key))
    .sort()
    .reduce((result, key) => {
      result[key] = sanitizeProfitLedgerHashValue(value[key]);
      return result;
    }, {});
}

function hashString(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createProfitLedgerHash(value = {}) {
  return hashString(
    JSON.stringify(
      sanitizeProfitLedgerHashValue({
        amounts: value.amounts,
        results: value.results,
        penaltyDetails: value.penaltyDetails,
        exchangeRate: value.exchangeRate,
        exchangeRates: value.exchangeRates,
        orderSnapshot: value.orderSnapshot,
        status: value.status,
        schemaVersion: value.schemaVersion,
        calculationVersion: value.calculationVersion,
      })
    )
  );
}

export function createProfitLedgerSnapshot(rows = [], options = {}) {
  const fetchedAt = normalizeText(options.fetchedAt || new Date().toISOString());
  const ledgerRows = rows
    .map((row) =>
      row?.schemaVersion === PROFIT_LEDGER_SCHEMA_VERSION ? row : createProfitLedgerRow(row, options.context)
    )
    .filter((row) => row.ledgerKey);
  return createProfitLedgerSnapshotFromLedgers(ledgerRows, { ...options, fetchedAt });
}

// Persistence is a packaging operation, not permission to run a hidden local
// recalculation. Production callers already have completed ledger rows.
export function createProfitLedgerSnapshotFromLedgers(ledgerRows = [], options = {}) {
  if (!Array.isArray(ledgerRows) || ledgerRows.some(row => !row || row.schemaVersion !== PROFIT_LEDGER_SCHEMA_VERSION || !row.ledgerKey)) {
    throw new Error('PROFIT_LEDGER_SNAPSHOT_REQUIRES_LEDGER_ROWS');
  }
  const fetchedAt = normalizeText(options.fetchedAt || new Date().toISOString());
  return {
    schemaVersion: PROFIT_LEDGER_SCHEMA_VERSION,
    calculationVersion: PROFIT_LEDGER_CALCULATION_VERSION,
    cacheGroup: PROFIT_LEDGER_CACHE_GROUP,
    sourceKey: normalizeText(options.sourceKey),
    rows: ledgerRows,
    penaltyDetails: extractPenaltyDetailsFromRows(ledgerRows),
    total: ledgerRows.length,
    errors: Array.isArray(options.errors) ? options.errors : [],
    fetchedAt,
    updatedAt: fetchedAt,
  };
}

function isEffectivePrimitive(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  const text = normalizeText(value);
  return Boolean(text) && !PLACEHOLDER_VALUES.has(text) && !PLACEHOLDER_VALUES.has(text.toLowerCase());
}

function isReadyLedgerEntry(value) {
  return isPlainObject(value) && value.status === 'ready' && isEffectivePrimitive(value.value);
}

function isProvisionalLedgerEntry(value) {
  return isPlainObject(value) && value.status === 'provisional' && isEffectivePrimitive(value.value);
}

function isLedgerEntryObject(value) {
  return (
    isPlainObject(value) &&
    Object.prototype.hasOwnProperty.call(value, 'status') &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  );
}

const AUTHORITATIVE_CROSS_BORDER_CHARGE_SOURCES = new Set([
  'cross-border-bus-ledger-cash-converted',
  'cross-border-bus-ledger',
  'cross-border-charge-exact',
  'cross-border-recharge-cash-converted',
]);

function isAuthoritativeCrossBorderChargeSource(value) {
  const source = normalizeText(value).toLowerCase();
  if (!source) return false;
  if (AUTHORITATIVE_CROSS_BORDER_CHARGE_SOURCES.has(source)) return true;
  return /^cross-border-(?:bus-)?(?:charge|ledger)-(?:exact|cash-converted)(?:-|$)/.test(source);
}

function hasAuthoritativeCrossBorderChargeEvidence(evidence = null) {
  if (!isPlainObject(evidence)) return false;
  if (isAuthoritativeCrossBorderChargeSource(evidence.source)) return true;
  const collectionNumbers = Array.isArray(evidence.collectionNumbers) ? evidence.collectionNumbers : [];
  const hasCollectionIdentity = Boolean(
    normalizeText(evidence.collectionNumber || evidence.internalOrderId || evidence.sourceHash) ||
      collectionNumbers.some((value) => normalizeText(value))
  );
  return hasCollectionIdentity && toFeeNumber(evidence.actualFeeCny) !== null;
}

function isAuthoritativeActualCrossBorderLedgerEntry(entry = null) {
  return Boolean(
    isReadyLedgerEntry(entry) &&
      (isAuthoritativeCrossBorderChargeSource(entry.source) ||
        hasAuthoritativeCrossBorderChargeEvidence(entry.evidence))
  );
}

function isNoForecastActualCrossBorderLedgerEntry(entry = null) {
  return Boolean(
    isReadyLedgerEntry(entry) &&
      toFeeNumber(entry.value) === 0 &&
      normalizeText(entry.source).toLowerCase() === 'cross-border-no-forecast'
  );
}

function isActualCrossBorderLedgerPath(path = []) {
  return path.length >= 2 && path[path.length - 2] === 'amounts' && path[path.length - 1] === 'actualCrossBorderBusFeeCny';
}

function isPenaltyDetailLedgerEntry(value) {
  return isLedgerEntryObject(value) && normalizeText(value.source) === 'ozon-finance-penalty-detail';
}

function isMissingPurchaseCostZeroEntry(value) {
  return (
    isReadyLedgerEntry(value) &&
    toFeeNumber(value.value) === 0 &&
    normalizeText(value.source) === 'missing-purchase-cost-zero'
  );
}

function hasPenaltyDetailEvidence(value = null) {
  if (!isLedgerEntryObject(value)) return false;
  if (isPenaltyDetailLedgerEntry(value)) return true;
  const records = value.evidence?.records;
  const summaryRecords = value.evidence?.summary?.records;
  return Boolean(
    value.evidence?.summary?.hasPenaltyEvent ||
    (Array.isArray(records) && records.length > 0) ||
    (Array.isArray(summaryRecords) && summaryRecords.length > 0)
  );
}

const PROFIT_ACTUAL_FINANCE_AMOUNT_KEYS = [
  'actualOzonFeeCny',
  'actualCommissionFeeCny',
  'actualPenaltyFeeCny',
  'actualAcquiringFeeCny',
  'actualDeliveryServiceFeeCny',
  'actualLogisticsFeeCny',
  'platformNetCny',
];

function isOzonFinanceLedgerEntry(value = null) {
  if (!isLedgerEntryObject(value)) return false;
  const source = normalizeText(value.source);
  return source === 'ozon-finance' || source.startsWith('ozon-finance-');
}

function hasActualFinanceLedgerEntryEvidence(value = null) {
  if (!isOzonFinanceLedgerEntry(value)) return false;
  if (hasPenaltyDetailEvidence(value)) return true;
  if (!isReadyLedgerEntry(value) && !isProvisionalLedgerEntry(value)) return false;
  return toFeeNumber(value.value) !== null;
}

function hasActualFinanceEvidenceInLedgerRow(row = {}) {
  const amounts = isPlainObject(row.amounts) ? row.amounts : {};
  return PROFIT_ACTUAL_FINANCE_AMOUNT_KEYS.some((key) => hasActualFinanceLedgerEntryEvidence(amounts[key]));
}

function isZeroNonPenaltyLedgerEntry(value = null) {
  return isReadyLedgerEntry(value) && toFeeNumber(value.value) === 0 && !hasPenaltyDetailEvidence(value);
}

function getLedgerPenaltyEvidenceScore(row = null) {
  const penaltyEntry = row?.amounts?.actualPenaltyFeeCny;
  const penaltyValue = isLedgerEntryObject(penaltyEntry) ? toFeeNumber(penaltyEntry.value) : null;
  if (hasPenaltyDetailEvidence(penaltyEntry) && penaltyValue !== null && penaltyValue > 0) return 4;
  if (hasPenaltyDetailEvidence(penaltyEntry)) return 3;
  if (penaltyValue !== null && penaltyValue > 0) return 2;
  return 0;
}

function getLedgerResultCompletenessScore(row = null) {
  return [row?.results?.actualProfitCny, row?.results?.bestProfitCny, row?.results?.estimatedProfitCny].filter(
    (entry) => isReadyLedgerEntry(entry) || isProvisionalLedgerEntry(entry)
  ).length;
}

function getLedgerPurchaseCostEvidenceScore(row = null) {
  const entry = row?.amounts?.sourcePurchaseCostCny;
  if (!isReadyLedgerEntry(entry)) return 0;
  if (isMissingPurchaseCostZeroEntry(entry)) return 0;
  const value = toFeeNumber(entry.value);
  if (value !== null && value > 0) return 2;
  return normalizeText(entry.source) === 'confirmed-no-purchase' ? 1 : 1;
}

function getLedgerFinanceFreshnessScore(row = null) {
  if (!isPlainObject(row)) return 0;
  if (normalizeText(row.actualFinanceStatus).toLowerCase() === 'confirmed') return 4;
  if (normalizeText(row.profitFinanceVersion)) return 3;
  if (row.financeLookupChecked === true) return 2;
  return hasActualFinanceEvidenceInLedgerRow(row) ? 1 : 0;
}

function getLedgerFinanceOperationCount(row = null) {
  if (!isPlainObject(row)) return 0;
  const count = Number(row.financeOperationCount);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function selectProfitLedgerFinanceAuthority(cachedRow = null, freshRow = null) {
  const candidates = [cachedRow, freshRow].filter(isPlainObject);
  return (
    candidates.sort((left, right) => {
      const freshnessDifference = getLedgerFinanceFreshnessScore(right) - getLedgerFinanceFreshnessScore(left);
      if (freshnessDifference) return freshnessDifference;
      const operationDifference = getLedgerFinanceOperationCount(right) - getLedgerFinanceOperationCount(left);
      if (operationDifference) return operationDifference;
      return getLedgerUpdatedTimestamp(right) - getLedgerUpdatedTimestamp(left);
    })[0] ?? null
  );
}

function preserveProfitLedgerFinanceMetadata(mergedRow = {}, cachedRow = null, freshRow = null) {
  const authority = selectProfitLedgerFinanceAuthority(cachedRow, freshRow);
  if (!authority) return mergedRow;
  const operationCount = Math.max(
    getLedgerFinanceOperationCount(cachedRow),
    getLedgerFinanceOperationCount(freshRow)
  );
  const actualFinanceStatus = normalizeText(authority.actualFinanceStatus);
  const profitFinanceVersion = normalizeText(authority.profitFinanceVersion);
  return {
    ...mergedRow,
    actualFinanceStatus: actualFinanceStatus || mergedRow.actualFinanceStatus,
    hasActualFinance:
      cachedRow?.hasActualFinance === true || freshRow?.hasActualFinance === true || authority.hasActualFinance === true,
    financeLookupChecked:
      cachedRow?.financeLookupChecked === true ||
      freshRow?.financeLookupChecked === true ||
      authority.financeLookupChecked === true,
    financeOperationCount: operationCount || mergedRow.financeOperationCount || 0,
    profitFinanceVersion: profitFinanceVersion || mergedRow.profitFinanceVersion,
  };
}

function getLedgerAfterSalesEvidenceScore(row = null) {
  if (!isPlainObject(row)) return 0;
  const count = Number(row.afterSalesCount);
  if (Number.isFinite(count) && count > 0) return Math.min(Math.floor(count), 9);
  return normalizeText(row.orderSnapshot?.afterSalesStatus) ? 1 : 0;
}

function getLedgerUpdatedTimestamp(row = null) {
  if (!isPlainObject(row)) return 0;
  return [row.updatedAt, row.sourceUpdatedAt, row.fetchedAt]
    .map((value) => Date.parse(normalizeText(value)))
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), 0);
}

function getProfitLedgerCandidateScore(row = null) {
  if (!isPlainObject(row) || !isPlainObject(row.amounts) || !isPlainObject(row.results)) return -1;
  return (
    getLedgerPenaltyEvidenceScore(row) * 1_000_000_000_000_000 +
    getLedgerPurchaseCostEvidenceScore(row) * 100_000_000_000_000 +
    getLedgerAfterSalesEvidenceScore(row) * 50_000_000_000_000 +
    getLedgerFinanceFreshnessScore(row) * 10_000_000_000_000 +
    getLedgerResultCompletenessScore(row) * 1_000_000_000_000
  );
}

export function selectBestProfitLedgerRow(candidates = []) {
  return (
    (Array.isArray(candidates) ? candidates : [])
      .filter((row) => isPlainObject(row) && isPlainObject(row.amounts) && isPlainObject(row.results))
      .sort((left, right) => {
        const scoreDifference = getProfitLedgerCandidateScore(right) - getProfitLedgerCandidateScore(left);
        if (scoreDifference) return scoreDifference;
        const operationDifference = getLedgerFinanceOperationCount(right) - getLedgerFinanceOperationCount(left);
        if (operationDifference) return operationDifference;
        return getLedgerUpdatedTimestamp(right) - getLedgerUpdatedTimestamp(left);
      })[0] ?? null
  );
}

export function isEffectiveProfitLedgerValue(value) {
  if (isReadyLedgerEntry(value)) return true;
  if (isProvisionalLedgerEntry(value)) return true;
  if (isLedgerEntryObject(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.values(value).some(isEffectiveProfitLedgerValue);
  return isEffectivePrimitive(value);
}

function mergeLedgerEntry(current, fresh, path = []) {
  if (!isPlainObject(fresh)) return current;
  if (isActualCrossBorderLedgerPath(path)) {
    if (isAuthoritativeActualCrossBorderLedgerEntry(fresh)) return fresh;
    if (isAuthoritativeActualCrossBorderLedgerEntry(current)) return current;
    if (isNoForecastActualCrossBorderLedgerEntry(fresh)) return fresh;
  }
  if (isPenaltyDetailLedgerEntry(fresh)) return fresh;
  if (isMissingPurchaseCostZeroEntry(fresh) && isReadyLedgerEntry(current) && toFeeNumber(current.value) > 0) {
    return current;
  }
  if (hasPenaltyDetailEvidence(current) && isZeroNonPenaltyLedgerEntry(fresh)) return current;
  if (isReadyLedgerEntry(fresh)) return fresh;
  if (isReadyLedgerEntry(current)) return current;
  if (isProvisionalLedgerEntry(fresh)) return fresh;
  if (
    isProvisionalLedgerEntry(current) &&
    fresh?.status === 'pending' &&
    String(fresh?.source || '').startsWith('ozon-finance')
  ) {
    return fresh;
  }
  if (isProvisionalLedgerEntry(current)) return current;
  return {
    ...(isPlainObject(current) ? current : {}),
    ...fresh,
  };
}

const PROFIT_PRODUCT_IMAGE_FIELDS = ['image', 'skuImage', 'primaryImage', 'mainImage', 'thumbnail', 'imageUrl'];
const PROFIT_PRODUCT_IMAGE_ARRAY_FIELDS = ['images', 'skuImages', 'mainImages', 'imageUrls'];

function normalizeProfitProductImageList(value) {
  const values = Array.isArray(value) ? value : [value];
  return uniqueValues(
    values
      .map(normalizeText)
      .filter((item) => item && !PLACEHOLDER_VALUES.has(item) && !PLACEHOLDER_VALUES.has(item.toLowerCase()))
  );
}

function getProfitProductSnapshotIdentity(product = {}, index = 0) {
  return (
    uniqueValues(
      [
        product.offerId,
        product.offer_id,
        product.sku,
        product.skuId,
        product.sku_id,
        product.productId,
        product.product_id,
        product.name,
      ].map(normalizeText)
    ).join('|') || `index:${index}`
  );
}

function mergeProfitProductSnapshot(current = {}, fresh = {}) {
  if (!isPlainObject(current)) return fresh;
  if (!isPlainObject(fresh)) return current;
  const next = { ...current };

  Object.entries(fresh).forEach(([key, value]) => {
    if (PROFIT_PRODUCT_IMAGE_FIELDS.includes(key) || PROFIT_PRODUCT_IMAGE_ARRAY_FIELDS.includes(key)) return;
    next[key] = mergeProfitLedgerValue(next[key], value, ['orderSnapshot', 'products', key]);
  });

  PROFIT_PRODUCT_IMAGE_FIELDS.forEach((field) => {
    const freshValue = normalizeProfitProductImageList(fresh[field])[0] || '';
    const currentValue = normalizeProfitProductImageList(current[field])[0] || '';
    next[field] = freshValue || currentValue || '';
  });

  PROFIT_PRODUCT_IMAGE_ARRAY_FIELDS.forEach((field) => {
    const mergedImages = uniqueValues([
      ...normalizeProfitProductImageList(fresh[field]),
      ...normalizeProfitProductImageList(current[field]),
    ]);
    if (mergedImages.length) {
      next[field] = mergedImages;
    } else if (Array.isArray(next[field])) {
      delete next[field];
    }
  });

  if (!next.image && Array.isArray(next.images) && next.images[0]) next.image = next.images[0];
  if (!next.skuImage && next.image) next.skuImage = next.image;
  if (!next.primaryImage && next.image) next.primaryImage = next.image;
  return next;
}

function mergeProfitProductSnapshots(current = [], fresh = []) {
  const currentProducts = Array.isArray(current) ? current.filter(isPlainObject) : [];
  const freshProducts = Array.isArray(fresh) ? fresh.filter(isPlainObject) : [];
  if (!freshProducts.length) return currentProducts.length ? current : fresh;
  if (!currentProducts.length) return fresh;

  const usedCurrentIndexes = new Set();
  const mergedProducts = freshProducts.map((freshProduct, freshIndex) => {
    const identity = getProfitProductSnapshotIdentity(freshProduct, freshIndex);
    const currentIndex = currentProducts.findIndex((currentProduct, index) => {
      if (usedCurrentIndexes.has(index)) return false;
      return getProfitProductSnapshotIdentity(currentProduct, index) === identity;
    });
    if (currentIndex < 0) return freshProduct;
    usedCurrentIndexes.add(currentIndex);
    return mergeProfitProductSnapshot(currentProducts[currentIndex], freshProduct);
  });

  currentProducts.forEach((currentProduct, index) => {
    if (!usedCurrentIndexes.has(index)) mergedProducts.push(currentProduct);
  });
  return mergedProducts;
}

function mergeProfitLedgerValue(current, fresh, path = []) {
  if (fresh === undefined || fresh === null) return current;
  if (isPlainObject(fresh) && 'status' in fresh && 'value' in fresh) {
    return mergeLedgerEntry(current, fresh, path);
  }
  if (Array.isArray(fresh)) {
    const fieldName = path[path.length - 1];
    const parentName = path[path.length - 2];
    if (parentName === 'orderSnapshot' && fieldName === 'products') {
      return mergeProfitProductSnapshots(current, fresh);
    }
    return fresh.length ? fresh : current;
  }
  if (isPlainObject(fresh)) {
    const next = { ...(isPlainObject(current) ? current : {}) };
    Object.entries(fresh).forEach(([key, value]) => {
      next[key] = mergeProfitLedgerValue(next[key], value, [...path, key]);
    });
    return next;
  }
  return isEffectivePrimitive(fresh) ? fresh : current;
}

function getLedgerRowStatus(row = {}) {
  const value = toFeeNumber(row?.results?.bestProfitCny?.value);
  if (value === null) return 'pending';
  return value >= 0 ? 'profit' : 'loss';
}

function getProfitLedgerOrderStatusText(row = {}) {
  const snapshot = isPlainObject(row.orderSnapshot) ? row.orderSnapshot : row;
  return [
    snapshot.status,
    snapshot.statusLabel,
    snapshot.detailStatus,
    snapshot.ozonStatus,
    snapshot.ozonStatusLabel,
    snapshot.rawStatus,
    snapshot.ozonRawStatus,
    snapshot.rawSubstatus,
    snapshot.rawPostingStatus,
    snapshot.substatus,
    snapshot.afterSalesStatus,
    snapshot.raw?.status,
    snapshot.raw?.substatus,
    snapshot.raw?.posting_status,
    snapshot.raw?.postingStatus,
    snapshot.raw?.analytics_data?.status,
    snapshot.raw?.financial_data?.status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isProfitLedgerFinalOrClosedStatus(statusText = '') {
  return /成功订单|已完成|完成|已签收|签收|已送达|delivered|received|signed|success|拒收后退款|已退款|退款|关闭订单|已关闭|关闭|已取消|取消|posting_canceled|cancel|canceled|cancelled|not_accepted|refus|reject/.test(
    statusText
  );
}

function isProfitLedgerFinalZeroActualStatus(statusText = '') {
  return /拒收后退款|已退款|退款|关闭订单|已关闭|关闭|已取消|取消|posting_canceled|cancel|canceled|cancelled|not_accepted|refus|reject/.test(
    statusText
  );
}

function isProfitLedgerActualFinanceChecked(row = {}, context = {}) {
  const status = normalizeText(firstFilled(context.actualFinanceStatus, row.actualFinanceStatus)).toLowerCase();
  if (status === 'confirmed' || status === 'provisional') return true;
  if (status === 'pending' || status === 'partial') return false;
  if (context.hasActualFinance === true || context.financeLookupChecked === true || row.financeLookupChecked === true) {
    return true;
  }
  if (normalizeText(context.profitFinanceVersion || row.profitFinanceVersion)) return true;
  if (Array.isArray(context.penaltyDetails) && context.penaltyDetails.length > 0) return true;
  if (hasPenaltyDetailEvidence(row.amounts?.actualPenaltyFeeCny)) return true;
  return hasActualFinanceEvidenceInLedgerRow(row);
}

function hasProfitLedgerCrossBorderForecastIdentifier(row = {}, context = {}) {
  const sourceRow = isPlainObject(row) ? row : {};
  const sourceSnapshot = isPlainObject(sourceRow.orderSnapshot) ? sourceRow.orderSnapshot : {};
  const actualCrossBorderEntry = isLedgerEntryObject(sourceRow.amounts?.actualCrossBorderBusFeeCny)
    ? sourceRow.amounts.actualCrossBorderBusFeeCny
    : null;
  const contextActualCrossBorderEntry = isLedgerEntryObject(context.amounts?.actualCrossBorderBusFeeCny)
    ? context.amounts.actualCrossBorderBusFeeCny
    : null;
  const directCrossBorderChargeEvidence = [
    context.crossBorderChargeEvidence,
    sourceRow.crossBorderChargeEvidence,
    sourceSnapshot.crossBorderChargeEvidence,
  ].find(isPlainObject) ?? null;
  const hasAuthoritativeCharge = Boolean(
    isAuthoritativeActualCrossBorderLedgerEntry(actualCrossBorderEntry) ||
      isAuthoritativeActualCrossBorderLedgerEntry(contextActualCrossBorderEntry) ||
      isAuthoritativeCrossBorderChargeSource(
        firstFilled(
          context.actualCrossBorderBusFeeSource,
          sourceRow.actualCrossBorderBusFeeSource,
          sourceSnapshot.actualCrossBorderBusFeeSource
        )
      ) ||
      hasAuthoritativeCrossBorderChargeEvidence(directCrossBorderChargeEvidence)
  );
  const snapshot = {
    ...sourceSnapshot,
    ...sourceRow,
    ...(isPlainObject(context.crossBorderInfo) ? { crossBorderInfo: context.crossBorderInfo } : {}),
    packageOrderId: firstFilled(sourceRow.packageOrderId, sourceSnapshot.packageOrderId, context.packageOrderId),
    crossBorderOrderId: firstFilled(
      sourceRow.crossBorderOrderId,
      sourceSnapshot.crossBorderOrderId,
      context.crossBorderOrderId
    ),
    crossBorderOrderNumber: firstFilled(
      sourceRow.crossBorderOrderNumber,
      sourceSnapshot.crossBorderOrderNumber,
      context.crossBorderOrderNumber
    ),
    packageOrderIds: [
      ...(Array.isArray(sourceSnapshot.packageOrderIds) ? sourceSnapshot.packageOrderIds : []),
      ...(Array.isArray(sourceRow.packageOrderIds) ? sourceRow.packageOrderIds : []),
      ...(Array.isArray(context.packageOrderIds) ? context.packageOrderIds : []),
    ],
    crossBorderOrderFound:
      sourceRow.crossBorderOrderFound === true ||
      sourceSnapshot.crossBorderOrderFound === true ||
      context.crossBorderOrderFound === true,
  };
  const crossBorderInfo = isPlainObject(snapshot.crossBorderInfo) ? snapshot.crossBorderInfo : {};
  const packageOrderIds = Array.isArray(snapshot.packageOrderIds) ? snapshot.packageOrderIds : [];
  return Boolean(
    hasAuthoritativeCharge ||
    snapshot.crossBorderOrderFound === true ||
    packageOrderIds.some(isEffectivePrimitive) ||
    isEffectivePrimitive(
      firstFilled(
        snapshot.packageOrderId,
        snapshot.crossBorderOrderId,
        snapshot.crossBorderOrderNumber,
        snapshot.sheetOrderSn,
        snapshot.sheetOrderNumber,
        snapshot.sheet_order_sn,
        crossBorderInfo.orderId,
        crossBorderInfo.order_id,
        crossBorderInfo.orderNumber,
        crossBorderInfo.order_number,
        crossBorderInfo.sheetOrderSn,
        crossBorderInfo.sheet_order_sn
      )
    )
  );
}

function hasProfitLedgerCheckedNoCrossBorderForecast(row = {}, context = {}) {
  if (hasProfitLedgerCrossBorderForecastIdentifier(row, context)) return false;
  const sourceRow = isPlainObject(row) ? row : {};
  const sourceSnapshot = isPlainObject(sourceRow.orderSnapshot) ? sourceRow.orderSnapshot : {};
  const sourceCrossBorderInfo = isPlainObject(sourceRow.crossBorderInfo) ? sourceRow.crossBorderInfo : {};
  const snapshotCrossBorderInfo = isPlainObject(sourceSnapshot.crossBorderInfo) ? sourceSnapshot.crossBorderInfo : {};
  const contextCrossBorderInfo = isPlainObject(context.crossBorderInfo) ? context.crossBorderInfo : {};
  const evidenceText = [
    context.crossBorderReadStatus,
    context.readStatus,
    context.crossBorderStatus,
    context.crossBorderLookupStatus,
    context.purchaseLookupStatus,
    contextCrossBorderInfo.readStatus,
    contextCrossBorderInfo.status,
    contextCrossBorderInfo.message,
    sourceRow.crossBorderReadStatus,
    sourceRow.readStatus,
    sourceRow.crossBorderStatus,
    sourceRow.crossBorderLookupStatus,
    sourceRow.purchaseLookupStatus,
    sourceCrossBorderInfo.readStatus,
    sourceCrossBorderInfo.status,
    sourceCrossBorderInfo.message,
    sourceSnapshot.crossBorderReadStatus,
    sourceSnapshot.readStatus,
    sourceSnapshot.crossBorderStatus,
    sourceSnapshot.crossBorderLookupStatus,
    sourceSnapshot.purchaseLookupStatus,
    snapshotCrossBorderInfo.readStatus,
    snapshotCrossBorderInfo.status,
    snapshotCrossBorderInfo.message,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!evidenceText) return false;
  return /未查到|未找到|无预报|没有预报|无记录|没有记录|not\s*found|no\s*record|not_found/.test(
    evidenceText
  );
}

function getProfitLedgerCancellationEvidence(row = {}, context = {}) {
  const sourceRow = isPlainObject(row) ? row : {};
  const sourceSnapshot = isPlainObject(sourceRow.orderSnapshot) ? sourceRow.orderSnapshot : {};
  const contextRaw = isPlainObject(context.raw) ? context.raw : {};
  const sourceRaw = isPlainObject(sourceRow.raw) ? sourceRow.raw : {};
  const snapshotRaw = isPlainObject(sourceSnapshot.raw) ? sourceSnapshot.raw : {};
  const cancellations = [
    context.cancellation,
    contextRaw.cancellation,
    sourceRow.cancellation,
    sourceRaw.cancellation,
    sourceSnapshot.cancellation,
    snapshotRaw.cancellation,
  ].filter(isPlainObject);
  const cancelledAfterShip = readExplicitBooleanFlag(
    context.cancelledAfterShip,
    context.cancelled_after_ship,
    sourceRow.cancelledAfterShip,
    sourceRow.cancelled_after_ship,
    sourceSnapshot.cancelledAfterShip,
    sourceSnapshot.cancelled_after_ship,
    ...cancellations.flatMap((cancellation) => [
      cancellation.cancelled_after_ship,
      cancellation.canceled_after_ship,
      cancellation.cancelledAfterShip,
      cancellation.canceledAfterShip,
    ])
  );
  const statusText = [
    context.afterSalesStatus,
    context.cancellationStage,
    sourceRow.afterSalesStatus,
    sourceRow.cancellationStage,
    sourceSnapshot.afterSalesStatus,
    sourceSnapshot.cancellationStage,
    context.status,
    sourceRow.status,
    sourceSnapshot.status,
    sourceRow.rawStatus,
    sourceSnapshot.rawStatus,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return { cancelledAfterShip, statusText };
}

function hasProfitLedgerDefinitivePreShipmentCancellation(row = {}, context = {}) {
  const { cancelledAfterShip, statusText } = getProfitLedgerCancellationEvidence(row, context);
  if (cancelledAfterShip !== null) return cancelledAfterShip === false;
  return /发货前取消|取消于发货前|before[\s_-]*ship|pre[\s_-]*shipment/.test(statusText);
}

function shouldZeroActualCrossBorderBusFeeForNoForecast(row = {}, context = {}) {
  return (
    isProfitLedgerFinalZeroActualStatus(getProfitLedgerOrderStatusText(row)) &&
    isProfitLedgerActualFinanceChecked(row, context) &&
    !hasProfitLedgerCrossBorderForecastIdentifier(row, context) &&
    (hasProfitLedgerCheckedNoCrossBorderForecast(row, context) ||
      hasProfitLedgerDefinitivePreShipmentCancellation(row, context))
  );
}

function isProfitLedgerInProgressStatus(statusText = '') {
  return /等待|待发货|待备货|即将超时|发货超时|配送超时|已经发货|已发货|发货中|运输中|派送|awaiting|deliver|shipping|in_transit|processing/.test(
    statusText
  );
}

function shouldForceActualProfitPendingByOrderStatus(row = {}) {
  const statusText = getProfitLedgerOrderStatusText(row);
  if (!statusText) return false;
  if (isProfitLedgerFinalOrClosedStatus(statusText)) return false;
  return isProfitLedgerInProgressStatus(statusText);
}

function getReadyLedgerAmountValue(entry) {
  return isReadyLedgerEntry(entry) ? toFeeNumber(entry.value) : null;
}

function recomputeProfitLedgerResults(row = {}) {
  const amounts = isPlainObject(row.amounts) ? row.amounts : {};
  const updatedAt = normalizeText(row.updatedAt || new Date().toISOString());
  const scopedPenaltyDetails = getLedgerRowScopedPenaltyDetails(row);
  const readyPenaltyDetailsTotal = getReadyPenaltyDetailsTotal(scopedPenaltyDetails);
  const existingPenaltySummary = row.amounts?.actualPenaltyFeeCny?.evidence?.summary ?? null;
  const penaltySummary = scopedPenaltyDetails.length
    ? {
        schemaVersion: 1,
        status: readyPenaltyDetailsTotal === null ? 'pending' : 'ready',
        hasPenaltyEvent: true,
        hasReadyPenaltyAmount: scopedPenaltyDetails.some(isReadyPenaltyDetail),
        hasPendingPenaltyAmount: scopedPenaltyDetails.some((record) => !isReadyPenaltyDetail(record)),
        totalCny: readyPenaltyDetailsTotal,
        count: scopedPenaltyDetails.length,
        readyCount: scopedPenaltyDetails.filter(isReadyPenaltyDetail).length,
        pendingCount: scopedPenaltyDetails.filter((record) => !isReadyPenaltyDetail(record)).length,
        records: scopedPenaltyDetails,
      }
    : existingPenaltySummary;
  const salesAmount = amounts.salesAmountCny;
  const financeChecked = isProfitLedgerActualFinanceChecked(row);
  const finalZeroActualStatus = !isPartialCompensationSale(row) && isProfitLedgerFinalZeroActualStatus(getProfitLedgerOrderStatusText(row));
  const actualSalesAmount =
    isPartialCompensationSale(row)
      ? createLedgerAmount(isReadyLedgerEntry(salesAmount) && isReadyLedgerEntry(amounts.buyerCompensationCny)
        ? salesAmount.value - amounts.buyerCompensationCny.value : null,
      { source: 'actual-order-income-after-compensation', reason: '部分补偿金额待核实', updatedAt })
      : finalZeroActualStatus && financeChecked
      ? createLedgerAmount(0, {
          source: 'actual-order-income',
          reason: '',
          updatedAt,
        })
      : amounts.actualSalesAmountCny || salesAmount;
  const sourcePurchaseCost = amounts.sourcePurchaseCostCny;
  const estimatedCommissionFee = amounts.estimatedCommissionFeeCny;
  const estimatedAcquiringFee = amounts.estimatedAcquiringFeeCny;
  const estimatedDeliveryServiceFee = amounts.estimatedDeliveryServiceFeeCny;
  const estimatedCrossBorderBusFee = amounts.estimatedCrossBorderBusFeeCny || amounts.crossBorderBusFeeCny;
  const cachedActualCrossBorderBusFee = amounts.actualCrossBorderBusFeeCny;
  const zeroActualCrossBorderBusFeeForNoForecast = shouldZeroActualCrossBorderBusFeeForNoForecast(row);
  const zeroFinalActualCrossBorderBusFeeWithoutExactCharge = finalZeroActualStatus && financeChecked;
  const actualCrossBorderBusFee = isAuthoritativeActualCrossBorderLedgerEntry(cachedActualCrossBorderBusFee)
    ? cachedActualCrossBorderBusFee
    : zeroActualCrossBorderBusFeeForNoForecast
      ? createLedgerAmount(0, {
          source: 'cross-border-no-forecast',
          reason: '',
          updatedAt,
        })
      : finalZeroActualStatus
        ? zeroFinalActualCrossBorderBusFeeWithoutExactCharge
          ? createLedgerAmount(0, {
              source: 'cross-border-final-no-exact-charge',
              reason: '',
              updatedAt,
            })
          : createLedgerAmount(null, {
              source: 'cross-border-charge-pending',
              reason: '缺跨境巴士实际扣费流水',
              updatedAt,
            })
        : (isReadyLedgerEntry(cachedActualCrossBorderBusFee) ||
            isProvisionalLedgerEntry(cachedActualCrossBorderBusFee))
          ? cachedActualCrossBorderBusFee
          : amounts.crossBorderBusFeeCny || estimatedCrossBorderBusFee;
  const logisticsFee = amounts.logisticsFeeCny;
  const actualCommissionFee = amounts.actualCommissionFeeCny;
  const currentActualPenaltyFee = amounts.actualPenaltyFeeCny;
  const currentActualPenaltyValue = getReadyLedgerAmountValue(currentActualPenaltyFee);
  const actualPenaltyFee =
    readyPenaltyDetailsTotal !== null &&
    (currentActualPenaltyValue === null || Math.abs(currentActualPenaltyValue - readyPenaltyDetailsTotal) > 0.005)
      ? createLedgerAmount(readyPenaltyDetailsTotal, {
          source: 'ozon-finance-penalty-detail',
          reason: 'missing actual penalty fee',
          updatedAt,
          evidence: {
            summary: penaltySummary,
            records: scopedPenaltyDetails,
          },
        })
      : currentActualPenaltyFee;
  const actualAcquiringFee = amounts.actualAcquiringFeeCny;
  const actualDeliveryServiceFee = amounts.actualDeliveryServiceFeeCny;
  const actualLogisticsFee = amounts.actualLogisticsFeeCny;
  const actualOzonFee = amounts.actualOzonFeeCny;
  const actualFeeEntries = [
    actualCommissionFee,
    actualPenaltyFee,
    actualAcquiringFee,
    actualDeliveryServiceFee,
    actualLogisticsFee,
  ];
  const actualFeeTotal = actualFeeEntries.every(isReadyLedgerEntry)
    ? actualFeeEntries.reduce((sum, entry) => sum + (getReadyLedgerAmountValue(entry) ?? 0), 0)
    : null;
  const currentActualOzonFeeValue = getReadyLedgerAmountValue(actualOzonFee);
  const nextActualOzonFee =
    actualFeeTotal !== null &&
    (currentActualOzonFeeValue === null || Math.abs(currentActualOzonFeeValue - actualFeeTotal) > 0.005)
      ? createLedgerAmount(actualFeeTotal, {
          source: 'ozon-finance',
          reason: '缺财务流水扣费',
          updatedAt,
        })
      : actualOzonFee;
  const nextAmounts = {
    ...amounts,
    actualSalesAmountCny: actualSalesAmount,
    actualOzonFeeCny: nextActualOzonFee,
    actualPenaltyFeeCny: actualPenaltyFee,
    estimatedCrossBorderBusFeeCny: estimatedCrossBorderBusFee,
    actualCrossBorderBusFeeCny: actualCrossBorderBusFee,
    crossBorderBusFeeCny: estimatedCrossBorderBusFee,
  };

  const estimatedInputs = [
    salesAmount,
    sourcePurchaseCost,
    estimatedCommissionFee,
    estimatedAcquiringFee,
    estimatedDeliveryServiceFee,
    estimatedCrossBorderBusFee,
    logisticsFee,
  ];
  const estimatedMissing = getPendingReasons(estimatedInputs);
  const estimatedProfit = createLedgerResult(
    estimatedInputs.every(isReadyLedgerEntry)
      ? calculateEstimatedProfitCny({
          orderPaymentCny: getReadyLedgerAmountValue(salesAmount),
          sourcePurchaseCostCny: getReadyLedgerAmountValue(sourcePurchaseCost),
          commissionFeeCny: getReadyLedgerAmountValue(estimatedCommissionFee),
          acquiringFeeCny: getReadyLedgerAmountValue(estimatedAcquiringFee),
          deliveryServiceFeeCny: getReadyLedgerAmountValue(estimatedDeliveryServiceFee),
          crossBorderBusFeeCny: getReadyLedgerAmountValue(estimatedCrossBorderBusFee),
          logisticsFeeCny: getReadyLedgerAmountValue(logisticsFee),
        })
      : null,
    {
      missing: estimatedMissing,
      reason: estimatedMissing.join('; '),
      formula: 'sales-source-estimatedFees-bus-logistics',
      updatedAt,
    }
  );

  const actualInputs = [
    actualSalesAmount,
    sourcePurchaseCost,
    actualCommissionFee,
    actualPenaltyFee,
    actualAcquiringFee,
    actualDeliveryServiceFee,
    actualLogisticsFee,
    actualCrossBorderBusFee,
  ];
  const forceActualProfitPendingByStatus = shouldForceActualProfitPendingByOrderStatus(row);
  const actualMissing = [
    ...(!financeChecked ? ['缺财务流水扣费'] : []),
    ...getPendingReasons(actualInputs),
    ...(forceActualProfitPendingByStatus ? ['order is not final or completed'] : []),
  ];
  const actualProfit = createLedgerResult(
    financeChecked && !forceActualProfitPendingByStatus && actualInputs.every(isReadyLedgerEntry)
      ? calculateActualProfitWithDetailFees({
          orderPaymentCny: getReadyLedgerAmountValue(actualSalesAmount),
          sourcePurchaseCostCny: getReadyLedgerAmountValue(sourcePurchaseCost),
          actualCommissionFeeCny: getReadyLedgerAmountValue(actualCommissionFee),
          actualPenaltyFeeCny: getReadyLedgerAmountValue(actualPenaltyFee),
          actualAcquiringFeeCny: getReadyLedgerAmountValue(actualAcquiringFee),
          actualDeliveryServiceFeeCny: getReadyLedgerAmountValue(actualDeliveryServiceFee),
          actualLogisticsFeeCny: getReadyLedgerAmountValue(actualLogisticsFee),
          crossBorderBusFeeCny: getReadyLedgerAmountValue(actualCrossBorderBusFee),
        })
      : null,
    {
      missing: actualMissing,
      reason: actualMissing.join('; '),
      formula: 'actualIncome-source-commission-penalty-acquiring-delivery-logistics-bus',
      updatedAt,
    }
  );

  const existingRefundLoss = row.results?.refundLossCny;
  const refundLoss = isPlainObject(existingRefundLoss)
    ? existingRefundLoss
    : createLedgerResult(null, { reason: 'not a refund loss order', updatedAt });
  const bestProfitValue =
    refundLoss.status === 'ready'
      ? -refundLoss.value
      : actualProfit.status === 'ready'
        ? actualProfit.value
        : estimatedProfit.status === 'ready'
          ? estimatedProfit.value
          : null;
  const bestProfit = createLedgerResult(bestProfitValue, {
    missing:
      refundLoss.status === 'ready'
        ? []
        : actualProfit.status === 'ready'
          ? []
          : actualMissing.length
            ? actualMissing
            : estimatedMissing,
    reason: actualMissing.length ? actualMissing.join('; ') : estimatedMissing.join('; '),
    formula:
      refundLoss.status === 'ready'
        ? 'refundLoss'
        : actualProfit.status === 'ready'
          ? actualProfit.formula
          : estimatedProfit.formula,
    updatedAt,
  });

  return {
    ...row,
    actualFinanceStatus: row.actualFinanceStatus || (financeChecked ? 'confirmed' : ''),
    hasActualFinance: row.hasActualFinance === true || financeChecked,
    financeLookupChecked: row.financeLookupChecked === true || financeChecked,
    amounts: nextAmounts,
    penaltyDetails: scopedPenaltyDetails.length ? scopedPenaltyDetails : row.penaltyDetails,
    results: {
      ...(isPlainObject(row.results) ? row.results : {}),
      estimatedProfitCny: estimatedProfit,
      actualProfitCny: actualProfit,
      refundLossCny: refundLoss,
      bestProfitCny: bestProfit,
    },
  };
}

function recomputeMergedLedgerRow(row = {}) {
  const next = recomputeProfitLedgerResults(row);
  return {
    ...next,
    status: getLedgerRowStatus(next),
    fieldHash: createProfitLedgerHash(next),
  };
}

const MIGRATED_COMMISSION_REBUILD_REASON =
  '佣金规则已升级，等待按当前 rFBS 商品比例和 Ozon 财务流水重建';

function createMigratedCommissionPendingAmount(source = '') {
  return createLedgerAmount(null, {
    source,
    reason: MIGRATED_COMMISSION_REBUILD_REASON,
  });
}

/**
 * v13 之前的快照可能没有完整读取 finance operation 的 sale_commission。
 * 迁移时只让实际佣金及其 Ozon 汇总等待财务流水重建；旧的预估佣金必须
 * 保留，避免升级过程把整张利润表置为“待确认”。利润页随后会用当前商品
 * 缓存中的精确 rFBS 比例覆盖这份预估值。
 */
function invalidateMigratedCommissionEvidence(row = {}) {
  const amounts = isPlainObject(row.amounts) ? row.amounts : {};
  return {
    ...row,
    amounts: {
      ...amounts,
      actualCommissionFeeCny: createMigratedCommissionPendingAmount('ozon-finance-sale-commission'),
      actualOzonFeeCny: createMigratedCommissionPendingAmount('ozon-finance'),
    },
  };
}

export function migrateProfitLedgerRowToCurrentVersion(row = null) {
  if (!isPlainObject(row) || !(row.ledgerKey || row.orderKey)) return null;
  const calculationVersion = normalizeText(row.calculationVersion);
  const isCurrentVersion = calculationVersion === PROFIT_LEDGER_CALCULATION_VERSION;
  const isMigratableVersion = PROFIT_LEDGER_MIGRATABLE_CALCULATION_VERSIONS.includes(calculationVersion);
  const preservesCurrentCommissionEvidence =
    calculationVersion === 'profit-ledger-v16-per-order-finance-exchange-rate' ||
    calculationVersion === 'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge' ||
    calculationVersion === 'profit-ledger-v14-final-cross-border-charge-evidence' ||
    calculationVersion === 'profit-ledger-v13-rfbs-finance-commission';
  const requiresCommissionRebuild = isMigratableVersion && !preservesCurrentCommissionEvidence;
  if (!isCurrentVersion && !isMigratableVersion) return null;

  const versionedRow = canonicalizeProfitLedgerRowKey({
    ...row,
    schemaVersion: PROFIT_LEDGER_SCHEMA_VERSION,
    calculationVersion: PROFIT_LEDGER_CALCULATION_VERSION,
    ...(isMigratableVersion ? { migratedFromCalculationVersion: calculationVersion } : {}),
  });
  if (calculationVersion === 'profit-ledger-v15-final-cancel-zero-bus-without-exact-charge'
    || calculationVersion === 'profit-ledger-v16-per-order-finance-exchange-rate') {
    // This is a storage/version migration, not a change of financial rules.
    return { ...versionedRow, fieldHash: createProfitLedgerHash(versionedRow) };
  }
  return recomputeMergedLedgerRow(
    requiresCommissionRebuild ? invalidateMigratedCommissionEvidence(versionedRow) : versionedRow
  );
}

export function mergeProfitLedgerRows(cachedRows = [], freshRows = [], options = {}) {
  const keepUnseenCached = options.keepUnseenCached !== false;
  const cachedByKey = new Map();
  (Array.isArray(cachedRows) ? cachedRows : [])
    .map(canonicalizeProfitLedgerRowKey)
    .filter((row) => row?.ledgerKey || row?.orderKey)
    .forEach((row) => {
      const key = getProfitLedgerCanonicalRowKey(row);
      const current = cachedByKey.get(key);
      cachedByKey.set(key, current ? selectBestProfitLedgerRow([current, row]) : row);
    });
  const seenFreshKeys = new Set();
  const mergedFreshRows = (Array.isArray(freshRows) ? freshRows : [])
    .map(canonicalizeProfitLedgerRowKey)
    .map((freshRow) => {
      const key = getProfitLedgerCanonicalRowKey(freshRow);
      if (!key) return null;
      seenFreshKeys.add(key);
      const cachedRow = cachedByKey.get(key);
      const mergedRow = mergeProfitLedgerValue(cachedRow, freshRow);
      return recomputeMergedLedgerRow(canonicalizeProfitLedgerRowKey(
        preserveProfitLedgerFinanceMetadata(mergedRow, cachedRow, freshRow)
      ));
    })
    .filter(Boolean);

  if (!keepUnseenCached) return mergedFreshRows;
  const cachedOnlyRows = [...cachedByKey.entries()].filter(([key]) => !seenFreshKeys.has(key)).map(([, row]) => row);
  return [...mergedFreshRows, ...cachedOnlyRows];
}

function runLocalProfitLedgerSteps(iterator) {
  if (usesPrivateProfitExecution) throw new Error('PROFIT_LOCAL_EXECUTION_DISABLED');
  let state = iterator.next();
  try {
    while (!state.done) {
      const task = state.value;
      if (task.operation === 'migrate-ledgers') state = iterator.next(task.rows.map(migrateProfitLedgerRowToCurrentVersion).filter(Boolean));
      else if (task.operation === 'merge-ledgers') state = iterator.next(mergeProfitLedgerRows(task.cachedRows, task.freshRows, task.options));
      else throw new Error('PROFIT_LEDGER_STEP_INVALID');
    }
    return state.value;
  } finally { iterator.return?.(); }
}

export function mergeProfitLedgerSnapshot(cachedSnapshot = {}, freshSnapshot = {}, options = {}) {
  return runLocalProfitLedgerSteps(mergeProfitLedgerSnapshotSteps(cachedSnapshot, freshSnapshot, options));
}

function* mergeProfitLedgerSnapshotSteps(cachedSnapshot = {}, freshSnapshot = {}, options = {}) {
  const cachedRows = Array.isArray(cachedSnapshot?.rows) ? cachedSnapshot.rows : [];
  const freshRows = Array.isArray(freshSnapshot?.rows) ? freshSnapshot.rows : [];
  const freshErrors = Array.isArray(freshSnapshot?.errors) ? freshSnapshot.errors : [];
  const keepCachedRows = freshRows.length === 0 && freshErrors.length > 0;
  const rows = keepCachedRows
    ? cachedRows
    : yield { operation: 'merge-ledgers', cachedRows, freshRows, options: { keepUnseenCached: options.keepUnseenCached } };
  return {
    ...(isPlainObject(cachedSnapshot) ? cachedSnapshot : {}),
    ...(isPlainObject(freshSnapshot) ? freshSnapshot : {}),
    schemaVersion: PROFIT_LEDGER_SCHEMA_VERSION,
    calculationVersion: PROFIT_LEDGER_CALCULATION_VERSION,
    cacheGroup: PROFIT_LEDGER_CACHE_GROUP,
    rows,
    penaltyDetails: {
      ...(isPlainObject(cachedSnapshot?.penaltyDetails) ? cachedSnapshot.penaltyDetails : {}),
      ...extractPenaltyDetailsFromRows(rows),
    },
    total: rows.length,
    errors: freshErrors.length ? freshErrors : Array.isArray(cachedSnapshot?.errors) ? cachedSnapshot.errors : [],
    updatedAt: freshSnapshot?.updatedAt || freshSnapshot?.fetchedAt || cachedSnapshot?.updatedAt || '',
  };
}

function createProfitLedgerSnapshotStableHash(snapshot = {}) {
  const rows = (Array.isArray(snapshot?.rows) ? snapshot.rows : [])
    .map((row) => ({
      key: normalizeText(row?.ledgerKey || row?.orderKey),
      hash: createProfitLedgerHash(row),
    }))
    .filter((row) => row.key && row.hash)
    .sort((left, right) => left.key.localeCompare(right.key));
  return hashString(
    JSON.stringify(
      sortObject({
        schemaVersion: PROFIT_LEDGER_SCHEMA_VERSION,
        calculationVersion: PROFIT_LEDGER_CALCULATION_VERSION,
        rows,
        errors: Array.isArray(snapshot?.errors) ? snapshot.errors.map(sanitizeProfitLedgerHashValue) : [],
        penaltyDetails: sanitizeProfitLedgerHashValue(snapshot?.penaltyDetails ?? snapshot?.profitPenaltyDetails ?? {}),
      })
    )
  );
}

export function normalizeProfitLedgerStore(store = {}) {
  const normalized = isPlainObject(store) ? { ...store } : {};
  return {
    ...normalized,
    profitLedgerSnapshots: trimProfitLedgerSnapshots(normalized.profitLedgerSnapshots),
    profitPenaltyDetails: isPlainObject(normalized.profitPenaltyDetails) ? normalized.profitPenaltyDetails : {},
  };
}

function normalizeProfitLedgerSnapshotKeys(snapshotKey = '') {
  return uniqueValues((Array.isArray(snapshotKey) ? snapshotKey : [snapshotKey]).map(normalizeText));
}

const LEGACY_SECRET_CACHE_KEY_SEGMENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeProfitLedgerSnapshotKeyForCompatibility(snapshotKey = '') {
  return normalizeText(snapshotKey)
    .split(':')
    .filter((part) => !LEGACY_SECRET_CACHE_KEY_SEGMENT_PATTERN.test(part))
    .join(':');
}

function findCompatibleProfitLedgerSnapshotKey(snapshotMap = {}, keys = []) {
  const directKey = keys.find((candidateKey) => {
    const snapshot = snapshotMap[candidateKey];
    return isPlainObject(snapshot) && Array.isArray(snapshot.rows);
  });
  if (directKey) return directKey;

  const compatibleKeys = new Set(keys.map(normalizeProfitLedgerSnapshotKeyForCompatibility).filter(Boolean));
  if (!compatibleKeys.size) return '';

  return (
    Object.entries(snapshotMap).find(([storedKey, snapshot]) => {
      return (
        isPlainObject(snapshot) &&
        Array.isArray(snapshot.rows) &&
        compatibleKeys.has(normalizeProfitLedgerSnapshotKeyForCompatibility(storedKey))
      );
    })?.[0] || ''
  );
}

export function readProfitLedgerSnapshotFromStore(store = {}, snapshotKey = '') {
  return runLocalProfitLedgerSteps(readProfitLedgerSnapshotSteps(store, snapshotKey));
}

export function* readProfitLedgerSnapshotSteps(store = {}, snapshotKey = '') {
  const keys = normalizeProfitLedgerSnapshotKeys(snapshotKey);
  if (!keys.length) return null;
  const normalizedStore = normalizeProfitLedgerStore(store);
  const key = findCompatibleProfitLedgerSnapshotKey(normalizedStore.profitLedgerSnapshots, keys);
  if (!key) return null;
  const snapshot = normalizedStore.profitLedgerSnapshots[key];
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.rows)) return null;
  const rows = yield { operation: 'migrate-ledgers', rows: snapshot.rows };
  const profitPenaltyDetails = {
    ...(isPlainObject(normalizedStore.profitPenaltyDetails) ? normalizedStore.profitPenaltyDetails : {}),
    ...(isPlainObject(snapshot.penaltyDetails) ? snapshot.penaltyDetails : {}),
    ...(isPlainObject(snapshot.profitPenaltyDetails) ? snapshot.profitPenaltyDetails : {}),
  };
  return {
    ...snapshot,
    schemaVersion: PROFIT_LEDGER_SCHEMA_VERSION,
    calculationVersion: PROFIT_LEDGER_CALCULATION_VERSION,
    cacheGroup: PROFIT_LEDGER_CACHE_GROUP,
    rows,
    profitPenaltyDetails,
    penaltyDetails: isPlainObject(snapshot.penaltyDetails) ? snapshot.penaltyDetails : {},
    total: rows.length,
    errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
  };
}

export function mergeProfitLedgerSnapshotIntoStore(store = {}, snapshotKey = '', freshSnapshot = {}, options = {}) {
  return runLocalProfitLedgerSteps(mergeProfitLedgerStoreSteps(store, snapshotKey, freshSnapshot, options));
}

export function* mergeProfitLedgerStoreSteps(store = {}, snapshotKey = '', freshSnapshot = {}, options = {}) {
  const key = normalizeProfitLedgerSnapshotKeys(snapshotKey)[0] || '';
  const originalSnapshots = isPlainObject(store?.profitLedgerSnapshots) ? store.profitLedgerSnapshots : {};
  const normalizedStore = normalizeProfitLedgerStore(store);
  const compactedOnNormalize = normalizedStore.profitLedgerSnapshots !== originalSnapshots;
  if (!key) {
    return {
      store: normalizedStore,
      snapshot: null,
      stats: { changed: false, compacted: compactedOnNormalize, rowCount: 0 },
    };
  }
  const storedSnapshotKey = findCompatibleProfitLedgerSnapshotKey(
    normalizedStore.profitLedgerSnapshots,
    normalizeProfitLedgerSnapshotKeys(snapshotKey)
  );
  const storedSnapshot = storedSnapshotKey ? normalizedStore.profitLedgerSnapshots[storedSnapshotKey] : null;
  const requiresStoredVersionMigration = Boolean(
    storedSnapshot &&
      (normalizeText(storedSnapshot.calculationVersion) !== PROFIT_LEDGER_CALCULATION_VERSION ||
        storedSnapshot.rows.some(
          (row) => normalizeText(row?.calculationVersion) !== PROFIT_LEDGER_CALCULATION_VERSION
        ))
  );
  const currentSnapshot = yield* readProfitLedgerSnapshotSteps(normalizedStore, key);
  const mergedSnapshot = yield* mergeProfitLedgerSnapshotSteps(currentSnapshot, freshSnapshot, options);
  const previousHash = currentSnapshot ? createProfitLedgerSnapshotStableHash(currentSnapshot) : '';
  const nextHash = createProfitLedgerSnapshotStableHash(mergedSnapshot);
  if (currentSnapshot && previousHash === nextHash && !requiresStoredVersionMigration) {
    return {
      store: normalizedStore,
      snapshot: currentSnapshot,
      stats: {
        changed: false,
        compacted: compactedOnNormalize,
        rowCount: currentSnapshot.rows.length,
        snapshotKey: key,
        migrated: false,
      },
    };
  }
  const snapshotsBeforeFinalTrim = {
    ...trimProfitLedgerSnapshots(normalizedStore.profitLedgerSnapshots),
    [key]: {
      ...mergedSnapshot,
      signature: nextHash,
    },
  };
  normalizedStore.profitLedgerSnapshots = trimProfitLedgerSnapshots(snapshotsBeforeFinalTrim, {
    preferredSnapshotKey: key,
  });
  const compactedAfterMerge = normalizedStore.profitLedgerSnapshots !== snapshotsBeforeFinalTrim;
  const freshPenaltyDetails = extractPenaltyDetailsFromRows(mergedSnapshot.rows);
  normalizedStore.profitPenaltyDetails = Object.entries(freshPenaltyDetails).reduce(
    (details, [detailKey, detail]) => ({
      ...details,
      [detailKey]: mergePenaltyDetailRecord(details[detailKey], detail),
    }),
    { ...normalizedStore.profitPenaltyDetails }
  );
  normalizedStore.updatedAt = mergedSnapshot.updatedAt || mergedSnapshot.fetchedAt || new Date().toISOString();
  return {
    store: normalizedStore,
    snapshot: normalizedStore.profitLedgerSnapshots[key],
    stats: {
      changed: true,
      compacted: compactedOnNormalize || compactedAfterMerge,
      rowCount: mergedSnapshot.rows.length,
      snapshotKey: key,
      migrated: requiresStoredVersionMigration,
    },
  };
}

export function clearProfitLedgerSnapshotFromStore(store = {}, snapshotKey = '') {
  const keys = normalizeProfitLedgerSnapshotKeys(snapshotKey);
  const normalizedStore = normalizeProfitLedgerStore(store);
  const existingKeys = keys.filter((key) => normalizedStore.profitLedgerSnapshots[key]);
  if (!existingKeys.length) {
    return {
      store: normalizedStore,
      stats: {
        changed: false,
        snapshotKey: keys[0] || '',
        snapshotKeys: keys,
      },
    };
  }

  const remainingSnapshots = { ...normalizedStore.profitLedgerSnapshots };
  existingKeys.forEach((key) => {
    delete remainingSnapshots[key];
  });
  const updatedAt = new Date().toISOString();
  return {
    store: {
      ...normalizedStore,
      profitLedgerSnapshots: remainingSnapshots,
      updatedAt,
    },
    stats: {
      changed: true,
      snapshotKey: existingKeys[0],
      snapshotKeys: existingKeys,
      updatedAt,
    },
  };
}

function getStableProfitLedgerShopSourceKey(shop = {}) {
  const clientId = normalizeText(shop?.clientId || shop?.shopClientId);
  const shopId = normalizeText(shop?.id);
  const label = normalizeText(shop?.shopAlias || shop?.name || shop?.sellerName);
  if (clientId) return `ozon-shop:client:${clientId}`;
  if (shopId) return `ozon-shop:id:${shopId}`;
  return label ? `ozon-shop:label:${label}` : '';
}

function getLegacyProfitLedgerShopSourceKey(shop = {}) {
  return [
    normalizeText(shop?.id),
    normalizeText(shop?.clientId || shop?.shopClientId),
    normalizeText(shop?.shopAlias || shop?.name || shop?.sellerName),
  ]
    .filter(Boolean)
    .join(':');
}

function getProfitLedgerSnapshotSourceKey(source = [], keyGetter) {
  const shops = Array.isArray(source) ? source : [source];
  return shops.map(keyGetter).filter(Boolean).sort().join('|');
}

export function getProfitLedgerSnapshotCacheKey(source = []) {
  const sourceKey = getProfitLedgerSnapshotSourceKey(source, getStableProfitLedgerShopSourceKey);
  return `${PROFIT_LEDGER_CACHE_GROUP}:${sourceKey || 'default'}`;
}

export function getProfitLedgerSnapshotCacheKeyCandidates(source = []) {
  const shops = (Array.isArray(source) ? source : [source]).filter(Boolean);
  const sourceGroups = [shops];
  if (shops.length > 1) {
    shops.forEach((_shop, index) => {
      sourceGroups.push(shops.filter((_item, itemIndex) => itemIndex !== index));
    });
  }
  return uniqueValues(sourceGroups.flatMap((group) => {
    const stableKey = getProfitLedgerSnapshotCacheKey(group);
    const legacySourceKey = getProfitLedgerSnapshotSourceKey(group, getLegacyProfitLedgerShopSourceKey);
    return [stableKey, legacySourceKey ? `${PROFIT_LEDGER_CACHE_GROUP}:${legacySourceKey}` : ''];
  }));
}
