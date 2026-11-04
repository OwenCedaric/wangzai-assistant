import { randomUUID } from "node:crypto";
import { createStableHash } from "../../utils/stableHash.js";
import { getOzonSoftwareCategoryByIds } from "../../cache/catalog/softwareCategoryNameService.js";
export {
  booleanFromValue,
  firstFilled,
  firstFiniteNumber,
  normalizeId,
  normalizeProductCurrencyCode,
  normalizeText,
  normalizeVisibility,
  normalizeVisibilityToken,
  nowIso,
  safeJsonParse,
  toFiniteNumber,
  toInteger,
} from "./productDtoValues.js";
import {
  booleanFromValue,
  firstFilled,
  normalizeId,
  normalizeProductCurrencyCode,
  normalizeText,
  normalizeVisibility,
  normalizeVisibilityToken,
  safeJsonParse,
  toFiniteNumber,
} from "./productDtoValues.js";
export { extractImages, extractPrimaryImage, normalizeImageList } from "./productDtoImages.js";
import { extractImages, extractPrimaryImage } from "./productDtoImages.js";
import { normalizePublicWarehouseStocks } from "./productDtoStock.js";
export {
  collectNestedStockItems,
  compactStock,
  extractStock,
  getExplicitStockAvailabilityEvidence,
  getPublicStockValue,
  getStockItemKey,
  getStockItemQuantity,
  getWarehouseStockTotalFromSource,
  hasExplicitEmptyPrimaryStockArray,
  hasExplicitEmptyStockArray,
  hasExplicitNoStockEvidence,
  hasExplicitStockPresenceEvidence,
  normalizeStockJsonWithComputedPresent,
  repairStoredStockPatch,
  shouldRepairStoredStockValue,
  sumStockItems,
} from "./productDtoStock.js";
import {
  extractStock,
  getExplicitStockAvailabilityEvidence,
  getPublicStockValue,
  normalizeStockJsonWithComputedPresent,
} from "./productDtoStock.js";
export {
  PRODUCT_FACET_OBSERVATION_STATUS,
  PRODUCT_FULL_HYDRATION_FACETS,
  PRODUCT_HYDRATION_FACET_COLUMNS,
  PRODUCT_OZON_MATERIAL_SOURCE,
  chunkProductHydrationValues,
  createProductHydrationCoverage,
  isProductFacetGapStatus,
  isProductFacetSuccessStatus,
  isProductHydrationComplete,
  latestProductHydrationTimestamp,
  toPublicProductHydration,
} from "./productDtoHydration.js";
import { toPublicProductHydration } from "./productDtoHydration.js";
export {
  aggregateCanonicalCommissionStatus,
  buildCompactFeePayload,
  canonicalRatePpmToPercent,
  compactFee,
  createPatchHash,
  extractAcquiringFee,
  extractAcquiringObservation,
  extractAcquiringPercent,
  extractCommissionObservation,
  findDeepNumericByKeys,
  firstFiniteFromValues,
  firstPositiveFiniteNumber,
  mergeCanonicalFactReadRow,
  normalizePositivePercent,
  splitIds,
  toPublicProductFeeEvidence,
} from "./productDtoFees.js";
import {
  extractAcquiringFee,
  extractAcquiringPercent,
  extractCommissionObservation,
  firstPositiveFiniteNumber,
  toPublicProductFeeEvidence,
} from "./productDtoFees.js";


export const PRODUCT_STATUS_BY_VISIBILITY = Object.freeze({
  IN_SALE: "出售中",
  TO_SUPPLY: "待销售",
  STATE_FAILED: "错误品",
  VALIDATION_STATE_FAIL: "待修改",
  REMOVED_FROM_SALE: "违规品",
  ARCHIVED: "已下架",
});

export const STRONG_PRODUCT_VISIBILITIES = new Set([
  "STATE_FAILED",
  "VALIDATION_STATE_FAIL",
  "REMOVED_FROM_SALE",
  "ARCHIVED",
]);
export const WEAK_INFERRED_PRODUCT_VISIBILITIES = new Set(["IN_SALE", "TO_SUPPLY"]);
export const SELLABLE_PRODUCT_VISIBILITIES = new Set(["IN_SALE", "TO_SUPPLY"]);

export const VISIBILITY_BY_STATUS_LABEL = Object.freeze({
  出售中: "IN_SALE",
  销售中: "IN_SALE",
  待销售: "TO_SUPPLY",
  准备销售: "TO_SUPPLY",
  已售罄: "TO_SUPPLY",
  错误品: "STATE_FAILED",
  错误: "STATE_FAILED",
  待修改: "VALIDATION_STATE_FAIL",
  违规品: "REMOVED_FROM_SALE",
  商品已下架: "REMOVED_FROM_SALE",
  已下架: "ARCHIVED",
  档案: "ARCHIVED",
});

export function mapStatusLabel(visibility) {
  const normalized = normalizeVisibility(visibility);
  return PRODUCT_STATUS_BY_VISIBILITY[normalized] || "";
}

export function isStrongProductVisibility(visibility) {
  return STRONG_PRODUCT_VISIBILITIES.has(normalizeVisibilityToken(visibility));
}

export function shouldPreserveExistingStatusOnAllSync(
  existingVisibility,
  nextVisibility,
  requestVisibility,
) {
  const existing = normalizeVisibilityToken(existingVisibility);
  const next = normalizeVisibilityToken(nextVisibility);
  const request = normalizeVisibility(requestVisibility, "ALL");
  return (
    request === "ALL" &&
    isStrongProductVisibility(existing) &&
    !isStrongProductVisibility(next)
  );
}

export function normalizeStatusLabel(value) {
  const text = normalizeText(value);
  if (!text || text === "全部商品") return "";
  return VISIBILITY_BY_STATUS_LABEL[text]
    ? mapStatusLabel(VISIBILITY_BY_STATUS_LABEL[text])
    : text;
}

