import { getOzonEndpoint } from "../../ozon/ozonEndpointRegistry.js";
import { createStableHash } from "../../utils/stableHash.js";
import { normalizeText, uniqueIds } from "./productSyncValues.js";

export const PRODUCT_LIST_DEFAULT_PAGE_SIZE = 1000;

export const PRODUCT_HYDRATION_BATCH_SIZE = 100;

// products.infoList is capped at 100 product IDs by the endpoint registry.
// Core hydration includes that endpoint, so its shared batch cannot be larger
// even though price/stock endpoints accept a larger payload.
export const PRODUCT_HYDRATION_CORE_BATCH_SIZE = 100;

export const PRODUCT_HYDRATION_FAST_BATCH_SIZE = 1000;

export const PRODUCT_HYDRATION_DEFAULT_CONCURRENCY = 12;

export const PRODUCT_HYDRATION_MAX_CONCURRENCY = 24;

export function normalizePageSize(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

export function isAllPagesValue(value) {
  return (
    value === 0 ||
    ["all", "unlimited", "none", "full"].includes(
      normalizeText(value).toLowerCase(),
    )
  );
}

export function normalizeMaxPages(value, fallback = 1) {
  if (isAllPagesValue(value)) return Number.POSITIVE_INFINITY;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export function normalizeMaxHydrateProducts(value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    isAllPagesValue(value)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(number);
}

export function normalizeHydrationConcurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return PRODUCT_HYDRATION_DEFAULT_CONCURRENCY;
  }
  return Math.min(Math.floor(number), PRODUCT_HYDRATION_MAX_CONCURRENCY);
}

export function requiredHydrationFacets(mode) {
  if (mode === "details") return ["detail"];
  if (mode === "pictures") return ["pictures"];
  if (mode === "fast") return ["prices", "stocks"];
  if (mode === "core") return ["detail", "prices", "stocks"];
  return ["detail", "pictures", "prices", "stocks", "attributes"];
}

export function normalizeHydrationBatchSize(value, fallback, maxBatchSize) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), maxBatchSize);
}

export async function runWithConcurrency(items = [], concurrency, worker) {
  if (!items.length) return;
  const workerCount = Math.min(
    Math.max(Number(concurrency) || 1, 1),
    items.length,
  );
  let cursor = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    }),
  );
}

export function limitIds(values, maxCount) {
  const ids = uniqueIds(values);
  return Number.isFinite(maxCount) ? ids.slice(0, maxCount) : ids;
}

export function progressTotalForMaxPages(maxPages) {
  return Number.isFinite(maxPages) ? maxPages : 0;
}

