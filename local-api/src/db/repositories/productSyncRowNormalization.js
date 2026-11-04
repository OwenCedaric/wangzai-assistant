import { createStableHash } from "../../utils/stableHash.js";
import {
  PRODUCT_FACET_OBSERVATION_STATUS,
  PRODUCT_HYDRATION_FACET_COLUMNS,
  addField,
  addJsonField,
  addNumberField,
  addResolvedStatusFields,
  collectNestedStockItems,
  compactAttributes,
  compactFee,
  compactJson,
  compactPrice,
  compactStock,
  createPatchHash,
  extractAcquiringObservation,
  extractCommissionObservation,
  extractCurrency,
  extractDimensions,
  extractImages,
  extractPrice,
  extractPrimaryImage,
  extractStock,
  firstFilled,
  getStockItemQuantity,
  hasExplicitEmptyPrimaryStockArray,
  hasExplicitEmptyStockArray,
  hasExplicitNoStockEvidence,
  hasExplicitStockPresenceEvidence,
  isProductFacetGapStatus,
  isProductFacetSuccessStatus,
  normalizeId,
  normalizePositivePercent,
  normalizeText,
  nowIso,
  safeJsonParse,
  toFiniteNumber,
  toInteger,
} from "./productCanonicalDto.js";

export const PRIMARY_STOCKS_EXPLICIT_EMPTY = Symbol(
  "primary-stocks-explicit-empty",
);

export function normalizeFacetObservationStatus(status) {
  const normalized = normalizeText(status).toLowerCase();
  if (!Object.values(PRODUCT_FACET_OBSERVATION_STATUS).includes(normalized)) {
    throw new Error(
      `Unsupported product facet observation status: ${status || "empty"}`,
    );
  }
  return normalized;
}

export function createFacetObservation({
  row,
  facet,
  status,
  endpointKey,
  sourceReason,
  provenance = {},
  observedAt = nowIso(),
} = {}) {
  const currentStatus = normalizeFacetObservationStatus(status);
  const previousObservations = safeJsonParse(
    row?.facet_observations_json,
    {},
  );
  const previous =
    previousObservations && typeof previousObservations === "object"
      ? previousObservations[facet]
      : null;
  const syncedColumn = PRODUCT_HYDRATION_FACET_COLUMNS[facet];
  const hasPreviousFact =
    isProductFacetSuccessStatus(previous?.status) ||
    Boolean(row?.[syncedColumn]);
  const shouldRetainPrevious =
    hasPreviousFact && isProductFacetGapStatus(currentStatus);
  const resolvedStatus = shouldRetainPrevious
    ? "stale_previous"
    : currentStatus;
  return {
    status: resolvedStatus,
    ...(shouldRetainPrevious ? { currentStatus } : {}),
    endpointKey: normalizeText(endpointKey) || null,
    operationId:
      normalizeText(provenance.operationId ?? provenance.operation_id) || null,
    contractVersion:
      normalizeText(
        provenance.contractVersion ?? provenance.contract_version,
      ) || null,
    mapperVersion:
      normalizeText(provenance.mapperVersion ?? provenance.mapper_version) ||
      null,
    responseHash:
      normalizeText(provenance.responseHash ?? provenance.response_hash) || null,
    runId: normalizeText(provenance.runId ?? provenance.run_id) || null,
    snapshotId:
      normalizeText(provenance.snapshotId ?? provenance.snapshot_id) || null,
    expectedAt:
      normalizeText(provenance.expectedAt ?? provenance.expected_at) || null,
    observedAt,
    sourceReason: normalizeText(sourceReason) || null,
    actualIdentity: {
      productId: normalizeId(row?.product_id) || null,
      offerId: normalizeId(row?.offer_id) || null,
      productKey: normalizeText(row?.product_key) || null,
    },
    ...(shouldRetainPrevious
      ? {
          retainedPrevious: true,
          previousResponseHash: normalizeText(previous?.responseHash) || null,
          lastSuccessfulAt:
            normalizeText(previous?.observedAt ?? row?.[syncedColumn]) || null,
        }
      : {}),
  };
}

