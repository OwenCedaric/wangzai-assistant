import { createStableHash } from "../../utils/stableHash.js";
import * as canonicalDto from "./productCanonicalDto.js";
import {
  normalizeFacetObservationStatus,
  createFacetObservation,
  applyPriceFeeObservations,
  normalizeHydrationFacet,
  normalizeInfoRow,
  normalizePictureRow,
  normalizePriceRow,
  aggregateStockRows,
  normalizeStockRow,
  applyPrimaryStockAvailabilityEvidence,
  normalizeAttributeRow,
  resolveStockEndpointKey,
  normalizeWarehouseStockSet,
} from "./productSyncRowNormalization.js";


const {
  nowIso,
  normalizeText,
  normalizeId,
  firstFilled,
  toFiniteNumber,
  firstFiniteNumber,
  toInteger,
  normalizeVisibility,
  normalizeVisibilityToken,
  normalizeProductCurrencyCode,
  PRODUCT_STATUS_BY_VISIBILITY,
  STRONG_PRODUCT_VISIBILITIES,
  WEAK_INFERRED_PRODUCT_VISIBILITIES,
  SELLABLE_PRODUCT_VISIBILITIES,
  VISIBILITY_BY_STATUS_LABEL,
  mapStatusLabel,
  isStrongProductVisibility,
  shouldPreserveExistingStatusOnAllSync,
  normalizeStatusLabel,
  visibilityFromStatusLabel,
  booleanFromValue,
  hasObjectArrayItems,
  resolveProductStatusFromEvidence,
  resolvePublicProductStatus,
  normalizeSnapshotVisibilities,
  firstMappedSnapshotVisibility,
  mergeSnapshotVisibilities,
  sanitizeSnapshotVisibilities,
  isExplicitProductVisibilitySync,
  reconcileSnapshotVisibilitiesForCurrentStatus,
  normalizeImageList,
  extractPrimaryImage,
  extractImages,
  collectNestedStockItems,
  hasExplicitEmptyPrimaryStockArray,
  hasExplicitEmptyStockArray,
  hasExplicitStockPresenceEvidence,
  hasExplicitNoStockEvidence,
  getStockItemQuantity,
  getStockItemKey,
  sumStockItems,
  getWarehouseStockTotalFromSource,
  normalizeStockJsonWithComputedPresent,
  getPublicStockValue,
  shouldRepairStoredStockValue,
  repairStoredStockPatch,
  extractStock,
  extractPrice,
  extractCurrency,
  normalizeProductInput,
  createProductRemoteHash,
  createProductKey,
  createProductRowId,
  safeJsonParse,
  compactJson,
  addJsonField,
  addField,
  addNumberField,
  addResolvedStatusFields,
  normalizeWeight,
  normalizeDimension,
  extractDimensions,
  compactAttributes,
  compactPrice,
  compactStock,
  extractCommission,
  toPublicProduct,
  normalizePageSize,
  jsonExtractSql,
  archivedEvidenceSql,
  visibilityEvidenceSql,
  appendVisibilityWhere,
  buildWhere,
  buildCanonicalWhere,
  buildProductCounts,
  normalizeProductSort,
  stockSortValueSql,
  feeSortValueSql,
  profitSortValueSql,
  statusSortValueSql,
  numericOrderBy,
  buildProductOrderBy,
  canonicalIdentityOrder,
  canonicalNumericOrderBy,
  canonicalStatusSortValueSql,
  buildCanonicalProductOrderBy,
  canonicalProductSourceCte,
  splitIds,
  createPatchHash,
  findDeepNumericByKeys,
  firstFiniteFromValues,
  extractAcquiringFee,
  extractAcquiringPercent,
  compactFee,
  PRODUCT_HYDRATION_FACET_COLUMNS,
  PRODUCT_FACET_OBSERVATION_STATUS,
  PRODUCT_FULL_HYDRATION_FACETS,
  PRODUCT_OZON_MATERIAL_SOURCE,
  createProductHydrationCoverage,
  isProductHydrationComplete,
  latestProductHydrationTimestamp,
  chunkProductHydrationValues,
  toPublicProductHydration,
  firstPositiveFiniteNumber,
  isProductFacetSuccessStatus,
  isProductFacetGapStatus,
  normalizePositivePercent,
  extractCommissionObservation,
  extractAcquiringObservation,
  buildCompactFeePayload,
  toPublicProductFeeEvidence,
  canonicalRatePpmToPercent,
  aggregateCanonicalCommissionStatus,
  mergeCanonicalFactReadRow,
} = canonicalDto;

