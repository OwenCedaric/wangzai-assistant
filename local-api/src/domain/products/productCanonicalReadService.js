import { createStableHash } from "../../utils/stableHash.js";

function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function parseListInput(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  return normalizeText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildProductReadCacheKey(query = {}) {
  return `products:read:${createStableHash(
    {
      shopId: normalizeText(query.shopId ?? query.shop_id),
      scope: normalizeText(
        query.scope ??
          query.view ??
          (normalizeText(query.visibility ?? query.status).toUpperCase() === "ALL"
            ? "software_all"
            : "status"),
      ),
      visibility: normalizeText(query.visibility ?? query.status),
      keyword: normalizeText(query.keyword ?? query.q),
      productIds: parseListInput(query.productIds ?? query.product_id ?? query.productId),
      offerIds: parseListInput(query.offerIds ?? query.offer_id ?? query.offerId),
      shopIds: parseListInput(query.shopIds ?? query.shop_ids),
      materialSources: parseListInput(query.materialSources ?? query.material_sources),
      warehouseIds: parseListInput(query.warehouseIds ?? query.warehouse_ids),
      defaultWarehouseId: normalizeText(query.defaultWarehouseId ?? query.default_warehouse_id),
      warehouseFilters: parseListInput(query.warehouseFilters ?? query.warehouse_filters),
      stockFilters: parseListInput(
        query.stockFilters ?? query.stock_filters ?? query.stockStates ?? query.stock_states,
      ),
      projection: normalizeText(query.projection),
      productStatuses: parseListInput(query.productStatuses ?? query.product_statuses),
      sourceStatuses: parseListInput(query.sourceStatuses ?? query.source_statuses),
      page: Math.max(Number(query.page) || 1, 1),
      pageSize: Number(query.pageSize ?? query.limit) || 20,
      offset: Number(query.offset) || 0,
      sort: normalizeText(query.sort) || "stable",
    },
    { length: 32 },
  )}`;
}

function buildProductSummaryCacheKey(query = {}) {
  return buildProductReadCacheKey(query).replace(/^products:read:/u, "products:summary:");
}

function buildProductReadCacheTags(query = {}) {
  const shopIds = parseListInput(query.shopIds ?? query.shop_ids).filter(
    (shopId) => !["all", "*"].includes(shopId.toLowerCase()),
  );
  if (shopIds.length) {
    return [...new Set(shopIds.map((shopId) => `shop:${shopId}`))];
  }
  const shopId = normalizeText(query.shopId ?? query.shop_id);
  return shopId && !["all", "*"].includes(shopId.toLowerCase()) ? [`shop:${shopId}`] : [];
}

function resolveProductReadShopId(query = {}) {
  const direct = normalizeText(query.shopId ?? query.shop_id);
  if (direct && !["all", "*"].includes(direct.toLowerCase())) return direct;
  const shopIds = parseListInput(query.shopIds ?? query.shop_ids).filter(
    (shopId) => !["all", "*"].includes(shopId.toLowerCase()),
  );
  return [...new Set(shopIds)].length === 1 ? shopIds[0] : "";
}

export function createProductCanonicalReadService({
  repository,
  stateService,
  summaryService,
  cleanupService,
  productHotCache,
} = {}) {
  function readCache(query = {}) {
    if (!repository) {
      return {
        ok: false,
        error: {
          code: "PRODUCT_CACHE_NOT_CONNECTED",
          message: "商品缓存表尚未连接。",
        },
      };
    }
    const started = Date.now();
    const cacheShopId = resolveProductReadShopId(query);
    const cacheKey = cacheShopId ? buildProductReadCacheKey(query) : "";
    if (cacheKey) {
      const cached = productHotCache.get(cacheKey);
      if (cached) {
        return { ...cached, source: "memory", durationMs: Date.now() - started };
      }
    }
    const useWarehousePickerProjection = normalizeText(query.projection) === "warehouse-picker"
      && typeof repository.listWarehousePickerProducts === "function";
    const payload = useWarehousePickerProjection
      ? repository.listWarehousePickerProducts(query)
      : repository.listProducts(query);
    payload.durationMs = Date.now() - started;
    payload.syncState = stateService?.listStates("products", {
      shopId: query.shopId || query.shop_id,
      limit: 5,
    }) ?? [];
    if (cacheKey) {
      productHotCache.set(cacheKey, { ...payload, source: "memory" }, {
        tags: buildProductReadCacheTags({ ...query, shopId: cacheShopId, shopIds: [] }),
      });
    }
    return payload;
  }

  function readSummary(query = {}) {
    if (!summaryService) {
      return {
        ok: false,
        error: {
          code: "PRODUCT_SUMMARY_NOT_CONNECTED",
          message: "商品摘要只读服务尚未连接。",
        },
      };
    }
    const started = Date.now();
    const cacheShopId = resolveProductReadShopId(query);
    const cacheKey = cacheShopId ? buildProductSummaryCacheKey(query) : "";
    if (cacheKey) {
      const cached = productHotCache.get(cacheKey);
      if (cached) {
        return { ...cached, source: "memory", durationMs: Date.now() - started };
      }
    }
    const payload = summaryService.readSummary(query);
    payload.durationMs = Date.now() - started;
    if (cacheKey) {
      productHotCache.set(cacheKey, { ...payload, source: "memory" }, {
        tags: buildProductReadCacheTags({ ...query, shopId: cacheShopId, shopIds: [] }),
      });
    }
    return payload;
  }

  function readSkuFamily(query = {}) {
    if (!repository?.listSkuFamily) {
      return {
        ok: false,
        error: { code: "PRODUCT_SKU_FAMILY_NOT_CONNECTED", message: "商品SKU家族读取服务尚未连接。" },
      };
    }
    const payload = repository.listSkuFamily({
      shopId: query.shopId ?? query.shop_id,
      sku: query.sku ?? query.skuId ?? query.sku_id,
      productId: query.productId ?? query.product_id,
      offerId: query.offerId ?? query.offer_id,
    });
    return { ok: true, ...payload };
  }

  function cleanupProductCache(options = {}) {
    if (!cleanupService) {
      return {
        ok: false,
        error: {
          code: "PRODUCT_CACHE_CLEANUP_NOT_CONNECTED",
          message: "商品 response_cache 清理服务尚未连接。",
        },
      };
    }
    return cleanupService.cleanupResponseCache(options);
  }

  function warmProductReadCache({ shopId, visibility, visibilities } = {}) {
    const targets = Array.isArray(visibilities) && visibilities.length
      ? visibilities
      : [visibility || "ALL"];
    for (const targetVisibility of targets) {
      for (const pageSize of [20, 30, 50, 100]) {
        readCache({ shopId, visibility: targetVisibility, pageSize, page: 1 });
      }
    }
  }

  return {
    readCache,
    readSummary,
    readSkuFamily,
    cleanupProductCache,
    warmProductReadCache,
    countOwnerHotCache(shopId) {
      return productHotCache.count({
        tags: [`shop:${normalizeText(shopId)}`],
      });
    },
    invalidateOwnerHotCache(shopId) {
      return productHotCache.invalidate({
        tags: [`shop:${normalizeText(shopId)}`],
      });
    },
  };
}