export function applyPriceFeeObservations({
  patch,
  row,
  timestamp,
  provenance = {},
} = {}) {
  if (!patch?.commission || !patch?.acquiring) return;
  const previousCommissionValues = [
    row?.commission_percent,
    row?.commission_percent_fbo,
    row?.commission_percent_fbs,
    row?.commission_percent_rfbs,
    row?.commission_percent_fbp,
  ].map(normalizePositivePercent).filter((value) => value !== null);
  const retainCommission =
    patch.commission.status !== "returned" &&
    previousCommissionValues.length > 0;
  const commissionStatus = retainCommission
    ? "stale_previous"
    : patch.commission.status;

  if (!retainCommission && patch.commission.status !== "returned") {
    patch.fields.commission_percent = null;
    patch.fields.commission_percent_fbo = null;
    patch.fields.commission_percent_fbs = null;
    patch.fields.commission_percent_rfbs = null;
    patch.fields.commission_percent_fbp = null;
  }
  patch.fields.commission_status = commissionStatus;
  patch.fields.commission_provenance_json = compactJson({
    status: commissionStatus,
    ...(retainCommission ? { currentStatus: patch.commission.status } : {}),
    endpointKey: "products.prices",
    operationId: normalizeText(provenance.operationId) || null,
    contractVersion: normalizeText(provenance.contractVersion) || null,
    mapperVersion: normalizeText(provenance.mapperVersion) || null,
    responseHash: normalizeText(provenance.responseHash) || null,
    runId: normalizeText(provenance.runId) || null,
    snapshotId: normalizeText(provenance.snapshotId) || null,
    observedAt: timestamp,
    sourceReason: patch.commission.sourceReason,
    selectedPercent: patch.commission.selectedPercent,
    fulfillmentPercents: patch.commission.percents,
    rawFulfillmentPercents: patch.commission.rawPercents,
    ...(retainCommission
      ? {
          retainedPrevious: true,
          previousPositivePercents: previousCommissionValues,
        }
      : {}),
  });

  const previousAcquiringValues = [
    row?.acquiring_fee_value,
    row?.acquiring_percent,
  ].map(toFiniteNumber).filter((value) => value !== null && value > 0);
  const retainAcquiring =
    patch.acquiring.status !== "returned" &&
    previousAcquiringValues.length > 0;
  const acquiringStatus = retainAcquiring
    ? "stale_previous"
    : patch.acquiring.status;
  if (!retainAcquiring && patch.acquiring.status !== "returned") {
    patch.fields.acquiring_fee_value = null;
    patch.fields.acquiring_percent = null;
  }
  patch.fields.acquiring_status = acquiringStatus;
  patch.fields.acquiring_provenance_json = compactJson({
    status: acquiringStatus,
    ...(retainAcquiring ? { currentStatus: patch.acquiring.status } : {}),
    endpointKey: "products.prices",
    operationId: normalizeText(provenance.operationId) || null,
    contractVersion: normalizeText(provenance.contractVersion) || null,
    mapperVersion: normalizeText(provenance.mapperVersion) || null,
    responseHash: normalizeText(provenance.responseHash) || null,
    runId: normalizeText(provenance.runId) || null,
    snapshotId: normalizeText(provenance.snapshotId) || null,
    observedAt: timestamp,
    sourceReason: patch.acquiring.sourceReason,
    feeValue: patch.acquiring.feeValue,
    percent: patch.acquiring.percent,
    rawFeeValue: patch.acquiring.rawFeeValue,
    rawPercent: patch.acquiring.rawPercent,
    ...(retainAcquiring
      ? { retainedPrevious: true, previousPositiveValues: previousAcquiringValues }
      : {}),
  });

  if (
    patch.commission.status === "returned" ||
    patch.acquiring.status === "returned"
  ) {
    patch.fields.fee_hash = createPatchHash({
      commission: patch.commission,
      acquiring: patch.acquiring,
      responseHash: normalizeText(provenance.responseHash) || null,
    });
    patch.fields.fee_synced_at = timestamp;
  } else if (!retainCommission && !retainAcquiring) {
    patch.fields.fee_hash = null;
    patch.fields.fee_synced_at = null;
  }
}

