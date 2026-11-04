import { createStableHash } from "../../utils/stableHash.js";
import * as canonicalDto from "./productCanonicalDto.js";
import * as supportModel from "./productSupportModel.js";
import {
  createOzonMaterialCandidate,
  dedupeMaterialCandidates,
  toPublicManualCostProfile,
  firstExplicitCost,
  mergeManualCostProfiles,
  prepareLegacyProductSourceLinkGroup,
} from "./productSupportRowMerge.js";

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
  hasExplicitEmptyStockArray,
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

const {
  PRODUCT_MATERIAL_SOURCE_RANK,
  normalizeMaterialSource,
  getMaterialSourceRank,
  toSqlBool,
  createSupportProductKey,
  createSupportRowId,
  normalizeSupportIdentity,
  repairLegacyScopedProductSourceLinkKeys,
  getSourceLinkMedia,
  repairProductSourceLinkMedia,
  normalizeMaterialProfileInput,
  LEGACY_PRODUCT_MATERIAL_FIELDS,
  prepareLegacyMaterialProfile,
  encodeProductMaterialCursor,
  decodeProductMaterialCursor,
  toPublicMaterialProfile,
  normalizeSourceEntry,
  toPublicSourceLink,
  normalizeLegacyCursorText,
  encodeProductSourceLinkCursor,
  decodeProductSourceLinkCursor,
  normalizeLegacySourceSlot,
  toPublicImageHealth,
  repairProductStockValuesFromStockJson,
} = supportModel;

