import { getOzonEndpoint } from "../../ozon/ozonEndpointRegistry.js";
import { createStableHash } from "../../utils/stableHash.js";

const MAX_REFS = 100;

function normalizeText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function unique(values = []) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function normalizeRef(value = {}) {
  return {
    productId: normalizeText(value.productId ?? value.product_id),
    offerId: normalizeText(value.offerId ?? value.offer_id),
    sku: normalizeText(value.sku ?? value.skuId ?? value.sku_id),
  };
}

function refKey(ref = {}) {
  return `${normalizeText(ref.productId)}\u0000${normalizeText(ref.offerId)}\u0000${normalizeText(ref.sku)}`;
}

function normalizeRefs(input = {}) {
  const refs = (Array.isArray(input.refs) ? input.refs : [])
    .map(normalizeRef)
    .filter((ref) => ref.productId || ref.offerId || ref.sku);
  const deduped = new Map(refs.map((ref) => [refKey(ref), ref]));
  return [...deduped.values()].slice(0, MAX_REFS);
}

function normalizeFacets(value) {
  const allowed = new Set(["detail", "pictures", "attributes", "prices", "stocks"]);
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(normalizeText).filter((item) => allowed.has(item)))];
}

function extractItems(data) {
  if (Array.isArray(data?.result?.items)) return data.result.items;
  if (Array.isArray(data?.result?.products)) return data.result.products;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.products)) return data.products;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data)) return data;
  return [];
}

function schedulerData(result) {
  return result?.data ?? result?.cache?.payload ?? null;
}

function schedulerOk(result) {
  return result?.status !== "partial"
    && Boolean(result?.ok || result?.status === "success" || result?.status === "cache_hit");
}

function rowProductId(row = {}) {
  return normalizeText(row.product_id ?? row.productId ?? row.id);
}

function rowOfferId(row = {}) {
  return normalizeText(row.offer_id ?? row.offerId);
}

function provenance(endpointKey, scheduled, rows) {
  const endpoint = getOzonEndpoint(endpointKey);
  const observedAt = new Date().toISOString();
  return {
    operationId: normalizeText(scheduled?.jobId) || null,
    contractVersion: normalizeText(endpoint?.contractVersion) || `${endpointKey}:unknown`,
    mapperVersion: normalizeText(endpoint?.mapperVersion) || `product-push-refresh:${endpointKey}:v1`,
    responseHash: normalizeText(scheduled?.results?.[0]?.remoteHash)
      || createStableHash({ endpointKey, rows }),
    runId: null,
    snapshotId: null,
    expectedAt: observedAt,
    observedAt,
  };
}

/**
 * Exact product refresh used only after a signed Ozon push. It never scans the
 * full catalogue: at most 100 pushed identities are read and merged into the
 * same canonical SQLite product tables used by normal product sync.
 */
