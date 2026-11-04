import {
  booleanFromValue,
  firstFilled,
  normalizeId,
  normalizeText,
  safeJsonParse,
  toInteger,
} from "./productDtoValues.js";

export function collectNestedStockItems(item = {}) {
  const stockContainer =
    item.stocks &&
    typeof item.stocks === "object" &&
    !Array.isArray(item.stocks)
      ? item.stocks
      : {};
  return [
    ...(Array.isArray(item.stocks) ? item.stocks : []),
    ...(Array.isArray(stockContainer.stocks) ? stockContainer.stocks : []),
    ...(Array.isArray(item.warehouse_stocks) ? item.warehouse_stocks : []),
    ...(Array.isArray(item.warehouseStocks) ? item.warehouseStocks : []),
    ...(Array.isArray(item.quants) ? item.quants : []),
  ].filter((stock) => stock && typeof stock === "object");
}

export function hasExplicitEmptyPrimaryStockArray(item = {}) {
  const stockContainer =
    item.stocks &&
    typeof item.stocks === "object" &&
    !Array.isArray(item.stocks)
      ? item.stocks
      : {};
  return (
    (Array.isArray(item.stocks) && item.stocks.length === 0) ||
    (Array.isArray(stockContainer.stocks) &&
      stockContainer.stocks.length === 0)
  );
}

export function hasExplicitEmptyStockArray(item = {}) {
  return (
    hasExplicitEmptyPrimaryStockArray(item) ||
    (Array.isArray(item.warehouse_stocks) &&
      item.warehouse_stocks.length === 0) ||
    (Array.isArray(item.warehouseStocks) &&
      item.warehouseStocks.length === 0)
  );
}

export function getExplicitStockAvailabilityEvidence(item = {}) {
  const stockContainer =
    item.stocks &&
    typeof item.stocks === "object" &&
    !Array.isArray(item.stocks)
      ? item.stocks
      : {};
  const visibilityDetails =
    item.visibility_details && typeof item.visibility_details === "object"
      ? item.visibility_details
      : {};
  const directHasStock = booleanFromValue(
    firstFilled(
      item.has_stock,
      item.hasStock,
      stockContainer.has_stock,
      stockContainer.hasStock,
      visibilityDetails.has_stock,
      visibilityDetails.hasStock,
    ),
  );
  const fboHasStock = booleanFromValue(
    firstFilled(
      item.has_fbo_stocks,
      item.hasFboStocks,
      stockContainer.has_fbo_stocks,
      stockContainer.hasFboStocks,
      visibilityDetails.has_fbo_stocks,
      visibilityDetails.hasFboStocks,
    ),
  );
  const fbsHasStock = booleanFromValue(
    firstFilled(
      item.has_fbs_stocks,
      item.hasFbsStocks,
      stockContainer.has_fbs_stocks,
      stockContainer.hasFbsStocks,
      visibilityDetails.has_fbs_stocks,
      visibilityDetails.hasFbsStocks,
    ),
  );

  return { directHasStock, fboHasStock, fbsHasStock };
}

export function hasExplicitStockPresenceEvidence(item = {}) {
  const { directHasStock, fboHasStock, fbsHasStock } =
    getExplicitStockAvailabilityEvidence(item);
  return directHasStock === true || fboHasStock === true || fbsHasStock === true;
}

export function hasExplicitNoStockEvidence(item = {}) {
  const { directHasStock, fboHasStock, fbsHasStock } =
    getExplicitStockAvailabilityEvidence(item);

  // An empty collection and a lone delivery flag are not scalar-zero proof.
  // Any contradictory positive flag wins over false flags.
  if (directHasStock === true || fboHasStock === true || fbsHasStock === true) {
    return false;
  }
  return (
    directHasStock === false ||
    (fboHasStock === false && fbsHasStock === false)
  );
}

export function getStockItemQuantity(item = {}) {
  return toInteger(
    firstFilled(
      item.present,
      item.stock,
      item.available,
      item.stock_value,
      item.quantity,
      item.available_stock_count,
      item.valid_stock_count,
    ),
  );
}