export function normalizeHydrationFacet(facet) {
  const normalized = normalizeText(facet).toLowerCase();
  if (!PRODUCT_HYDRATION_FACET_COLUMNS[normalized]) {
    throw new Error(`Unsupported product hydration facet: ${facet || "empty"}`);
  }
  return normalized;
}

export function normalizeInfoRow(row = {}) {
  const productId = normalizeId(
    firstFilled(row.id, row.product_id, row.productId),
  );
  const offerId = normalizeId(firstFilled(row.offer_id, row.offerId));
  const images = extractImages(row);
  const dimensions = extractDimensions(row);
  const fields = {};
  const status = addResolvedStatusFields(fields, row);
  addField(fields, "product_id", productId);
  addField(fields, "offer_id", offerId);
  addField(
    fields,
    "sku",
    normalizeId(firstFilled(row.sku, row.sku_id, row.skuId)),
  );
  addField(
    fields,
    "name",
    normalizeText(firstFilled(row.name, row.title, row.product_name)),
  );
  addField(
    fields,
    "primary_image_url",
    extractPrimaryImage(row) || images[0],
  );
  addJsonField(fields, "images_json", images);
  addNumberField(fields, "price_value", extractPrice(row));
  addField(fields, "currency_code", extractCurrency(row));
  addNumberField(fields, "weight_kg", dimensions.weightKg);
  addNumberField(fields, "width_cm", dimensions.widthCm);
  addNumberField(fields, "height_cm", dimensions.heightCm);
  addNumberField(fields, "depth_cm", dimensions.depthCm);
  addField(
    fields,
    "category_id",
    normalizeId(
      firstFilled(
        row.description_category_id,
        row.category_id,
        row.categoryId,
        row.category?.id,
      ),
    ),
  );
  addField(
    fields,
    "category_name",
    normalizeText(
      firstFilled(row.category_name, row.categoryName, row.category?.name),
    ),
  );
  addField(
    fields,
    "type_id",
    normalizeId(
      firstFilled(
        row.type_id,
        row.typeId,
        row.category?.type_id,
        row.category?.typeId,
      ),
    ),
  );
  return {
    productId,
    offerId,
    sku: fields.sku,
    name: fields.name,
    visibility: status.visibility,
    facetStatus: "returned",
    facetSourceReason: "ozon-detail-row-returned",
    fields,
    hashPayload: fields,
  };
}

export function normalizePictureRow(row = {}) {
  const productId = normalizeId(
    firstFilled(row.product_id, row.productId, row.id),
  );
  const offerId = normalizeId(firstFilled(row.offer_id, row.offerId));
  const images = extractImages(row);
  const fields = {};
  addField(
    fields,
    "primary_image_url",
    extractPrimaryImage(row) || images[0],
  );
  fields.images_json = compactJson(images);
  return {
    productId,
    offerId,
    facetStatus: images.length > 0 ? "returned" : "returned_empty",
    facetSourceReason:
      images.length > 0
        ? "ozon-pictures-row-returned"
        : "ozon-pictures-explicit-empty",
    fields,
    hashPayload: fields,
  };
}