export function visibilityFromStatusLabel(value) {
  return VISIBILITY_BY_STATUS_LABEL[normalizeStatusLabel(value)] || "";
}

export function hasObjectArrayItems(value) {
  return (
    Array.isArray(value) &&
    value.some((item) => item && typeof item === "object")
  );
}

export function resolveProductStatusFromEvidence(row = {}, contextVisibility = "ALL") {
  const rawStatusLabel = normalizeStatusLabel(
    firstFilled(row.status_label, row.statusLabel, row.status?.name),
  );
  const labelVisibility = visibilityFromStatusLabel(rawStatusLabel);
  if (labelVisibility)
    return {
      visibility: labelVisibility,
      statusLabel: mapStatusLabel(labelVisibility),
    };

  const directVisibility = normalizeVisibilityToken(
    firstFilled(
      row.visibility,
      row.visibility_status,
      row.visibilityStatus,
      row.status?.state,
      row.visibility_details?.visibility,
      row.visibility_details?.status,
      row.visibility_details?.state,
    ),
    "",
  );
  if (
    directVisibility &&
    directVisibility !== "ALL" &&
    mapStatusLabel(directVisibility)
  ) {
    return {
      visibility: directVisibility,
      statusLabel: mapStatusLabel(directVisibility),
    };
  }

  const directStatusVisibility = visibilityFromStatusLabel(
    firstFilled(row.status, row.state),
  );
  if (directStatusVisibility) {
    return {
      visibility: directStatusVisibility,
      statusLabel: mapStatusLabel(directStatusVisibility),
    };
  }

  const archived = booleanFromValue(
    firstFilled(row.archived, row.is_archived, row.isArchive, row.is_archive),
  );
  if (archived === true)
    return { visibility: "ARCHIVED", statusLabel: mapStatusLabel("ARCHIVED") };

  const requestVisibility = normalizeVisibility(contextVisibility, "ALL");
  if (requestVisibility !== "ALL" && mapStatusLabel(requestVisibility)) {
    return {
      visibility: requestVisibility,
      statusLabel: mapStatusLabel(requestVisibility),
    };
  }

  if (
    hasObjectArrayItems(row.errors) ||
    hasObjectArrayItems(row.validation_errors)
  ) {
    return {
      visibility: "VALIDATION_STATE_FAIL",
      statusLabel: mapStatusLabel("VALIDATION_STATE_FAIL"),
    };
  }

  if (requestVisibility === "ALL") {
    return { visibility: "ALL", statusLabel: rawStatusLabel || "" };
  }

  return { visibility: "ALL", statusLabel: rawStatusLabel || "" };
}

export function resolvePublicProductStatus(row = {}) {
  const raw =
    typeof row.raw_json === "string"
      ? safeJsonParse(row.raw_json, {})
      : row.raw_json && typeof row.raw_json === "object"
        ? row.raw_json
        : {};
  const evidenceRow = {
    ...raw,
    ...row,
    archived: firstFilled(
      row.archived,
      row.is_archived,
      row.isArchive,
      row.is_archive,
      raw.archived,
      raw.is_archived,
      raw.isArchive,
      raw.is_archive,
    ),
  };
  const resolved = resolveProductStatusFromEvidence(
    evidenceRow,
    row.visibility || "ALL",
  );
  if (
    resolved.visibility !== "ALL" &&
    resolved.statusLabel &&
    resolved.statusLabel !== "未知状态"
  ) {
    return resolved;
  }
  const storedStatus = normalizeStatusLabel(
    row.status_label || row.statusLabel,
  );
  const storedVisibility = visibilityFromStatusLabel(storedStatus);
  if (storedVisibility)
    return {
      visibility: storedVisibility,
      statusLabel: mapStatusLabel(storedVisibility),
    };
  const rawVisibility = normalizeVisibilityToken(row.visibility);
  if (
    rawVisibility &&
    rawVisibility !== "ALL" &&
    mapStatusLabel(rawVisibility)
  ) {
    return {
      visibility: rawVisibility,
      statusLabel: mapStatusLabel(rawVisibility),
    };
  }
  const snapshotVisibility = firstMappedSnapshotVisibility(row);
  if (snapshotVisibility && mapStatusLabel(snapshotVisibility)) {
    return {
      visibility: snapshotVisibility,
      statusLabel: mapStatusLabel(snapshotVisibility),
    };
  }
  return {
    visibility: rawVisibility || "ALL",
    statusLabel: storedStatus || "",
  };
}

export function normalizeSnapshotVisibilities(value) {
  const values = Array.isArray(value) ? value : safeJsonParse(value, []);
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => normalizeVisibilityToken(item))
        .filter(Boolean),
    ),
  ];
}

export function firstMappedSnapshotVisibility(row = {}) {
  return (
    normalizeSnapshotVisibilities(
      firstFilled(
        row.snapshot_visibilities_json,
        row.snapshotVisibilities,
        row.productSnapshotVisibilities,
        row.product_snapshot_visibilities,
      ),
    ).find(
      (visibility) => visibility !== "ALL" && mapStatusLabel(visibility),
    ) || ""
  );
}

export function mergeSnapshotVisibilities(...values) {
  return [
    ...new Set(
      values.flatMap((value) => {
        if (Array.isArray(value))
          return value
            .map((item) => normalizeVisibilityToken(item))
            .filter(Boolean);
        const normalized = normalizeVisibilityToken(value);
        return normalized ? [normalized] : [];
      }),
    ),
  ];
}

export function sanitizeSnapshotVisibilities(values = []) {
  const normalized = mergeSnapshotVisibilities(values);
  if (!normalized.some(isStrongProductVisibility)) return normalized;
  return normalized.filter(
    (visibility) => !WEAK_INFERRED_PRODUCT_VISIBILITIES.has(visibility),
  );
}

export function isExplicitProductVisibilitySync(visibility) {
  const normalized = normalizeVisibility(visibility, "ALL");
  return normalized !== "ALL" && Boolean(mapStatusLabel(normalized));
}