export function createProductSyncStagingRepository(db, {
  canonicalFacts = null,
  refreshProductHydratedAt,
  syncOzonMaterialProjection,
} = {}) {
  if (!db) throw new Error("createProductSyncStagingRepository requires db.");
  if (typeof refreshProductHydratedAt !== "function") {
    throw new Error("createProductSyncStagingRepository requires refreshProductHydratedAt.");
  }
  if (typeof syncOzonMaterialProjection !== "function") {
    throw new Error("createProductSyncStagingRepository requires syncOzonMaterialProjection.");
  }

  const selectExistingByProductId = db.prepare(
    "SELECT * FROM ozon_products WHERE shop_id = ? AND product_id = ? LIMIT 1",
  );
  const selectExistingByOfferIdForResolution = db.prepare(
    "SELECT * FROM ozon_products WHERE shop_id = ? AND offer_id = ? AND product_id IS NOT NULL AND TRIM(product_id) <> '' LIMIT 1",
  );
  const selectExistingBySkuForResolution = db.prepare(
    "SELECT * FROM ozon_products WHERE shop_id = ? AND sku = ? AND product_id IS NOT NULL AND TRIM(product_id) <> '' LIMIT 1",
  );
  const selectExistingById = db.prepare(
    "SELECT * FROM ozon_products WHERE id = ? LIMIT 1",
  );
  const updateFacetObservationsById = db.prepare(`
    UPDATE ozon_products
    SET facet_observations_json = ?, updated_at = ?
    WHERE id = ?
  `);
  const countWarehouseStockFactsByProductId = db.prepare(`
    SELECT COUNT(*) AS count
      FROM product_warehouse_stock_facts
     WHERE product_identity_id = ?
       AND lower(COALESCE(contract_version, '')) LIKE '%stocks-by-warehouse%'
  `);

  function getExisting(shopId, productId) {
    if (!productId) return null;
    return selectExistingByProductId.get(shopId, productId) || null;
  }

  function resolveExistingProductRow(shopId, productId, offerId = "", sku = "") {
    const byProductId = getExisting(shopId, productId);
    if (byProductId) return byProductId;
    // Some secondary Ozon endpoints return only offer_id/SKU. They may locate
    // an already canonical product, but they are never allowed to create or
    // merge a formal product identity without the row's stored product_id.
    if (offerId) {
      const byOffer = selectExistingByOfferIdForResolution.get(shopId, offerId);
      if (byOffer) return byOffer;
    }
    if (sku) return selectExistingBySkuForResolution.get(shopId, sku) || null;
    return null;
  }

  function ensureProductRow({
    shopId,
    productId = "",
    offerId = "",
    sku = "",
    name = "",
    visibility = "ALL",
    timestamp = nowIso(),
  } = {}) {
    if (!productId) return null;
    const existing = getExisting(shopId, productId);
    if (existing) return existing;
    const status = resolveProductStatusFromEvidence(
      { product_id: productId, offer_id: offerId, sku, name, visibility },
      visibility,
    );
    const productKey = createProductKey({
      productId,
      offerId,
      sku,
      raw: { productId, offerId, sku },
    });
    const id = createProductRowId(shopId, productKey);
    db.prepare(
      `
      INSERT OR IGNORE INTO ozon_products (
        id, shop_id, product_key, product_id, offer_id, sku, name,
        visibility, status_label, sort_index, source_endpoint_key, raw_json,
        remote_hash, is_stale, last_seen_at, created_at, updated_at,
        snapshot_visibilities_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'products.hydration', '{}', ?, 0, ?, ?, ?, ?)
    `,
    ).run(
      id,
      shopId,
      productKey,
      productId || null,
      offerId || null,
      sku || null,
      normalizeText(name) || "未返回",
      status.visibility,
      status.statusLabel,
      createStableHash({ productId, offerId, sku, name }, { length: 32 }),
      timestamp,
      timestamp,
      timestamp,
      compactJson(mergeSnapshotVisibilities(visibility, status.visibility)),
    );
    return db.prepare("SELECT * FROM ozon_products WHERE id = ?").get(id);
  }

  function updateProductFields({
    row,
    fields,
    hashColumn,
    hash,
    syncedColumn,
    timestamp,
  }) {
    const entries = Object.entries(fields).filter(
      ([, value]) => value !== undefined,
    );
    if (!entries.length) {
      db.prepare(
        `UPDATE ozon_products
         SET ${hashColumn} = ?, ${syncedColumn} = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(hash, timestamp, timestamp, timestamp, row.id);
      return;
    }
    const setSql = entries.map(([column]) => `${column} = ?`).join(", ");
    db.prepare(
      `
      UPDATE ozon_products SET
        ${setSql},
        ${hashColumn} = ?,
        ${syncedColumn} = ?,
        last_seen_at = ?,
        updated_at = ?,
        is_stale = 0
      WHERE id = ?
    `,
    ).run(
      ...entries.map(([, value]) => value),
      hash,
      timestamp,
      timestamp,
      timestamp,
      row.id,
    );
  }

  function finalizeHydrationRow(rowId, type, timestamp) {
    refreshProductHydratedAt(rowId, timestamp);
    if (type !== "detail" && type !== "attributes") return;
    const current = selectExistingById.get(rowId);
    if (current) syncOzonMaterialProjection(current, timestamp);
  }





  function writeFacetObservationForRow({
    rowId,
    facet,
    status,
    endpointKey,
    sourceReason,
    provenance,
    observedAt = nowIso(),
  } = {}) {
    const normalizedFacet = normalizeHydrationFacet(facet);
    const row = selectExistingById.get(rowId);
    if (!row) return null;
    const observations = safeJsonParse(row.facet_observations_json, {});
    const next =
      observations && typeof observations === "object" && !Array.isArray(observations)
        ? { ...observations }
        : {};
    const observation = createFacetObservation({
      row,
      facet: normalizedFacet,
      status,
      endpointKey,
      sourceReason,
      provenance,
      observedAt,
    });
    next[normalizedFacet] = observation;
    updateFacetObservationsById.run(compactJson(next), observedAt, rowId);
    return observation;
  }

  function writeWarehouseStockObservationForRow({
    rowId,
    status,
    endpointKey = "products.stocksByWarehouseFbs",
    sourceReason,
    provenance = {},
    observedAt = nowIso(),
    warehouseStocks,
  } = {}) {
    const row = selectExistingById.get(rowId);
    if (!row) return null;
    const currentStatus = normalizeFacetObservationStatus(status);
    const observations = safeJsonParse(row.facet_observations_json, {});
    const next =
      observations && typeof observations === "object" && !Array.isArray(observations)
        ? { ...observations }
        : {};
    const previous = next.warehouseStocks;
    const hasPreviousFact =
      isProductFacetSuccessStatus(previous?.status) ||
      Number(countWarehouseStockFactsByProductId.get(rowId)?.count || 0) > 0;
    const shouldRetainPrevious =
      hasPreviousFact && isProductFacetGapStatus(currentStatus);
    const normalizedStocks = Array.isArray(warehouseStocks)
      ? warehouseStocks.map((stock) => ({
          warehouseId: normalizeId(stock.warehouseId ?? stock.warehouse_id) || null,
          warehouseName:
            normalizeText(stock.warehouseName ?? stock.warehouse_name) || null,
          sku: normalizeId(stock.sku) || null,
          fulfillmentType:
            normalizeText(stock.fulfillmentType ?? stock.fulfillment_type)
              .toUpperCase() || "SELLER",
          presentQuantity: toInteger(
            stock.presentQuantity ?? stock.present_quantity ?? stock.present,
          ),
          reservedQuantity: toInteger(
            stock.reservedQuantity ?? stock.reserved_quantity ?? stock.reserved,
          ),
          freeQuantity: toInteger(
            stock.freeQuantity ?? stock.free_quantity ?? stock.free_stock,
          ),
        }))
      : null;
    const sellerStockSubtotal = normalizedStocks
      ? normalizedStocks.reduce(
          (total, stock) => total + Math.max(0, stock.presentQuantity || 0),
          0,
        )
      : previous?.sellerStockSubtotal ?? null;
    const observation = {
      ...(shouldRetainPrevious && previous && typeof previous === "object"
        ? previous
        : {}),
      status: shouldRetainPrevious ? "stale_previous" : currentStatus,
      ...(shouldRetainPrevious ? { currentStatus } : {}),
      endpointKey,
      operationId:
        normalizeText(provenance.operationId ?? provenance.operation_id) || null,
      contractVersion:
        normalizeText(
          provenance.contractVersion ?? provenance.contract_version,
        ) || "ozon-products-stocks-by-warehouse-fbs-v2",
      mapperVersion:
        normalizeText(provenance.mapperVersion ?? provenance.mapper_version) ||
        "product-warehouse-stock-mapper-v1",
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
        productId: normalizeId(row.product_id) || null,
        offerId: normalizeId(row.offer_id) || null,
        productKey: normalizeText(row.product_key) || null,
      },
      ...(normalizedStocks
        ? {
            warehouseCount: normalizedStocks.length,
            sellerStockSubtotal,
            warehouseStocks: normalizedStocks,
          }
        : {}),
      ...(shouldRetainPrevious
        ? {
            retainedPrevious: true,
            previousResponseHash: normalizeText(previous?.responseHash) || null,
            lastSuccessfulAt: normalizeText(previous?.observedAt) || null,
          }
        : {}),
    };
    next.warehouseStocks = observation;
    updateFacetObservationsById.run(compactJson(next), observedAt, rowId);
    return observation;
  }



  function mergeHydrationRowsUncommitted({
    shopId,
    rows = [],
    expectedProductIds = [],
    expectedOfferIds = [],
    provenance = {},
    type,
    endpointKey,
    normalizeRow,
    hashColumn,
    syncedColumn,
  } = {}) {
    const timestamp = nowIso();
    let updated = 0;
    let unchanged = 0;
    let missing = 0;
    const actualProductIds = new Set();
    const actualOfferIds = new Set();
    const observationCounts = {};

    const recordActualObservation = (rowId, patch) => {
      const current = selectExistingById.get(rowId);
      const productId = normalizeId(current?.product_id);
      const offerId = normalizeId(current?.offer_id);
      if (productId) actualProductIds.add(productId);
      if (offerId) actualOfferIds.add(offerId);
      const observation = writeFacetObservationForRow({
        rowId,
        facet: type,
        status: patch.facetStatus || "returned",
        endpointKey,
        sourceReason:
          patch.facetSourceReason || "ozon-entity-row-returned-and-mapped",
        provenance,
        observedAt: timestamp,
      });
      if (observation?.status) {
        observationCounts[observation.status] =
          (observationCounts[observation.status] || 0) + 1;
      }
    };

    for (const source of rows) {
      const patch = normalizeRow(source);
      let productId = normalizeId(patch.productId);
      const offerId = normalizeId(patch.offerId);
      if (!productId) {
        productId = normalizeId(resolveExistingProductRow(shopId, "", offerId, patch.sku)?.product_id);
        if (productId) patch.productId = productId;
      }
      if (!productId) {
        missing += 1;
        continue;
      }
      const row = ensureProductRow({
        shopId,
        productId,
        offerId,
        sku: patch.sku,
        name: patch.name,
        visibility: patch.visibility,
        timestamp,
      });
      if (!row) {
        missing += 1;
        continue;
      }
      if (type === "stocks") {
        applyPrimaryStockAvailabilityEvidence({ patch, row, endpointKey });
      }
      const existingStatus = resolvePublicProductStatus(row);
      if (
        isStrongProductVisibility(existingStatus.visibility) &&
        !isStrongProductVisibility(patch.visibility)
      ) {
        patch.visibility = existingStatus.visibility;
        patch.fields = {
          ...patch.fields,
          visibility: existingStatus.visibility,
          status_label: mapStatusLabel(existingStatus.visibility),
        };
        patch.hashPayload = {
          ...(patch.hashPayload || patch.fields || patch),
          visibility: existingStatus.visibility,
          statusLabel: mapStatusLabel(existingStatus.visibility),
        };
      }
      if (
        type === "pictures" &&
        patch.facetStatus === "returned_empty" &&
        safeJsonParse(row.images_json, []).length > 0
      ) {
        delete patch.fields.images_json;
        patch.facetStatus = "stale_previous";
        patch.facetSourceReason =
          "ozon-empty-pictures-retained-previous-strong-value";
      }
      if (
        type === "attributes" &&
        patch.facetStatus === "returned_empty" &&
        safeJsonParse(row.attributes_json, []).length > 0
      ) {
        delete patch.fields.attributes_json;
        patch.facetStatus = "stale_previous";
        patch.facetSourceReason =
          "ozon-empty-attributes-retained-previous-strong-value";
      }
      if (type === "prices") {
        applyPriceFeeObservations({ patch, row, timestamp, provenance });
      }
      const hash = createPatchHash(patch.hashPayload || patch.fields || patch);
      if (row?.[hashColumn] === hash) {
        const stockRepair =
          type === "stocks"
            ? repairStoredStockPatch({
                stock_value: row.stock_value,
                stock_json: row.stock_json,
              })
            : null;
        if (type === "prices") {
          // Raw price hash can remain unchanged while the current operation,
          // response hash and availability status are new canonical evidence.
          updateProductFields({
            row,
            fields: patch.fields,
            hashColumn,
            hash,
            syncedColumn,
            timestamp,
          });
        } else if (stockRepair) {
          db.prepare(
            `UPDATE ozon_products SET stock_value = ?, stock_json = ?, ${syncedColumn} = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
          ).run(
            stockRepair.stockValue ?? row.stock_value,
            compactJson(stockRepair.stockJson),
            timestamp,
            timestamp,
            timestamp,
            row.id,
          );
        } else {
          db.prepare(
            `UPDATE ozon_products SET ${syncedColumn} = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
          ).run(timestamp, timestamp, timestamp, row.id);
        }
        recordActualObservation(row.id, patch);
        finalizeHydrationRow(row.id, type, timestamp);
        unchanged += 1;
        continue;
      }
      updateProductFields({
        row,
        fields: patch.fields,
        hashColumn,
        hash,
        syncedColumn,
        timestamp,
      });
      recordActualObservation(row.id, patch);
      finalizeHydrationRow(row.id, type, timestamp);
      updated += 1;
    }

    const normalizedExpectedProductIds = [
      ...new Set(expectedProductIds.map(normalizeId).filter(Boolean)),
    ];
    const normalizedExpectedOfferIds = [
      ...new Set(expectedOfferIds.map(normalizeId).filter(Boolean)),
    ];
    const missingProductIds = normalizedExpectedProductIds.filter(
      (productId) => !actualProductIds.has(productId),
    );
    const missingOfferIds = normalizedExpectedOfferIds.filter(
      (offerId) => !actualOfferIds.has(offerId),
    );
    if (missingProductIds.length || missingOfferIds.length) {
      const gapResult = recordProductHydrationFacetObservationsUncommitted({
        shopId,
        productIds: missingProductIds,
        offerIds: missingOfferIds,
        facet: type,
        status: "not_returned",
        endpointKey,
        sourceReason:
          missing > 0
            ? "ozon-response-identity-or-mapper-gap"
            : "ozon-expected-entity-not-returned",
        provenance,
        observedAt: timestamp,
      });
      for (const [status, count] of Object.entries(gapResult.statusCounts || {})) {
        observationCounts[status] = (observationCounts[status] || 0) + count;
      }
    }
    canonicalFacts?.projectRows({
      shopId,
      productIds: [...normalizedExpectedProductIds, ...actualProductIds],
      offerIds: [...normalizedExpectedOfferIds, ...actualOfferIds],
    });
    return {
      type,
      endpointKey,
      rows: rows.length,
      updated,
      unchanged,
      missing,
      actualProductIds: [...actualProductIds],
      actualOfferIds: [...actualOfferIds],
      missingProductIds,
      missingOfferIds,
      observationCounts,
      changed: updated,
      updatedAt: timestamp,
    };
  }

  function runProductHydrationTransaction(work) {
    if (db.isTransaction) return work(); db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function mergeHydrationRows(input = {}) {
    return runProductHydrationTransaction(() =>
      mergeHydrationRowsUncommitted(input),
    );
  }



  function recordProductHydrationFacetObservationsUncommitted({
    shopId,
    productIds = [],
    offerIds = [],
    facet,
    status,
    endpointKey,
    sourceReason,
    provenance = {},
    observedAt = nowIso(),
  } = {}) {
    const normalizedShopId = normalizeId(shopId);
    if (!normalizedShopId) throw new Error("shopId is required.");
    const normalizedFacet = normalizeHydrationFacet(facet);
    const normalizedStatus = normalizeFacetObservationStatus(status);
    const responseHash = normalizeText(
      provenance.responseHash ?? provenance.response_hash,
    );
    if (
      isProductFacetSuccessStatus(normalizedStatus) &&
      !responseHash
    ) {
      throw new Error("PRODUCT_FACET_SUCCESS_PROOF_REQUIRED");
    }
    const syncedColumn = PRODUCT_HYDRATION_FACET_COLUMNS[normalizedFacet];
    const matchedRowIds = new Set();

    const collectChunks = (column, values) => {
      for (const chunk of chunkProductHydrationValues(values)) {
        const placeholders = chunk.map(() => "?").join(", ");
        const matchedRows = db
          .prepare(
            `SELECT id FROM ozon_products
             WHERE shop_id = ? AND ${column} IN (${placeholders})`,
          )
          .all(normalizedShopId, ...chunk);
        for (const row of matchedRows) matchedRowIds.add(row.id);
      }
    };

    collectChunks("product_id", productIds);
    collectChunks("offer_id", offerIds);
    const statusCounts = {};
    for (const rowId of matchedRowIds) {
      if (isProductFacetSuccessStatus(normalizedStatus)) {
        db.prepare(
          `UPDATE ozon_products
           SET ${syncedColumn} = ?, last_seen_at = ?, updated_at = ?, is_stale = 0
           WHERE id = ?`,
        ).run(observedAt, observedAt, observedAt, rowId);
      }
      const observation = writeFacetObservationForRow({
        rowId,
        facet: normalizedFacet,
        status: normalizedStatus,
        endpointKey,
        sourceReason,
        provenance,
        observedAt,
      });
      if (isProductFacetSuccessStatus(normalizedStatus)) {
        finalizeHydrationRow(rowId, normalizedFacet, observedAt);
      } else {
        refreshProductHydratedAt(rowId, observedAt);
      }
      if (observation?.status) {
        statusCounts[observation.status] =
          (statusCounts[observation.status] || 0) + 1;
      }
    }
    return {
      facet: normalizedFacet,
      status: normalizedStatus,
      observed: matchedRowIds.size,
      statusCounts,
      updatedAt: observedAt,
    };
  }

  function recordProductHydrationFacetObservations(input = {}) {
    return runProductHydrationTransaction(() => {
      const result = recordProductHydrationFacetObservationsUncommitted(input);
      canonicalFacts?.projectRows({
        shopId: input.shopId ?? input.shop_id,
        productIds: input.productIds ?? input.product_ids ?? [],
        offerIds: input.offerIds ?? input.offer_ids ?? [],
      });
      return result;
    });
  }

  // Compatibility name retained only to turn old broad "checked" calls into
  // explicit failures. Callers must now supply a status and response proof.
  function markProductHydrationFacetChecked(input = {}) {
    if (!normalizeText(input.status)) {
      throw new Error("PRODUCT_FACET_STATUS_REQUIRED");
    }
    return recordProductHydrationFacetObservations(input);
  }

  function getProductHydrationCoverage({
    shopId,
    productIds = [],
    offerIds = [],
    requiredFacets = PRODUCT_FULL_HYDRATION_FACETS,
  } = {}) {
    const normalizedShopId = normalizeId(shopId);
    if (!normalizedShopId) throw new Error("shopId is required.");
    const facets = [
      ...new Set(requiredFacets.map((facet) => normalizeHydrationFacet(facet))),
    ];
    const rowsById = new Map();
    const foundProductIds = new Set();
    const foundOfferIds = new Set();

    const collectChunks = (column, values, foundValues) => {
      for (const chunk of chunkProductHydrationValues(values)) {
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = db
          .prepare(
            `SELECT * FROM ozon_products
             WHERE shop_id = ? AND ${column} IN (${placeholders})`,
          )
          .all(normalizedShopId, ...chunk);
        for (const row of rows) {
          rowsById.set(row.id, row);
          const matchedValue = normalizeId(row[column]);
          if (matchedValue) foundValues.add(matchedValue);
        }
      }
    };

    const normalizedProductIds = [
      ...new Set(productIds.map(normalizeId).filter(Boolean)),
    ];
    const normalizedOfferIds = [
      ...new Set(offerIds.map(normalizeId).filter(Boolean)),
    ];
    collectChunks("product_id", normalizedProductIds, foundProductIds);
    collectChunks("offer_id", normalizedOfferIds, foundOfferIds);

    const missingProductIds = normalizedProductIds.filter(
      (value) => !foundProductIds.has(value),
    );
    const missingOfferIds = normalizedOfferIds.filter(
      (value) => !foundOfferIds.has(value),
    );
    const missingByFacet = Object.fromEntries(facets.map((facet) => [facet, 0]));
    const incompleteKeys = [];
    let complete = 0;
    let incompleteRows = 0;
    for (const row of rowsById.values()) {
      const rowCoverage = createProductHydrationCoverage(row);
      const missingFacets = facets.filter(
        (facet) => rowCoverage[facet] !== true,
      );
      if (!missingFacets.length) {
        complete += 1;
        continue;
      }
      incompleteRows += 1;
      for (const facet of missingFacets) missingByFacet[facet] += 1;
      if (incompleteKeys.length < 20) {
        incompleteKeys.push({
          productId: normalizeId(row.product_id) || null,
          offerId: normalizeId(row.offer_id) || null,
          missingFacets,
          observations: safeJsonParse(row.facet_observations_json, {}),
        });
      }
    }
    const missingTargets = missingProductIds.length + missingOfferIds.length;
    return {
      requiredFacets: facets,
      total: rowsById.size + missingTargets,
      complete,
      incomplete: incompleteRows + missingTargets,
      missingByFacet,
      missingProductIds: missingProductIds.slice(0, 20),
      missingOfferIds: missingOfferIds.slice(0, 20),
      incompleteKeys,
    };
  }

  function upsertProducts({
    shopId,
    rows = [],
    visibility = "ALL",
    endpointKey = "products.list",
    sortOffset = 0,
  } = {}) {
    const timestamp = nowIso();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const productKeys = [];
    const allNormalizedRows = rows.map((row, index) =>
      normalizeProductInput(row, {
        shopId,
        visibility,
        endpointKey,
        sortIndex: sortOffset + index,
      }),
    );
    const normalizedRows = allNormalizedRows.filter((row) => row.productId);
    const missingProductId = allNormalizedRows.length - normalizedRows.length;
    const shouldPreserveExistingStrongStatus = endpointKey === "products.list";

    const selectExisting = db.prepare(
      "SELECT * FROM ozon_products WHERE shop_id = ? AND product_key = ?",
    );
    const insertOrReplace = db.prepare(`
      INSERT INTO ozon_products (
        id, shop_id, product_key, product_id, offer_id, sku, name,
        visibility, status_label, category_id, category_name, type_id, primary_image_url,
        price_value, currency_code, stock_value, commission_percent,
        weight_kg, width_cm, height_cm, depth_cm, sort_index,
        source_endpoint_key, raw_json, remote_hash, is_stale,
        last_seen_at, created_at, updated_at, images_json,
        snapshot_visibilities_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, product_key) DO UPDATE SET
        product_id = COALESCE(excluded.product_id, ozon_products.product_id),
        offer_id = COALESCE(excluded.offer_id, ozon_products.offer_id),
        sku = COALESCE(excluded.sku, ozon_products.sku),
        name = CASE WHEN excluded.name IS NOT NULL AND excluded.name <> '' AND excluded.name <> '未返回' THEN excluded.name ELSE ozon_products.name END,
        visibility = excluded.visibility,
        status_label = CASE WHEN excluded.status_label IS NOT NULL AND excluded.status_label <> '' AND excluded.status_label <> '未知状态' THEN excluded.status_label ELSE ozon_products.status_label END,
        category_id = COALESCE(excluded.category_id, ozon_products.category_id),
        category_name = COALESCE(excluded.category_name, ozon_products.category_name),
        type_id = COALESCE(excluded.type_id, ozon_products.type_id),
        primary_image_url = COALESCE(excluded.primary_image_url, ozon_products.primary_image_url),
        images_json = COALESCE(excluded.images_json, ozon_products.images_json),
        snapshot_visibilities_json = excluded.snapshot_visibilities_json,
        price_value = COALESCE(excluded.price_value, ozon_products.price_value),
        currency_code = COALESCE(excluded.currency_code, ozon_products.currency_code),
        stock_value = COALESCE(excluded.stock_value, ozon_products.stock_value),
        commission_percent = COALESCE(excluded.commission_percent, ozon_products.commission_percent),
        weight_kg = COALESCE(excluded.weight_kg, ozon_products.weight_kg),
        width_cm = COALESCE(excluded.width_cm, ozon_products.width_cm),
        height_cm = COALESCE(excluded.height_cm, ozon_products.height_cm),
        depth_cm = COALESCE(excluded.depth_cm, ozon_products.depth_cm),
        sort_index = excluded.sort_index,
        source_endpoint_key = excluded.source_endpoint_key,
        raw_json = excluded.raw_json,
        remote_hash = excluded.remote_hash,
        is_stale = 0,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);
    const touchUnchanged = db.prepare(`
      UPDATE ozon_products SET last_seen_at = ?, is_stale = 0, sort_index = ?, updated_at = ?, snapshot_visibilities_json = ?
      WHERE shop_id = ? AND product_key = ?
    `);

    for (const row of normalizedRows) {
      const existingByProductId = selectExistingByProductId.get(shopId, row.productId);
      const existing = existingByProductId || selectExisting.get(shopId, row.productKey);
      const writeRow = { ...row };
      if (existingByProductId) {
        writeRow.id = existingByProductId.id;
        writeRow.productKey = existingByProductId.product_key;
      }
      if (writeRow.productKey) productKeys.push(writeRow.productKey);
      const existingStatus = existing
        ? resolvePublicProductStatus(existing)
        : null;
      if (
        shouldPreserveExistingStrongStatus &&
        shouldPreserveExistingStatusOnAllSync(
          existingStatus?.visibility,
          writeRow.visibility,
          visibility,
        )
      ) {
        writeRow.visibility = existingStatus.visibility;
        writeRow.statusLabel = existingStatus.statusLabel;
        writeRow.remoteHash = createProductRemoteHash(writeRow);
      }
      const snapshotVisibilities = mergeSnapshotVisibilities(
        normalizeSnapshotVisibilities(existing?.snapshot_visibilities_json),
        writeRow.snapshotVisibilities,
      );
      const cleanSnapshotVisibilities =
        reconcileSnapshotVisibilitiesForCurrentStatus(
          snapshotVisibilities,
          writeRow.visibility,
          visibility,
        );
      if (existing?.remote_hash === writeRow.remoteHash) {
        touchUnchanged.run(
          timestamp,
          writeRow.sortIndex,
          timestamp,
          compactJson(cleanSnapshotVisibilities),
          shopId,
          writeRow.productKey,
        );
        unchanged += 1;
        continue;
      }
      insertOrReplace.run(
        writeRow.id,
        writeRow.shopId,
        writeRow.productKey,
        writeRow.productId || null,
        writeRow.offerId || null,
        writeRow.sku || null,
        writeRow.name,
        writeRow.visibility,
        writeRow.statusLabel,
        writeRow.categoryId || null,
        writeRow.categoryName || null,
        writeRow.typeId || null,
        writeRow.primaryImageUrl || null,
        writeRow.priceValue,
        writeRow.currencyCode,
        writeRow.stockValue,
        writeRow.commissionPercent,
        writeRow.weightKg,
        writeRow.widthCm,
        writeRow.heightCm,
        writeRow.depthCm,
        writeRow.sortIndex,
        writeRow.sourceEndpointKey,
        JSON.stringify(writeRow.raw ?? {}),
        writeRow.remoteHash,
        timestamp,
        timestamp,
        timestamp,
        writeRow.images.length ? compactJson(writeRow.images) : null,
        compactJson(cleanSnapshotVisibilities),
      );
      if (existing) updated += 1;
      else inserted += 1;
    }

    canonicalFacts?.projectRows({ shopId, productKeys });

    return {
      inserted,
      updated,
      unchanged,
      changed: inserted + updated,
      rows: normalizedRows.length,
      missingProductId,
      productKeys,
      updatedAt: timestamp,
    };
  }

  function reconcileVisibilitySnapshot({
    shopId,
    visibility,
    seenProductKeys = [],
  } = {}) {
    const normalizedShopId = normalizeText(shopId);
    const normalizedVisibility = normalizeVisibility(visibility, "");
    if (
      !normalizedShopId ||
      !normalizedVisibility ||
      normalizedVisibility === "ALL" ||
      !mapStatusLabel(normalizedVisibility)
    ) {
      return { updated: 0, stale: 0, skipped: true };
    }

    const timestamp = nowIso();
    const seen = new Set(
      (Array.isArray(seenProductKeys) ? seenProductKeys : [])
        .map(normalizeId)
        .filter(Boolean),
    );
    const candidates = db
      .prepare(
        `
      SELECT id, product_key, visibility, status_label, snapshot_visibilities_json
      FROM ozon_products
      WHERE shop_id = ?
        AND is_stale = 0
        AND (visibility = ? OR snapshot_visibilities_json LIKE ? OR status_label = ?)
    `,
      )
      .all(
        normalizedShopId,
        normalizedVisibility,
        `%"${normalizedVisibility}"%`,
        mapStatusLabel(normalizedVisibility),
      );

    const updateActive = db.prepare(`
      UPDATE ozon_products
      SET visibility = ?, status_label = ?, snapshot_visibilities_json = ?, updated_at = ?
      WHERE id = ?
    `);
    const markStale = db.prepare(`
      UPDATE ozon_products
      SET is_stale = 1, snapshot_visibilities_json = ?, updated_at = ?
      WHERE id = ?
    `);

    let updated = 0;
    let stale = 0;
    const changedProductKeys = [];

    for (const row of candidates) {
      if (seen.has(normalizeId(row.product_key))) continue;
      const nextSnapshots = sanitizeSnapshotVisibilities(
        normalizeSnapshotVisibilities(row.snapshot_visibilities_json).filter(
          (item) => item !== normalizedVisibility,
        ),
      );
      const nextVisibility =
        nextSnapshots.find((item) => item !== "ALL" && mapStatusLabel(item)) ||
        (nextSnapshots.includes("ALL") ? "ALL" : "");
      if (!nextVisibility) {
        markStale.run(compactJson(nextSnapshots), timestamp, row.id);
        changedProductKeys.push(row.product_key);
        stale += 1;
        continue;
      }
      updateActive.run(
        nextVisibility,
        mapStatusLabel(nextVisibility) || null,
        compactJson(nextSnapshots),
        timestamp,
        row.id,
      );
      changedProductKeys.push(row.product_key);
      updated += 1;
    }

    canonicalFacts?.projectRows({ shopId: normalizedShopId, productKeys: changedProductKeys });

    return {
      updated,
      stale,
      visibility: normalizedVisibility,
      seen: seen.size,
      updatedAt: timestamp,
    };
  }
















  function mergeProductInfoRows(input = {}) {
    return mergeHydrationRows({
      ...input,
      type: "detail",
      endpointKey: "products.infoList",
      normalizeRow: normalizeInfoRow,
      hashColumn: "detail_hash",
      syncedColumn: "detail_synced_at",
    });
  }

  function mergeProductPictureRows(input = {}) {
    return mergeHydrationRows({
      ...input,
      type: "pictures",
      endpointKey: "products.pictures",
      normalizeRow: normalizePictureRow,
      hashColumn: "pictures_hash",
      syncedColumn: "pictures_synced_at",
    });
  }

  function mergeProductPriceRows(input = {}) {
    return mergeHydrationRows({
      ...input,
      type: "prices",
      endpointKey: "products.prices",
      normalizeRow: normalizePriceRow,
      hashColumn: "prices_hash",
      syncedColumn: "prices_synced_at",
    });
  }

  function recordProductWarehouseStockObservations({
    shopId,
    productIds = [],
    offerIds = [],
    status = "failed",
    provenance = {},
    sourceReason,
  } = {}) {
    return runProductHydrationTransaction(() => {
      const targets = [
        ...productIds.map((productId) => ({ productId: normalizeId(productId) })),
        ...offerIds.map((offerId) => ({ offerId: normalizeId(offerId) })),
      ].filter((target) => target.productId || target.offerId);
      const canonicalResult =
        canonicalFacts?.recordWarehouseStockObservations?.({
          shopId,
          targets,
          status,
          provenance,
          sourceReason,
        }) || { recorded: 0, missing: targets.length, retainedPrevious: 0 };
      const seen = new Set();
      const statusCounts = {};
      for (const target of targets) {
        const row = resolveExistingProductRow(
          shopId,
          target.productId || "",
          target.offerId || "",
        );
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        const observation = writeWarehouseStockObservationForRow({
          rowId: row.id,
          status,
          provenance,
          sourceReason,
        });
        if (observation?.status) {
          statusCounts[observation.status] =
            (statusCounts[observation.status] || 0) + 1;
        }
      }
      return { ...canonicalResult, statusCounts };
    });
  }

  function mergeProductWarehouseStockRows(input = {}) {
    const sourceRows = Array.isArray(input.rows) ? input.rows : [];
    const responseLimit = toInteger(
      input.responseLimit ?? input.requestLimit ?? input.limit,
    );
    if (responseLimit && sourceRows.length >= responseLimit) {
      recordProductWarehouseStockObservations({
        shopId: input.shopId,
        productIds: input.expectedProductIds || [],
        offerIds: input.expectedOfferIds || [],
        status: "contract_invalid",
        provenance: input.provenance || {},
        sourceReason: "PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE",
      });
      const error = new Error("PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE");
      error.code = "PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE";
      throw error;
    }
    return runProductHydrationTransaction(() => {
      if (!canonicalFacts?.replaceWarehouseStockSets) {
        throw new Error("PRODUCT_WAREHOUSE_STOCK_FACTS_UNAVAILABLE");
      }
      const normalizedSets = aggregateStockRows(sourceRows)
        .map(normalizeWarehouseStockSet)
        .map((set) => {
          if (set.productId) return set;
          const existing = resolveExistingProductRow(
            input.shopId,
            "",
            set.offerId,
            set.sku,
          );
          return existing?.product_id
            ? { ...set, productId: normalizeId(existing.product_id) }
            : set;
        });
      const invalidSets = normalizedSets.filter((set) => set.invalid);
      if (invalidSets.length > 0) {
        const error = new Error(
          `PRODUCT_WAREHOUSE_STOCK_CONTRACT_INVALID:${invalidSets.length}`,
        );
        error.code = "PRODUCT_WAREHOUSE_STOCK_CONTRACT_INVALID";
        error.contractInvalid = invalidSets.length;
        error.reasons = [...new Set(invalidSets.map((set) => set.reason))];
        throw error;
      }

      const timestamp = nowIso();
      const actualProductIds = new Set();
      const actualOfferIds = new Set();
      const actualRowIds = new Set();
      for (const set of normalizedSets) {
        if (!set.productId) continue;
        if (!getExisting(input.shopId, set.productId)) {
          ensureProductRow({
            shopId: input.shopId,
            productId: set.productId,
            offerId: set.offerId,
            sku: set.sku,
            timestamp,
          });
        }
      }
      const projectedRows = normalizedSets
        .filter((set) => set.productId)
        .map((set) =>
          getExisting(input.shopId, set.productId),
        )
        .filter(Boolean);
      canonicalFacts.projectRows({
        shopId: input.shopId,
        productKeys: projectedRows.map((row) => row.product_key),
        productIds: normalizedSets.map((set) => set.productId).filter(Boolean),
        offerIds: normalizedSets.map((set) => set.offerId).filter(Boolean),
      });

      const availableSets = normalizedSets.filter((set) => !set.unavailable);
      const replacement = canonicalFacts.replaceWarehouseStockSets({
        shopId: input.shopId,
        sets: availableSets,
        provenance: input.provenance || {},
      });
      const observationCounts = {};
      const addObservationCount = (status) => {
        observationCounts[status] = (observationCounts[status] || 0) + 1;
      };
      for (const set of normalizedSets) {
        const row = getExisting(input.shopId, set.productId);
        if (!row || actualRowIds.has(row.id)) continue;
        actualRowIds.add(row.id);
        if (row.product_id) actualProductIds.add(normalizeId(row.product_id));
        if (row.offer_id) actualOfferIds.add(normalizeId(row.offer_id));
        const status = set.unavailable
          ? "unavailable"
          : set.stocks.length
            ? "returned"
            : "returned_empty";
        if (set.unavailable) {
          canonicalFacts.recordWarehouseStockObservations?.({
            shopId: input.shopId,
            targets: [set],
            status,
            provenance: input.provenance || {},
            sourceReason: "ozon-warehouse-stock-fields-unavailable",
          });
        }
        const observation = writeWarehouseStockObservationForRow({
          rowId: row.id,
          status,
          provenance: input.provenance || {},
          observedAt: timestamp,
          sourceReason: set.unavailable
            ? "ozon-warehouse-stock-fields-unavailable"
            : set.stocks.length
              ? "ozon-warehouse-stock-complete-set-returned"
              : "ozon-warehouse-stock-explicit-empty-set",
          warehouseStocks: set.unavailable ? undefined : set.stocks,
        });
        addObservationCount(observation?.status || status);
      }

      const expectedProductIds = [
        ...new Set(
          (input.expectedProductIds || []).map(normalizeId).filter(Boolean),
        ),
      ];
      const expectedOfferIds = [
        ...new Set(
          (input.expectedOfferIds || []).map(normalizeId).filter(Boolean),
        ),
      ];
      const missingProductIds = expectedProductIds.filter(
        (id) => !actualProductIds.has(id),
      );
      const missingOfferIds = expectedOfferIds.filter(
        (id) => !actualOfferIds.has(id),
      );
      const missingTargets = [
        ...missingProductIds.map((productId) => ({ productId })),
        ...missingOfferIds.map((offerId) => ({ offerId })),
      ];
      canonicalFacts.recordWarehouseStockObservations?.({
        shopId: input.shopId,
        targets: missingTargets,
        status: "not_returned",
        provenance: input.provenance || {},
        sourceReason: "ozon-expected-warehouse-stock-entity-not-returned",
      });
      const missingRowIds = new Set();
      for (const target of missingTargets) {
        const row = resolveExistingProductRow(
          input.shopId,
          target.productId || "",
          target.offerId || "",
        );
        if (!row || missingRowIds.has(row.id)) continue;
        missingRowIds.add(row.id);
        const observation = writeWarehouseStockObservationForRow({
          rowId: row.id,
          status: "not_returned",
          provenance: input.provenance || {},
          observedAt: timestamp,
          sourceReason: "ozon-expected-warehouse-stock-entity-not-returned",
        });
        addObservationCount(observation?.status || "not_returned");
      }

      return {
        type: "warehouse_stocks",
        endpointKey: "products.stocksByWarehouseFbs",
        rows: sourceRows.length,
        updated: replacement.changed,
        changed: replacement.changed,
        unchanged:
          replacement.unchanged + normalizedSets.filter((set) => set.unavailable).length,
        missing: replacement.missing,
        actualProductIds: [...actualProductIds],
        actualOfferIds: [...actualOfferIds],
        missingProductIds,
        missingOfferIds,
        observationCounts,
        updatedAt: timestamp,
      };
    });
  }

  function mergeProductStockRows(input = {}) {
    const endpointKey = resolveStockEndpointKey(input);
    if (endpointKey === "products.stocksByWarehouseFbs") {
      return mergeProductWarehouseStockRows(input);
    }
    return mergeHydrationRows({
      ...input,
      rows: aggregateStockRows(Array.isArray(input.rows) ? input.rows : []),
      type: "stocks",
      endpointKey,
      normalizeRow: normalizeStockRow,
      hashColumn: "stocks_hash",
      syncedColumn: "stocks_synced_at",
    });
  }

  function mergeProductAttributeRows(input = {}) {
    return mergeHydrationRows({
      ...input,
      type: "attributes",
      endpointKey: "products.attributes",
      normalizeRow: normalizeAttributeRow,
      hashColumn: "attributes_hash",
      syncedColumn: "attributes_synced_at",
    });
  }


  return {
    upsertProducts,
    mergeProductInfoRows,
    mergeProductPictureRows,
    mergeProductPriceRows,
    mergeProductStockRows,
    mergeProductWarehouseStockRows,
    recordProductWarehouseStockObservations,
    mergeProductAttributeRows,
    recordProductHydrationFacetObservations,
    markProductHydrationFacetChecked,
    getProductHydrationCoverage,
    reconcileVisibilitySnapshot,
  };
}