export function readContractPath(source, path) {
  const parts = normalizeText(path).split(".").filter(Boolean);
  let value = source;
  for (const part of parts) {
    if (value == null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

export function resolveProductListContractPlan(input = {}) {
  const endpoint = getOzonEndpoint("products.list");
  const planning = endpoint?.planning || {};
  if (planning.mode !== "last_id") {
    throw new Error("PRODUCT_LIST_CONTRACT_PAGINATION_MODE_INVALID");
  }
  const maxLimit = Math.max(Number(planning.maxLimit) || 1000, 1);
  const defaultLimit = Math.min(
    Math.max(Number(planning.defaultLimit) || 100, 1),
    maxLimit,
  );
  const requestedLimit = normalizePageSize(
    input.pageSize ?? input.limit ?? input.params?.[planning.limitParam],
    defaultLimit,
  );
  const contractMaxPages = Math.max(Number(planning.maxPages) || 1, 1);
  const requestedMaxPages = normalizeMaxPages(input.maxPages, 1);
  return Object.freeze({
    endpoint,
    limit: Math.min(requestedLimit, maxLimit),
    maxPages: Number.isFinite(requestedMaxPages)
      ? Math.min(requestedMaxPages, contractMaxPages)
      : contractMaxPages,
    lastIdParam: normalizeText(planning.lastIdParam) || "last_id",
    nextLastIdPath:
      normalizeText(planning.nextLastIdPath) || "result.last_id",
    itemsPath:
      normalizeText(endpoint?.responseShape?.itemsPath) || "result.items",
    stopOnEmpty: planning.stopOnEmpty !== false,
    stopOnShortPage: planning.stopOnShortPage === true,
    stopOnDuplicateLastId: planning.stopOnDuplicateLastId !== false,
    contractVersion:
      normalizeText(endpoint?.contractVersion) || "ozon-products-list-v3",
    mapperVersion:
      normalizeText(endpoint?.mapperVersion) || "product-list-mapper-v1",
  });
}

export function extractContractProductListPage(data, contract) {
  const contractItems = readContractPath(data, contract.itemsPath);
  const items = Array.isArray(contractItems) ? contractItems : extractItems(data);
  if (items.length > contract.limit) {
    throw new Error(
      `PRODUCT_LIST_CONTRACT_PAGE_LIMIT_EXCEEDED:${items.length}/${contract.limit}`,
    );
  }
  const contractLastId = readContractPath(data, contract.nextLastIdPath);
  const nextLastId = normalizeText(
    contractLastId === undefined ? extractLastId(data) : contractLastId,
  );
  const terminal = Boolean(
    !nextLastId ||
      (contract.stopOnEmpty && items.length === 0) ||
      (contract.stopOnShortPage && items.length < contract.limit),
  );
  return { items, nextLastId, terminal, isShortPage: items.length < contract.limit };
}

export function resolveEndpointBatchContract(endpointKey) {
  const endpoint = getOzonEndpoint(endpointKey);
  const planning = endpoint?.planning || {};
  if (planning.mode !== "ids") {
    throw new Error(`PRODUCT_HYDRATION_BATCH_CONTRACT_INVALID:${endpointKey}`);
  }
  const batchSize = Math.max(Number(planning.batchSize) || 0, 0);
  const maxBatches = Math.max(Number(planning.maxBatches) || 0, 0);
  if (!batchSize || !maxBatches || !normalizeText(planning.arrayParam)) {
    throw new Error(`PRODUCT_HYDRATION_BATCH_CONTRACT_INCOMPLETE:${endpointKey}`);
  }
  return Object.freeze({ endpointKey, batchSize, maxBatches });
}

export function resolveSharedHydrationBatchPlan(endpointKeys, requestedBatchSize) {
  const contracts = endpointKeys.map(resolveEndpointBatchContract);
  const contractBatchSize = Math.min(
    ...contracts.map((contract) => contract.batchSize),
  );
  const batchSize = normalizeHydrationBatchSize(
    requestedBatchSize,
    contractBatchSize,
    contractBatchSize,
  );
  return Object.freeze({ contracts, batchSize });
}

export function assertHydrationBatchCounts(chunks, plan) {
  for (const contract of plan.contracts) {
    if (chunks.length > contract.maxBatches) {
      throw new Error(
        `PRODUCT_HYDRATION_MAX_BATCHES_EXCEEDED:${contract.endpointKey}:${chunks.length}/${contract.maxBatches}`,
      );
    }
  }
}

export function shouldFinalizeProductReadCache(input = {}, visibility = "ALL") {
  if (input.skipFinalCacheRefresh === true || input.warmReadCache === false) {
    return false;
  }
  if (!(input.allStatuses || input.syncAllStatuses || input.fullRefresh)) {
    return true;
  }
  return visibility === "ALL" && input.warmReadCache === true;
}

export function chunkArray(values = [], chunkSize = 100, maxSize = 100) {
  const size = Math.min(
    Math.max(Number(chunkSize) || 100, 1),
    Math.max(Number(maxSize) || 100, 1),
  );
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function buildProductHydrationCacheKey({
  shopId,
  endpointKey,
  params,
} = {}) {
  const requestHash = createStableHash(
    {
      endpointKey: normalizeText(endpointKey),
      params: params && typeof params === "object" ? params : {},
    },
    { length: 32 },
  );
  return `products:hydrate:${normalizeText(shopId)}:${normalizeText(endpointKey)}:${requestHash}`;
}

export function extractItems(data) {
  if (Array.isArray(data?.result?.items)) return data.result.items;
  if (Array.isArray(data?.result?.products)) return data.result.products;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.products)) return data.products;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data)) return data;
  return [];
}

export function normalizeContractBoolean(value) {
  if (value === true || value === false) return value;
  const text = normalizeText(value).toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return null;
}

export function resolveCursorContinuation(data, endpoint = {}) {
  const planning = endpoint?.planning || {};
  const cursorPath = normalizeText(planning.nextCursorPath) || "result.cursor";
  const hasNextPath = normalizeText(planning.hasNextPath) || "result.has_next";
  const pathCursor = readContractPath(data, cursorPath);
  const pathHasNext = readContractPath(data, hasNextPath);
  const rawCursor =
    pathCursor !== undefined
      ? pathCursor
      : data?.cursor !== undefined
        ? data.cursor
        : data?.result?.cursor;
  const rawHasNext =
    pathHasNext !== undefined
      ? pathHasNext
      : data?.has_next !== undefined
        ? data.has_next
        : data?.result?.has_next;
  const cursor = normalizeText(rawCursor);
  const hasNext = normalizeContractBoolean(rawHasNext);
  const metadataPresent = rawCursor !== undefined || rawHasNext !== undefined;
  return {
    cursor,
    hasNext,
    metadataPresent,
    requiresContinuation: hasNext === true || Boolean(cursor),
    explicitComplete: metadataPresent && hasNext !== true && !cursor,
  };
}

export function extractLastId(data) {
  return normalizeText(
    data?.result?.last_id ??
      data?.last_id ??
      data?.cursor ??
      data?.result?.cursor,
  );
}