export function reconcileSnapshotVisibilitiesForCurrentStatus(
  existingSnapshots = [],
  currentVisibility = "",
  requestVisibility = "ALL",
) {
  const current = normalizeVisibilityToken(currentVisibility);
  const request = normalizeVisibility(requestVisibility, "ALL");
  const snapshots = mergeSnapshotVisibilities(
    existingSnapshots,
    request === "ALL" ? "ALL" : request,
    current && current !== "ALL" ? current : "",
  );

  if (
    SELLABLE_PRODUCT_VISIBILITIES.has(current) &&
    isExplicitProductVisibilitySync(request)
  ) {
    return snapshots.filter((visibility) => !isStrongProductVisibility(visibility));
  }

  if (isStrongProductVisibility(current)) {
    return snapshots.filter(
      (visibility) => visibility === current || visibility === "ALL",
    );
  }

  return sanitizeSnapshotVisibilities(snapshots);
}

export function extractPrice(item = {}) {
  // Ozon may return 0 in marketing price fields for archived products while
  // price.price still contains the actual positive price.  A zero sentinel
  // must not win merely because it appears first in the response.
  return firstPositiveFiniteNumber(
    item.price?.marketing_price,
    item.marketing_price,
    item.price?.marketing_seller_price,
    item.marketing_seller_price,
    item.price?.price,
    typeof item.price === "object" ? null : item.price,
    item.old_price,
  );
}

export function extractCurrency(item = {}) {
  return normalizeProductCurrencyCode(
    firstFilled(
      item.price?.currency_code,
      item.currency_code,
      item.currencyCode,
    ),
  );
}

export function normalizeProductInput(row = {}, context = {}) {
  const productId = normalizeId(
    firstFilled(row.product_id, row.productId, row.id),
  );
  const offerId = normalizeId(firstFilled(row.offer_id, row.offerId));
  const sku = normalizeId(firstFilled(row.sku, row.sku_id, row.skuId));
  const productKey = createProductKey({ productId, offerId, sku, raw: row });
  const requestVisibility = normalizeVisibility(context.visibility, "ALL");
  const status = resolveProductStatusFromEvidence(row, requestVisibility);
  const visibility = status.visibility;
  const snapshotVisibilities = mergeSnapshotVisibilities(
    requestVisibility,
    row.productSnapshotVisibilities,
    row.snapshotVisibilities,
  );
  const images = extractImages(row);
  const primaryImageUrl = extractPrimaryImage(row) || images[0] || "";
  const normalized = {
    id: createProductRowId(context.shopId, productKey),
    shopId: context.shopId,
    productKey,
    productId,
    offerId,
    sku,
    name:
      normalizeText(firstFilled(row.name, row.title, row.product_name)) ||
      "未返回",
    visibility,
    statusLabel: status.statusLabel || mapStatusLabel(visibility) || "未知状态",
    snapshotVisibilities,
    categoryId: normalizeId(
      firstFilled(
        row.description_category_id,
        row.category_id,
        row.categoryId,
        row.category?.id,
      ),
    ),
    categoryName: normalizeText(
      firstFilled(row.category_name, row.categoryName, row.category?.name),
    ),
    typeId: normalizeId(
      firstFilled(
        row.type_id,
        row.typeId,
        row.category?.type_id,
        row.category?.typeId,
      ),
    ),
    primaryImageUrl,
    images,
    priceValue: extractPrice(row),
    currencyCode: extractCurrency(row),
    stockValue: extractStock(row),
    commissionPercent: extractCommission(row),
    weightKg: normalizeWeight(
      row.weight_kg ?? row.weightKg ?? row.weight,
      row.weight_unit ?? row.weightUnit,
    ),
    widthCm: normalizeDimension(
      row.width_cm ?? row.widthCm ?? row.width,
      row.dimension_unit ?? row.dimensionUnit,
    ),
    heightCm: normalizeDimension(
      row.height_cm ?? row.heightCm ?? row.height,
      row.dimension_unit ?? row.dimensionUnit,
    ),
    depthCm: normalizeDimension(
      row.depth_cm ?? row.depthCm ?? row.depth ?? row.length,
      row.dimension_unit ?? row.dimensionUnit,
    ),
    sortIndex: Number.isFinite(Number(context.sortIndex))
      ? Number(context.sortIndex)
      : 0,
    sourceEndpointKey: context.endpointKey || "products.list",
    raw: row,
  };
  normalized.remoteHash = createProductRemoteHash(normalized);
  return normalized;
}

export function createProductRemoteHash(normalized = {}) {
  return createStableHash(
    {
      productId: normalized.productId,
      offerId: normalized.offerId,
      sku: normalized.sku,
      name: normalized.name,
      visibility: normalized.visibility,
      statusLabel: normalized.statusLabel,
      categoryId: normalized.categoryId,
      categoryName: normalized.categoryName,
      typeId: normalized.typeId,
      primaryImageUrl: normalized.primaryImageUrl,
      priceValue: normalized.priceValue,
      currencyCode: normalized.currencyCode,
      stockValue: normalized.stockValue,
      stockAvailability: getExplicitStockAvailabilityEvidence(
        normalized.raw || {},
      ),
      commissionPercent: normalized.commissionPercent,
      weightKg: normalized.weightKg,
      widthCm: normalized.widthCm,
      heightCm: normalized.heightCm,
      depthCm: normalized.depthCm,
    },
    { length: 32 },
  );
}

export function createProductKey({ productId, offerId, sku, raw } = {}) {
  return productId
    ? `product:${productId}`
    : offerId
      ? `offer:${offerId}`
      : sku
        ? `sku:${sku}`
        : `row:${createStableHash(raw || randomUUID(), { length: 20 })}`;
}

export function createProductRowId(shopId, productKey) {
  return `${shopId}:${createStableHash(productKey, { length: 24 })}`;
}

export function compactJson(value) {
  return JSON.stringify(value ?? null);
}

export function addJsonField(target, key, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value) && value.length === 0) return;
  if (typeof value === "string" && !value.trim()) return;
  target[key] = compactJson(value);
}