export function createProductPushRefreshService({
  repository,
  ozonScheduler,
  clearProductReadCache = () => {},
} = {}) {
  async function refreshProductsByRefs(input = {}) {
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const refs = normalizeRefs(input);
    const facets = normalizeFacets(input.facets);
    if (!shopId || !refs.length || !facets.length) {
      return {
        ok: false,
        shopId,
        failedRefKeys: refs.map(refKey),
        error: { code: "PRODUCT_PUSH_REFRESH_INPUT_REQUIRED", message: "推送补查缺少店铺、商品或刷新范围。" },
      };
    }
    if (!repository || !ozonScheduler?.executeReadOnly) {
      return {
        ok: false,
        shopId,
        failedRefKeys: refs.map(refKey),
        error: { code: "PRODUCT_PUSH_REFRESH_NOT_CONNECTED", message: "商品推送补查服务尚未连接。" },
      };
    }

    const requestCycle = normalizeText(input.requestCycle ?? input.request_cycle) || String(Date.now());
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || "ozon-push-product-refresh";
    const errors = [];
    let changedCount = 0;
    let unchangedCount = 0;

    async function executeAndMerge({ endpointKey, params, expectedProductIds = [], expectedOfferIds = [], merge }) {
      const scheduled = await ozonScheduler.executeReadOnly({
        shopId,
        domain: getOzonEndpoint(endpointKey)?.domain || "products",
        endpointKey,
        action: "ozon-push-product-refresh",
        priority: input.priority || "P1",
        params,
        cacheKey: `products:${shopId}:push-refresh:${endpointKey}:${createStableHash(params, { length: 24 })}`,
        idempotencyKey: `ozon-push-product-refresh:${shopId}:${endpointKey}:${requestCycle}:${createStableHash(params, { length: 24 })}`,
        requestedBy,
        forceRefresh: true,
        allowStale: false,
        waitForResult: true,
      });
      if (!schedulerOk(scheduled)) {
        const error = new Error(
          normalizeText(scheduled?.error?.message ?? scheduled?.job?.lastError)
          || `${endpointKey} 推送补查失败`,
        );
        error.code = "PRODUCT_PUSH_REFRESH_REMOTE_FAILED";
        throw error;
      }
      const rows = extractItems(schedulerData(scheduled));
      const mergeResult = merge({
        shopId,
        rows,
        expectedProductIds,
        expectedOfferIds,
        provenance: provenance(endpointKey, scheduled, rows),
      }) || {};
      changedCount += Number(mergeResult.changed ?? mergeResult.updated) || 0;
      unchangedCount += Number(mergeResult.unchanged) || 0;
      return rows;
    }

    const infoRows = [];
    const requestedProductIds = unique(refs.map((ref) => ref.productId));
    const requestedOfferIds = unique(refs.map((ref) => ref.offerId));
    const mustReadInfo = facets.includes("detail")
      || !requestedProductIds.length
      || requestedOfferIds.length > requestedProductIds.length;

    try {
      if (mustReadInfo) {
        const offerOnlyIds = unique(refs.filter((ref) => !ref.productId).map((ref) => ref.offerId));
        const skuOnlyIds = unique(
          refs.filter((ref) => !ref.productId && !ref.offerId).map((ref) => ref.sku),
        );
        const infoRequests = [
          requestedProductIds.length
            ? { params: { product_id: requestedProductIds }, expectedProductIds: requestedProductIds, expectedOfferIds: [] }
            : null,
          offerOnlyIds.length
            ? { params: { offer_id: offerOnlyIds }, expectedProductIds: [], expectedOfferIds: offerOnlyIds }
            : null,
          skuOnlyIds.length
            ? { params: { sku: skuOnlyIds }, expectedProductIds: [], expectedOfferIds: [] }
            : null,
        ].filter(Boolean);
        for (const request of infoRequests) {
          infoRows.push(...await executeAndMerge({
            endpointKey: "products.infoList",
            ...request,
            merge: (mergeInput) => repository.mergeProductInfoRows(mergeInput),
          }));
        }
      }

      const productIds = unique([
        ...requestedProductIds,
        ...infoRows.map(rowProductId),
      ]);
      const offerIds = unique([
        ...requestedOfferIds,
        ...infoRows.map(rowOfferId),
      ]);

      if (facets.includes("pictures") && productIds.length) {
        await executeAndMerge({
          endpointKey: "products.pictures",
          params: { product_id: productIds },
          expectedProductIds: productIds,
          merge: (mergeInput) => repository.mergeProductPictureRows(mergeInput),
        });
      }
      if (facets.includes("attributes") && offerIds.length) {
        await executeAndMerge({
          endpointKey: "products.attributes",
          params: { filter: { offer_id: offerIds }, limit: 1000 },
          expectedOfferIds: offerIds,
          merge: (mergeInput) => repository.mergeProductAttributeRows(mergeInput),
        });
      }
      if (facets.includes("prices") && productIds.length) {
        await executeAndMerge({
          endpointKey: "products.prices",
          params: { filter: { product_id: productIds }, limit: 1000 },
          expectedProductIds: productIds,
          merge: (mergeInput) => repository.mergeProductPriceRows(mergeInput),
        });
      }
      if (facets.includes("stocks") && productIds.length) {
        await executeAndMerge({
          endpointKey: "products.stocks",
          params: { filter: { product_id: productIds }, limit: 1000 },
          expectedProductIds: productIds,
          merge: (mergeInput) => repository.mergeProductStockRows(mergeInput),
        });
      }
      clearProductReadCache(shopId);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return {
      ok: errors.length === 0,
      shopId,
      requestedCount: refs.length,
      changedCount,
      unchangedCount,
      facets,
      failedRefKeys: errors.length ? refs.map(refKey) : [],
      errors,
    };
  }

  return { refreshProductsByRefs };
}

export const productPushRefKey = refKey;