export function getStockItemKey(item = {}, index = 0) {
  const warehouseId = normalizeId(
    firstFilled(item.warehouse_id, item.warehouseId, item.warehouse?.id),
  );
  const stockType = normalizeText(
    firstFilled(
      item.type,
      item.stock_type,
      item.stockType,
      item.delivery_schema,
      item.deliverySchema,
    ),
  ).toLowerCase();
  const sku = normalizeId(
    firstFilled(item.sku, item.fbs_sku, item.sku_id, item.skuId),
  );
  const offerId = normalizeId(firstFilled(item.offer_id, item.offerId));
  const productId = normalizeId(
    firstFilled(item.product_id, item.productId, item.id),
  );
  const identity = [warehouseId, stockType, sku || offerId || productId]
    .filter(Boolean)
    .join(":");
  return identity || `index:${index}`;
}

export function sumStockItems(stockItems = []) {
  let total = 0;
  let hasQuantity = false;
  const seen = new Set();
  stockItems.forEach((item, index) => {
    const quantity = getStockItemQuantity(item);
    if (quantity === null) return;
    const key = getStockItemKey(item, index);
    if (seen.has(key)) return;
    seen.add(key);
    total += quantity;
    hasQuantity = true;
  });
  return hasQuantity ? total : null;
}

export function getWarehouseStockTotalFromSource(source = {}) {
  if (!source || typeof source !== "object") return null;
  const stocks = collectNestedStockItems(source);
  return stocks.length ? sumStockItems(stocks) : null;
}

export function normalizeStockJsonWithComputedPresent(stockJson = {}) {
  if (!stockJson || typeof stockJson !== "object") return stockJson;
  const total = getWarehouseStockTotalFromSource(stockJson);
  if (total === null) return stockJson;
  return {
    ...stockJson,
    present: total,
  };
}

export function getPublicStockValue(rowStockValue, stockJson = null) {
  const directValue =
    rowStockValue === null || rowStockValue === undefined
      ? null
      : Number(rowStockValue);
  const stockJsonTotal = getWarehouseStockTotalFromSource(stockJson || {});
  if (stockJsonTotal !== null) return stockJsonTotal;
  return Number.isFinite(directValue) ? directValue : stockJsonTotal;
}

export function shouldRepairStoredStockValue(rowStockValue, stockJson = null) {
  const stockJsonTotal = getWarehouseStockTotalFromSource(stockJson || {});
  if (stockJsonTotal === null) return false;
  const currentValue =
    rowStockValue === null || rowStockValue === undefined
      ? null
      : Number(rowStockValue);
  return !Number.isFinite(currentValue) || currentValue !== stockJsonTotal;
}

export function repairStoredStockPatch(row = {}) {
  const stockJson = normalizeStockJsonWithComputedPresent(
    typeof row.stock_json === "string"
      ? safeJsonParse(row.stock_json, null)
      : row.stock_json,
  );
  const stockJsonTotal = getWarehouseStockTotalFromSource(stockJson);
  if (stockJsonTotal === null) return null;
  const rawStockJson =
    typeof row.stock_json === "string"
      ? safeJsonParse(row.stock_json, null)
      : row.stock_json;
  const rawPresent = toInteger(rawStockJson?.present);
  const shouldRepairStockJson = rawPresent !== stockJsonTotal;
  const shouldRepairStockValue = shouldRepairStoredStockValue(
    row.stock_value,
    stockJson,
  );
  if (!shouldRepairStockJson && !shouldRepairStockValue) return null;
  return {
    stockValue: shouldRepairStockValue ? stockJsonTotal : undefined,
    stockJson,
  };
}