export function addField(target, key, value) {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && !value.trim()) return;
  target[key] = value;
}

export function addNumberField(target, key, value) {
  if (value === undefined || value === null) return;
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  target[key] = number;
}

export function addResolvedStatusFields(target, row = {}, fallbackVisibility = "") {
  const status = resolveProductStatusFromEvidence(row, fallbackVisibility);
  if (status.visibility && status.visibility !== "ALL")
    addField(target, "visibility", status.visibility);
  if (status.statusLabel && status.statusLabel !== "未知状态")
    addField(target, "status_label", status.statusLabel);
  return status;
}

export function normalizeWeight(value, unit = "") {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const normalizedUnit = normalizeText(unit).toLowerCase();
  if (normalizedUnit === "kg" || normalizedUnit === "кг") return number;
  if (
    normalizedUnit === "g" ||
    normalizedUnit === "гр" ||
    normalizedUnit === "gram" ||
    normalizedUnit === "grams"
  )
    return number / 1000;
  return number > 100 ? number / 1000 : number;
}

export function normalizeDimension(value, unit = "") {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const normalizedUnit = normalizeText(unit).toLowerCase();
  if (normalizedUnit === "cm" || normalizedUnit === "см") return number;
  if (normalizedUnit === "mm" || normalizedUnit === "мм") return number / 10;
  return number > 100 ? number / 10 : number;
}

export function extractDimensions(row = {}) {
  const dimensions =
    row.dimensions ||
    row.dimension ||
    row.package_dimensions ||
    row.packageDimensions ||
    {};
  const weightUnit =
    row.weight_unit ??
    row.weightUnit ??
    dimensions.weight_unit ??
    dimensions.weightUnit;
  const dimensionUnit =
    row.dimension_unit ??
    row.dimensionUnit ??
    dimensions.dimension_unit ??
    dimensions.dimensionUnit;
  return {
    weightKg: normalizeWeight(
      row.weight_kg ?? row.weightKg ?? row.weight ?? dimensions.weight,
      weightUnit,
    ),
    widthCm: normalizeDimension(
      row.width_cm ?? row.widthCm ?? row.width ?? dimensions.width,
      dimensionUnit,
    ),
    heightCm: normalizeDimension(
      row.height_cm ?? row.heightCm ?? row.height ?? dimensions.height,
      dimensionUnit,
    ),
    depthCm: normalizeDimension(
      row.depth_cm ??
        row.depthCm ??
        row.depth ??
        row.length ??
        dimensions.depth ??
        dimensions.length,
      dimensionUnit,
    ),
  };
}

export function compactAttributes(row = {}) {
  const attrs = Array.isArray(row.attributes) ? row.attributes : [];
  return attrs.slice(0, 200).map((attr) => ({
    id: attr.id ?? attr.attribute_id ?? attr.attributeId ?? null,
    name: attr.name ?? attr.attribute_name ?? attr.attributeName ?? "",
    values: Array.isArray(attr.values)
      ? attr.values.slice(0, 20).map((value) => ({
          value:
            value?.value ?? value?.name ?? value?.dictionary_value ?? value,
          dictionary_value_id:
            value?.dictionary_value_id ?? value?.dictionaryValueId ?? undefined,
        }))
      : attr.value === undefined
        ? []
        : [{ value: attr.value }],
  }));
}

export function compactPrice(row = {}) {
  const price = row.price && typeof row.price === "object" ? row.price : {};
  const commissions =
    row.commissions && typeof row.commissions === "object"
      ? row.commissions
      : {};
  return {
    product_id: row.product_id ?? row.productId ?? null,
    offer_id: row.offer_id ?? row.offerId ?? null,
    price: price.price ?? row.price ?? null,
    marketing_price: price.marketing_price ?? row.marketing_price ?? null,
    marketing_seller_price:
      price.marketing_seller_price ?? row.marketing_seller_price ?? null,
    old_price: price.old_price ?? row.old_price ?? null,
    min_price: price.min_price ?? row.min_price ?? row.minPrice ?? null,
    currency_code:
      price.currency_code ?? row.currency_code ?? row.currencyCode ?? null,
    acquiring_fee_value: extractAcquiringFee(row),
    acquiring_percent: extractAcquiringPercent(row),
    commissions: {
      sales_percent_rfbs:
        commissions.sales_percent_rfbs ??
        row.commission_percent ??
        row.commissionPercent ??
        null,
      sales_percent_fbs: commissions.sales_percent_fbs ?? null,
      sales_percent_fbo: commissions.sales_percent_fbo ?? null,
      sales_percent_fbp: commissions.sales_percent_fbp ?? null,
    },
  };
}

export function extractCommission(row = {}) {
  const observation = extractCommissionObservation(row);
  // 0 is an Ozon availability sentinel, not a proven commission rate.
  // Only a positive direct mode can become the scalar compatibility field.
  // All four raw fulfillment modes remain in price_json and provenance.
  // This wrapper intentionally keeps the old mapper surface stable.
  // Missing or invalid observations deliberately remain null.
  return observation.selectedPercent;
}