export function normalizePriceRow(row = {}) {
  const productId = normalizeId(
    firstFilled(row.product_id, row.productId, row.id),
  );
  const offerId = normalizeId(firstFilled(row.offer_id, row.offerId));
  const compact = compactPrice(row);
  const commission = extractCommissionObservation(row);
  const acquiring = extractAcquiringObservation(row);
  const priceValue = extractPrice(row);
  const fields = {};
  const status = addResolvedStatusFields(fields, row);
  addNumberField(fields, "price_value", priceValue);
  addField(fields, "currency_code", extractCurrency(row));
  addNumberField(fields, "commission_percent", commission.selectedPercent);
  addNumberField(fields, "commission_percent_fbo", commission.percents.fbo);
  addNumberField(fields, "commission_percent_fbs", commission.percents.fbs);
  addNumberField(fields, "commission_percent_rfbs", commission.percents.rfbs);
  addNumberField(fields, "commission_percent_fbp", commission.percents.fbp);
  addNumberField(fields, "acquiring_fee_value", acquiring.feeValue);
  addNumberField(fields, "acquiring_percent", acquiring.percent);
  addJsonField(fields, "price_json", compact);
  addJsonField(fields, "fee_json", compactFee(row, commission, acquiring));
  return {
    productId,
    offerId,
    visibility: status.visibility,
    facetStatus: priceValue === null ? "unavailable" : "returned",
    facetSourceReason:
      priceValue === null
        ? "ozon-price-values-unavailable"
        : "ozon-price-row-returned",
    commission,
    acquiring,
    fields,
    hashPayload: {
      ...compact,
      visibility: status.visibility,
      statusLabel: status.statusLabel,
    },
  };
}

export function getStockRowIdentity(row = {}) {
  const productId = normalizeId(
    firstFilled(row.product_id, row.productId, row.id),
  );
  const offerId = normalizeId(firstFilled(row.offer_id, row.offerId));
  const sku = normalizeId(
    firstFilled(row.sku, row.sku_id, row.skuId, row.fbs_sku),
  );
  if (productId) return `product:${productId}`;
  if (offerId) return `offer:${offerId}`;
  if (sku) return `sku:${sku}`;
  return "";
}

export function createStockItemFromRow(row = {}) {
  const stockContainer =
    row.stocks && typeof row.stocks === "object" && !Array.isArray(row.stocks)
      ? row.stocks
      : {};
  return {
    present: firstFilled(
      row.present,
      row.stock,
      row.free_stock,
      row.freeStock,
      row.available,
      row.stock_value,
      row.quantity,
      row.available_stock_count,
      row.valid_stock_count,
      stockContainer.present,
      stockContainer.stock,
      stockContainer.available,
    ),
    reserved:
      firstFilled(
        row.reserved,
        row.reserved_quantity,
        row.reservedQuantity,
        stockContainer.reserved,
        stockContainer.reserved_quantity,
      ) ?? null,
    free_stock:
      firstFilled(
        row.free_stock,
        row.freeStock,
        stockContainer.free_stock,
        stockContainer.freeStock,
      ) ?? null,
    type: firstFilled(
      row.type,
      row.stock_type,
      row.stockType,
      row.delivery_schema,
      row.deliverySchema,
      stockContainer.type,
      stockContainer.stock_type,
    ),
    warehouse_id: firstFilled(
      row.warehouse_id,
      row.warehouseId,
      row.warehouse?.id,
      stockContainer.warehouse_id,
      stockContainer.warehouseId,
    ),
    warehouse_name: firstFilled(
      row.warehouse_name,
      row.warehouseName,
      row.warehouse?.name,
      stockContainer.warehouse_name,
      stockContainer.warehouseName,
    ),
    sku: firstFilled(
      row.sku,
      row.sku_id,
      row.skuId,
      row.fbs_sku,
      stockContainer.sku,
    ),
    offer_id: firstFilled(row.offer_id, row.offerId),
    product_id: firstFilled(row.product_id, row.productId, row.id),
  };
}

export function collectStockItemsForAggregation(row = {}) {
  const nested = collectNestedStockItems(row);
  if (nested.length) {
    return nested.map((stock) => ({
      ...stock,
      sku: firstFilled(
        stock.sku,
        stock.sku_id,
        stock.skuId,
        row.sku,
        row.sku_id,
        row.skuId,
        row.fbs_sku,
      ),
      offer_id: firstFilled(
        stock.offer_id,
        stock.offerId,
        row.offer_id,
        row.offerId,
      ),
      product_id: firstFilled(
        stock.product_id,
        stock.productId,
        stock.id,
        row.product_id,
        row.productId,
        row.id,
      ),
    }));
  }
  const stockItem = createStockItemFromRow(row);
  return getStockItemQuantity(stockItem) === null ? [] : [stockItem];
}