export function createProductSupportRepository(db, { refreshProductHydratedAt, readOnly = false } = {}) {
  if (!db) throw new Error("createProductSupportRepository requires db.");
  if (typeof refreshProductHydratedAt !== "function") {
    throw new Error("createProductSupportRepository requires refreshProductHydratedAt.");
  }

  const selectMaterialByProductKey = db.prepare(
    "SELECT * FROM product_material_profiles WHERE shop_id = ? AND product_key = ? ORDER BY source_rank DESC, updated_at DESC LIMIT 1",
  );
  const selectMaterialByProductKeyAndSource = db.prepare(
    "SELECT * FROM product_material_profiles WHERE shop_id = ? AND product_key = ? AND source = ? LIMIT 1",
  );
  const selectMaterialsByProductKey = db.prepare(
    "SELECT * FROM product_material_profiles WHERE shop_id = ? AND product_key = ? ORDER BY source_rank DESC, updated_at DESC LIMIT 20",
  );
  const selectMaterialByProductId = db.prepare(
    "SELECT * FROM product_material_profiles WHERE shop_id = ? AND product_id = ? ORDER BY source_rank DESC, updated_at DESC LIMIT 1",
  );
  const selectMaterialByOfferId = db.prepare(
    "SELECT * FROM product_material_profiles WHERE shop_id = ? AND offer_id = ? ORDER BY source_rank DESC, updated_at DESC LIMIT 1",
  );
  const selectSourceLinksByProductKey = db.prepare(
    "SELECT * FROM product_source_links WHERE shop_id = ? AND product_key = ? ORDER BY slot_index ASC",
  );
  const selectImageHealthByProductKey = db.prepare(
    "SELECT * FROM product_image_health WHERE shop_id = ? AND product_key = ? ORDER BY updated_at DESC LIMIT 100",
  );
  const selectManualCostProfilesByProductKey = db.prepare(`
    SELECT *
    FROM product_manual_cost_profiles
    WHERE shop_id = ? AND product_key = ?
    ORDER BY CASE source_type WHEN 'manual' THEN 0 ELSE 1 END, updated_at DESC
  `);
  const deleteOzonMaterialProjection = readOnly ? null : db.prepare(
    "DELETE FROM product_material_profiles WHERE shop_id = ? AND product_key = ? AND source = ?",
  );
  const upsertOzonMaterialProjection = readOnly ? null : db.prepare(`
    INSERT INTO product_material_profiles (
      id, shop_id, product_key, product_id, offer_id, sku, source, source_rank,
      weight_kg, width_cm, height_cm, depth_cm, apply_to_product, is_confirmed,
      ozon_synced_at, ozon_sync_status, source_order_id, source_order_number,
      source_purchase_order_number, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL, NULL, NULL, ?, ?, ?)
    ON CONFLICT(shop_id, product_key, source) DO UPDATE SET
      product_id = excluded.product_id,
      offer_id = excluded.offer_id,
      sku = excluded.sku,
      source_rank = excluded.source_rank,
      weight_kg = excluded.weight_kg,
      width_cm = excluded.width_cm,
      height_cm = excluded.height_cm,
      depth_cm = excluded.depth_cm,
      apply_to_product = 1,
      is_confirmed = 0,
      ozon_synced_at = excluded.ozon_synced_at,
      ozon_sync_status = excluded.ozon_sync_status,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);

  function syncOzonMaterialProjection(row = {}, timestamp = nowIso()) {
    const shopId = normalizeText(row.shop_id);
    const productKey = normalizeText(row.product_key);
    if (!shopId || !productKey) return { changed: 0, removed: 0 };
    const dimensions = [row.weight_kg, row.width_cm, row.height_cm, row.depth_cm];
    if (dimensions.every((value) => value === null || value === undefined || value === "")) {
      const removed = deleteOzonMaterialProjection.run(
        shopId,
        productKey,
        PRODUCT_OZON_MATERIAL_SOURCE,
      );
      return { changed: 0, removed: Number(removed.changes || 0) };
    }
    const id = createSupportRowId(
      "material",
      shopId,
      productKey,
      PRODUCT_OZON_MATERIAL_SOURCE,
    );
    const result = upsertOzonMaterialProjection.run(
      id,
      shopId,
      productKey,
      normalizeId(row.product_id) || null,
      normalizeId(row.offer_id) || null,
      normalizeId(row.sku) || null,
      PRODUCT_OZON_MATERIAL_SOURCE,
      getMaterialSourceRank(PRODUCT_OZON_MATERIAL_SOURCE),
      row.weight_kg ?? null,
      row.width_cm ?? null,
      row.height_cm ?? null,
      row.depth_cm ?? null,
      timestamp,
      "synced",
      compactJson({
        source: "products.hydration",
        detailSyncedAt: row.detail_synced_at || null,
        attributesSyncedAt: row.attributes_synced_at || null,
      }),
      timestamp,
      timestamp,
    );
    return { changed: Number(result.changes || 0), removed: 0 };
  }

  function getMaterialProfileForPublicRow(row = {}) {
    if (!row?.shopId && !row?.shop_id) return null;
    const shopId = row.shopId || row.shop_id;
    const productKey =
      row.productKey || row.product_key || createSupportProductKey(row);
    if (productKey) {
      const byKey = selectMaterialByProductKey.get(shopId, productKey);
      if (byKey) return toPublicMaterialProfile(byKey);
    }
    const productId = normalizeId(row.productId ?? row.product_id);
    if (productId) {
      const byProduct = selectMaterialByProductId.get(shopId, productId);
      if (byProduct) return toPublicMaterialProfile(byProduct);
    }
    const offerId = normalizeId(row.offerId ?? row.offer_id);
    if (offerId) {
      const byOffer = selectMaterialByOfferId.get(shopId, offerId);
      if (byOffer) return toPublicMaterialProfile(byOffer);
    }
    return null;
  }

  function getMaterialProfilesForPublicRow(row = {}) {
    const shopId = row.shopId || row.shop_id;
    const productKey =
      row.productKey || row.product_key || createSupportProductKey(row);
    if (!shopId || !productKey) return [];
    return selectMaterialsByProductKey
      .all(shopId, productKey)
      .map(toPublicMaterialProfile);
  }

  function getSourceLinksForPublicRow(row = {}) {
    const shopId = row.shopId || row.shop_id;
    const productKey =
      row.productKey || row.product_key || createSupportProductKey(row);
    if (!shopId || !productKey) return [];
    return selectSourceLinksByProductKey
      .all(shopId, productKey)
      .map(toPublicSourceLink);
  }

  function getImageHealthForPublicRow(row = {}) {
    const shopId = row.shopId || row.shop_id;
    const productKey =
      row.productKey || row.product_key || createSupportProductKey(row);
    if (!shopId || !productKey) return [];
    return selectImageHealthByProductKey
      .all(shopId, productKey)
      .map(toPublicImageHealth);
  }











  function getManualCostProfilesForPublicRow(row = {}) {
    const shopId = row.shopId || row.shop_id;
    const productKey =
      row.productKey || row.product_key || createSupportProductKey(row);
    if (!shopId || !productKey) return [];
    return selectManualCostProfilesByProductKey
      .all(shopId, productKey)
      .map(toPublicManualCostProfile);
  }



  function attachProductSupport(rows = []) {
    return rows.map((row) => {
      const materialProfile = getMaterialProfileForPublicRow(row);
      const savedMaterialProfiles = getMaterialProfilesForPublicRow(row);
      const materialCandidates = dedupeMaterialCandidates([
        ...savedMaterialProfiles,
        createOzonMaterialCandidate(row),
      ]);
      const sourceLinks = getSourceLinksForPublicRow(row);
      const imageHealth = getImageHealthForPublicRow(row);
      const manualCostProfiles = getManualCostProfilesForPublicRow(row);
      const manualCostProfile = mergeManualCostProfiles(manualCostProfiles);
      const primarySourceLink =
        sourceLinks.find((item) => item.isPrimary) || sourceLinks[0] || null;
      // Existing explicit product/order projections and the selected source
      // link remain higher-priority. Historical import is a fallback only and
      // never mutates Ozon priceValue/currencyCode/stock/fee fields.
      const explicitPurchaseCost = firstExplicitCost(
        row.sourcePurchaseCostCny,
        row.purchasePriceValue,
        row.purchaseCostCny,
        row.manualPurchasePriceValue,
        row.manualPurchasePrice,
        primarySourceLink?.priceValue,
      );
      const fallbackPurchaseCost = firstExplicitCost(
        explicitPurchaseCost,
        manualCostProfile?.purchaseCostCny,
      );
      return {
        ...row,
        materialProfile,
        materialProfiles: savedMaterialProfiles,
        materialCandidates,
        materialSource: materialProfile?.source || row.materialSource || "",
        sourceLinks,
        sourceRecord: sourceLinks.length
          ? {
              links: sourceLinks,
              primaryIndex: Math.max(
                0,
                sourceLinks.findIndex((item) => item.isPrimary),
              ),
            }
          : null,
        imageHealth,
        manualCostProfile,
        manualCostProfiles,
        sourcePurchaseCostCny: fallbackPurchaseCost,
        purchasePriceValue: firstExplicitCost(
          row.purchasePriceValue,
          explicitPurchaseCost,
          manualCostProfile?.purchaseCostCny,
        ),
        purchaseCostCny: firstExplicitCost(
          row.purchaseCostCny,
          explicitPurchaseCost,
          manualCostProfile?.purchaseCostCny,
        ),
        crossBorderCostCny: firstExplicitCost(
          row.crossBorderCostCny,
          manualCostProfile?.crossBorderCostCny,
        ),
        domesticFreightCny: firstExplicitCost(
          row.domesticFreightCny,
          manualCostProfile?.domesticFreightCny,
        ),
        packagingCostCny: firstExplicitCost(
          row.packagingCostCny,
          manualCostProfile?.packagingCostCny,
        ),
        otherCostCny: firstExplicitCost(
          row.otherCostCny,
          manualCostProfile?.otherCostCny,
        ),
        costCurrencyCode: manualCostProfile?.currencyCode || "",
        costSourcePlatform: manualCostProfile?.sourcePlatform || "",
        costSourceUrl: manualCostProfile?.sourceUrl || "",
        costPurchaseOrderNumber: manualCostProfile?.purchaseOrderNumber || "",
        costTrackingNumber: manualCostProfile?.trackingNumber || "",
        costNote: manualCostProfile?.note || "",
      };
    });
  }

  function upsertProductMaterialProfile(input = {}) {
    const normalized = normalizeMaterialProfileInput(input);
    if (!normalized.shopId)
      throw new Error("PRODUCT_MATERIAL_SHOP_ID_REQUIRED");
    if (!normalized.productKey)
      throw new Error("PRODUCT_MATERIAL_PRODUCT_KEY_REQUIRED");
    const activeBefore = selectMaterialByProductKey.get(
      normalized.shopId,
      normalized.productKey,
    );
    const existing = selectMaterialByProductKeyAndSource.get(
      normalized.shopId,
      normalized.productKey,
      normalized.source,
    );
    const timestamp = nowIso();
    const id =
      existing?.id ||
      createSupportRowId(
        "material",
        normalized.shopId,
        normalized.productKey,
        normalized.source,
      );
    db.prepare(
      `
      INSERT INTO product_material_profiles (
        id, shop_id, product_key, product_id, offer_id, sku, source, source_rank,
        weight_kg, width_cm, height_cm, depth_cm, apply_to_product, is_confirmed,
        ozon_synced_at, ozon_sync_status, source_order_id, source_order_number,
        source_purchase_order_number, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, product_key, source) DO UPDATE SET
        product_id = COALESCE(excluded.product_id, product_material_profiles.product_id),
        offer_id = COALESCE(excluded.offer_id, product_material_profiles.offer_id),
        sku = COALESCE(excluded.sku, product_material_profiles.sku),
        source_rank = excluded.source_rank,
        weight_kg = COALESCE(excluded.weight_kg, product_material_profiles.weight_kg),
        width_cm = COALESCE(excluded.width_cm, product_material_profiles.width_cm),
        height_cm = COALESCE(excluded.height_cm, product_material_profiles.height_cm),
        depth_cm = COALESCE(excluded.depth_cm, product_material_profiles.depth_cm),
        apply_to_product = excluded.apply_to_product,
        is_confirmed = excluded.is_confirmed,
        ozon_synced_at = COALESCE(NULLIF(excluded.ozon_synced_at, ''), product_material_profiles.ozon_synced_at),
        ozon_sync_status = COALESCE(NULLIF(excluded.ozon_sync_status, ''), product_material_profiles.ozon_sync_status),
        source_order_id = COALESCE(NULLIF(excluded.source_order_id, ''), product_material_profiles.source_order_id),
        source_order_number = COALESCE(NULLIF(excluded.source_order_number, ''), product_material_profiles.source_order_number),
        source_purchase_order_number = COALESCE(NULLIF(excluded.source_purchase_order_number, ''), product_material_profiles.source_purchase_order_number),
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `,
    ).run(
      id,
      normalized.shopId,
      normalized.productKey,
      normalized.productId || null,
      normalized.offerId || null,
      normalized.sku || null,
      normalized.source,
      normalized.sourceRank,
      normalized.weightKg,
      normalized.widthCm,
      normalized.heightCm,
      normalized.depthCm,
      normalized.applyToProduct,
      normalized.isConfirmed,
      normalized.ozonSyncedAt || null,
      normalized.ozonSyncStatus || null,
      normalized.sourceOrderId || null,
      normalized.sourceOrderNumber || null,
      normalized.sourcePurchaseOrderNumber || null,
      compactJson(normalized.raw || {}),
      existing?.created_at || timestamp,
      timestamp,
    );
    const saved = selectMaterialByProductKeyAndSource.get(
      normalized.shopId,
      normalized.productKey,
      normalized.source,
    );
    const activeAfter = selectMaterialByProductKey.get(
      normalized.shopId,
      normalized.productKey,
    );
    const activeProfile = toPublicMaterialProfile(activeAfter);
    const savedProfile = toPublicMaterialProfile(saved);
    return {
      ok: true,
      changed: true,
      preserved: Boolean(
        activeBefore &&
        activeAfter &&
        activeBefore.source === activeAfter.source &&
        saved?.source !== activeAfter.source,
      ),
      profile: activeProfile,
      activeProfile,
      savedProfile,
    };
  }

  /**
   * Typed browser/file retirement import. Every profile is normalized and
   * identity-checked before BEGIN IMMEDIATE, then all rows share one commit
   * timestamp. It never reaches the Ozon scheduler.
   */
  function importLegacyProductMaterialProfiles(inputs = []) {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new Error("PRODUCT_MATERIAL_LEGACY_IMPORT_REQUIRED");
    }
    const identities = new Set();
    const hasLocalOwner = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'shop_database_metadata'").get();
    const selectShopForLegacyMaterialImport = db.prepare(hasLocalOwner
      ? 'SELECT shop_id AS id FROM shop_database_metadata WHERE shop_id = ? LIMIT 1'
      : 'SELECT id FROM shops WHERE id = ? LIMIT 1');
    const prepared = inputs.map((input) => {
      const normalized = prepareLegacyMaterialProfile(input);
      if (!selectShopForLegacyMaterialImport.get(normalized.shopId)) {
        throw new Error("PRODUCT_MATERIAL_LEGACY_SHOP_SCOPE_INVALID");
      }
      const identity = `${normalized.shopId}\u001f${normalized.productKey}\u001f${normalized.source}`;
      if (identities.has(identity)) {
        throw new Error("PRODUCT_MATERIAL_LEGACY_IDENTITY_DUPLICATE");
      }
      identities.add(identity);
      const existing = selectMaterialByProductKeyAndSource.get(
        normalized.shopId,
        normalized.productKey,
        normalized.source,
      );
      return { normalized, existing };
    });
    const timestamp = nowIso();
    const upsert = db.prepare(
      `
      INSERT INTO product_material_profiles (
        id, shop_id, product_key, product_id, offer_id, sku, source, source_rank,
        weight_kg, width_cm, height_cm, depth_cm, apply_to_product, is_confirmed,
        ozon_synced_at, ozon_sync_status, source_order_id, source_order_number,
        source_purchase_order_number, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, product_key, source) DO UPDATE SET
        product_id = COALESCE(excluded.product_id, product_material_profiles.product_id),
        offer_id = COALESCE(excluded.offer_id, product_material_profiles.offer_id),
        sku = COALESCE(excluded.sku, product_material_profiles.sku),
        source_rank = excluded.source_rank,
        weight_kg = COALESCE(excluded.weight_kg, product_material_profiles.weight_kg),
        width_cm = COALESCE(excluded.width_cm, product_material_profiles.width_cm),
        height_cm = COALESCE(excluded.height_cm, product_material_profiles.height_cm),
        depth_cm = COALESCE(excluded.depth_cm, product_material_profiles.depth_cm),
        apply_to_product = excluded.apply_to_product,
        is_confirmed = excluded.is_confirmed,
        ozon_synced_at = COALESCE(NULLIF(excluded.ozon_synced_at, ''), product_material_profiles.ozon_synced_at),
        ozon_sync_status = COALESCE(NULLIF(excluded.ozon_sync_status, ''), product_material_profiles.ozon_sync_status),
        source_order_id = COALESCE(NULLIF(excluded.source_order_id, ''), product_material_profiles.source_order_id),
        source_order_number = COALESCE(NULLIF(excluded.source_order_number, ''), product_material_profiles.source_order_number),
        source_purchase_order_number = COALESCE(NULLIF(excluded.source_purchase_order_number, ''), product_material_profiles.source_purchase_order_number),
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `,
    );
    db.exec('SAVEPOINT legacy_product_material_import');
    try {
      prepared.forEach(({ normalized, existing }) => {
        upsert.run(
          existing?.id || createSupportRowId(
            "material",
            normalized.shopId,
            normalized.productKey,
            normalized.source,
          ),
          normalized.shopId,
          normalized.productKey,
          normalized.productId || null,
          normalized.offerId || null,
          normalized.sku || null,
          normalized.source,
          normalized.sourceRank,
          normalized.weightKg,
          normalized.widthCm,
          normalized.heightCm,
          normalized.depthCm,
          normalized.applyToProduct,
          normalized.isConfirmed,
          normalized.ozonSyncedAt || null,
          normalized.ozonSyncStatus || null,
          normalized.sourceOrderId || null,
          normalized.sourceOrderNumber || null,
          normalized.sourcePurchaseOrderNumber || null,
          compactJson(normalized.raw || {}),
          existing?.created_at || timestamp,
          timestamp,
        );
      });
      db.exec('RELEASE SAVEPOINT legacy_product_material_import');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT legacy_product_material_import');
      db.exec('RELEASE SAVEPOINT legacy_product_material_import');
      throw error;
    }
    return {
      ok: true,
      importedCount: prepared.length,
      scopeCount: new Set(prepared.map(({ normalized }) => normalized.shopId)).size,
      digest: createStableHash(
        prepared.map(({ normalized }) => ({
          shopId: normalized.shopId,
          productKey: normalized.productKey,
          source: normalized.source,
        })),
      ),
    };
  }

  function listProductMaterialProfilesPage(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const productKey = normalizeText(query.productKey ?? query.product_key);
    const offerIds = splitIds(query.offerIds ?? query.offer_id ?? query.offerId);
    const productIds = splitIds(query.productIds ?? query.product_id ?? query.productId);
    const cursorText = normalizeLegacyCursorText(query.cursor);
    const cursor = cursorText ? decodeProductMaterialCursor(cursorText) : null;
    if (cursorText && !cursor) throw new Error("PRODUCT_MATERIAL_CURSOR_INVALID");
    const where = [];
    const params = [];
    if (shopId && !["all", "*"].includes(shopId.toLowerCase())) {
      where.push("shop_id = ?");
      params.push(shopId);
    }
    if (productKey) {
      where.push("product_key = ?");
      params.push(productKey);
    }
    if (offerIds.length) {
      where.push(`offer_id IN (${offerIds.map(() => "?").join(",")})`);
      params.push(...offerIds);
    }
    if (productIds.length) {
      where.push(`product_id IN (${productIds.map(() => "?").join(",")})`);
      params.push(...productIds);
    }
    const baseWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      db.prepare(`SELECT COUNT(*) AS total FROM product_material_profiles ${baseWhere}`).get(...params).total,
    ) || 0;
    if (cursor) {
      where.push(
        "(shop_id > ? OR (shop_id = ? AND product_key > ?) OR (shop_id = ? AND product_key = ? AND source > ?))",
      );
      params.push(
        cursor.shopId,
        cursor.shopId,
        cursor.productKey,
        cursor.shopId,
        cursor.productKey,
        cursor.source,
      );
    }
    const pageWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(query.limit ?? query.pageSize) || 500, 1), 1000);
    const candidates = db
      .prepare(
        `SELECT * FROM product_material_profiles ${pageWhere}
         ORDER BY shop_id ASC, product_key ASC, source ASC LIMIT ?`,
      )
      .all(...params, limit + 1);
    const hasMore = candidates.length > limit;
    const rows = candidates.slice(0, limit).map(toPublicMaterialProfile);
    const tail = candidates[Math.min(candidates.length, limit) - 1];
    return {
      ok: true,
      rows,
      total,
      hasMore,
      nextCursor: hasMore && tail ? encodeProductMaterialCursor(tail) : "",
    };
  }

  function listProductMaterialProfiles(query = {}) {
    if (normalizeText(query.cursorMode) === "legacy-migration") {
      return listProductMaterialProfilesPage(query);
    }
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const productKey = normalizeText(query.productKey ?? query.product_key);
    const offerIds = splitIds(
      query.offerIds ?? query.offer_id ?? query.offerId,
    );
    const productIds = splitIds(
      query.productIds ?? query.product_id ?? query.productId,
    );
    const where = [];
    const params = [];
    if (shopId && !["all", "*"].includes(shopId.toLowerCase())) {
      where.push("shop_id = ?");
      params.push(shopId);
    }
    if (productKey) {
      where.push("product_key = ?");
      params.push(productKey);
    }
    if (offerIds.length) {
      where.push(`offer_id IN (${offerIds.map(() => "?").join(",")})`);
      params.push(...offerIds);
    }
    if (productIds.length) {
      where.push(`product_id IN (${productIds.map(() => "?").join(",")})`);
      params.push(...productIds);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const rows = db
      .prepare(
        `SELECT * FROM product_material_profiles ${sqlWhere} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return rows.map(toPublicMaterialProfile);
  }

  function upsertProductSourceLinks(input = {}) {
    const identity = normalizeSupportIdentity(input);
    if (!identity.shopId) throw new Error("PRODUCT_SOURCE_SHOP_ID_REQUIRED");
    if (!identity.productKey)
      throw new Error("PRODUCT_SOURCE_PRODUCT_KEY_REQUIRED");
    const record =
      input.record && typeof input.record === "object" ? input.record : input;
    const rawLinks = Array.isArray(input.links)
      ? input.links
      : Array.isArray(record.links)
        ? record.links
        : [];
    const primaryIndex = Math.max(
      0,
      Number(record.primaryIndex ?? input.primaryIndex) || 0,
    );
    const timestamp = nowIso();
    const saved = [];
    const retainedSlotIndexes = [];
    rawLinks.slice(0, 5).forEach((entry, index) => {
      const normalized = normalizeSourceEntry(entry, index, primaryIndex);
      if (!normalized.url && !normalized.sourceProductId) return;
      retainedSlotIndexes.push(normalized.slotIndex);
      const id = createSupportRowId(
        "source",
        identity.shopId,
        identity.productKey,
        index,
      );
      db.prepare(
        `
        INSERT INTO product_source_links (
          id, shop_id, product_key, product_id, offer_id, sku, slot_index, is_primary,
          platform, url, source_product_id, title, image_url, preview_image_url, original_image_url, price_value, currency_code,
          qty, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shop_id, product_key, slot_index) DO UPDATE SET
          product_id = COALESCE(excluded.product_id, product_source_links.product_id),
          offer_id = COALESCE(excluded.offer_id, product_source_links.offer_id),
          sku = COALESCE(excluded.sku, product_source_links.sku),
          is_primary = excluded.is_primary,
          platform = excluded.platform,
          url = excluded.url,
          source_product_id = excluded.source_product_id,
          title = COALESCE(NULLIF(excluded.title, ''), product_source_links.title),
          image_url = COALESCE(NULLIF(excluded.image_url, ''), product_source_links.image_url),
          preview_image_url = COALESCE(NULLIF(excluded.preview_image_url, ''), product_source_links.preview_image_url),
          original_image_url = COALESCE(NULLIF(excluded.original_image_url, ''), product_source_links.original_image_url),
          price_value = COALESCE(excluded.price_value, product_source_links.price_value),
          currency_code = COALESCE(excluded.currency_code, product_source_links.currency_code),
          qty = COALESCE(NULLIF(excluded.qty, ''), product_source_links.qty),
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        identity.shopId,
        identity.productKey,
        identity.productId || null,
        identity.offerId || null,
        identity.sku || null,
        normalized.slotIndex,
        normalized.isPrimary,
        normalized.platform || null,
        normalized.url || null,
        normalized.sourceProductId || null,
        normalized.title || null,
        normalized.imageUrl || null,
        normalized.previewImageUrl || null,
        normalized.originalImageUrl || null,
        normalized.priceValue,
        normalized.currencyCode || null,
        normalized.qty || null,
        null,
        timestamp,
        timestamp,
      );
      saved.push(normalized);
    });
    const staleWhere = retainedSlotIndexes.length
      ? ` AND slot_index NOT IN (${retainedSlotIndexes.map(() => "?").join(",")})`
      : "";
    db.prepare(
      `DELETE FROM product_source_links WHERE shop_id = ? AND product_key = ?${staleWhere}`,
    ).run(identity.shopId, identity.productKey, ...retainedSlotIndexes);
    const rows = selectSourceLinksByProductKey
      .all(identity.shopId, identity.productKey)
      .map(toPublicSourceLink);
    return {
      ok: true,
      changed: saved.length,
      links: rows,
      record: { links: rows, primaryIndex },
    };
  }

  /**
   * One-time typed legacy import. It deliberately has a narrower shape than
   * the normal interactive write and validates the complete source before the
   * single transaction starts, so a bad sibling cannot produce a partial
   * browser retirement.
   */
  function importLegacyProductSourceLinks(inputs = []) {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new Error("PRODUCT_SOURCE_LEGACY_IMPORT_REQUIRED");
    }
    const recordKeys = new Set();
    const prepared = inputs.map((input) => {
      const group = prepareLegacyProductSourceLinkGroup(input);
      const recordKey = `${group.identity.shopId}\u001f${group.identity.productKey}`;
      if (recordKeys.has(recordKey)) {
        throw new Error("PRODUCT_SOURCE_LEGACY_RECORD_DUPLICATE");
      }
      recordKeys.add(recordKey);
      return group;
    });
    const timestamp = nowIso();
    const upsert = db.prepare(
      `
      INSERT INTO product_source_links (
        id, shop_id, product_key, product_id, offer_id, sku, slot_index, is_primary,
        platform, url, source_product_id, title, image_url, preview_image_url, original_image_url, price_value, currency_code,
        qty, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, product_key, slot_index) DO UPDATE SET
        product_id = COALESCE(excluded.product_id, product_source_links.product_id),
        offer_id = COALESCE(excluded.offer_id, product_source_links.offer_id),
        sku = COALESCE(excluded.sku, product_source_links.sku),
        is_primary = excluded.is_primary,
        platform = excluded.platform,
        url = excluded.url,
        source_product_id = excluded.source_product_id,
        title = COALESCE(NULLIF(excluded.title, ''), product_source_links.title),
        image_url = COALESCE(NULLIF(excluded.image_url, ''), product_source_links.image_url),
        preview_image_url = COALESCE(NULLIF(excluded.preview_image_url, ''), product_source_links.preview_image_url),
        original_image_url = COALESCE(NULLIF(excluded.original_image_url, ''), product_source_links.original_image_url),
        price_value = COALESCE(excluded.price_value, product_source_links.price_value),
        currency_code = COALESCE(excluded.currency_code, product_source_links.currency_code),
        qty = COALESCE(NULLIF(excluded.qty, ''), product_source_links.qty),
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `,
    );
    db.exec('SAVEPOINT legacy_product_source_import');
    try {
      prepared.forEach(({ identity, links }) => {
        links.forEach((link) => {
          upsert.run(
            createSupportRowId("source", identity.shopId, identity.productKey, link.slotIndex),
            identity.shopId,
            identity.productKey,
            identity.productId || null,
            identity.offerId || null,
            identity.sku || null,
            link.slotIndex,
            link.isPrimary,
            link.platform || null,
            link.url || null,
            link.sourceProductId || null,
            link.title || null,
            link.imageUrl || null,
            link.previewImageUrl || null,
            link.originalImageUrl || null,
            link.priceValue,
            link.currencyCode || null,
            link.qty || null,
            null,
            timestamp,
            timestamp,
          );
        });
        const retainedSlots = links.map((link) => link.slotIndex);
        const staleWhere = ` AND slot_index NOT IN (${retainedSlots.map(() => "?").join(",")})`;
        db.prepare(
          `DELETE FROM product_source_links WHERE shop_id = ? AND product_key = ?${staleWhere}`,
        ).run(identity.shopId, identity.productKey, ...retainedSlots);
      });
      db.exec('RELEASE SAVEPOINT legacy_product_source_import');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT legacy_product_source_import');
      db.exec('RELEASE SAVEPOINT legacy_product_source_import');
      throw error;
    }
    return {
      ok: true,
      importedCount: prepared.length,
      scopeCount: new Set(prepared.map(({ identity }) => identity.shopId)).size,
      digest: createStableHash(
        prepared.map(({ identity, links }) => ({
          shopId: identity.shopId,
          productKey: identity.productKey,
          slots: links.map((link) => link.slotIndex).sort((left, right) => left - right),
        })),
      ),
    };
  }

  function listProductSourceLinksPage(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const productKey = normalizeText(query.productKey ?? query.product_key);
    const cursorMode = normalizeText(query.cursorMode) === "legacy-migration";
    const cursor = cursorMode
      ? decodeProductSourceLinkCursor(query.cursor)
      : null;
    if (cursorMode && normalizeLegacyCursorText(query.cursor) && !cursor) {
      throw new Error("PRODUCT_SOURCE_CURSOR_INVALID");
    }
    const where = [];
    const params = [];
    if (shopId && !["all", "*"].includes(shopId.toLowerCase())) {
      where.push("shop_id = ?");
      params.push(shopId);
    }
    if (productKey) {
      where.push("product_key = ?");
      params.push(productKey);
    }
    const baseWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      db.prepare(`SELECT COUNT(*) AS total FROM product_source_links ${baseWhere}`).get(...params).total,
    ) || 0;
    if (cursor) {
      where.push(
        "(shop_id > ? OR (shop_id = ? AND product_key > ?) OR (shop_id = ? AND product_key = ? AND slot_index > ?))",
      );
      params.push(
        cursor.shopId,
        cursor.shopId,
        cursor.productKey,
        cursor.shopId,
        cursor.productKey,
        cursor.slotIndex,
      );
    }
    const pageWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(query.limit ?? query.pageSize) || 500, 1), 1000);
    const candidates = db
      .prepare(
        `SELECT * FROM product_source_links ${pageWhere}
         ORDER BY shop_id ASC, product_key ASC, slot_index ASC LIMIT ?`,
      )
      .all(...params, limit + 1);
    const hasMore = candidates.length > limit;
    const rows = candidates.slice(0, limit).map(toPublicSourceLink);
    const tail = candidates[Math.min(candidates.length, limit) - 1];
    return {
      ok: true,
      rows,
      total,
      hasMore,
      nextCursor: hasMore && tail ? encodeProductSourceLinkCursor(tail) : "",
    };
  }

  function listProductSourceLinks(query = {}) {
    if (normalizeText(query.cursorMode) === "legacy-migration") {
      return listProductSourceLinksPage(query);
    }
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const productKey = normalizeText(query.productKey ?? query.product_key);
    const where = [];
    const params = [];
    if (shopId && !["all", "*"].includes(shopId.toLowerCase())) {
      where.push("shop_id = ?");
      params.push(shopId);
    }
    if (productKey) {
      where.push("product_key = ?");
      params.push(productKey);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Number(query.limit) || 500, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const rows = db
      .prepare(
        `SELECT * FROM product_source_links ${sqlWhere} ORDER BY updated_at DESC, slot_index ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return rows.map(toPublicSourceLink);
  }

  function upsertProductImageHealth(input = {}) {
    const identity = normalizeSupportIdentity(input);
    const imageUrl = normalizeText(
      input.imageUrl ?? input.image_url ?? input.url,
    );
    if (!identity.shopId)
      throw new Error("PRODUCT_IMAGE_HEALTH_SHOP_ID_REQUIRED");
    if (!imageUrl) throw new Error("PRODUCT_IMAGE_HEALTH_URL_REQUIRED");
    const timestamp = nowIso();
    const checkedAt =
      normalizeText(input.checkedAt ?? input.checked_at) || timestamp;
    const id = createSupportRowId(
      "image",
      identity.shopId,
      identity.productKey || imageUrl,
      imageUrl,
    );
    db.prepare(
      `
      INSERT INTO product_image_health (
        id, shop_id, product_key, product_id, offer_id, image_url, status,
        http_status, source, checked_at, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, image_url) DO UPDATE SET
        product_key = COALESCE(excluded.product_key, product_image_health.product_key),
        product_id = COALESCE(excluded.product_id, product_image_health.product_id),
        offer_id = COALESCE(excluded.offer_id, product_image_health.offer_id),
        status = excluded.status,
        http_status = excluded.http_status,
        source = excluded.source,
        checked_at = excluded.checked_at,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `,
    ).run(
      id,
      identity.shopId,
      identity.productKey || null,
      identity.productId || null,
      identity.offerId || null,
      imageUrl,
      normalizeText(input.status) || "unknown",
      toInteger(input.httpStatus ?? input.http_status),
      normalizeText(input.source) || null,
      checkedAt,
      compactJson(input.raw || input),
      timestamp,
      timestamp,
    );
    const row = db
      .prepare(
        "SELECT * FROM product_image_health WHERE shop_id = ? AND image_url = ?",
      )
      .get(identity.shopId, imageUrl);
    return { ok: true, imageHealth: toPublicImageHealth(row) };
  }


  return {
    attachProductSupport,
    syncOzonMaterialProjection,
    upsertProductMaterialProfile,
    importLegacyProductMaterialProfiles,
    listProductMaterialProfiles,
    listProductMaterialProfilesPage,
    upsertProductSourceLinks,
    importLegacyProductSourceLinks,
    listProductSourceLinks,
    listProductSourceLinksPage,
    upsertProductImageHealth,
  };
}
