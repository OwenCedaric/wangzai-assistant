import * as canonicalDto from "./productCanonicalDto.js";
import { PRODUCT_SORT_COLUMNS } from './productSortProjection.js';

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

const PRODUCT_QUERY_MATERIAL_SOURCES = new Set([
  "cross-border",
  "supplier",
  "ozon-initial",
  "missing",
]);
const PRODUCT_QUERY_WAREHOUSE_FILTERS = new Set([
  "returned",
  "default",
  "missing",
  "multi",
]);
const PRODUCT_QUERY_STOCK_FILTERS = new Set([
  "zero",
  "positive",
  "missing",
  "multi",
]);
const PRODUCT_QUERY_SOURCE_STATUSES = new Set([
  "saved",
  "missing",
  "pdd",
  "1688",
  "taobao",
]);
const PRODUCT_QUERY_STATUS_LABELS = new Set(
  Object.values(PRODUCT_STATUS_BY_VISIBILITY),
);

export function createProductCanonicalQueryRepository(db, {
  canonicalFactsAvailable = false,
  attachProductSupport,
  allowCompatibilityRepairs = true,
} = {}) {
  if (!db) throw new Error("createProductCanonicalQueryRepository requires db.");
  if (typeof attachProductSupport !== "function") {
    throw new Error("createProductCanonicalQueryRepository requires attachProductSupport.");
  }
  const canonicalFacts = Boolean(canonicalFactsAvailable);

  function normalizeFilterList(value, { lower = false, allowed = null } = {}) {
    const items = splitIds(value);
    const normalized = items.map((item) =>
      lower ? normalizeText(item).toLowerCase() : normalizeText(item),
    );
    return [
      ...new Set(
        normalized.filter((item) => item && (!allowed || allowed.has(item))),
      ),
    ];
  }

  function appendInPredicate(predicates, params, expression, values = []) {
    if (!values.length) return;
    predicates.push(`${expression} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  }

  function normalizedMaterialSourcePredicates(
    values = [],
    outerAlias,
    { canonical = false } = {},
  ) {
    const selectedSource = `lower(COALESCE((
      SELECT selected_material.source
      FROM product_material_profiles AS selected_material
      WHERE selected_material.shop_id = ${outerAlias}.shop_id
        AND selected_material.product_key = ${outerAlias}.product_key
        AND selected_material.apply_to_product = 1
      ORDER BY selected_material.source_rank DESC, selected_material.updated_at DESC
      LIMIT 1
    ), ''))`;
    const completeProfile = `EXISTS (
      SELECT 1 FROM product_material_profiles AS complete_material
      WHERE complete_material.shop_id = ${outerAlias}.shop_id
        AND complete_material.product_key = ${outerAlias}.product_key
        AND complete_material.apply_to_product = 1
        AND complete_material.weight_kg IS NOT NULL
        AND complete_material.width_cm IS NOT NULL
        AND complete_material.height_cm IS NOT NULL
        AND complete_material.depth_cm IS NOT NULL
    )`;
    const completeProduct = canonical
      ? `(${outerAlias}.canonical_weight_g IS NOT NULL
        AND ${outerAlias}.canonical_length_mm IS NOT NULL
        AND ${outerAlias}.canonical_width_mm IS NOT NULL
        AND ${outerAlias}.canonical_height_mm IS NOT NULL)`
      : `(${outerAlias}.weight_kg IS NOT NULL
        AND ${outerAlias}.width_cm IS NOT NULL
        AND ${outerAlias}.height_cm IS NOT NULL
        AND ${outerAlias}.depth_cm IS NOT NULL)`;
    const completeMaterial = `(${completeProfile} OR ${completeProduct})`;
    const isCrossBorder = `${selectedSource} IN ('cross-border-bus', 'cross_border_bus', 'crossborderbus')`;
    const isSupplier = `${selectedSource} IN ('supplier-confirmed', 'supplier_confirmed', 'supplier', 'manual-confirmed', 'manual_confirmed')`;
    const clauses = [];
    const params = [];
    for (const value of values) {
      if (value === "cross-border") {
        clauses.push(isCrossBorder);
        continue;
      }
      if (value === "supplier") {
        clauses.push(isSupplier);
        continue;
      }
      if (value === "ozon-initial") {
        clauses.push(`(NOT (${isCrossBorder}) AND NOT (${isSupplier}) AND ${completeMaterial})`);
        continue;
      }
      if (value === "missing") {
        clauses.push(`(NOT (${isCrossBorder}) AND NOT (${isSupplier}) AND NOT ${completeMaterial})`);
        continue;
      }
      clauses.push(`${selectedSource} = ?`);
      params.push(value);
    }
    return { clause: clauses.length ? `(${clauses.join(" OR ")})` : "", params };
  }

  function sourceStatusPredicate(status, outerAlias) {
    const correlation = `source_link.shop_id = ${outerAlias}.shop_id
      AND source_link.product_key = ${outerAlias}.product_key`;
    if (status === "missing") {
      return `NOT EXISTS (
        SELECT 1 FROM product_source_links AS source_link
        WHERE ${correlation} AND COALESCE(source_link.url, '') <> ''
      )`;
    }
    if (status === "saved") {
      return `EXISTS (
        SELECT 1 FROM product_source_links AS source_link
        WHERE ${correlation} AND COALESCE(source_link.url, '') <> ''
      )`;
    }
    const matchByPlatform = {
      pdd: ["pdd", "pinduoduo", "yangkeduo", "拼多多"],
      "1688": ["1688", "alibaba"],
      taobao: ["taobao", "tmall", "淘宝", "天猫"],
    };
    const aliases = matchByPlatform[status] || [status];
    const platformConditions = aliases.map((alias) => {
      const escaped = alias.replaceAll("'", "''");
      return `(lower(COALESCE(source_link.platform, '')) LIKE '%${escaped}%'
        OR lower(COALESCE(source_link.url, '')) LIKE '%${escaped}%'
        OR lower(COALESCE(source_link.source_product_id, '')) LIKE '%${escaped}%'
        OR lower(COALESCE(source_link.title, '')) LIKE '%${escaped}%')`;
    });
    return `EXISTS (
      SELECT 1 FROM product_source_links AS source_link
      WHERE ${correlation} AND (${platformConditions.join(" OR ")})
    )`;
  }

  function warehouseFilterPredicate(filter, identityExpression, defaultWarehouseId) {
    const correlation = `warehouse_stock.product_identity_id = ${identityExpression}`;
    const exactSource =
      "lower(COALESCE(warehouse_stock.contract_version, '')) LIKE '%stocks-by-warehouse%'";
    if (filter === "missing") {
      return `NOT EXISTS (
        SELECT 1 FROM product_warehouse_stock_facts AS warehouse_stock
        WHERE ${correlation} AND ${exactSource}
      )`;
    }
    if (filter === "multi") {
      return `(SELECT COUNT(DISTINCT COALESCE(warehouse_stock.warehouse_id, warehouse_stock.warehouse_key))
        FROM product_warehouse_stock_facts AS warehouse_stock
        WHERE ${correlation} AND ${exactSource}) > 1`;
    }
    if (filter === "default") {
      if (!defaultWarehouseId) return "0 = 1";
      return `(NOT EXISTS (
          SELECT 1 FROM product_warehouse_stock_facts AS warehouse_stock
          WHERE ${correlation} AND ${exactSource}
        ) OR EXISTS (
          SELECT 1 FROM product_warehouse_stock_facts AS warehouse_stock
          WHERE ${correlation} AND ${exactSource}
            AND warehouse_stock.warehouse_id = ?
        ))`;
    }
    return `EXISTS (
      SELECT 1 FROM product_warehouse_stock_facts AS warehouse_stock
      WHERE ${correlation} AND ${exactSource}
    )`;
  }

  function stockFilterPredicate(filter, {
    canonical,
    identityExpression,
    stockQuantityExpression,
    stockPresenceExpression,
  }) {
    if (filter === "zero") {
      return `${stockPresenceExpression} IS NOT NULL AND ${stockQuantityExpression} = 0`;
    }
    if (filter === "positive") {
      return `${stockQuantityExpression} > 0`;
    }
    if (filter === "missing") {
      return canonical
        ? `(${stockPresenceExpression} IS NULL OR ${stockQuantityExpression} IS NULL)`
        : `${stockQuantityExpression} IS NULL`;
    }
    if (filter === "multi") {
      return `(SELECT COUNT(DISTINCT COALESCE(warehouse_stock.warehouse_id, warehouse_stock.warehouse_key))
        FROM product_warehouse_stock_facts AS warehouse_stock
        WHERE warehouse_stock.product_identity_id = ${identityExpression}
          AND lower(COALESCE(warehouse_stock.contract_version, ''))
              LIKE '%stocks-by-warehouse%') > 1`;
    }
    return "0 = 1";
  }

  function buildScopedProductWhere(filters = {}, { canonical = false } = {}) {
    const outerAlias = canonical ? "canonical_source" : "ozon_products";
    const baseFilters = {
      ...filters,
      shopId: filters.shopIds?.length ? "" : filters.shopId,
    };
    const base = canonical ? buildCanonicalWhere(baseFilters) : buildWhere(baseFilters);
    const predicates = base.clause ? [base.clause.replace(/^WHERE\s+/i, "")] : [];
    const params = [...base.params];
    if (filters.shopIds?.length) {
      appendInPredicate(predicates, params, `${outerAlias}.shop_id`, filters.shopIds);
    }

    const identityExpression = canonical
      ? `COALESCE(${outerAlias}.canonical_identity_id, ${outerAlias}.id)`
      : `${outerAlias}.id`;
    const material = normalizedMaterialSourcePredicates(
      filters.materialSources,
      outerAlias,
      { canonical },
    );
    if (material.clause) {
      predicates.push(material.clause);
      params.push(...material.params);
    }

    if (filters.warehouseIds?.length) {
      predicates.push(`EXISTS (
        SELECT 1 FROM product_warehouse_stock_facts AS warehouse_stock
        WHERE warehouse_stock.product_identity_id = ${identityExpression}
          AND lower(COALESCE(warehouse_stock.contract_version, ''))
              LIKE '%stocks-by-warehouse%'
          AND warehouse_stock.warehouse_id IN (${filters.warehouseIds.map(() => "?").join(",")})
      )`);
      params.push(...filters.warehouseIds);
    }
    if (filters.warehouseFilters?.length) {
      const clauses = [];
      for (const filter of filters.warehouseFilters) {
        clauses.push(
          warehouseFilterPredicate(
            filter,
            identityExpression,
            filters.defaultWarehouseId,
          ),
        );
        if (filter === "default" && filters.defaultWarehouseId) {
          params.push(filters.defaultWarehouseId);
        }
      }
      predicates.push(`(${clauses.join(" OR ")})`);
    }

    if (filters.stockFilters?.length) {
      const stockQuantityExpression = canonical
        ? `${outerAlias}.canonical_stock_quantity`
        : `${outerAlias}.stock_value`;
      const stockPresenceExpression = canonical
        ? `${outerAlias}.canonical_stock_present`
        : `${outerAlias}.stock_value`;
      predicates.push(`(${filters.stockFilters.map((filter) =>
        stockFilterPredicate(filter, {
          canonical,
          identityExpression,
          stockQuantityExpression,
          stockPresenceExpression,
        })).join(" OR ")})`);
    }

    if (filters.productStatuses?.length) {
      const expression = canonical
        ? `COALESCE(${outerAlias}.canonical_status_label, ${outerAlias}.status_label, '')`
        : `COALESCE(${outerAlias}.status_label, '')`;
      appendInPredicate(predicates, params, expression, filters.productStatuses);
    }

    if (filters.sourceStatuses?.length) {
      predicates.push(`(${filters.sourceStatuses
        .map((status) => sourceStatusPredicate(status, outerAlias))
        .join(" OR ")})`);
    }
    return {
      clause: predicates.length ? `WHERE ${predicates.join(" AND ")}` : "",
      params,
    };
  }

  function countFilteredProducts(filters, { visibility = "" } = {}) {
    const scopedFilters = { ...filters, visibility };
    const { clause, params } = buildScopedProductWhere(scopedFilters, {
      canonical: canonicalFacts,
    });
    return canonicalFacts
      ? Number(db.prepare(`
          WITH ${canonicalProductSourceCte()}
          SELECT COUNT(*) AS total FROM canonical_source ${clause}
        `).get(...params)?.total) || 0
      : Number(db.prepare(
          `SELECT COUNT(*) AS total FROM ozon_products ${clause}`,
        ).get(...params)?.total) || 0;
  }

  function buildFilteredCounts(filters) {
    const counts = {};
    for (const visibility of Object.keys(PRODUCT_STATUS_BY_VISIBILITY)) {
      counts[visibility] = countFilteredProducts(filters, { visibility });
    }
    counts.ALL = countFilteredProducts(filters, { visibility: "" });
    return counts;
  }

  function canUseCanonicalStatusFactCounts(filters) {
    return (
      (!filters.shopIds?.length || filters.shopIds.length === 1)
      && (
        !filters.shopId
        || !filters.shopIds?.length
        || filters.shopId === filters.shopIds[0]
      )
      && !filters.keyword
      && !filters.productIds?.length
      && !filters.offerIds?.length
      && !filters.categoryIds?.length
      && !filters.typeIds?.length
      && !filters.materialSources?.length
      && !filters.warehouseIds?.length
      && !filters.warehouseFilters?.length
      && !filters.stockFilters?.length
      && !filters.productStatuses?.length
      && !filters.sourceStatuses?.length
    );
  }

  function buildCanonicalStablePageCtes(filters, pageSize, offset) {
    const predicates = ["status.is_stale = 0"];
    const pageParams = [];
    const scopedShopId = filters.shopIds?.length === 1
      ? filters.shopIds[0]
      : filters.shopId;
    if (scopedShopId && !["all", "*"].includes(scopedShopId.toLowerCase())) {
      predicates.push("legacy.shop_id = ?");
      pageParams.push(scopedShopId);
    }
    if (filters.visibility && filters.visibility !== "ALL") {
      predicates.push(`(
        status.visibility = ? OR
        status.status_label = ? OR
        status.snapshot_visibilities_json LIKE ?
      )`);
      pageParams.push(
        filters.visibility,
        mapStatusLabel(filters.visibility),
        `%"${filters.visibility}"%`,
      );
    }
    const statusOrder = `CASE
      WHEN status.visibility = 'IN_SALE' OR status.status_label = '出售中' THEN 10
      WHEN status.visibility = 'TO_SUPPLY' OR status.status_label = '待销售' THEN 20
      WHEN status.visibility = 'STATE_FAILED' OR status.status_label = '错误品' THEN 30
      WHEN status.visibility = 'VALIDATION_STATE_FAIL' OR status.status_label = '待修改' THEN 40
      WHEN status.visibility = 'REMOVED_FROM_SALE' OR status.status_label = '违规品' THEN 50
      WHEN status.visibility = 'ARCHIVED' OR status.status_label = '已下架'
        OR status.snapshot_visibilities_json LIKE '%"ARCHIVED"%' THEN 60
      ELSE 999
    END`;
    const pagedSourceCte = `
      paged_product_identity AS MATERIALIZED (
        SELECT legacy.id AS product_identity_id
        FROM ozon_products AS legacy
        JOIN product_identities AS identity
          ON identity.product_identity_id = legacy.id
         AND identity.shop_id = legacy.shop_id
        JOIN product_status_facts AS status
          ON status.product_identity_id = identity.product_identity_id
         AND status.shop_id = identity.shop_id
        WHERE ${predicates.join(" AND ")}
        ORDER BY ${statusOrder} ASC,
                 COALESCE(identity.product_id, legacy.product_id) ASC,
                 COALESCE(identity.offer_id, legacy.offer_id) ASC
        LIMIT ? OFFSET ?
      )
    `;
    const pageBoundCanonicalSource = canonicalProductSourceCte().replace(
      "FROM ozon_products AS legacy",
      `FROM paged_product_identity AS page_identity
       JOIN ozon_products AS legacy
         ON legacy.id = page_identity.product_identity_id`,
    );
    return {
      ctes: `${pagedSourceCte}, ${pageBoundCanonicalSource}, base AS (
        SELECT * FROM canonical_source
      )`,
      params: [...pageParams, pageSize, offset],
      orderBy: `ORDER BY ${buildCanonicalProductOrderBy("stable")}`,
    };
  }

  function listWarehousePickerProducts(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    if (!shopId || ["all", "*"].includes(shopId.toLowerCase())) {
      return listProducts({ ...query, projection: "" });
    }
    const requestedPageSize = Number(query.pageSize ?? query.limit);
    const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0
      ? Math.min(Math.floor(requestedPageSize), 5000)
      : 5000;
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const visibility = normalizeText(query.visibility ?? query.status)
      ? normalizeVisibility(query.visibility ?? query.status)
      : "ALL";
    const where = ["product.shop_id = ?", "product.is_stale = 0"];
    const params = [shopId];
    if (visibility && visibility !== "ALL") {
      where.push(`(
        COALESCE(status.visibility, product.visibility, '') = ? OR
        COALESCE(status.status_label, product.status_label, '') = ? OR
        COALESCE(status.snapshot_visibilities_json, product.snapshot_visibilities_json, '[]') LIKE ?
      )`);
      params.push(visibility, mapStatusLabel(visibility), `%"${visibility}"%`);
    }
    const fromSql = `
      FROM ozon_products AS product
      LEFT JOIN product_status_facts AS status
        ON status.product_identity_id = product.id
       AND status.shop_id = product.shop_id
       AND status.is_stale = 0
      WHERE ${where.join(" AND ")}
    `;
    const total = Number(db.prepare(`SELECT COUNT(*) AS total ${fromSql}`).get(...params)?.total) || 0;
    const statusOrder = `CASE
      WHEN COALESCE(status.visibility, product.visibility) = 'IN_SALE'
        OR COALESCE(status.status_label, product.status_label) = '出售中' THEN 10
      WHEN COALESCE(status.visibility, product.visibility) = 'TO_SUPPLY'
        OR COALESCE(status.status_label, product.status_label) = '待销售' THEN 20
      WHEN COALESCE(status.visibility, product.visibility) = 'STATE_FAILED'
        OR COALESCE(status.status_label, product.status_label) = '错误品' THEN 30
      WHEN COALESCE(status.visibility, product.visibility) = 'VALIDATION_STATE_FAIL'
        OR COALESCE(status.status_label, product.status_label) = '待修改' THEN 40
      WHEN COALESCE(status.visibility, product.visibility) = 'REMOVED_FROM_SALE'
        OR COALESCE(status.status_label, product.status_label) = '违规品' THEN 50
      WHEN COALESCE(status.visibility, product.visibility) = 'ARCHIVED'
        OR COALESCE(status.status_label, product.status_label) = '已下架' THEN 60
      ELSE 999
    END`;
    const rows = db.prepare(`
      SELECT product.id,
             product.shop_id,
             product.product_id,
             product.offer_id,
             product.sku,
             product.name,
             COALESCE(status.visibility, product.visibility, '') AS visibility,
             COALESCE(status.status_label, product.status_label, '') AS status_label,
             COALESCE(
               status.snapshot_visibilities_json,
               product.snapshot_visibilities_json,
               '[]'
             ) AS snapshot_visibilities_json,
             COALESCE((
               SELECT image.image_url
               FROM product_image_facts AS image
               WHERE image.product_identity_id = product.id
               ORDER BY image.is_primary DESC, image.image_index ASC
               LIMIT 1
             ), product.primary_image_url, '') AS primary_image_url,
             product.stock_value,
             COALESCE((
               SELECT json_group_array(json_object(
                 'warehouseId', warehouse_stock.warehouse_id,
                 'warehouseName', warehouse_stock.warehouse_name,
                 'warehouseKey', warehouse_stock.warehouse_key,
                 'sku', warehouse_stock.sku,
                 'fulfillmentType', warehouse_stock.fulfillment_type,
                 'presentQuantity', warehouse_stock.present_quantity,
                 'reservedQuantity', warehouse_stock.reserved_quantity,
                 'freeQuantity', warehouse_stock.free_quantity
               ))
               FROM product_warehouse_stock_facts AS warehouse_stock
               WHERE warehouse_stock.product_identity_id = product.id
                 AND lower(COALESCE(warehouse_stock.contract_version, ''))
                     LIKE '%stocks-by-warehouse%'
             ), '[]') AS warehouse_stocks_json
      ${fromSql}
      ORDER BY ${statusOrder} ASC, product.product_id ASC, product.offer_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    const publicRows = rows.map((row) => {
      const snapshotVisibilities = safeJsonParse(row.snapshot_visibilities_json, []);
      const warehouseStocks = safeJsonParse(row.warehouse_stocks_json, []);
      const sellerWarehouseStockTotal = warehouseStocks.reduce(
        (sum, stock) => sum + (Number(stock?.presentQuantity) || 0),
        0,
      );
      return {
        id: row.id,
        shopId: row.shop_id,
        productId: normalizeId(row.product_id),
        offerId: normalizeId(row.offer_id),
        sku: normalizeId(row.sku),
        name: normalizeText(row.name) || "未返回",
        visibility: normalizeText(row.visibility),
        statusLabel: normalizeText(row.status_label),
        productSnapshotVisibility: snapshotVisibilities[0] || "",
        productSnapshotVisibilities: snapshotVisibilities,
        snapshotVisibilities,
        primaryImageUrl: normalizeText(row.primary_image_url),
        images: row.primary_image_url ? [normalizeText(row.primary_image_url)] : [],
        stockValue: toFiniteNumber(row.stock_value),
        warehouseStocks,
        sellerWarehouseStockTotal,
        warehouseStockTotal: sellerWarehouseStockTotal,
        warehouseStockCount: warehouseStocks.length,
        warehouseStockComplete: warehouseStocks.length > 0,
      };
    });
    return {
      ok: true,
      domain: "products",
      source: "sqlite",
      stale: false,
      projection: "warehouse-picker",
      rows: publicRows,
      page,
      pageSize,
      offset,
      total,
      counts: { ALL: total, ...(visibility !== "ALL" ? { [visibility]: total } : {}) },
      sort: "stable",
      syncState: null,
      durationMs: 0,
    };
  }

  function listProducts(query = {}, { sortKeysOnly = false } = {}) {
    const pageSize = sortKeysOnly ? Math.max(1, Math.trunc(Number(query.pageSize) || 20)) : normalizePageSize(query.pageSize ?? query.limit);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const sort = normalizeProductSort(query.sort);
    const filters = {
      shopId: normalizeText(query.shopId ?? query.shop_id),
      shopIds: (() => {
        const values = normalizeFilterList(query.shopIds ?? query.shop_ids);
        return values.some((value) => ["all", "*"].includes(value.toLowerCase()))
          ? []
          : values;
      })(),
      visibility: normalizeText(query.visibility ?? query.status)
        ? normalizeVisibility(query.visibility ?? query.status)
        : "",
      keyword: normalizeText(query.keyword ?? query.q),
      productIds: splitIds(
        query.productIds ?? query.product_id ?? query.productId,
      ),
      offerIds: splitIds(query.offerIds ?? query.offer_id ?? query.offerId),
      categoryIds: splitIds(
        query.categoryIds
          ?? query.category_ids
          ?? query.descriptionCategoryIds
          ?? query.description_category_ids
          ?? query.categoryId
          ?? query.category_id
          ?? query.descriptionCategoryId
          ?? query.description_category_id,
      ),
      typeIds: splitIds(query.typeIds ?? query.type_ids ?? query.typeId ?? query.type_id),
      materialSources: normalizeFilterList(
        query.materialSources ?? query.material_sources,
        { lower: true, allowed: PRODUCT_QUERY_MATERIAL_SOURCES },
      ),
      warehouseIds: normalizeFilterList(query.warehouseIds ?? query.warehouse_ids),
      defaultWarehouseId: normalizeText(
        query.defaultWarehouseId ?? query.default_warehouse_id,
      ),
      warehouseFilters: normalizeFilterList(
        query.warehouseFilters ?? query.warehouse_filters,
        { lower: true, allowed: PRODUCT_QUERY_WAREHOUSE_FILTERS },
      ),
      stockFilters: normalizeFilterList(
        query.stockFilters ?? query.stock_filters ?? query.stockStates ?? query.stock_states,
        { lower: true, allowed: PRODUCT_QUERY_STOCK_FILTERS },
      ),
      productStatuses: normalizeFilterList(
        query.productStatuses ?? query.product_statuses,
      )
        .map((status) =>
          PRODUCT_STATUS_BY_VISIBILITY[normalizeVisibility(status)]
            ? mapStatusLabel(normalizeVisibility(status))
            : status,
        )
        .filter((status) => PRODUCT_QUERY_STATUS_LABELS.has(status)),
      sourceStatuses: normalizeFilterList(
        query.sourceStatuses ?? query.source_statuses,
        { lower: true, allowed: PRODUCT_QUERY_SOURCE_STATUSES },
      ),
    };
    const { clause, params } = buildScopedProductWhere(filters, {
      canonical: canonicalFacts,
    });
    // The normal list view has no advanced predicates. Its tab counters are
    // already canonical in product_status_facts, so do not rebuild the large
    // multi-fact canonical CTE once per tab (plus once for total). Advanced
    // filtered views keep the exact scoped CTE path below.
    const useStatusFactCounts = canUseCanonicalStatusFactCounts(filters);
    const statusCountShopId = filters.shopIds?.length === 1
      ? filters.shopIds[0]
      : filters.shopId;
    const statusFactCounts = useStatusFactCounts
      ? buildProductCounts(db, statusCountShopId, { canonical: canonicalFacts })
      : null;
    const totalRow = useStatusFactCounts
      ? null
      : canonicalFacts
        ? db.prepare(`
          WITH ${canonicalProductSourceCte()}
          SELECT COUNT(*) AS total FROM canonical_source ${clause}
        `).get(...params)
        : db.prepare(`SELECT COUNT(*) AS total FROM ozon_products ${clause}`).get(...params);
    const useCanonicalStablePage = canonicalFacts && useStatusFactCounts && sort === "stable";
    const canonicalPage = useCanonicalStablePage
      ? buildCanonicalStablePageCtes(filters, pageSize, offset)
      : {
          ctes: `${canonicalProductSourceCte()},
          base AS (
            SELECT * FROM canonical_source
            ${clause}
            ORDER BY ${buildCanonicalProductOrderBy(sort)}
            LIMIT ? OFFSET ?
          )`,
          params: [...params, pageSize, offset],
          orderBy: "",
        };
    const countMap = statusFactCounts || buildFilteredCounts(filters);
    const total = useStatusFactCounts
      ? Number(filters.visibility && filters.visibility !== 'ALL' ? countMap[filters.visibility] : countMap.ALL) || 0
      : Number(totalRow?.total) || 0;
    if (sortKeysOnly && canonicalFacts) {
      const rows = db.prepare(`WITH ${canonicalPage.ctes}
        SELECT ${PRODUCT_SORT_COLUMNS.map(([name]) => `base.${name}`).join(', ')} FROM base
        ${canonicalPage.orderBy}`).all(...canonicalPage.params);
      return { rows, total, counts: countMap, page, pageSize, offset, sort };
    }
    const rows = canonicalFacts
      ? db.prepare(`
          WITH ${canonicalPage.ctes}
          SELECT base.*,
                 (SELECT json_group_object(
                           lower(commission.fulfillment_type),
                           json_object(
                             'ratePpm', commission.rate_ppm,
                             'status', commission.status,
                             'operationId', commission.operation_id,
                             'contractVersion', commission.contract_version,
                             'mapperVersion', commission.mapper_version,
                             'responseHash', commission.response_hash,
                             'runId', commission.run_id,
                             'snapshotId', commission.snapshot_id,
                             'observedAt', commission.observed_at,
                             'sourceReason', commission.source_reason
                           )
                         )
                    FROM product_commission_facts AS commission
                   WHERE commission.product_identity_id = base.id
                 ) AS canonical_commissions_json,
                 (SELECT json_group_array(image.image_url)
                    FROM product_image_facts AS image
                   WHERE image.product_identity_id = base.id
                   ORDER BY image.image_index
                 ) AS canonical_images_json,
                 (SELECT COUNT(*)
                    FROM product_image_facts AS image
                   WHERE image.product_identity_id = base.id
                 ) AS canonical_image_count,
                 (SELECT json_group_array(
                           json_object(
                             'warehouseId', warehouse_stock.warehouse_id,
                             'warehouseName', warehouse_stock.warehouse_name,
                             'warehouseKey', warehouse_stock.warehouse_key,
                             'sku', warehouse_stock.sku,
                             'fulfillmentType', warehouse_stock.fulfillment_type,
                             'presentQuantity', warehouse_stock.present_quantity,
                             'reservedQuantity', warehouse_stock.reserved_quantity,
                             'freeQuantity', warehouse_stock.free_quantity,
                             'operationId', warehouse_stock.operation_id,
                             'contractVersion', warehouse_stock.contract_version,
                             'mapperVersion', warehouse_stock.mapper_version,
                             'responseHash', warehouse_stock.response_hash,
                             'runId', warehouse_stock.run_id,
                             'snapshotId', warehouse_stock.snapshot_id,
                             'observedAt', warehouse_stock.observed_at
                           )
                         )
                    FROM product_warehouse_stock_facts AS warehouse_stock
                   WHERE warehouse_stock.product_identity_id = base.id
                     AND lower(COALESCE(warehouse_stock.contract_version, ''))
                         LIKE '%stocks-by-warehouse%'
                 ) AS canonical_warehouse_stocks_json,
                 (SELECT json_group_object(
                           observation.facet,
                           json_object(
                             'status', observation.status,
                             'operationId', observation.operation_id,
                             'endpointKey', observation.endpoint_key,
                             'contractVersion', observation.contract_version,
                             'mapperVersion', observation.mapper_version,
                             'responseHash', observation.response_hash,
                             'runId', observation.run_id,
                             'snapshotId', observation.snapshot_id,
                             'expectedAt', observation.expected_at,
                             'observedAt', observation.observed_at,
                             'sourceReason', observation.source_reason
                           )
                         )
                    FROM product_facet_observations AS observation
                   WHERE observation.product_identity_id = base.id
                 ) AS canonical_facet_observations_json
            FROM base
            ${canonicalPage.orderBy}
        `).all(...canonicalPage.params)
      : db.prepare(`
          SELECT * FROM ozon_products
          ${clause}
          ORDER BY ${buildProductOrderBy(sort)}
          LIMIT ? OFFSET ?
        `).all(...params, pageSize, offset);
    const repairedRows = rows.map((sourceRow) => {
      const repair = repairStoredStockPatch(sourceRow);
      const row = repair
        ? {
            ...sourceRow,
            stock_value: repair.stockValue ?? sourceRow.stock_value,
            stock_json: compactJson(repair.stockJson ?? safeJsonParse(sourceRow.stock_json, null)),
          }
        : sourceRow;
      if (!repair) return mergeCanonicalFactReadRow(row);
      const stockJson = safeJsonParse(row.stock_json, null);
      const stockValue = row.stock_value;
      const timestamp = nowIso();
      if (allowCompatibilityRepairs) {
        db.prepare(
          "UPDATE ozon_products SET stock_value = ?, stock_json = ?, updated_at = ? WHERE id = ?",
        ).run(stockValue, compactJson(stockJson), timestamp, row.id);
      }
      return mergeCanonicalFactReadRow({
        ...row,
        stock_value: stockValue,
        stock_json: compactJson(stockJson),
        updated_at: timestamp,
      });
    });
    return {
      ok: true,
      domain: "products",
      source: "sqlite",
      stale: false,
      rows: attachProductSupport(repairedRows.map(toPublicProduct)),
      page,
      pageSize,
      offset,
      total,
      counts: countMap,
      sort,
      syncState: null,
      durationMs: 0,
    };
  }

  function getProductsByIds(query = {}) {
    return listProducts({ ...query, pageSize: query.pageSize || 100 });
  }

  function resolveOfferIdsForProducts({
    shopId,
    productIds = [],
    offerIds = [],
    limit = 1000,
  } = {}) {
    const normalizedProductIds = splitIds(productIds);
    const normalizedOfferIds = splitIds(offerIds);
    const where = ["shop_id = ?", "is_stale = 0"];
    const params = [shopId];
    if (normalizedProductIds.length) {
      where.push(
        `product_id IN (${normalizedProductIds.map(() => "?").join(",")})`,
      );
      params.push(...normalizedProductIds);
    }
    if (normalizedOfferIds.length) {
      where.push(
        `offer_id IN (${normalizedOfferIds.map(() => "?").join(",")})`,
      );
      params.push(...normalizedOfferIds);
    }
    if (!normalizedProductIds.length && !normalizedOfferIds.length) return [];
    const fallbackLimit = Math.max(
      normalizedProductIds.length + normalizedOfferIds.length,
      1,
    );
    const numericLimit = Number(limit);
    const sqlLimit =
      Number.isFinite(numericLimit) && numericLimit > 0
        ? Math.floor(numericLimit)
        : fallbackLimit;
    const rows = db
      .prepare(
        `
      SELECT product_id, offer_id FROM ozon_products
      WHERE ${where.join(" AND ")}
      ORDER BY sort_index ASC, product_id ASC, offer_id ASC
      LIMIT ?
    `,
      )
      .all(...params, sqlLimit);
    return [
      ...new Set(rows.map((row) => normalizeId(row.offer_id)).filter(Boolean)),
    ];
  }

  function resolveProductModelNamesForOffers({ shopId, offerIds = [] } = {}) {
    const normalizedShopId = normalizeText(shopId);
    const normalizedOfferIds = splitIds(offerIds);
    if (!canonicalFacts || !normalizedShopId || !normalizedOfferIds.length) return [];
    const rows = db.prepare(`
      SELECT identity.offer_id,
             json_extract(attribute.value, '$.values[0].value') AS model_name
        FROM product_identities AS identity
        JOIN product_attribute_facts AS facts
          ON facts.product_identity_id = identity.product_identity_id
        JOIN json_each(facts.attributes_json) AS attribute
       WHERE identity.shop_id = ?
         AND identity.offer_id IN (${normalizedOfferIds.map(() => '?').join(',')})
         AND CAST(json_extract(attribute.value, '$.id') AS INTEGER) = 9048
       ORDER BY identity.offer_id ASC
    `).all(normalizedShopId, ...normalizedOfferIds);
    return rows.map((row) => ({
      offerId: normalizeId(row.offer_id),
      modelName: normalizeText(row.model_name),
    })).filter((row) => row.offerId && row.modelName);
  }

  function productModelIdentity(row = {}) {
    const attributes = safeJsonParse(row.attributes_json, []);
    const model = (Array.isArray(attributes) ? attributes : []).find(
      (attribute) => Number(attribute?.id) === 9048,
    );
    return normalizeText(model?.values?.[0]?.value);
  }

  function listSkuFamily({ shopId, sku, productId, offerId } = {}) {
    const normalizedShopId = normalizeText(shopId);
    const identities = [
      ["sku", normalizeId(sku)],
      ["product_id", normalizeId(productId)],
      ["offer_id", normalizeId(offerId)],
    ].filter(([, value]) => value);
    if (!normalizedShopId || !identities.length) return { rows: [], total: 0, modelIdentity: "" };
    const predicates = identities.map(([column]) => `${column} = ?`);
    const baseRow = db.prepare(`
      SELECT * FROM ozon_products
       WHERE shop_id = ? AND (${predicates.join(" OR ")})
       ORDER BY hydrated_at DESC, updated_at DESC
       LIMIT 1
    `).get(normalizedShopId, ...identities.map(([, value]) => value));
    if (!baseRow) return { rows: [], total: 0, modelIdentity: "" };

    const modelIdentity = productModelIdentity(baseRow);
    let rows = [baseRow];
    if (modelIdentity) {
      rows = db.prepare(`
        SELECT product.*
          FROM ozon_products AS product
         WHERE product.shop_id = ?
           AND EXISTS (
             SELECT 1
               FROM json_each(CASE WHEN json_valid(product.attributes_json) THEN product.attributes_json ELSE '[]' END) AS attribute
               JOIN json_each(COALESCE(json_extract(attribute.value, '$.values'), '[]')) AS attribute_value
              WHERE CAST(json_extract(attribute.value, '$.id') AS INTEGER) = 9048
                AND CAST(json_extract(attribute_value.value, '$.value') AS TEXT) = ?
           )
         ORDER BY product.sort_index ASC, product.product_id ASC, product.offer_id ASC
         LIMIT 1000
      `).all(normalizedShopId, modelIdentity);
    }
    const publicRows = rows.map(toPublicProduct);
    return {
      rows: publicRows,
      total: publicRows.length,
      modelIdentity,
      matchedBy: identities[0][0],
    };
  }

  return {
    listProducts,
    listProductSortKeys: (query) => listProducts(query, { sortKeysOnly: true }),
    listWarehousePickerProducts,
    getProductsByIds,
    resolveOfferIdsForProducts,
    resolveProductModelNamesForOffers,
    listSkuFamily,
  };
}