export function aggregateStockRows(rows = []) {
  const grouped = new Map();
  const output = [];
  const explicitEmptyRows = new WeakSet();
  for (const row of rows) {
    const key = getStockRowIdentity(row);
    if (!key) {
      output.push(row);
      continue;
    }
    let target = grouped.get(key);
    if (!target) {
      target = {
        ...row,
        product_id: firstFilled(row.product_id, row.productId, row.id),
        offer_id: firstFilled(row.offer_id, row.offerId),
        sku: firstFilled(row.sku, row.sku_id, row.skuId, row.fbs_sku),
        stocks: [],
      };
      Object.defineProperty(target, PRIMARY_STOCKS_EXPLICIT_EMPTY, {
        value: false,
        writable: true,
        enumerable: false,
      });
      grouped.set(key, target);
      output.push(target);
    }
    if (hasExplicitEmptyStockArray(row)) explicitEmptyRows.add(target);
    if (hasExplicitEmptyPrimaryStockArray(row)) {
      target[PRIMARY_STOCKS_EXPLICIT_EMPTY] = true;
    }
    target.stocks.push(...collectStockItemsForAggregation(row));
  }
  return output.map((row) => {
    if (Array.isArray(row.stocks) && row.stocks.length > 0) return row;
    // `stocks: []` on an entity returned by Ozon is endpoint evidence.  Do
    // not confuse it with the temporary empty array created while grouping
    // flattened warehouse rows.  The explicit empty shape is needed later
    // to distinguish returned_empty from a row whose stock field is absent.
    if (explicitEmptyRows.has(row)) return row;
    const { stocks, ...rest } = row;
    return rest;
  });
}

export function normalizeStockRow(row = {}) {
  const productId = normalizeId(
    firstFilled(row.product_id, row.productId, row.id),
  );
  const offerId = normalizeId(firstFilled(row.offer_id, row.offerId));
  const sku = normalizeId(
    firstFilled(row.sku, row.sku_id, row.skuId, row.fbs_sku),
  );
  const compact = compactStock(row);
  const extractedStockValue = extractStock(row);
  const explicitEmptyStock = hasExplicitEmptyStockArray(row);
  const explicitPrimaryEmptyStock = Object.prototype.hasOwnProperty.call(
    row,
    PRIMARY_STOCKS_EXPLICIT_EMPTY,
  )
    ? row[PRIMARY_STOCKS_EXPLICIT_EMPTY] === true
    : hasExplicitEmptyPrimaryStockArray(row);
  const explicitStockPresence = hasExplicitStockPresenceEvidence(row);
  const explicitNoStock = hasExplicitNoStockEvidence(row);
  const stockValue =
    extractedStockValue === null && explicitNoStock
      ? 0
      : extractedStockValue;
  if (
    stockValue !== null &&
    (compact.present === null ||
      compact.present === undefined ||
      compact.present === "")
  ) {
    compact.present = stockValue;
  }
  const fields = {};
  const status = addResolvedStatusFields(fields, row);
  addField(fields, "sku", sku);
  // Null is intentional here: a returned empty/unknown stock projection must
  // not silently retain an unrelated previous scalar quantity.
  fields.stock_value = stockValue;
  addJsonField(fields, "stock_json", compact);
  const facetStatus =
    stockValue !== null
      ? "returned"
      : explicitEmptyStock
        ? "returned_empty"
        : "unavailable";
  return {
    productId,
    offerId,
    sku: fields.sku,
    visibility: status.visibility,
    explicitStockPresence,
    explicitPrimaryEmptyStock,
    // Keep the raw evidence distinction here. The caller may promote an
    // explicit empty entity from the comprehensive products.stocks endpoint
    // to total zero, but a missing field/row must remain unavailable.
    facetStatus,
    facetSourceReason:
      extractedStockValue === 0
        ? "ozon-explicit-zero-stock"
        : explicitNoStock && stockValue === 0
          ? "ozon-explicit-no-stock-flags"
          : explicitEmptyStock
            ? "ozon-explicit-empty-stocks"
            : stockValue === null
              ? "ozon-stock-values-unavailable"
              : "ozon-stock-row-returned",
    fields,
    hashPayload: {
      ...compact,
      visibility: status.visibility,
      statusLabel: status.statusLabel,
    },
  };
}

