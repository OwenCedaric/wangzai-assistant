import { getOzonEndpoint } from "../../ozon/ozonEndpointRegistry.js";
import { createStableHash } from "../../utils/stableHash.js";

const MAX_REFS = 100;
const BATCH_SIZE = 100;
const HYDRATION_CACHE_TTL_MS = 5 * 60_000;

function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

function uniqueValues(values = []) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.map(normalizeText).filter(Boolean))];
}

function chunkValues(values = [], size = BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeShopId(value) {
  const shopId = normalizeText(value);
  if (!shopId || ["all", "*"].includes(shopId.toLowerCase())) {
    const error = new Error("商品补查必须指定一个准确店铺。");
    error.code = "PRODUCT_SUMMARY_HYDRATE_SHOP_REQUIRED";
    throw error;
  }
  return shopId;
}

function normalizeRef(value = {}) {
  return {
    productId: normalizeText(value.productId ?? value.product_id),
    offerId: normalizeText(value.offerId ?? value.offer_id),
    sku: normalizeText(value.sku ?? value.skuId ?? value.sku_id),
  };
}

function normalizeRefs(input = {}) {
  const refs = (Array.isArray(input.refs) ? input.refs : [])
    .map(normalizeRef)
    .filter((ref) => ref.productId || ref.offerId || ref.sku);
  if (!refs.length) {
    uniqueValues(input.productIds ?? input.product_ids).forEach((productId) => refs.push({ productId, offerId: "", sku: "" }));
    uniqueValues(input.offerIds ?? input.offer_ids).forEach((offerId) => refs.push({ productId: "", offerId, sku: "" }));
    uniqueValues(input.skus ?? input.skuIds ?? input.sku_ids).forEach((sku) => refs.push({ productId: "", offerId: "", sku }));
  }
  const deduped = new Map();
  refs.forEach((ref) => {
    const key = `${ref.productId}\u0000${ref.offerId}\u0000${ref.sku}`;
    if (!deduped.has(key)) deduped.set(key, ref);
  });
  const output = [...deduped.values()];
  if (!output.length) {
    const error = new Error("缺少待补查的商品标识。");
    error.code = "PRODUCT_SUMMARY_HYDRATE_IDENTITY_REQUIRED";
    throw error;
  }
  if (output.length > MAX_REFS) {
    const error = new Error(`单次最多补查 ${MAX_REFS} 个商品。`);
    error.code = "PRODUCT_SUMMARY_HYDRATE_LIMIT_EXCEEDED";
    throw error;
  }
  return output;
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

function getSchedulerData(result) {
  return result?.data ?? result?.cache?.payload ?? null;
}

function isSchedulerOk(result) {
  if (result?.status === "partial") return false;
  return Boolean(result?.ok || result?.status === "cache_hit" || result?.status === "success");
}

function schedulerErrorMessage(result, fallback) {
  return normalizeText(
    result?.error?.message ??
      result?.errorMessage ??
      result?.message ??
      fallback,
  ) || fallback;
}

function rowIdentity(row = {}) {
  return {
    productId: normalizeText(row.productId ?? row.product_id ?? row.id),
    offerId: normalizeText(row.offerId ?? row.offer_id),
    sku: normalizeText(row.sku ?? row.skuId ?? row.sku_id),
  };
}

function rowCandidates(row = {}) {
  const identity = rowIdentity(row);
  return uniqueValues([identity.productId, identity.offerId, identity.sku]);
}

function refMatchesRow(ref, row) {
  const candidates = new Set(rowCandidates(row));
  return uniqueValues([ref.productId, ref.offerId, ref.sku]).some((value) => candidates.has(value));
}

function rowHasImage(row = {}) {
  const images = Array.isArray(row.images) ? row.images : [];
  return Boolean(normalizeText(row.primaryImageUrl ?? row.primary_image) || images.some(normalizeText));
}

function refIsSatisfied(ref, rows = [], requireImages = false) {
  return rows.some((row) => refMatchesRow(ref, row) && (!requireImages || rowHasImage(row)));
}

function dedupeRows(rows = []) {
  const output = new Map();
  rows.forEach((row) => {
    const identity = rowIdentity(row);
    const key = `${normalizeText(row.shopId ?? row.shop_id)}:${identity.productId || identity.offerId || identity.sku}`;
    if (key !== ":") output.set(key, row);
  });
  return [...output.values()];
}

function createProvenance(endpointKey, scheduled, rows) {
  const endpoint = getOzonEndpoint(endpointKey);
  const observedAt = new Date().toISOString();
  return {
    operationId: normalizeText(scheduled?.jobId) || null,
    contractVersion: normalizeText(endpoint?.contractVersion) || `${endpointKey}:unknown`,
    mapperVersion: normalizeText(endpoint?.mapperVersion) || `product-summary-hydration:${endpointKey}:v1`,
    responseHash:
      normalizeText(scheduled?.results?.[0]?.remoteHash) ||
      createStableHash({ endpointKey, rows }),
    runId: null,
    snapshotId: null,
    expectedAt: observedAt,
    observedAt,
  };
}

export function createProductSummaryHydrationService({
  repository,
  ozonScheduler,
  readSummary,
  productHotCache,
  clearProductReadCache = () => {},
} = {}) {
  const inflight = new Map();

  function readRows(shopId, refs) {
    if (typeof readSummary !== "function") return [];
    const productIds = uniqueValues(refs.map((ref) => ref.productId));
    const offerIds = uniqueValues(refs.map((ref) => ref.offerId));
    const skus = uniqueValues(refs.map((ref) => ref.sku));
    const common = { shopId, scope: "software_all", sort: "stable", pageSize: MAX_REFS };
    const rows = [];
    for (const chunk of chunkValues(offerIds)) {
      rows.push(...(readSummary({ ...common, offerIds: chunk.join(",") })?.rows || []));
    }
    for (const chunk of chunkValues(productIds)) {
      rows.push(...(readSummary({ ...common, productIds: chunk.join(",") })?.rows || []));
    }
    for (const sku of skus) {
      const matches = readSummary({ ...common, keyword: sku })?.rows || [];
      rows.push(...matches.filter((row) => rowCandidates(row).includes(sku)));
    }
    return dedupeRows(rows);
  }

  async function executeBatch({ shopId, endpointKey, params, requestedBy }) {
    const endpoint = getOzonEndpoint(endpointKey);
    const cacheKey = `products:summary-hydrate:remote:${createStableHash({ shopId, endpointKey, params }, { length: 32 })}`;
    const scheduled = await ozonScheduler.executeReadOnly({
      shopId,
      domain: endpoint?.domain || "products",
      endpointKey,
      action: "hydrate-product-summary",
      priority: "P1",
      params,
      cacheKey,
      idempotencyKey: `${cacheKey}:${Math.floor(Date.now() / 60_000)}`,
      requestedBy,
      forceRefresh: true,
      allowStale: false,
      waitForResult: true,
    });
    if (!isSchedulerOk(scheduled)) {
      const error = new Error(schedulerErrorMessage(scheduled, `${endpointKey} 商品补查失败`));
      error.code = "PRODUCT_SUMMARY_HYDRATE_REMOTE_FAILED";
      throw error;
    }
    const rows = extractItems(getSchedulerData(scheduled));
    return { rows, provenance: createProvenance(endpointKey, scheduled, rows) };
  }

  async function hydrateRemote({ shopId, refs, requireImages, requestedBy }) {
    const initialRows = readRows(shopId, refs);
    let unresolved = refs.filter((ref) => !refIsSatisfied(ref, initialRows, requireImages));
    if (!unresolved.length) {
      return { ok: true, status: "local_hit", shopId, rows: initialRows, remoteRequestCount: 0 };
    }

    const infoRows = [];
    let remoteRequestCount = 0;
    const readInfoField = async (fieldName, values, expectedKey) => {
      for (const chunk of chunkValues(values)) {
        if (!chunk.length) continue;
        const result = await executeBatch({
          shopId,
          endpointKey: "products.infoList",
          params: { [fieldName]: chunk },
          requestedBy,
        });
        remoteRequestCount += 1;
        repository.mergeProductInfoRows({
          shopId,
          rows: result.rows,
          expectedProductIds: expectedKey === "product" ? chunk : [],
          expectedOfferIds: expectedKey === "offer" ? chunk : [],
          provenance: result.provenance,
        });
        clearProductReadCache(shopId);
        infoRows.push(...result.rows);
      }
    };

    await readInfoField(
      "offer_id",
      uniqueValues(unresolved.map((ref) => ref.offerId)),
      "offer",
    );
    unresolved = unresolved.filter((ref) => !refIsSatisfied(ref, infoRows));
    await readInfoField(
      "product_id",
      uniqueValues(unresolved.map((ref) => ref.productId)),
      "product",
    );
    unresolved = unresolved.filter((ref) => !refIsSatisfied(ref, infoRows));
    await readInfoField(
      "sku",
      uniqueValues(unresolved.map((ref) => ref.sku)),
      "sku",
    );

    const actualProductIds = uniqueValues(infoRows.map((row) => rowIdentity(row).productId));
    for (const chunk of chunkValues(actualProductIds)) {
      const result = await executeBatch({
        shopId,
        endpointKey: "products.pictures",
        params: { product_id: chunk },
        requestedBy,
      });
      remoteRequestCount += 1;
      repository.mergeProductPictureRows({
        shopId,
        rows: result.rows,
        expectedProductIds: chunk,
        expectedOfferIds: [],
        provenance: result.provenance,
      });
      clearProductReadCache(shopId);
    }

    const rows = readRows(shopId, refs);
    const satisfiedCount = refs.filter((ref) => refIsSatisfied(ref, rows, requireImages)).length;
    return {
      ok: true,
      status:
        satisfiedCount === refs.length
          ? "hydrated"
          : rows.length
            ? "partial"
            : "not_found",
      shopId,
      rows,
      requestedCount: refs.length,
      satisfiedCount,
      remoteRequestCount,
    };
  }

  async function hydrateSummary(input = {}) {
    if (!repository || !ozonScheduler?.executeReadOnly || typeof readSummary !== "function") {
      const error = new Error("商品摘要补查服务尚未连接。");
      error.code = "PRODUCT_SUMMARY_HYDRATE_NOT_CONNECTED";
      throw error;
    }
    const shopId = normalizeShopId(input.shopId ?? input.shop_id);
    const refs = normalizeRefs(input);
    const requireImages = input.requireImages === true || input.require_images === true;
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || "product-summary-cache-miss";
    const requestKey = `products:summary-hydrate:${createStableHash({ shopId, refs, requireImages }, { length: 32 })}`;
    const cached = productHotCache?.get(requestKey);
    if (cached) return { ...cached, source: "memory" };
    if (inflight.has(requestKey)) return inflight.get(requestKey);
    const task = hydrateRemote({ shopId, refs, requireImages, requestedBy })
      .then((payload) => {
        productHotCache?.set(requestKey, payload, {
          tags: [`shop:${shopId}`],
          ttlMs: HYDRATION_CACHE_TTL_MS,
        });
        return payload;
      })
      .finally(() => inflight.delete(requestKey));
    inflight.set(requestKey, task);
    return task;
  }

  return { hydrateSummary };
}