export function toPublicProduct(row = {}) {
  const images = safeJsonParse(row.images_json, []);
  const attributes = safeJsonParse(row.attributes_json, []);
  const priceJson = safeJsonParse(row.price_json, null);
  const stockJson = normalizeStockJsonWithComputedPresent(
    safeJsonParse(row.stock_json, null),
  );
  const stockValue = getPublicStockValue(row.stock_value, stockJson);
  const warehouseStocks = normalizePublicWarehouseStocks(row);
  const facetObservations = safeJsonParse(row.facet_observations_json, {});
  const normalizedWarehouseObservation = facetObservations?.warehouse_stocks;
  const compatibilityWarehouseObservation = facetObservations?.warehouseStocks;
  const warehouseStockObservation =
    normalizedWarehouseObservation || compatibilityWarehouseObservation
      ? {
          ...(compatibilityWarehouseObservation || {}),
          ...(normalizedWarehouseObservation || {}),
          currentStatus:
            compatibilityWarehouseObservation?.currentStatus ??
            normalizedWarehouseObservation?.currentStatus ??
            null,
        }
      : null;
  const sellerWarehouseStockTotal = warehouseStocks.length > 0
    ? warehouseStocks.reduce(
        (total, stock) => total + stock.presentQuantity,
        0,
      )
    : normalizeText(warehouseStockObservation?.status).toLowerCase() ===
        "returned_empty"
      ? 0
      : null;
  const warehouseStockComplete = ["returned", "returned_empty"].includes(
    normalizeText(warehouseStockObservation?.status).toLowerCase(),
  );
  const rawSnapshotVisibilities = normalizeSnapshotVisibilities(
    row.snapshot_visibilities_json,
  );
  const publicStatus = resolvePublicProductStatus(row);
  const snapshotVisibilities = reconcileSnapshotVisibilitiesForCurrentStatus(
    rawSnapshotVisibilities,
    publicStatus.visibility,
    publicStatus.visibility,
  );
  const softwareCategory = getOzonSoftwareCategoryByIds({
    descriptionCategoryId: row.category_id,
    typeId: row.type_id,
  });
  const storedCategoryName = row.category_name || "";
  const categoryName = softwareCategory?.pathText || storedCategoryName;
  return {
    id: row.id,
    factSource: row.canonical_fact_source || "legacy-product-compatibility",
    shopId: row.shop_id,
    productKey: row.product_key,
    productId: row.product_id || "",
    offerId: row.offer_id || "",
    sku: row.sku || "",
    name: row.name || "",
    visibility: publicStatus.visibility || row.visibility || "ALL",
    statusLabel: publicStatus.statusLabel || "",
    productSnapshotVisibility: snapshotVisibilities[0] || "",
    productSnapshotVisibilities: snapshotVisibilities,
    snapshotVisibilities,
    categoryId: row.category_id || "",
    categoryName,
    categoryPath: categoryName,
    typeId: row.type_id || "",
    softwareCategoryName: softwareCategory?.name || "",
    softwareCategoryPath: softwareCategory?.pathText || "",
    softwareCategoryRootName: softwareCategory?.rootName || "",
    softwareCategorySource:
      softwareCategory?.source || (storedCategoryName ? "ozon-cache" : ""),
    primaryImageUrl: row.primary_image_url || images[0] || "",
    images,
    priceValue:
      row.price_value === null || row.price_value === undefined
        ? null
        : Number(row.price_value),
    currencyCode: normalizeProductCurrencyCode(
      firstFilled(
        priceJson?.currency_code,
        priceJson?.price?.currency_code,
        row.currency_code,
      ),
    ),
    stockValue,
    warehouseStocks,
    sellerWarehouseStockTotal,
    warehouseStockTotal: sellerWarehouseStockTotal,
    warehouseStockCount: warehouseStocks.length,
    warehouseStockComplete,
    warehouseStockObservation,
    commissionPercent:
      row.commission_percent === null || row.commission_percent === undefined
        ? null
        : Number(row.commission_percent),
    acquiringFeeValue:
      row.acquiring_fee_value === null || row.acquiring_fee_value === undefined
        ? null
        : Number(row.acquiring_fee_value),
    acquiringPercent:
      row.acquiring_percent === null || row.acquiring_percent === undefined
        ? null
        : Number(row.acquiring_percent),
    feeJson: safeJsonParse(row.fee_json, null), ...toPublicProductFeeEvidence(row),
    weightKg:
      row.weight_kg === null || row.weight_kg === undefined
        ? null
        : Number(row.weight_kg),
    widthCm:
      row.width_cm === null || row.width_cm === undefined
        ? null
        : Number(row.width_cm),
    heightCm:
      row.height_cm === null || row.height_cm === undefined
        ? null
        : Number(row.height_cm),
    depthCm:
      row.depth_cm === null || row.depth_cm === undefined
        ? null
        : Number(row.depth_cm),
    attributes,
    priceJson,
    stockJson,
    ...toPublicProductHydration(row),
    detailSyncedAt: row.detail_synced_at || null,
    picturesSyncedAt: row.pictures_synced_at || null,
    pricesSyncedAt: row.prices_synced_at || null,
    stocksSyncedAt: row.stocks_synced_at || null,
    attributesSyncedAt: row.attributes_synced_at || null,
    isStale: Boolean(row.is_stale),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

export function normalizePageSize(value) {
  return Math.min(Math.max(Number(value) || 20, 1), 1000);
}

export function jsonExtractSql(column, path) {
  return `json_extract(CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END, '${path}')`;
}

export function archivedEvidenceSql() {
  return `(
    ${jsonExtractSql("raw_json", "$.archived")} = 1 OR
    ${jsonExtractSql("raw_json", "$.is_archived")} = 1 OR
    ${jsonExtractSql("raw_json", "$.isArchive")} = 1 OR
    ${jsonExtractSql("raw_json", "$.is_archive")} = 1 OR
    snapshot_visibilities_json LIKE '%"ARCHIVED"%'
  )`;
}

export function visibilityEvidenceSql() {
  return `(visibility = ? OR status_label = ? OR snapshot_visibilities_json LIKE ?)`;
}

export function appendVisibilityWhere(where, params, visibility) {
  if (visibility === "ARCHIVED") {
    where.push(`(${visibilityEvidenceSql()} OR ${archivedEvidenceSql()})`);
    params.push(visibility, mapStatusLabel(visibility), `%"${visibility}"%`);
    return;
  }
  where.push(visibilityEvidenceSql());
  params.push(visibility, mapStatusLabel(visibility), `%"${visibility}"%`);
}

export function buildWhere(filters = {}) {
  const where = ["is_stale = 0"];
  const params = [];
  if (
    filters.shopId &&
    !["all", "*"].includes(String(filters.shopId).trim().toLowerCase())
  ) {
    where.push("shop_id = ?");
    params.push(filters.shopId);
  }
  if (filters.visibility === "ALL") {
    // 软件内“全部商品”是店铺当前全部有效商品，不等同于 Ozon /v3/product/list 的 ALL 快照。
    // 下架、待销售、错误、待修改、违规等状态都必须计入全部，避免状态卡和分页总数偏小。
  } else if (filters.visibility) {
    appendVisibilityWhere(where, params, filters.visibility);
  }
  if (filters.keyword) {
    where.push(
      "(name LIKE ? OR offer_id LIKE ? OR sku LIKE ? OR product_id LIKE ? OR category_name LIKE ?)",
    );
    const pattern = `%${filters.keyword}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.productIds?.length) {
    where.push(
      `product_id IN (${filters.productIds.map(() => "?").join(",")})`,
    );
    params.push(...filters.productIds);
  }
  if (filters.offerIds?.length) {
    where.push(`offer_id IN (${filters.offerIds.map(() => "?").join(",")})`);
    params.push(...filters.offerIds);
  }
  if (filters.categoryIds?.length) {
    where.push(`category_id IN (${filters.categoryIds.map(() => "?").join(",")})`);
    params.push(...filters.categoryIds);
  }
  if (filters.typeIds?.length) {
    where.push(`type_id IN (${filters.typeIds.map(() => "?").join(",")})`);
    params.push(...filters.typeIds);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function buildCanonicalWhere(filters = {}) {
  const where = ["COALESCE(canonical_is_stale, is_stale) = 0"];
  const params = [];
  if (
    filters.shopId
    && !["all", "*"].includes(String(filters.shopId).trim().toLowerCase())
  ) {
    where.push("shop_id = ?");
    params.push(filters.shopId);
  }
  if (filters.visibility && filters.visibility !== "ALL") {
    where.push(`(
      canonical_visibility = ? OR
      canonical_status_label = ? OR
      canonical_snapshot_visibilities_json LIKE ?
    )`);
    params.push(
      filters.visibility,
      mapStatusLabel(filters.visibility),
      `%"${filters.visibility}"%`,
    );
  }
  if (filters.keyword) {
    where.push(`(
      COALESCE(canonical_name, name, '') LIKE ? OR
      COALESCE(canonical_offer_id, offer_id, '') LIKE ? OR
      COALESCE(canonical_sku, sku, '') LIKE ? OR
      COALESCE(canonical_product_id, product_id, '') LIKE ? OR
      COALESCE(canonical_category_name, category_name, '') LIKE ?
    )`);
    const pattern = `%${filters.keyword}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.productIds?.length) {
    where.push(
      `COALESCE(canonical_product_id, product_id) IN (${filters.productIds.map(() => "?").join(",")})`,
    );
    params.push(...filters.productIds);
  }
  if (filters.offerIds?.length) {
    where.push(
      `COALESCE(canonical_offer_id, offer_id) IN (${filters.offerIds.map(() => "?").join(",")})`,
    );
    params.push(...filters.offerIds);
  }
  if (filters.categoryIds?.length) {
    where.push(
      `COALESCE(canonical_category_id, category_id) IN (${filters.categoryIds.map(() => "?").join(",")})`,
    );
    params.push(...filters.categoryIds);
  }
  if (filters.typeIds?.length) {
    where.push(
      `COALESCE(canonical_type_id, type_id) IN (${filters.typeIds.map(() => "?").join(",")})`,
    );
    params.push(...filters.typeIds);
  }
  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export function buildProductCounts(db, shopId = "", { canonical = false } = {}) {
  const countMap = {};
  Object.keys(PRODUCT_STATUS_BY_VISIBILITY).forEach((visibility) => {
    countMap[visibility] = 0;
  });
  const normalizedShopId = ["all", "*"].includes(
    String(shopId || "")
      .trim()
      .toLowerCase(),
  )
    ? ""
    : shopId;
  const shopFilter = normalizedShopId || null;
  if (canonical) {
    Object.keys(PRODUCT_STATUS_BY_VISIBILITY).forEach((visibility) => {
      const countRow = db
        .prepare(
          `
        SELECT COUNT(*) AS count
        FROM product_status_facts
        WHERE is_stale = 0
          AND (? IS NULL OR shop_id = ?)
          AND (
            visibility = ? OR
            status_label = ? OR
            snapshot_visibilities_json LIKE ?
          )
      `,
        )
        .get(
          shopFilter,
          shopFilter,
          visibility,
          mapStatusLabel(visibility),
          `%"${visibility}"%`,
        );
      countMap[visibility] = Number(countRow?.count) || 0;
    });
    const totalProductCount = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM product_status_facts
      WHERE is_stale = 0
        AND (? IS NULL OR shop_id = ?)
    `,
      )
      .get(shopFilter, shopFilter);
    countMap.ALL = Number(totalProductCount?.count) || 0;
    return countMap;
  }
  Object.keys(PRODUCT_STATUS_BY_VISIBILITY).forEach((visibility) => {
    const visibilityWhere = [];
    const visibilityParams = [];
    appendVisibilityWhere(visibilityWhere, visibilityParams, visibility);
    const countRow = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM ozon_products
      WHERE is_stale = 0
        AND (? IS NULL OR shop_id = ?)
        AND ${visibilityWhere.join(" AND ")}
    `,
      )
      .get(shopFilter, shopFilter, ...visibilityParams);
    countMap[visibility] = Number(countRow?.count) || 0;
  });
  const totalProductCount = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM ozon_products
    WHERE is_stale = 0
      AND (? IS NULL OR shop_id = ?)
  `,
    )
    .get(shopFilter, shopFilter);
  countMap.ALL = Number(totalProductCount?.count) || 0;
  return countMap;
}

export function normalizeProductSort(value) {
  const text = normalizeText(value).toLowerCase();
  if (["stock_desc", "stock-desc"].includes(text)) return "stock_desc";
  if (["stock_asc", "stock-asc"].includes(text)) return "stock_asc";
  if (["price_desc", "price-desc"].includes(text)) return "price_desc";
  if (["price_asc", "price-asc"].includes(text)) return "price_asc";
  if (["fee_desc", "fee-desc"].includes(text)) return "fee_desc";
  if (["fee_asc", "fee-asc"].includes(text)) return "fee_asc";
  if (["profit_desc", "profit-desc"].includes(text)) return "profit_desc";
  if (["profit_asc", "profit-asc"].includes(text)) return "profit_asc";
  if (["weight_desc", "weight-desc"].includes(text)) return "weight_desc";
  if (["weight_asc", "weight-asc"].includes(text)) return "weight_asc";
  if (["status_desc", "status-desc"].includes(text)) return "status_desc";
  if (["status_asc", "status-asc"].includes(text)) return "status_asc";
  if (["updated_desc", "updated-desc", "updated"].includes(text))
    return "updated_desc";
  if (["product_id", "product-id", "identity"].includes(text))
    return "identity";
  return "stable";
}

export function stockSortValueSql() {
  return `COALESCE(
    (
      SELECT SUM(CAST(${jsonExtractSql("value", "$.present")} AS REAL))
      FROM json_each(CASE WHEN json_valid(stock_json) THEN stock_json ELSE '{"stocks":[]}' END, '$.stocks')
      WHERE ${jsonExtractSql("value", "$.present")} IS NOT NULL
    ),
    CAST(${jsonExtractSql("stock_json", "$.present")} AS REAL),
    stock_value
  )`;
}

export function feeSortValueSql() {
  return `(
    COALESCE(acquiring_fee_value, 0) +
    CASE
      WHEN price_value IS NOT NULL AND commission_percent IS NOT NULL
      THEN price_value * commission_percent / 100.0
      ELSE 0
    END
  )`;
}

export function profitSortValueSql() {
  return `(COALESCE(price_value, 0) - ${feeSortValueSql()})`;
}

export function statusSortValueSql() {
  return `CASE
    WHEN visibility = 'IN_SALE' OR status_label = '出售中' THEN 10
    WHEN visibility = 'TO_SUPPLY' OR status_label = '待销售' THEN 20
    WHEN visibility = 'STATE_FAILED' OR status_label = '错误品' THEN 30
    WHEN visibility = 'VALIDATION_STATE_FAIL' OR status_label = '待修改' THEN 40
    WHEN visibility = 'REMOVED_FROM_SALE' OR status_label = '违规品' THEN 50
    WHEN visibility = 'ARCHIVED' OR status_label = '已下架' OR ${archivedEvidenceSql()} THEN 60
    ELSE 999
  END`;
}

export function numericOrderBy(expression, direction) {
  const dir = direction === "asc" ? "ASC" : "DESC";
  return `(${expression}) IS NULL ASC, (${expression}) ${dir}, product_id ASC, offer_id ASC`;
}

export function buildProductOrderBy(sort = "stable") {
  const normalized = normalizeProductSort(sort);
  if (normalized === "updated_desc")
    return "updated_at DESC, product_id ASC, offer_id ASC";
  if (normalized === "identity") return "product_id ASC, offer_id ASC, sku ASC";
  if (normalized === "stock_desc") return numericOrderBy(stockSortValueSql(), "desc");
  if (normalized === "stock_asc") return numericOrderBy(stockSortValueSql(), "asc");
  if (normalized === "price_desc") return numericOrderBy("price_value", "desc");
  if (normalized === "price_asc") return numericOrderBy("price_value", "asc");
  if (normalized === "fee_desc") return numericOrderBy(feeSortValueSql(), "desc");
  if (normalized === "fee_asc") return numericOrderBy(feeSortValueSql(), "asc");
  if (normalized === "profit_desc") return numericOrderBy(profitSortValueSql(), "desc");
  if (normalized === "profit_asc") return numericOrderBy(profitSortValueSql(), "asc");
  if (normalized === "weight_desc") return numericOrderBy("weight_kg", "desc");
  if (normalized === "weight_asc") return numericOrderBy("weight_kg", "asc");
  if (normalized === "status_desc") return `${statusSortValueSql()} DESC, product_id ASC, offer_id ASC`;
  if (normalized === "status_asc") return `${statusSortValueSql()} ASC, product_id ASC, offer_id ASC`;
  return "sort_index ASC, product_id ASC, offer_id ASC, updated_at DESC";
}

export function canonicalIdentityOrder(direction = "ASC") {
  return `COALESCE(canonical_product_id, product_id) ${direction}, COALESCE(canonical_offer_id, offer_id) ${direction}`;
}

export function canonicalNumericOrderBy(expression, direction) {
  const dir = direction === "asc" ? "ASC" : "DESC";
  return `(${expression}) IS NULL ASC, (${expression}) ${dir}, ${canonicalIdentityOrder("ASC")}`;
}

export function canonicalStatusSortValueSql() {
  return `CASE
    WHEN canonical_visibility = 'IN_SALE' OR canonical_status_label = '出售中' THEN 10
    WHEN canonical_visibility = 'TO_SUPPLY' OR canonical_status_label = '待销售' THEN 20
    WHEN canonical_visibility = 'STATE_FAILED' OR canonical_status_label = '错误品' THEN 30
    WHEN canonical_visibility = 'VALIDATION_STATE_FAIL' OR canonical_status_label = '待修改' THEN 40
    WHEN canonical_visibility = 'REMOVED_FROM_SALE' OR canonical_status_label = '违规品' THEN 50
    WHEN canonical_visibility = 'ARCHIVED' OR canonical_status_label = '已下架'
      OR canonical_snapshot_visibilities_json LIKE '%"ARCHIVED"%' THEN 60
    ELSE 999
  END`;
}

export function buildCanonicalProductOrderBy(sort = "stable") {
  const normalized = normalizeProductSort(sort);
  if (normalized === "updated_desc") {
    return `COALESCE(canonical_status_updated_at, updated_at) DESC, ${canonicalIdentityOrder("ASC")}`;
  }
  if (normalized === "identity") {
    return `${canonicalIdentityOrder("ASC")}, COALESCE(canonical_sku, sku) ASC`;
  }
  if (normalized === "stock_desc") return canonicalNumericOrderBy("canonical_stock_quantity", "desc");
  if (normalized === "stock_asc") return canonicalNumericOrderBy("canonical_stock_quantity", "asc");
  if (normalized === "price_desc") return canonicalNumericOrderBy("canonical_price_minor", "desc");
  if (normalized === "price_asc") return canonicalNumericOrderBy("canonical_price_minor", "asc");
  const canonicalFee = `(COALESCE(canonical_acquiring_fee_minor, 0)
    + CASE WHEN canonical_price_minor IS NOT NULL AND canonical_commission_rate_ppm IS NOT NULL
      THEN canonical_price_minor * canonical_commission_rate_ppm / 1000000.0 ELSE 0 END)`;
  if (normalized === "fee_desc") return canonicalNumericOrderBy(canonicalFee, "desc");
  if (normalized === "fee_asc") return canonicalNumericOrderBy(canonicalFee, "asc");
  const canonicalProfit = `(COALESCE(canonical_price_minor, 0) - ${canonicalFee})`;
  if (normalized === "profit_desc") return canonicalNumericOrderBy(canonicalProfit, "desc");
  if (normalized === "profit_asc") return canonicalNumericOrderBy(canonicalProfit, "asc");
  if (normalized === "weight_desc") return canonicalNumericOrderBy("canonical_weight_g", "desc");
  if (normalized === "weight_asc") return canonicalNumericOrderBy("canonical_weight_g", "asc");
  if (normalized === "status_desc") return `${canonicalStatusSortValueSql()} DESC, ${canonicalIdentityOrder("ASC")}`;
  if (normalized === "status_asc") return `${canonicalStatusSortValueSql()} ASC, ${canonicalIdentityOrder("ASC")}`;
  return `${canonicalStatusSortValueSql()} ASC, ${canonicalIdentityOrder("ASC")}`;
}

export function canonicalProductSourceCte() {
  return `
    canonical_source AS (
      SELECT legacy.*,
             identity.product_identity_id AS canonical_identity_id,
             identity.product_id AS canonical_product_id,
             identity.offer_id AS canonical_offer_id,
             identity.sku AS canonical_sku,
             status.visibility AS canonical_visibility,
             status.status_label AS canonical_status_label,
             status.is_stale AS canonical_is_stale,
             status.snapshot_visibilities_json AS canonical_snapshot_visibilities_json,
             status.updated_at AS canonical_status_updated_at,
             detail.product_identity_id AS canonical_detail_present,
             detail.name AS canonical_name,
             detail.category_id AS canonical_category_id,
             detail.category_name AS canonical_category_name,
             detail.type_id AS canonical_type_id,
             dimensions.product_identity_id AS canonical_dimensions_present,
             dimensions.weight_g AS canonical_weight_g,
             dimensions.length_mm AS canonical_length_mm,
             dimensions.width_mm AS canonical_width_mm,
             dimensions.height_mm AS canonical_height_mm,
             price.product_identity_id AS canonical_price_present,
             price.amount_minor AS canonical_price_minor,
             price.currency_code AS canonical_price_currency,
             acquiring.product_identity_id AS canonical_acquiring_present,
             acquiring.fee_minor AS canonical_acquiring_fee_minor,
             acquiring.rate_ppm AS canonical_acquiring_rate_ppm,
             acquiring.status AS canonical_acquiring_status,
             acquiring.operation_id AS canonical_acquiring_operation_id,
             acquiring.contract_version AS canonical_acquiring_contract_version,
             acquiring.mapper_version AS canonical_acquiring_mapper_version,
             acquiring.response_hash AS canonical_acquiring_response_hash,
             acquiring.run_id AS canonical_acquiring_run_id,
             acquiring.snapshot_id AS canonical_acquiring_snapshot_id,
             acquiring.observed_at AS canonical_acquiring_observed_at,
             acquiring.source_reason AS canonical_acquiring_source_reason,
             stock.product_identity_id AS canonical_stock_present,
             stock.present_quantity AS canonical_stock_quantity,
             stock.status AS canonical_stock_status,
             stock.source_reason AS canonical_stock_source_reason,
             attributes.product_identity_id AS canonical_attributes_present,
             attributes.attributes_json AS canonical_attributes_json,
             (
               SELECT commission.rate_ppm
               FROM product_commission_facts AS commission
               WHERE commission.product_identity_id = legacy.id
                 AND commission.rate_ppm IS NOT NULL
               ORDER BY CASE commission.fulfillment_type
                 WHEN 'RFBS' THEN 1 WHEN 'FBS' THEN 2 WHEN 'FBO' THEN 3 ELSE 4 END
               LIMIT 1
             ) AS canonical_commission_rate_ppm
      FROM ozon_products AS legacy
      JOIN product_identities AS identity
        ON identity.product_identity_id = legacy.id
       AND identity.shop_id = legacy.shop_id
      JOIN product_status_facts AS status
        ON status.product_identity_id = identity.product_identity_id
       AND status.shop_id = identity.shop_id
      LEFT JOIN product_detail_facts AS detail
        ON detail.product_identity_id = identity.product_identity_id
      LEFT JOIN product_dimension_facts AS dimensions
        ON dimensions.product_identity_id = identity.product_identity_id
       AND dimensions.source_type = 'ozon'
      LEFT JOIN product_price_facts AS price
        ON price.product_identity_id = identity.product_identity_id
      LEFT JOIN product_acquiring_facts AS acquiring
        ON acquiring.product_identity_id = identity.product_identity_id
      LEFT JOIN product_stock_facts AS stock
        ON stock.product_identity_id = identity.product_identity_id
      LEFT JOIN product_attribute_facts AS attributes
        ON attributes.product_identity_id = identity.product_identity_id
    )
  `;
}