export function applyPrimaryStockAvailabilityEvidence({
  patch,
  row,
  endpointKey,
} = {}) {
  if (
    endpointKey !== "products.stocks" ||
    patch?.facetStatus !== "returned_empty" ||
    patch?.explicitPrimaryEmptyStock !== true
  ) {
    return patch;
  }
  const productListPayload =
    normalizeText(row?.source_endpoint_key) === "products.list"
      ? safeJsonParse(row?.raw_json, {})
      : {};
  // Numeric quantities and explicit positive availability always outrank an
  // empty collection.  In every other case, an identified entity row from
  // the comprehensive products.stocks endpoint with `stocks: []` is the
  // endpoint's explicit zero-sized collection (not an omitted entity).
  if (
    patch.explicitStockPresence ||
    hasExplicitStockPresenceEvidence(productListPayload)
  ) {
    return patch;
  }

  const stockJson = safeJsonParse(patch.fields?.stock_json, {});
  patch.fields.stock_value = 0;
  patch.fields.stock_json = compactJson({
    ...(stockJson && typeof stockJson === "object" ? stockJson : {}),
    present: 0,
    stocks: Array.isArray(stockJson?.stocks) ? stockJson.stocks : [],
  });
  patch.facetStatus = "returned";
  patch.facetSourceReason = "ozon-explicit-empty-stocks-zero";
  patch.hashPayload = {
    ...(patch.hashPayload || {}),
    present: 0,
    availabilityEvidence: "products.stocks:explicit-empty-entity",
  };
  return patch;
}

export function normalizeAttributeRow(row = {}) {
  const productId = normalizeId(
    firstFilled(row.id, row.product_id, row.productId),
  );
  const offerId = normalizeId(firstFilled(row.offer_id, row.offerId));
  const images = extractImages(row);
  const dimensions = extractDimensions(row);
  const attributes = compactAttributes(row);
  const fields = {};
  const status = addResolvedStatusFields(fields, row);
  addField(fields, "product_id", productId);
  addField(fields, "offer_id", offerId);
  addField(
    fields,
    "sku",
    normalizeId(firstFilled(row.sku, row.sku_id, row.skuId)),
  );
  addField(
    fields,
    "name",
    normalizeText(firstFilled(row.name, row.title, row.product_name)),
  );
  addField(
    fields,
    "primary_image_url",
    extractPrimaryImage(row) || images[0],
  );
  addJsonField(fields, "images_json", images);
  fields.attributes_json = compactJson(attributes);
  addNumberField(fields, "weight_kg", dimensions.weightKg);
  addNumberField(fields, "width_cm", dimensions.widthCm);
  addNumberField(fields, "height_cm", dimensions.heightCm);
  addNumberField(fields, "depth_cm", dimensions.depthCm);
  addField(
    fields,
    "category_id",
    normalizeId(
      firstFilled(
        row.description_category_id,
        row.category_id,
        row.categoryId,
        row.category?.id,
      ),
    ),
  );
  addField(
    fields,
    "category_name",
    normalizeText(
      firstFilled(row.category_name, row.categoryName, row.category?.name),
    ),
  );
  addField(
    fields,
    "type_id",
    normalizeId(
      firstFilled(
        row.type_id,
        row.typeId,
        row.category?.type_id,
        row.category?.typeId,
      ),
    ),
  );
  return {
    productId,
    offerId,
    sku: fields.sku,
    name: fields.name,
    visibility: status.visibility,
    facetStatus: attributes.length > 0 ? "returned" : "returned_empty",
    facetSourceReason:
      attributes.length > 0
        ? "ozon-attributes-row-returned"
        : "ozon-attributes-explicit-empty",
    fields,
    hashPayload: { ...fields, attributes },
  };
}

