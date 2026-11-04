import { normalizeText } from "./productSyncValues.js";

export const PRODUCT_NOTIFICATION_SNAPSHOT_LIMIT = 10_000;

export const PRODUCT_NOTIFICATION_MAX_EVENTS_PER_SYNC = 500;

export const PRODUCT_LOW_STOCK_THRESHOLD = 5;

export function normalizeComparableText(value) {
  return normalizeText(value).toLowerCase();
}

export function productNotificationKey(row = {}) {
  return (
    normalizeText(row.productKey) ||
    normalizeText(row.productId) ||
    normalizeText(row.offerId) ||
    normalizeText(row.sku) ||
    normalizeText(row.id)
  );
}

export function productDisplayName(row = {}) {
  return (
    normalizeText(row.name) ||
    normalizeText(row.offerId) ||
    normalizeText(row.productId) ||
    normalizeText(row.sku) ||
    "未知商品"
  );
}

export function normalizeNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeMoneyOrNull(value) {
  const number = normalizeNumberOrNull(value);
  return number === null ? null : Number(number.toFixed(2));
}

export function stockAlertLevel(stockValue) {
  const stock = normalizeNumberOrNull(stockValue);
  if (stock === null) return "";
  if (stock <= 0) return "zero";
  if (stock < PRODUCT_LOW_STOCK_THRESHOLD) return "low";
  return "";
}

export function shouldRecordProductNotifications(input = {}) {
  // Ozon Push is authoritative for product notifications. The previous
  // background-snapshot diff path is intentionally retired to prevent duplicate
  // bell rows and stale guesses after a delayed full sync.
  void input;
  return false;
}

export function createProductSnapshotMap(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = productNotificationKey(row);
    if (key) map.set(key, row);
  }
  return map;
}

export function readProductNotificationRows(repository, shopId) {
  if (!repository || !shopId) return [];
  const page = repository.listProducts({
    shopId,
    visibility: "ALL",
    pageSize: PRODUCT_NOTIFICATION_SNAPSHOT_LIMIT,
    page: 1,
  });
  return Array.isArray(page?.rows)
    ? page.rows.map((row) => ({
        productKey: row.productKey || "",
        ...productValueSnapshot(row),
      }))
    : [];
}

export function productValueSnapshot(row = {}) {
  return {
    name: row.name || "",
    offerId: row.offerId || "",
    productId: row.productId || "",
    sku: row.sku || "",
    primaryImageUrl: row.primaryImageUrl || "",
    visibility: row.visibility || "",
    statusLabel: row.statusLabel || "",
    priceValue: normalizeMoneyOrNull(row.priceValue),
    currencyCode: row.currencyCode || "",
    stockValue: normalizeNumberOrNull(row.stockValue),
  };
}

export function buildProductNotificationEvents({
  beforeRows = [],
  afterRows = [],
  shopId,
  shopName,
  snapshotId,
  sourceJobId,
} = {}) {
  const beforeByKey = createProductSnapshotMap(beforeRows);
  const events = [];
  for (const after of afterRows) {
    if (events.length >= PRODUCT_NOTIFICATION_MAX_EVENTS_PER_SYNC) break;
    const key = productNotificationKey(after);
    if (!key || !beforeByKey.has(key)) continue;
    const before = beforeByKey.get(key);
    const beforeSnapshot = productValueSnapshot(before);
    const afterSnapshot = productValueSnapshot(after);
    const entityLabel = productDisplayName(after);
    const base = {
      shopId,
      shopName,
      domain: "products",
      sourceEndpoint: "products.sync",
      sourceJobId,
      snapshotId,
      entityType: "product",
      entityId: after.productKey || key,
      offerId: after.offerId || before.offerId || null,
      productId: after.productId || before.productId || null,
    };

    if (
      normalizeComparableText(beforeSnapshot.visibility) !==
        normalizeComparableText(afterSnapshot.visibility) ||
      normalizeComparableText(beforeSnapshot.statusLabel) !==
        normalizeComparableText(afterSnapshot.statusLabel)
    ) {
      events.push({
        ...base,
        eventType: "product_status_changed",
        severity: "info",
        title: "商品状态变化",
        summary: `${entityLabel}：${beforeSnapshot.statusLabel || beforeSnapshot.visibility || "未知"} -> ${afterSnapshot.statusLabel || afterSnapshot.visibility || "未知"}`,
        oldValue: beforeSnapshot,
        newValue: afterSnapshot,
      });
      if (events.length >= PRODUCT_NOTIFICATION_MAX_EVENTS_PER_SYNC) break;
    }

    if (
      beforeSnapshot.priceValue !== null &&
      afterSnapshot.priceValue !== null &&
      beforeSnapshot.priceValue !== afterSnapshot.priceValue
    ) {
      events.push({
        ...base,
        eventType: "product_price_changed",
        severity: "info",
        title: "商品价格变化",
        summary: `${entityLabel}：${beforeSnapshot.priceValue} -> ${afterSnapshot.priceValue}`,
        oldValue: beforeSnapshot,
        newValue: afterSnapshot,
      });
      if (events.length >= PRODUCT_NOTIFICATION_MAX_EVENTS_PER_SYNC) break;
    }

    const beforeStockLevel = stockAlertLevel(beforeSnapshot.stockValue);
    const afterStockLevel = stockAlertLevel(afterSnapshot.stockValue);
    if (afterStockLevel && beforeStockLevel !== afterStockLevel) {
      const isZero = afterStockLevel === "zero";
      events.push({
        ...base,
        eventType: isZero ? "product_stock_zero" : "product_stock_low",
        severity: "warning",
        title: isZero ? "商品库存为 0" : "商品库存偏低",
        summary: `${entityLabel}：当前库存 ${afterSnapshot.stockValue}`,
        oldValue: beforeSnapshot,
        newValue: afterSnapshot,
      });
    }
  }
  return events;
}

export function recordProductNotificationEventsForSnapshot({
  repository,
  snapshotService,
  beforeRows,
  snapshotId,
  sourceJobId,
  shopId,
  shopName = "",
} = {}) {
  if (!snapshotService?.isAvailable?.() || !snapshotId) return 0;
  if (!Array.isArray(beforeRows) || !beforeRows.length) return 0;
  const afterRows = readProductNotificationRows(repository, shopId);
  const events = buildProductNotificationEvents({
    beforeRows,
    afterRows,
    shopId,
    shopName,
    snapshotId,
    sourceJobId,
  });
  let recordedCount = 0;
  for (const event of events) {
    const recorded = snapshotService.recordNotification(event);
    if (recorded && !recorded.deduped && !recorded.skipped) recordedCount += 1;
  }
  return recordedCount;
}