export function extractStock(item = {}) {
  const nestedStockItems = collectNestedStockItems(item);
  const nestedTotal = nestedStockItems.length
    ? sumStockItems(nestedStockItems)
    : null;
  if (nestedTotal !== null) return nestedTotal;

  const stockCandidates = [
    item.stock,
    item.present,
    item.stocks?.present,
    item.stocks?.available,
    item.stocks?.stock,
    item.stock_value,
    item.available_stock_count,
    item.valid_stock_count,
  ];
  for (const candidate of stockCandidates) {
    const number = toInteger(candidate);
    if (number !== null) return number;
  }
  return null;
}

export function compactStock(row = {}) {
  const stockContainer =
    row.stocks && typeof row.stocks === "object" && !Array.isArray(row.stocks)
      ? row.stocks
      : {};
  const stocks = collectNestedStockItems(row);
  const stockValue = extractStock(row);
  const warehouseStockTotal = stocks.length ? sumStockItems(stocks) : null;
  const directPresent = firstFilled(
    row.present,
    row.stock,
    row.stock_value,
    stockContainer.present,
    stockContainer.stock,
    stockContainer.available,
  );
  const compact = {
    product_id: row.product_id ?? row.productId ?? null,
    offer_id: row.offer_id ?? row.offerId ?? null,
    sku: row.sku ?? row.sku_id ?? row.skuId ?? null,
    present:
      warehouseStockTotal !== null
        ? warehouseStockTotal
        : directPresent === ""
          ? (stockValue ?? null)
          : directPresent,
  };
  if (stocks.length > 0 || hasExplicitEmptyStockArray(row)) {
    compact.stocks = stocks.slice(0, 50).map((stock) => ({
      present: stock.present ?? stock.stock ?? stock.available ?? null,
      reserved: stock.reserved ?? null,
      type: stock.type ?? stock.stock_type ?? null,
      warehouse_id: stock.warehouse_id ?? stock.warehouseId ?? null,
      sku: stock.sku ?? stock.sku_id ?? stock.skuId ?? null,
      offer_id:
        stock.offer_id ??
        stock.offerId ??
        row.offer_id ??
        row.offerId ??
        null,
      product_id:
        stock.product_id ??
        stock.productId ??
        stock.id ??
        row.product_id ??
        row.productId ??
        row.id ??
        null,
    }));
  }
  return compact;
}

export function normalizePublicWarehouseStocks(row = {}) {
  const parsed = safeJsonParse(
    row.warehouse_stocks_json ?? row.canonical_warehouse_stocks_json,
    [],
  );
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((stock) => {
      const warehouseId = normalizeId(
        stock?.warehouseId ?? stock?.warehouse_id ?? stock?.warehouseKey,
      );
      const presentQuantity = toInteger(
        stock?.presentQuantity ?? stock?.present_quantity ?? stock?.present,
      );
      if (!warehouseId || presentQuantity === null || presentQuantity < 0) {
        return null;
      }
      return {
        warehouseId,
        warehouseName:
          normalizeText(stock?.warehouseName ?? stock?.warehouse_name) || null,
        warehouseKey:
          normalizeId(stock?.warehouseKey ?? stock?.warehouse_key) || warehouseId,
        sku: normalizeId(stock?.sku) || null,
        fulfillmentType:
          normalizeText(stock?.fulfillmentType ?? stock?.fulfillment_type)
            .toUpperCase() || "SELLER",
        presentQuantity,
        reservedQuantity: toInteger(
          stock?.reservedQuantity ?? stock?.reserved_quantity,
        ),
        freeQuantity: toInteger(
          stock?.freeQuantity ?? stock?.free_quantity ?? stock?.free_stock,
        ),
        operationId: normalizeText(stock?.operationId) || null,
        contractVersion: normalizeText(stock?.contractVersion) || null,
        mapperVersion: normalizeText(stock?.mapperVersion) || null,
        responseHash: normalizeText(stock?.responseHash) || null,
        runId: normalizeText(stock?.runId) || null,
        snapshotId: normalizeText(stock?.snapshotId) || null,
        observedAt: normalizeText(stock?.observedAt) || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.warehouseId.localeCompare(right.warehouseId, undefined, {
        numeric: true,
      }),
    );
}