export function resolveStockEndpointKey(input = {}) {
  const explicitEndpointKey = normalizeText(
    input.endpointKey ?? input.endpoint_key ?? input.provenance?.endpointKey,
  );
  if (
    explicitEndpointKey === "products.stocks" ||
    explicitEndpointKey === "products.stocksByWarehouseFbs"
  ) {
    return explicitEndpointKey;
  }
  const contractVersion = normalizeText(
    input.provenance?.contractVersion ?? input.provenance?.contract_version,
  ).toLowerCase();
  return contractVersion.includes("stocks-by-warehouse-fbs")
    ? "products.stocksByWarehouseFbs"
    : "products.stocks";
}

export function normalizeWarehouseStockSet(row = {}) {
  const productId = normalizeId(
    firstFilled(row.product_id, row.productId, row.id),
  );
  const offerId = normalizeId(firstFilled(row.offer_id, row.offerId));
  const sku = normalizeId(
    firstFilled(row.sku, row.sku_id, row.skuId, row.fbs_sku),
  );
  if (!productId && !offerId && !sku) {
    return {
      invalid: true,
      reason: "warehouse-stock-identity-missing",
      productId,
      offerId,
      sku,
      stocks: [],
    };
  }
  const items = collectStockItemsForAggregation(row);
  const explicitEmpty = hasExplicitEmptyStockArray(row);
  if (!items.length) {
    return {
      productId,
      offerId,
      sku,
      stocks: [],
      explicitEmpty,
      unavailable: !explicitEmpty,
    };
  }
  const stocks = new Map();
  for (const item of items) {
    const warehouseId = normalizeId(
      firstFilled(
        item.warehouse_id,
        item.warehouseId,
        item.warehouse?.id,
        row.warehouse_id,
        row.warehouseId,
        row.warehouse?.id,
      ),
    );
    const presentQuantity = toInteger(
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
    const reservedQuantity = toInteger(
      firstFilled(
        item.reserved,
        item.reserved_quantity,
        item.reservedQuantity,
        row.reserved,
        row.reserved_quantity,
        row.reservedQuantity,
      ),
    );
    const freeQuantity = toInteger(
      firstFilled(
        item.free_stock,
        item.freeStock,
        item.free_quantity,
        item.freeQuantity,
        row.free_stock,
        row.freeStock,
      ),
    );
    if (
      !warehouseId ||
      presentQuantity === null ||
      presentQuantity < 0 ||
      (reservedQuantity !== null && reservedQuantity < 0) ||
      (freeQuantity !== null && freeQuantity < 0)
    ) {
      return {
        invalid: true,
        reason: "warehouse-stock-row-contract-invalid",
        productId,
        offerId,
        sku,
        stocks: [],
      };
    }
    const stock = {
      warehouseId,
      warehouseName:
        normalizeText(
          firstFilled(
            item.warehouse_name,
            item.warehouseName,
            item.warehouse?.name,
            row.warehouse_name,
            row.warehouseName,
            row.warehouse?.name,
          ),
        ) || null,
      sku:
        normalizeId(
          firstFilled(
            item.sku,
            item.sku_id,
            item.skuId,
            item.fbs_sku,
            sku,
          ),
        ) || null,
      fulfillmentType:
        normalizeText(
          firstFilled(
            item.type,
            item.stock_type,
            item.stockType,
            item.delivery_schema,
            item.deliverySchema,
            row.type,
            row.stock_type,
            row.delivery_schema,
          ),
        ).toUpperCase() || "SELLER",
      presentQuantity,
      reservedQuantity,
      freeQuantity,
    };
    const previous = stocks.get(warehouseId);
    if (previous && createStableHash(previous) !== createStableHash(stock)) {
      return {
        invalid: true,
        reason: "warehouse-stock-duplicate-conflict",
        productId,
        offerId,
        sku,
        stocks: [],
      };
    }
    stocks.set(warehouseId, stock);
  }
  return {
    productId,
    offerId,
    sku,
    stocks: [...stocks.values()],
    explicitEmpty: false,
    unavailable: false,
  };
}
