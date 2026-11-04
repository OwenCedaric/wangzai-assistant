import { SYNC_JOB_STATUS } from "../../sync/syncJobService.js";
import { createStableHash } from "../../utils/stableHash.js";
import { getOzonEndpoint } from "../../ozon/ozonEndpointRegistry.js";
import {
  resolveProductAtomicActivationDatabase,
  runProductAtomicActivationProcess,
} from "./productAtomicActivationProcessRunner.js";
import { normalizeId, normalizeText, normalizeVisibility, nowIso, uniqueIds } from "./productSyncValues.js";
import {
  PRODUCT_HYDRATION_BATCH_SIZE,
  assertHydrationBatchCounts,
  chunkArray,
  extractContractProductListPage,
  extractItems,
  isAllPagesValue,
  limitIds,
  normalizeHydrationConcurrency,
  normalizeMaxHydrateProducts,
  progressTotalForMaxPages,
  requiredHydrationFacets,
  resolveCursorContinuation,
  resolveProductListContractPlan,
  resolveSharedHydrationBatchPlan,
  runWithConcurrency,
  shouldFinalizeProductReadCache,
} from "./productSyncPlanning.js";
export { buildProductHydrationCacheKey } from "./productSyncPlanning.js";
import { buildProductHydrationCacheKey } from "./productSyncPlanning.js";
import {
  readProductNotificationRows,
  recordProductNotificationEventsForSnapshot,
  shouldRecordProductNotifications,
} from "./productSyncNotifications.js";
export const PRODUCT_FULL_SYNC_VISIBILITIES = Object.freeze([
  "ALL",
  "IN_SALE",
  "TO_SUPPLY",
  "STATE_FAILED",
  "VALIDATION_STATE_FAIL",
  "REMOVED_FROM_SALE",
  "ARCHIVED",
]);

const PRODUCT_HYDRATION_MODES = new Set([
  "full",
  "core",
  "fast",
  "details",
  "pictures",
]);

function parseListInput(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  return normalizeText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAllShopToken(value) {
  return ["all", "*", "全部店铺", "all_shops"].includes(
    normalizeText(value).toLowerCase(),
  );
}

function shouldSyncAllStatuses(input = {}) {
  const token = normalizeText(
    input.visibility ?? input.status ?? input.params?.filter?.visibility,
  ).toUpperCase();
  return Boolean(
    input.allStatuses ||
    input.syncAllStatuses ||
    input.fullRefresh ||
    ["ALL_STATUSES", "FULL"].includes(token),
  );
}

const PRODUCT_UNIFIED_FULL_RUN_MODES = new Set([
  "bootstrap",
  "full",
  "reconcile",
]);

function isRequiredUnifiedFullRun(input = {}) {
  const mode = normalizeProductAtomicRunMode(input, true);
  return shouldSyncAllStatuses(input) || PRODUCT_UNIFIED_FULL_RUN_MODES.has(mode);
}

function resolveVisibilityPlan(input = {}) {
  if (isRequiredUnifiedFullRun(input)) {
    return [...PRODUCT_FULL_SYNC_VISIBILITIES];
  }
  const explicit = [
    ...parseListInput(input.visibilities),
    ...parseListInput(input.visibilityList),
    ...parseListInput(input.statuses),
  ].map(normalizeVisibility);
  if (explicit.length) return [...new Set(explicit)];
  if (shouldSyncAllStatuses(input)) return [...PRODUCT_FULL_SYNC_VISIBILITIES];
  return [
    normalizeVisibility(
      input.visibility ??
        input.status ??
        input.params?.filter?.visibility ??
        "ALL",
    ),
  ];
}

function buildProductRequestFingerprint(input = {}) {
  return createStableHash(
    {
      shopId: input.shopId,
      domain: "products",
      endpointKey: "products.list",
      action:
        input.hydrate === false
          ? "sync-products-list"
          : "sync-products-list-hydrate",
      visibility: input.visibility,
      visibilities: Array.isArray(input.visibilities)
        ? input.visibilities.map(normalizeVisibility)
        : [],
      pageSize: input.pageSize ?? input.limit ?? input.params?.limit,
      maxPages: input.maxPages,
      hydrate: input.hydrate !== false,
      hydrationMode: normalizeHydrationMode(
        input.hydrationMode ?? input.hydrationScope,
      ),
      hydrationBatchSize: input.hydrationBatchSize,
      forceRefresh: input.forceRefresh !== false,
    },
    { length: 32 },
  );
}

function normalizeHydrationMode(value) {
  const mode = normalizeText(value).toLowerCase();
  if (["detail", "details", "identity", "titles"].includes(mode)) {
    return "details";
  }
  if (["core", "list_core", "list-core"].includes(mode)) {
    return "core";
  }
  if (["fast", "quick", "price_stock", "price-stock"].includes(mode)) {
    return "fast";
  }
  if (["picture", "pictures", "image", "images"].includes(mode)) {
    return "pictures";
  }
  return PRODUCT_HYDRATION_MODES.has(mode) ? mode : "full";
}

function warehouseStockIncompleteError(reason = "unknown") {
  const error = new Error(
    `PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE:${normalizeText(reason) || "unknown"}`,
  );
  error.code = "PRODUCT_WAREHOUSE_STOCK_RESPONSE_INCOMPLETE";
  return error;
}

function getSchedulerData(result) {
  return result?.data ?? result?.cache?.payload ?? null;
}

function isSchedulerOk(result) {
  if (result?.status === "partial") return false;
  return Boolean(
    result?.ok ||
    result?.status === "cache_hit" ||
    result?.status === "success",
  );
}

function createProductsJobId() {
  return `products_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function publicJobPayload(job, extra = {}) {
  return {
    ok: true,
    accepted: true,
    domain: "products",
    jobId: job?.jobId || job?.id,
    job,
    status: job?.status || "queued",
    ...extra,
  };
}

function collectProductIdentifiers(rows = [], identityContract = null) {
  const primaryField = normalizeText(identityContract?.primaryField);
  const alternateField = normalizeText(identityContract?.alternateField);
  const productIds = [];
  const offerIds = [];
  rows.forEach((row) => {
    const productId = normalizeId(
      (primaryField ? row?.[primaryField] : undefined) ??
        row?.product_id ??
        row?.productId ??
        row?.id,
    );
    const offerId = normalizeId(
      (alternateField ? row?.[alternateField] : undefined) ??
        row?.offer_id ??
        row?.offerId,
    );
    if (productId) productIds.push(productId);
    if (offerId) offerIds.push(offerId);
  });
  return { productIds: uniqueIds(productIds), offerIds: uniqueIds(offerIds) };
}

function hydrationCoverageError(label, missingProductIds = []) {
  const preview = missingProductIds.slice(0, 10).join(", ");
  const more = missingProductIds.length > 10 ? ` 等 ${missingProductIds.length} 条` : "";
  return `${label}返回不完整，缺少商品 ID：${preview}${more}`;
}

function schedulerErrorMessage(result, fallback = "Ozon 商品接口调用失败") {
  const first = result?.errors?.[0];
  return (
    first?.message ||
    result?.job?.lastError ||
    result?.error?.message ||
    fallback
  );
}

export function activateStagedProductSync(
  {
    db,
    repository,
    jobService,
    snapshotService,
    stateService,
    atomicRunRepository,
  } = {},
  input = {},
) {
  const atomicRunId = normalizeText(input.atomicRunId);
  const snapshotId = normalizeText(input.snapshotId);
  const shopId = normalizeText(input.shopId);
  const jobId = normalizeText(input.jobId);
  const visibility = normalizeVisibility(input.visibility || "FULL");
  const runVisibilities = uniqueIds(input.runVisibilities).map(normalizeVisibility);
  const completedVisibilities = new Set(
    uniqueIds(input.completedVisibilities).map(normalizeVisibility),
  );
  let finalJob = null;

  const activation = atomicRunRepository.activateRun(atomicRunId, {
    snapshotId,
    apply({ run, batches }) {
      let changedCount = 0;
      let unchangedCount = 0;
      const activatedProductKeysByVisibility = new Map();
      const sortOffsetByVisibility = new Map();

      for (const batch of batches.filter((item) => item.stageKind === "list")) {
        const batchVisibility = normalizeVisibility(
          batch.visibility || runVisibilities[0],
        );
        const sortOffset = sortOffsetByVisibility.get(batchVisibility) || 0;
        const merge = repository.upsertProducts({
          shopId,
          rows: batch.rows,
          visibility: batchVisibility,
          endpointKey: batch.endpointKey,
          sortOffset,
        });
        sortOffsetByVisibility.set(
          batchVisibility,
          sortOffset + batch.rows.length,
        );
        changedCount += merge.changed || 0;
        unchangedCount += merge.unchanged || 0;
        if (!activatedProductKeysByVisibility.has(batchVisibility)) {
          activatedProductKeysByVisibility.set(batchVisibility, []);
        }
        activatedProductKeysByVisibility
          .get(batchVisibility)
          .push(...(merge.productKeys || []));
      }

      for (const targetVisibility of runVisibilities) {
        if (
          !completedVisibilities.has(targetVisibility) ||
          !input.allowVisibilityReconcile ||
          targetVisibility === "ALL"
        ) {
          continue;
        }
        const reconcile = repository.reconcileVisibilitySnapshot({
          shopId,
          visibility: targetVisibility,
          seenProductKeys: uniqueIds(
            activatedProductKeysByVisibility.get(targetVisibility) || [],
          ),
        });
        changedCount += (reconcile.updated || 0) + (reconcile.stale || 0);
      }

      for (const batch of batches.filter((item) => item.stageKind === "facet")) {
        const merge = applyStagedProductFacet(repository, batch.facet, {
          shopId,
          rows: batch.rows,
          expectedProductIds: batch.expectedProductIds,
          expectedOfferIds: batch.expectedOfferIds,
          provenance: {
            operationId: batch.batchKey,
            contractVersion: batch.contractVersion,
            mapperVersion: batch.mapperVersion,
            responseHash: batch.responseHash,
            runId: atomicRunId,
            snapshotId,
            observedAt: batch.observedAt,
          },
        });
        changedCount += merge.changed || 0;
        unchangedCount += merge.unchanged || 0;
      }

      const notificationCount = recordProductNotificationEventsForSnapshot({
        repository,
        snapshotService,
        beforeRows: input.notificationBeforeRows,
        snapshotId,
        sourceJobId: jobId,
        shopId,
        shopName: normalizeText(input.shopName),
      });
      const cacheRowCount = repository.listProducts({
        shopId,
        visibility: "ALL",
        pageSize: 1,
      }).total;
      const hasSourceGaps = run.sourceGapCount > 0;
      const sourceGapSummary = summarizeStagedProductSourceGaps(batches);
      const jobStatus = hasSourceGaps
        ? SYNC_JOB_STATUS.partial
        : SYNC_JOB_STATUS.success;
      snapshotService?.finishSnapshot?.(snapshotId, {
        status: hasSourceGaps ? "completed_with_source_gaps" : jobStatus,
        active: true,
        rowCount: cacheRowCount,
        changedCount,
        unchangedCount,
        failedCount: 0,
      });
      finalJob = jobService.updateJob(jobId, {
        status: jobStatus,
        changedCount,
        unchangedCount,
        failedCount: 0,
        finishedAt: nowIso(),
        lastError: hasSourceGaps
          ? `Ozon 有 ${run.sourceGapCount} 条已证明未返回分面${
              sourceGapSummary ? `：${sourceGapSummary}` : ""
            }，保留已有强事实。`
          : null,
        snapshotId,
        message:
          notificationCount > 0
            ? `商品原子同步完成，已记录 ${notificationCount} 条后台变化提醒。`
            : "商品原子同步已完成并激活本地快照。",
      });
      stateService.upsertState({
        domain: "products",
        shopId,
        scopeKey: `products:list:${visibility}`,
        status: jobStatus,
        lastSuccessAt: nowIso(),
        lastAttemptAt: nowIso(),
        lastError: hasSourceGaps
          ? "PRODUCT_SYNC_COMPLETED_WITH_SOURCE_GAPS"
          : null,
        changedCount,
        unchangedCount,
        remoteCursor: run.committedCursor,
      });
      writeCurrentShopDomainSyncState(db, {
        shopId,
        domain: "products",
        status: hasSourceGaps ? "completed_with_source_gaps" : "completed",
        activeSnapshotId: snapshotId,
        committedCursor: run.committedCursor,
        proofHash: run.proofHash,
      });
      return { changedCount, unchangedCount, notificationCount, cacheRowCount };
    },
  });

  return {
    activation,
    finalJob: finalJob || jobService.getJob(jobId) || activation.run,
    ...(activation.result || {}),
  };
}


export function createProductSyncService({
  db,
  ozonScheduler,
  shopRepository,
  repository,
  jobService,
  snapshotService,
  stateService,
  atomicRunRepository, shopProductStorage,
  backgroundRunner = (task) => setImmediate(task),
  clearProductReadCache = () => {},
  warmProductReadCache = () => {},
} = {}) {
  function getShopName(shopId) {
    return (
      normalizeText(shopRepository?.getShopById?.(shopId)?.name) ||
      normalizeText(shopRepository?.getPublicShopById?.(shopId)?.name) ||
      ""
    );
  }

  function recordProductNotificationEvents({
    beforeRows,
    snapshotId,
    sourceJobId,
    shopId,
  }) {
    return recordProductNotificationEventsForSnapshot({
      repository,
      snapshotService,
      beforeRows,
      snapshotId,
      sourceJobId,
      shopId,
      shopName: getShopName(shopId),
    });
  }

  async function executeHydrationBatch({
    job,
    shopId,
    endpointKey,
    params,
    cacheKey,
    idempotencyKey,
    requestedBy,
    priority = "P2",
    profile,
    source,
    syncMode,
    recoveryRestoreId,
    recoveryGenerationId,
    recoveryOverlapMinutes,
    snapshotId,
  }) {
    const expectedAt = nowIso();
    const endpoint = getOzonEndpoint(endpointKey);
    const paginateWarehouseStocks = endpointKey === "products.stocksByWarehouseFbs";
    const maxPages = paginateWarehouseStocks
      ? Math.max(Number(endpoint?.planning?.maxPages) || 0, 1)
      : 1;
    const cursorParam = normalizeText(endpoint?.planning?.cursorParam) || "cursor";
    const rows = [];
    const remoteHashes = [];
    const seenCursors = new Set();
    let scheduled = null;
    let firstScheduled = null;
    let currentParams = { ...(params || {}) };
    let pagination = {
      pages: 0,
      metadataPresent: false,
      explicitComplete: false,
      followedContinuation: false,
    };

    for (let page = 1; page <= maxPages; page += 1) {
      const pageScheduled = await ozonScheduler.executeReadOnly({
        shopId,
        domain: "products",
        endpointKey,
        action: "hydrate-products",
        priority,
        profile,
        source,
        syncMode,
        recoveryRestoreId,
        recoveryGenerationId,
        recoveryOverlapMinutes,
        snapshotId,
        params: currentParams,
        cacheKey:
          page === 1
            ? cacheKey
            : `${cacheKey}:page:${page}:${createStableHash(
                { cursor: currentParams[cursorParam] },
                { length: 12 },
              )}`,
        idempotencyKey: page === 1 ? idempotencyKey : `${idempotencyKey}:page:${page}`,
        requestedBy,
        forceRefresh: true,
        allowStale: true,
        waitForResult: true,
      });
      if (!isSchedulerOk(pageScheduled)) {
        throw new Error(
          schedulerErrorMessage(pageScheduled, `${endpointKey} 补水失败`),
        );
      }
      if (!firstScheduled) firstScheduled = pageScheduled;
      scheduled = pageScheduled;
      const data = getSchedulerData(pageScheduled);
      rows.push(...extractItems(data));
      const pageRemoteHash = normalizeText(pageScheduled?.results?.[0]?.remoteHash);
      if (pageRemoteHash) remoteHashes.push(pageRemoteHash);
      pagination.pages = page;

      if (!paginateWarehouseStocks) break;
      const continuation = resolveCursorContinuation(data, endpoint);
      pagination.metadataPresent =
        pagination.metadataPresent || continuation.metadataPresent;
      pagination.explicitComplete = continuation.explicitComplete;
      if (!continuation.requiresContinuation) {
        if (pagination.followedContinuation && !continuation.explicitComplete) {
          throw warehouseStockIncompleteError("continuation_terminal_metadata_missing");
        }
        break;
      }
      if (!continuation.cursor) {
        throw warehouseStockIncompleteError("continuation_cursor_missing");
      }
      if (seenCursors.has(continuation.cursor)) {
        throw warehouseStockIncompleteError("duplicate_cursor");
      }
      if (page >= maxPages) {
        throw warehouseStockIncompleteError("max_pages_exceeded");
      }
      seenCursors.add(continuation.cursor);
      pagination.followedContinuation = true;
      currentParams = {
        ...(params || {}),
        [cursorParam]: continuation.cursor,
      };
    }

    const responseHash =
      (remoteHashes.length === 1 ? remoteHashes[0] : "") ||
      createStableHash({ endpointKey, rows });
    return {
      scheduled: firstScheduled || scheduled,
      rows,
      pagination,
      provenance: {
        operationId: normalizeText(firstScheduled?.jobId ?? scheduled?.jobId) || null,
        contractVersion:
          normalizeText(endpoint?.contractVersion) ||
          `${endpointKey}:${normalizeText(endpoint?.path) || "unknown"}`,
        mapperVersion:
          normalizeText(endpoint?.mapperVersion) ||
          `product-hydration-mapper:${endpointKey}:v1`,
        responseHash,
        runId: normalizeText(job?.jobId) || null,
        snapshotId: normalizeText(snapshotId) || null,
        expectedAt,
        observedAt: nowIso(),
      },
    };
  }

  function resolveOfferIdsWithoutFixedCap({
    shopId,
    productIds = [],
    offerIds = [],
    maxHydrateProducts = Number.POSITIVE_INFINITY,
  } = {}) {
    const existingOfferIds = limitIds(offerIds, maxHydrateProducts);
    const limitedProductIds = limitIds(productIds, maxHydrateProducts);
    if (
      existingOfferIds.length >= limitedProductIds.length &&
      limitedProductIds.length > 0
    ) {
      return existingOfferIds;
    }
    const productChunks = chunkArray(limitedProductIds, 900);
    const resolved = [...existingOfferIds];
    for (const chunk of productChunks) {
      const remainingLimit = Number.isFinite(maxHydrateProducts)
        ? Math.max(maxHydrateProducts - resolved.length, 0)
        : chunk.length + existingOfferIds.length;
      if (remainingLimit === 0) break;
      resolved.push(
        ...repository.resolveOfferIdsForProducts({
          shopId,
          productIds: chunk,
          offerIds: existingOfferIds,
          limit: remainingLimit,
        }),
      );
    }
    return limitIds(resolved, maxHydrateProducts);
  }

  async function hydrateProducts({
    job,
    shopId,
    productIds = [],
    offerIds = [],
    requestedBy,
    maxHydrateProducts = Number.POSITIVE_INFINITY,
    priority = "P2",
    profile,
    source,
    syncMode,
    recoveryRestoreId,
    recoveryGenerationId,
    recoveryOverlapMinutes,
    snapshotId,
    atomicRunId,
    hydrationConcurrency,
    hydrationMode,
    hydrationBatchSize,
  } = {}) {
    const maxHydrateCount = normalizeMaxHydrateProducts(maxHydrateProducts);
    const concurrency = normalizeHydrationConcurrency(hydrationConcurrency);
    const mode = normalizeHydrationMode(hydrationMode);
    const isCoreMode = mode === "core";
    const isFastMode = mode === "fast";
    const isDetailsMode = mode === "details";
    const isPicturesMode = mode === "pictures";
    const productEndpointKeys = [
      ...(!isFastMode && !isPicturesMode ? ["products.infoList"] : []),
      ...((isPicturesMode ||
      (!isCoreMode && !isFastMode && !isDetailsMode))
        ? ["products.pictures"]
        : []),
      ...(!isDetailsMode && !isPicturesMode
        ? ["products.prices", "products.stocks"]
        : []),
    ];
    const productBatchPlan = resolveSharedHydrationBatchPlan(
      productEndpointKeys,
      hydrationBatchSize,
    );
    const productBatchSize = productBatchPlan.batchSize;
    const limitedProductIds = limitIds(productIds, maxHydrateCount);
    const resolvedOfferIds =
      isCoreMode || isFastMode || isDetailsMode || isPicturesMode
        ? []
        : resolveOfferIdsWithoutFixedCap({
            shopId,
            productIds: limitedProductIds,
            offerIds,
            maxHydrateProducts: maxHydrateCount,
          });
    const productChunks = chunkArray(
      limitedProductIds,
      productBatchSize,
      productBatchSize,
    );
    assertHydrationBatchCounts(productChunks, productBatchPlan);
    const offerBatchPlan = resolveSharedHydrationBatchPlan(
      ["products.stocksByWarehouseFbs", "products.attributes"],
      PRODUCT_HYDRATION_BATCH_SIZE,
    );
    const offerChunks = chunkArray(
      resolvedOfferIds,
      offerBatchPlan.batchSize,
      offerBatchPlan.batchSize,
    );
    assertHydrationBatchCounts(offerChunks, offerBatchPlan);
    const totalHydrationBatches =
      productChunks.length * productEndpointKeys.length +
      offerChunks.length * 2;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let done = job.progress?.done || 0;
    const errors = [];
    const facetCoverage = {};

    jobService.updateJob(job.jobId, {
      progressTotal: (job.progress?.total || 0) + totalHydrationBatches,
    });

    const tasks = [];
    const addProductHydrator = ({
      endpointKey,
      facet,
      paramBuilder,
      merge,
      label,
      requiresExactProductCoverage = false,
    }) => {
      for (let index = 0; index < productChunks.length; index += 1) {
        const chunk = productChunks[index];
        const params = paramBuilder(chunk);
        tasks.push({
          endpointKey,
          label,
          params,
          cacheKey: buildProductHydrationCacheKey({
            shopId,
            endpointKey,
            params,
          }),
          idempotencyKey: `${job.jobId}:${endpointKey}:product:${index + 1}`,
          facet,
          expectedProductIds: [...chunk],
          expectedOfferIds: [],
          requiresExactProductCoverage,
          merge,
        });
      }
    };

    if (!isFastMode && !isPicturesMode) {
      addProductHydrator({
        endpointKey: "products.infoList",
        facet: "detail",
        label: "详情",
        paramBuilder: (chunk) => ({ product_id: chunk }),
        merge: (input) => repository.mergeProductInfoRows(input),
        requiresExactProductCoverage: true,
      });
    }
    if (isPicturesMode || (!isCoreMode && !isFastMode && !isDetailsMode)) {
      addProductHydrator({
        endpointKey: "products.pictures",
        facet: "pictures",
        label: "图片",
        paramBuilder: (chunk) => ({ product_id: chunk }),
        merge: (input) => repository.mergeProductPictureRows(input),
      });
    }
    if (!isDetailsMode && !isPicturesMode) {
      addProductHydrator({
        endpointKey: "products.prices",
        facet: "prices",
        label: "价格",
        paramBuilder: (chunk) => ({ filter: { product_id: chunk }, limit: 1000 }),
        merge: (input) => repository.mergeProductPriceRows(input),
      });
      addProductHydrator({
        endpointKey: "products.stocks",
        facet: "stocks",
        label: "库存",
        paramBuilder: (chunk) => ({ filter: { product_id: chunk }, limit: 1000 }),
        merge: (input) => repository.mergeProductStockRows(input),
      });
    }

    for (let index = 0; index < offerChunks.length; index += 1) {
      const chunk = offerChunks[index];
      const endpointKey = "products.stocksByWarehouseFbs";
      const params = { offer_id: chunk, limit: 1000 };
      tasks.push({
        endpointKey,
        label: "仓库库存",
        params,
        cacheKey: buildProductHydrationCacheKey({
          shopId,
          endpointKey,
          params,
        }),
        idempotencyKey: `${job.jobId}:products.stocksByWarehouseFbs:offer:${index + 1}`,
        facet: "warehouse_stocks",
        expectedProductIds: [],
        expectedOfferIds: [...chunk],
        requiresExactProductCoverage: false,
        recordsFacetObservation: false,
        merge: (input) => repository.mergeProductWarehouseStockRows(input),
      });
    }

    for (let index = 0; index < offerChunks.length; index += 1) {
      const chunk = offerChunks[index];
      const endpointKey = "products.attributes";
      const params = { filter: { offer_id: chunk }, limit: 1000 };
      tasks.push({
        endpointKey,
        label: "属性",
        params,
        cacheKey: buildProductHydrationCacheKey({
          shopId,
          endpointKey,
          params,
        }),
        idempotencyKey: `${job.jobId}:products.attributes:offer:${index + 1}`,
        facet: "attributes",
        expectedProductIds: [],
        expectedOfferIds: [...chunk],
        requiresExactProductCoverage: false,
        merge: (input) => repository.mergeProductAttributeRows(input),
      });
    }

    tasks.forEach((task, index) => {
      task.atomicBatchIndex = index + 1;
    });

    await runWithConcurrency(tasks, concurrency, async (task) => {
      let facetObservationRecorded = false;
      let batchProvenance = null;
      try {
        const result = await executeHydrationBatch({
          job,
          shopId,
          endpointKey: task.endpointKey,
          params: task.params,
          cacheKey: task.cacheKey,
          idempotencyKey: task.idempotencyKey,
          requestedBy,
          priority,
          profile,
          source,
          syncMode,
          recoveryRestoreId,
          recoveryGenerationId,
          recoveryOverlapMinutes,
          snapshotId,
        });
        batchProvenance = result.provenance;
        const responseLimit = Number(task.params?.limit || 0);
        const warehouseResponseLimit =
          task.endpointKey === "products.stocksByWarehouseFbs" &&
          result.pagination?.explicitComplete
            ? null
            : responseLimit;
        if (
          task.endpointKey === "products.stocksByWarehouseFbs" &&
          !result.pagination?.explicitComplete
        ) {
          throw warehouseStockIncompleteError("completion_metadata_missing");
        }
        if (
          task.endpointKey === "products.stocksByWarehouseFbs" &&
          warehouseResponseLimit > 0 &&
          result.rows.length >= warehouseResponseLimit
        ) {
          throw warehouseStockIncompleteError("page_limit_without_completion_metadata");
        }
        const actualIdentifiers = collectProductIdentifiers(result.rows);
        if (
          task.endpointKey === "products.stocksByWarehouseFbs" &&
          task.expectedOfferIds.length > 0 &&
          actualIdentifiers.productIds.length > 0
        ) {
          actualIdentifiers.offerIds = uniqueIds([
            ...actualIdentifiers.offerIds,
            ...repository.resolveOfferIdsForProducts({
              shopId,
              productIds: actualIdentifiers.productIds,
              offerIds: [],
              limit: Math.max(
                task.expectedOfferIds.length,
                actualIdentifiers.productIds.length,
              ),
            }),
          ]);
        }
        const expectedIds = uniqueIds([
          ...task.expectedProductIds,
          ...task.expectedOfferIds,
        ]);
        const actualIds = new Set(uniqueIds([
          ...actualIdentifiers.productIds,
          ...actualIdentifiers.offerIds,
        ]));
        const returnedCount = expectedIds.filter((id) => actualIds.has(id)).length;
        const missingCount = Math.max(expectedIds.length - returnedCount, 0);
        const currentCoverage = facetCoverage[task.facet] || {
          expected: 0,
          returned: 0,
          returnedEmpty: 0,
          notApplicable: 0,
          unavailable: 0,
          notReturned: 0,
          failed: 0,
        };
        currentCoverage.expected += expectedIds.length;
        currentCoverage.returned += returnedCount;
        currentCoverage.notReturned += missingCount;
        facetCoverage[task.facet] = currentCoverage;
        const mergeResult = atomicRunId
          ? (() => {
              atomicRunRepository.stageBatch({
                runId: atomicRunId,
                stageKind: "facet",
                endpointKey: task.endpointKey,
                facet: task.facet,
                batchIndex: task.atomicBatchIndex,
                expectedProductIds: task.expectedProductIds,
                expectedOfferIds: task.expectedOfferIds,
                actualProductIds: actualIdentifiers.productIds,
                actualOfferIds: actualIdentifiers.offerIds,
                rows: result.rows,
                responseHash: result.provenance.responseHash,
                contractVersion: result.provenance.contractVersion,
                mapperVersion: result.provenance.mapperVersion,
                status: result.rows.length ? "returned" : "returned_empty",
                sourceReason: result.rows.length
                  ? "ozon-facet-batch-returned"
                  : "ozon-facet-batch-explicit-empty",
                observedAt: result.provenance.observedAt,
              });
              return {
                changed: 0,
                unchanged: result.rows.length,
                missingProductIds: task.expectedProductIds.filter(
                  (id) => !new Set(actualIdentifiers.productIds).has(id),
                ),
              };
            })()
          : task.merge({
              shopId,
              rows: result.rows,
              expectedProductIds: task.expectedProductIds,
              expectedOfferIds: task.expectedOfferIds,
              responseLimit:
                task.endpointKey === "products.stocksByWarehouseFbs"
                  ? warehouseResponseLimit
                  : responseLimit,
              provenance: result.provenance,
            });
        facetObservationRecorded = true;
        changedCount += mergeResult.changed || 0;
        unchangedCount += mergeResult.unchanged || 0;
        const missingProductIds = task.requiresExactProductCoverage
          ? mergeResult.missingProductIds || []
          : [];
        if (!atomicRunId && missingProductIds.length > 0) {
          throw new Error(
            hydrationCoverageError(task.label, missingProductIds),
          );
        }
      } catch (error) {
        if (
          !facetObservationRecorded &&
          !atomicRunId &&
          task.recordsFacetObservation !== false
        ) {
          try {
            repository.recordProductHydrationFacetObservations({
              shopId,
              facet: task.facet,
              productIds: task.expectedProductIds,
              offerIds: task.expectedOfferIds,
              status: "failed",
              endpointKey: task.endpointKey,
              sourceReason:
                error instanceof Error
                  ? error.message
                  : "product-hydration-request-failed",
              provenance: {
                runId: normalizeText(job?.jobId) || null,
                snapshotId: normalizeText(snapshotId) || null,
                expectedAt: nowIso(),
              },
            });
          } catch (observationError) {
            errors.push(
              `${task.label}分面记录失败：${
                observationError instanceof Error
                  ? observationError.message
                  : String(observationError)
              }`,
            );
          }
        }
        if (
          !facetObservationRecorded &&
          task.recordsFacetObservation === false
        ) {
          try {
            const errorCode = normalizeText(error?.code ?? error?.message);
            const contractInvalid =
              errorCode.includes("CONTRACT_INVALID") ||
              errorCode.includes("RESPONSE_INCOMPLETE");
            repository.recordProductWarehouseStockObservations({
              shopId,
              productIds: task.expectedProductIds,
              offerIds: task.expectedOfferIds,
              status: contractInvalid ? "contract_invalid" : "failed",
              sourceReason:
                error instanceof Error
                  ? error.message
                  : "product-warehouse-stock-request-failed",
              provenance: {
                ...(batchProvenance || {}),
                runId:
                  normalizeText(batchProvenance?.runId ?? job?.jobId) || null,
                snapshotId:
                  normalizeText(
                    batchProvenance?.snapshotId ?? snapshotId,
                  ) || null,
                expectedAt: nowIso(),
              },
            });
          } catch (observationError) {
            errors.push(
              `${task.label}分面记录失败：${
                observationError instanceof Error
                  ? observationError.message
                  : String(observationError)
              }`,
            );
          }
        }
        failedCount += 1;
        errors.push(
          `${task.label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        done += 1;
        jobService.updateJob(job.jobId, {
          progressDone: done,
          changedCount,
          unchangedCount,
          failedCount,
        });
      }
    });

    const coverage = atomicRunId
      ? {
          requiredFacets: requiredHydrationFacets(mode),
          total: limitedProductIds.length,
          complete: limitedProductIds.length,
          incomplete: 0,
          staged: true,
          facetCoverage,
        }
      : repository.getProductHydrationCoverage({
          shopId,
          productIds: limitedProductIds,
          offerIds: resolvedOfferIds,
          requiredFacets: requiredHydrationFacets(mode),
        });
    if (!atomicRunId && coverage.incomplete > 0 && failedCount === 0) {
      failedCount += 1;
      const missingSummary = Object.entries(coverage.missingByFacet)
        .filter(([, count]) => count > 0)
        .map(([facet, count]) => `${facet}=${count}`)
        .join(", ");
      errors.push(
        `补水覆盖不完整：${coverage.incomplete}/${coverage.total} 条未完成${
          missingSummary ? `（${missingSummary}）` : ""
        }`,
      );
    }

    return {
      changedCount,
      unchangedCount,
      failedCount,
      errors,
      productCount: limitedProductIds.length,
      offerCount: resolvedOfferIds.length,
      hydrationMode: mode,
      hydrationBatchSize: productBatchSize,
      coverage,
      facetCoverage,
    };
  }

  async function runProductsSyncJob(job, input = {}) {
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const requestedVisibility = normalizeVisibility(
      input.visibility ??
        input.status ??
        input.params?.filter?.visibility ??
        "ALL",
    );
    const runVisibilities = Array.isArray(input.visibilities) && input.visibilities.length
      ? [...new Set(input.visibilities.map(normalizeVisibility))]
      : [requestedVisibility];
    const unifiedFullRun = runVisibilities.length > 1;
    const visibility = unifiedFullRun ? "FULL" : runVisibilities[0];
    const listContract = resolveProductListContractPlan(input);
    const limit = listContract.limit;
    const maxPages = listContract.maxPages;
    const hydrate = unifiedFullRun ? true : input.hydrate !== false;
    const maxHydrateProducts = normalizeMaxHydrateProducts(
      input.maxHydrateProducts,
    );
    const requestedBy =
      normalizeText(input.requestedBy ?? input.requested_by) ||
      "products-domain-service";
    const syncSource =
      normalizeText(input.source ?? input.syncSource) || requestedBy;
    const syncMode = normalizeText(input.syncMode ?? input.sync_mode) || null;
    const recoveryRestoreId = normalizeText(
      input.recoveryRestoreId ?? input.recovery_restore_id,
    ) || null;
    const recoveryGenerationId = normalizeText(
      input.recoveryGenerationId ?? input.recovery_generation_id,
    ) || null;
    const recoveryOverlapMinutes = Number.isFinite(
      Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes),
    )
      ? Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes)
      : null;
    const forceRefresh = input.forceRefresh !== false;
    const initialLastId = normalizeText(
      input.lastId ?? input.last_id ?? input.params?.last_id,
    );
    if (unifiedFullRun && initialLastId) {
      throw new Error("PRODUCT_FULL_SYNC_MUST_START_FROM_EMPTY_CURSOR");
    }
    const notificationBeforeRows = shouldRecordProductNotifications(input)
      ? readProductNotificationRows(repository, shopId)
      : [];
    const atomicEnabled = Boolean(atomicRunRepository && input.atomic !== false);
    if (unifiedFullRun && !atomicEnabled) {
      throw new Error("PRODUCT_FULL_SYNC_ATOMIC_RUN_REQUIRED");
    }
    const snapshot = snapshotService?.createSnapshot?.({
      domain: "products",
      shopId,
      source: syncSource,
      status: "running",
      sourceJobId: job.jobId,
    });
    const snapshotId = snapshot?.id || null;
    let atomicRunId = null;
    if (atomicEnabled) {
      const listEndpoint = getOzonEndpoint("products.list");
      const atomicRun = atomicRunRepository.createRun({
        runId: `product_run_${job.jobId}`,
        shopId,
        mode: normalizeProductAtomicRunMode(input, hydrate),
        visibility,
        visibilities: runVisibilities,
        requestFingerprint:
          normalizeText(job.requestFingerprint) ||
          buildProductRequestFingerprint({ ...input, shopId, visibility, hydrate }),
        contractHash: createStableHash({
          endpointKey: listEndpoint.key,
          path: listEndpoint.path,
          contractVersion: listEndpoint.contractVersion,
          pagination: listEndpoint.pagination,
          visibilities: runVisibilities,
        }),
        mapperVersion:
          normalizeText(listEndpoint.mapperVersion) || "product-list-mapper-v1",
        baseSnapshotId: readActiveProductSnapshotId(db, shopId),
        startCursor: unifiedFullRun ? null : initialLastId,
      });
      if (atomicRun.reused && atomicRun.run.status !== "queued" && atomicRun.run.status !== "interrupted") {
        throw new Error("PRODUCT_SYNC_RUN_ALREADY_ACTIVE");
      }
      atomicRunId = atomicRun.run.runId;
      atomicRunRepository.startFetching(atomicRunId, {
        leaseOwner: `products-service:${job.jobId}`,
        leaseExpiresAt: futureIso(30 * 60 * 1000),
      });
    }
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let totalRows = 0;
    const collectedProductIds = [];
    const collectedOfferIds = [];
    const collectedProductKeys = [];
    const collectedProductKeysByVisibility = new Map();
    const collectedIdentityKeys = [];
    const errors = [];
    const completedVisibilities = new Set();
    let completedListPageCount = 0;

    clearProductReadCache(shopId);
    jobService.updateJob(job.jobId, {
      status: SYNC_JOB_STATUS.running,
      startedAt: nowIso(),
      progressTotal: progressTotalForMaxPages(maxPages) * runVisibilities.length,
      snapshotId,
    });
    stateService.upsertState({
      domain: "products",
      shopId,
      scopeKey: `products:list:${visibility}`,
      status: "running",
      lastAttemptAt: nowIso(),
    });

    try {
      for (const targetVisibility of runVisibilities) {
        let lastId = unifiedFullRun ? "" : initialLastId;
        const seenLastIds = new Set(lastId ? [lastId] : []);
        const visibilityProductKeys = [];
        const failuresBeforeVisibility = failedCount;
        for (let page = 1; page <= maxPages; page += 1) {
          const params = {
            filter: { visibility: targetVisibility },
            [listContract.lastIdParam]: lastId,
            [listContract.endpoint.planning.limitParam]: limit,
          };
          const scheduled = await ozonScheduler.executeReadOnly({
            shopId,
            domain: "products",
            endpointKey: "products.list",
            action: "sync-products-list",
            priority: input.priority || (page === 1 ? "P1" : "P2"),
            profile: input.profile ?? input.schedulerProfile,
            source: syncSource,
            syncMode,
            recoveryRestoreId,
            recoveryGenerationId,
            recoveryOverlapMinutes,
            snapshotId,
            params,
            cacheKey: `products:list:${shopId}:${targetVisibility}:page:${page}:limit:${limit}`,
            idempotencyKey: `${job.jobId}:products.list:${targetVisibility}:page:${page}`,
            requestedBy,
            forceRefresh,
            allowStale: true,
          });

          if (!isSchedulerOk(scheduled)) {
            failedCount += 1;
            errors.push(
              `${targetVisibility} 列表第 ${page} 页：${schedulerErrorMessage(scheduled)}`,
            );
            break;
          }

          const data = getSchedulerData(scheduled);
          const listPage = extractContractProductListPage(data, listContract);
          const { items, nextLastId, terminal: terminalPage } = listPage;
          const identifiers = collectProductIdentifiers(
            items,
            listContract.endpoint.entityIdentity,
          );
          const listResponseHash =
            normalizeText(scheduled?.results?.[0]?.remoteHash) ||
            createStableHash({
              endpointKey: "products.list",
              visibility: targetVisibility,
              items,
              nextLastId,
            });
          const merge = atomicRunId
            ? (() => {
                atomicRunRepository.stageBatch({
                  runId: atomicRunId,
                  stageKind: "list",
                  endpointKey: "products.list",
                  facet: "identity",
                  visibility: targetVisibility,
                  batchIndex: page,
                  requestCursor: lastId,
                  nextCursor: nextLastId,
                  rows: items,
                  actualProductIds: identifiers.productIds,
                  actualOfferIds: identifiers.offerIds,
                  responseHash: listResponseHash,
                  contractVersion: listContract.contractVersion,
                  mapperVersion: listContract.mapperVersion,
                  status: items.length ? "returned" : "returned_empty",
                  sourceReason: items.length
                    ? "ozon-list-page-returned"
                    : "ozon-list-terminal-empty-page",
                });
                atomicRunRepository.recordPageProof({
                  runId: atomicRunId,
                  visibility: targetVisibility,
                  pageIndex: page,
                  requestCursor: lastId,
                  nextCursor: nextLastId,
                  rowCount: items.length,
                  pageLimit: limit,
                  isShortPage: listPage.isShortPage,
                  isTerminal: terminalPage,
                  responseHash: listResponseHash,
                  contractVersion: listContract.contractVersion,
                  mapperVersion: listContract.mapperVersion,
                });
                atomicRunRepository.heartbeat(atomicRunId, {
                  leaseOwner: `products-service:${job.jobId}`,
                  leaseExpiresAt: futureIso(30 * 60 * 1000),
                });
                return {
                  changed: 0,
                  unchanged: items.length,
                  productKeys: collectProductStageKeys(
                    items,
                    listContract.endpoint.entityIdentity,
                  ),
                };
              })()
            : repository.upsertProducts({
                shopId,
                rows: items,
                visibility: targetVisibility,
                endpointKey: "products.list",
                sortOffset: (page - 1) * limit,
              });
          changedCount += merge.changed;
          unchangedCount += merge.unchanged;
          totalRows += items.length;
          collectedProductIds.push(...identifiers.productIds);
          collectedOfferIds.push(...identifiers.offerIds);
          collectedProductKeys.push(...(merge.productKeys || []));
          collectedIdentityKeys.push(
            ...collectProductStageKeys(
              items,
              listContract.endpoint.entityIdentity,
            ),
          );
          visibilityProductKeys.push(...(merge.productKeys || []));
          completedListPageCount += 1;
          jobService.updateJob(job.jobId, {
            progressDone: completedListPageCount,
            progressTotal: maxPages * runVisibilities.length,
            changedCount,
            unchangedCount,
            failedCount,
          });

          lastId = nextLastId;
          if (terminalPage) {
            completedVisibilities.add(targetVisibility);
            break;
          }
          if (
            listContract.stopOnDuplicateLastId &&
            seenLastIds.has(lastId)
          ) {
            failedCount += 1;
            errors.push(
              `${targetVisibility} 列表第 ${page} 页后返回重复 last_id，已停止继续分页以避免重复同步。`,
            );
            break;
          }
          seenLastIds.add(lastId);
        }
        collectedProductKeysByVisibility.set(
          targetVisibility,
          uniqueIds(visibilityProductKeys),
        );
        if (
          failedCount === failuresBeforeVisibility &&
          !completedVisibilities.has(targetVisibility)
        ) {
          failedCount += 1;
          errors.push(
            `${targetVisibility} 在 Contract Registry 允许的 ${maxPages} 页内未出现终止页。`,
          );
        }
        if (failedCount > failuresBeforeVisibility) break;
      }

      if (!atomicRunId && failedCount === 0) {
        for (const targetVisibility of runVisibilities) {
          if (
            !completedVisibilities.has(targetVisibility) ||
            (!(unifiedFullRun || isAllPagesValue(input.maxPages))) ||
            targetVisibility === "ALL"
          ) {
            continue;
          }
          const reconcile = repository.reconcileVisibilitySnapshot({
            shopId,
            visibility: targetVisibility,
            seenProductKeys:
              collectedProductKeysByVisibility.get(targetVisibility) || [],
          });
          changedCount += (reconcile.updated || 0) + (reconcile.stale || 0);
        }
      }

      let hydration = {
        changedCount: 0,
        unchangedCount: 0,
        failedCount: 0,
        errors: [],
      };
      if (
        failedCount === 0 &&
        completedVisibilities.size === runVisibilities.length &&
        hydrate &&
        (collectedProductIds.length || collectedOfferIds.length)
      ) {
        hydration = await hydrateProducts({
          job: jobService.getJob(job.jobId),
          shopId,
          productIds: uniqueIds(collectedProductIds),
          offerIds: uniqueIds(collectedOfferIds),
          requestedBy,
          maxHydrateProducts,
          // A full product hydration can enqueue hundreds of requests. Keep
          // those requests below interactive reads (for example chat paging)
          // so a user action is not forced to wait behind the whole product
          // refresh queue.
          priority: input.priority || "P2",
          profile: input.profile ?? input.schedulerProfile,
          source: syncSource,
          syncMode,
          recoveryRestoreId,
          recoveryGenerationId,
          recoveryOverlapMinutes,
          snapshotId,
          atomicRunId,
          hydrationConcurrency:
            input.hydrationConcurrency ??
            input.concurrentHydration ??
            input.concurrency,
          hydrationMode: input.hydrationMode ?? input.hydrationScope,
          hydrationBatchSize: input.hydrationBatchSize,
        });
        changedCount += hydration.changedCount;
        unchangedCount += hydration.unchangedCount;
        failedCount += hydration.failedCount;
        errors.push(...hydration.errors);
      }

      if (atomicRunId) {
        if (failedCount > 0) {
          const failedStatus = totalRows > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
          const lastError = errors.length ? errors.slice(0, 5).join("；") : "商品原子同步网络阶段失败。";
          atomicRunRepository.failRun(atomicRunId, {
            // 网络、超时、限流和单批次映射失败仍属于可续跑任务。
            // 保留同一个 run_id，下一轮只会覆盖相同 batch_key，禁止
            // 每次自动重试都新增一整套永久 JSON 副本。
            status: "interrupted",
            errorCode: "PRODUCT_SYNC_FETCH_OR_MAP_FAILED",
            errorMessage: lastError,
          });
          snapshotService?.finishSnapshot?.(snapshotId, {
            status: failedStatus,
            active: false,
            rowCount: 0,
            changedCount: 0,
            unchangedCount: 0,
            failedCount,
          });
          const failedJob = jobService.updateJob(job.jobId, {
            status: failedStatus,
            changedCount: 0,
            unchangedCount: 0,
            failedCount,
            finishedAt: nowIso(),
            lastError,
            snapshotId,
          });
          stateService.upsertState({
            domain: "products",
            shopId,
            scopeKey: `products:list:${visibility}`,
            status: failedStatus,
            lastAttemptAt: nowIso(),
            lastError,
          });
          clearProductReadCache(shopId);
          return failedJob;
        }

        const identityIds = uniqueIds(collectedIdentityKeys);
        const proofFacets = {
          identity: {
            expected: identityIds.length,
            returned: identityIds.length,
            returnedEmpty: 0,
            notApplicable: 0,
            unavailable: 0,
            notReturned: 0,
            failed: 0,
          },
          ...(hydration.facetCoverage || {}),
        };
        atomicRunRepository.markProving(atomicRunId, {
          facets: proofFacets,
          requiredVisibilities: runVisibilities,
        });
        const activationInput = {
          atomicRunId,
          snapshotId,
          shopId,
          shopName: getShopName(shopId),
          jobId: job.jobId,
          visibility,
          runVisibilities,
          completedVisibilities: [...completedVisibilities],
          allowVisibilityReconcile:
            unifiedFullRun || isAllPagesValue(input.maxPages),
          notificationBeforeRows,
        };
        const activationDependencies = {
          db,
          repository,
          jobService,
          snapshotService,
          stateService,
          atomicRunRepository,
        };
        const workerDatabase = shopProductStorage?.isDirectWriteShop?.(shopId) ? null : resolveProductAtomicActivationDatabase(db);
        const activationResult = workerDatabase
          ? await runProductAtomicActivationProcess({
              database: workerDatabase,
              activation: activationInput,
            })
          : activateStagedProductSync(
              activationDependencies,
              activationInput,
            );
        changedCount = activationResult.changedCount || 0;
        unchangedCount = activationResult.unchangedCount || 0;
        clearProductReadCache(shopId);
        if (shouldFinalizeProductReadCache(input, visibility)) {
          warmProductReadCache({
            shopId,
            visibility,
            visibilities:
              input.allStatuses || input.syncAllStatuses || input.fullRefresh
                ? PRODUCT_FULL_SYNC_VISIBILITIES
                : [visibility],
          });
        }
        return (
          activationResult.finalJob ||
          jobService.getJob(job.jobId) ||
          activationResult.activation?.run
        );
      }

      const finalStatus =
        failedCount > 0
          ? totalRows > 0
            ? SYNC_JOB_STATUS.partial
            : SYNC_JOB_STATUS.failed
          : SYNC_JOB_STATUS.success;
      const lastError = errors.length ? errors.slice(0, 5).join("；") : null;
      const notificationCount =
        finalStatus === SYNC_JOB_STATUS.failed
          ? 0
          : recordProductNotificationEvents({
              beforeRows: notificationBeforeRows,
              snapshotId,
              sourceJobId: job.jobId,
              shopId,
            });
      const cacheRowCount = repository.listProducts({
        shopId,
        visibility: "ALL",
        pageSize: 1,
      }).total;
      snapshotService?.finishSnapshot?.(snapshotId, {
        status: finalStatus,
        active: finalStatus !== SYNC_JOB_STATUS.failed,
        rowCount: cacheRowCount,
        changedCount,
        unchangedCount,
        failedCount,
      });
      const finalJob = jobService.updateJob(job.jobId, {
        status: finalStatus,
        changedCount,
        unchangedCount,
        failedCount,
        finishedAt: nowIso(),
        lastError,
        snapshotId,
        message:
          notificationCount > 0
            ? `商品同步完成，已记录 ${notificationCount} 条后台变化提醒。`
            : undefined,
      });
      stateService.upsertState({
        domain: "products",
        shopId,
        scopeKey: `products:list:${visibility}`,
        status: finalStatus,
        lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
        lastAttemptAt: nowIso(),
        lastError,
        changedCount,
        unchangedCount,
      });
      clearProductReadCache(shopId);
      if (shouldFinalizeProductReadCache(input, visibility)) {
        warmProductReadCache({
          shopId,
          visibility,
          visibilities:
            input.allStatuses || input.syncAllStatuses || input.fullRefresh
              ? PRODUCT_FULL_SYNC_VISIBILITIES
              : [visibility],
        });
      }
      return finalJob;
    } catch (error) {
      if (atomicRunId) {
        try {
          atomicRunRepository.failRun(atomicRunId, {
            status: "invalid",
            errorCode:
              normalizeText(error?.code) ||
              normalizeText(error?.message).split(":")[0] ||
              "PRODUCT_SYNC_ATOMIC_FAILED",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        } catch (_atomicFailure) {
          // The original sync failure remains authoritative; stale-fence failures
          // deliberately keep the run for startup recovery rather than guessing.
        }
      }
      snapshotService?.finishSnapshot?.(snapshotId, {
        status: SYNC_JOB_STATUS.failed,
        active: false,
        rowCount: 0,
        changedCount,
        unchangedCount,
        failedCount: Math.max(1, failedCount),
      });
      const finalJob = jobService.updateJob(job.jobId, {
        status: SYNC_JOB_STATUS.failed,
        failedCount: Math.max(1, failedCount),
        lastError: error instanceof Error ? error.message : String(error),
        finishedAt: nowIso(),
        snapshotId,
      });
      stateService.upsertState({
        domain: "products",
        shopId,
        scopeKey: `products:list:${visibility}`,
        status: "failed",
        lastAttemptAt: nowIso(),
        lastError: finalJob.lastError,
      });
      clearProductReadCache(shopId);
      return finalJob;
    }
  }

  function validateSyncFoundation() {
    if (
      !repository ||
      !jobService ||
      !stateService ||
      !ozonScheduler?.executeReadOnly
    ) {
      return {
        ok: false,
        domain: "products",
        error: {
          code: "PRODUCT_SYNC_NOT_CONNECTED",
          message: "商品列表同步底座尚未连接。",
        },
      };
    }
    return null;
  }

  function hasUsableCredentials(shopId) {
    if (!shopRepository?.getShopCredentialsForInternalUse) return true;
    const credentials = shopRepository.getShopCredentialsForInternalUse(shopId);
    return Boolean(credentials?.clientId && credentials?.apiKey);
  }

  function resolveTargetShopIds(input = {}) {
    const explicitIds = [
      ...parseListInput(input.shopIds),
      ...parseListInput(input.shop_ids),
    ];
    const rawShopId = normalizeText(input.shopId ?? input.shop_id);
    if (rawShopId && !isAllShopToken(rawShopId)) explicitIds.push(rawShopId);
    const allRequested =
      input.allShops === true ||
      input.all_shops === true ||
      isAllShopToken(rawShopId);

    if (allRequested) {
      return (shopRepository?.listShops?.() || [])
        .filter(
          (shop) =>
            shop?.id &&
            shop.status !== "disabled" &&
            shop.hasClientId &&
            shop.hasApiKey,
        )
        .map((shop) => shop.id);
    }
    return [...new Set(explicitIds.map(normalizeText).filter(Boolean))];
  }

  function createProductsSyncJob(input = {}) {
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const requestedVisibilities =
      Array.isArray(input.visibilities) && input.visibilities.length
        ? [...new Set(input.visibilities.map(normalizeVisibility))]
        : [
            normalizeVisibility(
              input.visibility ?? input.params?.filter?.visibility ?? "ALL",
            ),
          ];
    const requiredUnifiedFullRun = isRequiredUnifiedFullRun(input);
    const unifiedFullRun =
      requiredUnifiedFullRun || isCompleteProductVisibilitySet(requestedVisibilities);
    const visibilities = requiredUnifiedFullRun
      ? [...PRODUCT_FULL_SYNC_VISIBILITIES]
      : requestedVisibilities;
    const visibility = unifiedFullRun ? "FULL" : visibilities[0];
    const effectiveInput = unifiedFullRun
      ? {
          ...input,
          visibilities,
          visibility: "FULL",
          hydrate: true,
          hydrationMode: "full",
          maxHydrateProducts: "all",
          maxPages: "all",
          ...(requiredUnifiedFullRun ? {} : { syncMode: "full" }),
        }
      : { ...input, visibilities, visibility };
    if (!shopId) {
      return {
        ok: false,
        domain: "products",
        error: {
          code: "PRODUCT_SYNC_SHOP_ID_REQUIRED",
          message:
            "商品列表同步需要 shopId，或传入 shopId=all/allShops=true 执行多店铺同步。",
        },
      };
    }
    if (!hasUsableCredentials(shopId)) {
      return {
        ok: false,
        domain: "products",
        shopId,
        visibility,
        error: {
          code: "PRODUCT_SYNC_CREDENTIALS_MISSING",
          message: "商品列表同步需要已加密保存的 Ozon 店铺凭据。",
        },
      };
    }

    const hydrate = unifiedFullRun ? true : input.hydrate !== false;
    const hydrationMode = unifiedFullRun
      ? "full"
      : normalizeHydrationMode(input.hydrationMode ?? input.hydrationScope);
    const maxPages = resolveProductListContractPlan(effectiveInput).maxPages;
    const requestFingerprint = buildProductRequestFingerprint({
      ...effectiveInput,
      shopId,
      visibility,
      visibilities,
      hydrate,
    });
    const idempotencyKey = input.idempotencyKey
      ? `${input.idempotencyKey}:${shopId}:${visibility}`
      : `products:list:${shopId}:${visibility}:${hydrate ? "hydrate" : "list"}:${Math.floor(Date.now() / 30_000)}`;
    const reusable = jobService.findReusableJob({
      requestFingerprint,
      idempotencyKey: input.idempotencyKey ? idempotencyKey : null,
    });
    if (reusable?.job) {
      return publicJobPayload(reusable.job, {
        hydrate,
        hydrationMode,
        reused: true,
        reusedFromJobId: reusable.job.jobId,
        reason: reusable.reason,
        visibility,
        visibilities,
        unifiedFullRun,
        readPath: "/api/cache/products",
      });
    }

    const job = jobService.createJob({
      id: createProductsJobId(),
      domain: "products",
      shopId,
      endpointKey: "products.list",
      action: hydrate ? "sync-products-list-hydrate" : "sync-products-list",
      priority:
        input.priority ||
        (input.profile === "background" ||
        input.schedulerProfile === "background"
          ? "P4"
          : "P1"),
      profile: input.profile ?? input.schedulerProfile ?? null,
      source: input.source ?? input.syncSource ?? null,
      stage: "products.list",
      message: unifiedFullRun
        ? "商品统一全量任务已进入后台队列：七个状态完整分页后统一补水并原子激活。"
        : hydrate
        ? hydrationMode === "fast"
          ? "商品列表价格库存快照同步任务已进入后台队列。"
          : hydrationMode === "core"
            ? "商品列表核心快照同步任务已进入后台队列。"
            : "商品列表+补水同步任务已进入后台队列。"
        : "商品列表同步任务已进入后台队列。",
      requestedBy: input.requestedBy || "frontend",
      cacheKey: `products:list:${shopId}:${visibility}`,
      idempotencyKey,
      requestFingerprint,
      progressTotal: progressTotalForMaxPages(maxPages) * visibilities.length,
    });

    backgroundRunner(() =>
      runProductsSyncJob(job, {
        ...effectiveInput,
        shopId,
        visibility,
        visibilities,
        hydrate,
      }).catch(
        () => undefined,
      ),
    );
    return publicJobPayload(job, {
      hydrate,
      hydrationMode,
      reused: false,
      visibility,
      visibilities,
      unifiedFullRun,
      batch: unifiedFullRun,
      message: unifiedFullRun
        ? "商品统一全量任务已接收；七个状态属于同一 run，完成前不会激活新快照。"
        : hydrate
        ? hydrationMode === "fast"
          ? "商品列表价格库存快照同步任务已接收，页面应继续读取 /api/cache/products 本地缓存并轮询 job。"
          : hydrationMode === "pictures"
            ? "商品图片快照同步任务已接收，页面应继续读取 /api/cache/products 本地缓存并轮询 job。"
          : hydrationMode === "core"
            ? "商品列表核心快照同步任务已接收，页面应继续读取 /api/cache/products 本地缓存并轮询 job。"
            : "商品列表+补水同步任务已接收，页面应继续读取 /api/cache/products 本地缓存并轮询 job。"
        : "商品列表同步任务已接收，页面应继续读取 /api/cache/products 本地缓存并轮询 job。",
      readPath: "/api/cache/products",
    });
  }

  function startSync(input = {}) {
    const foundationError = validateSyncFoundation();
    if (foundationError) return foundationError;

    const targetShopIds = resolveTargetShopIds(input);
    if (!targetShopIds.length) {
      return {
        ok: false,
        domain: "products",
        error: {
          code: "PRODUCT_SYNC_NO_CONFIGURED_SHOPS",
          message:
            "没有可同步的 Ozon 店铺：请先保存 Client ID 和 API Key，或传入明确 shopId。",
        },
      };
    }
    const visibilities = resolveVisibilityPlan(input);
    const unifiedFullRun =
      isRequiredUnifiedFullRun(input) || isCompleteProductVisibilitySet(visibilities);
    const jobs = [];
    const errors = [];
    for (const shopId of targetShopIds) {
      const jobPlans = unifiedFullRun
        ? [{ visibility: "FULL", visibilities, hydrate: true, maxPages: "all" }]
        : visibilities.map((visibility) => ({
            visibility,
            visibilities: [visibility],
            hydrate: input.hydrate !== false,
            maxPages: input.maxPages,
          }));
      for (const plan of jobPlans) {
        const result = createProductsSyncJob({
          ...input,
          shopId,
          ...plan,
        });
        if (result?.accepted) jobs.push(result);
        else
          errors.push({
            shopId,
            visibility: plan.visibility,
            error: result?.error || {
              code: "PRODUCT_SYNC_UNKNOWN_ERROR",
              message: "商品同步任务创建失败。",
            },
          });
      }
    }

    if (jobs.length === 1 && errors.length === 0) return jobs[0];
    if (!jobs.length) {
      return {
        ok: false,
        domain: "products",
        batch: true,
        shopIds: targetShopIds,
        visibilities,
        errors,
        error: errors[0]?.error || {
          code: "PRODUCT_SYNC_BATCH_EMPTY",
          message: "没有创建任何商品同步任务。",
        },
      };
    }

    return {
      ok: errors.length === 0,
      accepted: true,
      domain: "products",
      batch: true,
      status: errors.length ? "partial" : "queued",
      shopIds: targetShopIds,
      visibilities,
      hydrate: unifiedFullRun ? true : input.hydrate !== false,
      unifiedFullRun,
      jobIds: jobs.map((item) => item.jobId).filter(Boolean),
      jobs: jobs.map((item) => ({
        jobId: item.jobId,
        status: item.status,
        shopId: item.job?.shopId || item.shopId || null,
        visibility: item.visibility,
        visibilities: item.visibilities || [item.visibility],
        hydrate: item.hydrate !== false,
        hydrationMode: item.hydrationMode || "full",
        reused: Boolean(item.reused),
        reusedFromJobId: item.reusedFromJobId || null,
      })),
      errors,
      readPath: "/api/cache/products",
      message:
        unifiedFullRun
          ? "商品统一全量批次已接收：每个店铺只有一个 run，七个状态完整分页后统一补水并原子激活。"
          : "商品同步批次已接收，页面继续读取 SQLite 缓存。",
    };
  }

  return {
    startSync,
    runProductsSyncJob,
  };
}

function hasSqliteTable(db, tableName) {
  if (!db || !normalizeText(tableName)) return false;
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(normalizeText(tableName)),
  );
}

function futureIso(offsetMs) {
  return new Date(Date.now() + Math.max(Number(offsetMs) || 0, 0)).toISOString();
}

function normalizeProductAtomicRunMode(input = {}, hydrate = true) {
  const explicit = normalizeText(input.syncMode ?? input.sync_mode).toLowerCase();
  if (["bootstrap", "full", "reconcile", "incremental", "fast", "details", "readback"].includes(explicit)) {
    return explicit;
  }
  if (input.bootstrap === true || normalizeText(input.reason).toLowerCase() === "rebind") return "bootstrap";
  if (input.recoveryRestoreId || input.recovery_restore_id) return "reconcile";
  if (input.fullRefresh || input.allStatuses || input.syncAllStatuses) return "full";
  const hydrationMode = normalizeHydrationMode(input.hydrationMode ?? input.hydrationScope);
  if (hydrate && hydrationMode === "fast") return "fast";
  if (hydrate && hydrationMode === "details") return "details";
  if (normalizeText(input.source).toLowerCase().includes("readback")) return "readback";
  return "incremental";
}

function readActiveProductSnapshotId(db, shopId) {
  if (!hasSqliteTable(db, "ozon_sync_snapshots")) return null;
  return db.prepare(`
    SELECT id FROM ozon_sync_snapshots
     WHERE domain = 'products' AND shop_id = ? AND active = 1
     ORDER BY activated_at DESC, created_at DESC LIMIT 1
  `).get(normalizeText(shopId))?.id || null;
}

function collectProductStageKeys(rows = [], identityContract = null) {
  const primaryField = normalizeText(identityContract?.primaryField);
  const alternateField = normalizeText(identityContract?.alternateField);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const productId = normalizeId(
      (primaryField ? row?.[primaryField] : undefined) ??
        row?.product_id ??
        row?.productId ??
        row?.id,
    );
    const offerId = normalizeId(
      (alternateField ? row?.[alternateField] : undefined) ??
        row?.offer_id ??
        row?.offerId,
    );
    const sku = normalizeId(row?.sku ?? row?.sku_id ?? row?.skuId);
    if (productId) return `product:${productId}`;
    if (offerId) return `offer:${offerId}`;
    if (sku) return `sku:${sku}`;
    return "";
  }).filter(Boolean);
}

function applyStagedProductFacet(repository, facet, input) {
  switch (normalizeText(facet).toLowerCase()) {
    case "detail":
      return repository.mergeProductInfoRows(input);
    case "pictures":
      return repository.mergeProductPictureRows(input);
    case "prices":
      return repository.mergeProductPriceRows(input);
    case "stocks":
      return repository.mergeProductStockRows(input);
    case "warehouse_stocks":
      return repository.mergeProductWarehouseStockRows(input);
    case "attributes":
      return repository.mergeProductAttributeRows(input);
    default:
      throw new Error(`PRODUCT_SYNC_STAGED_FACET_UNSUPPORTED:${facet || "empty"}`);
  }
}

function summarizeStagedProductSourceGaps(batches = []) {
  const byFacet = new Map();
  for (const batch of Array.isArray(batches) ? batches : []) {
    if (batch.stageKind !== "facet") continue;
    const expected = uniqueIds([
      ...(batch.expectedProductIds || []),
      ...(batch.expectedOfferIds || []),
    ]);
    const actual = new Set(uniqueIds([
      ...(batch.actualProductIds || []),
      ...(batch.actualOfferIds || []),
    ]));
    const missing = expected.filter((id) => !actual.has(id));
    if (!missing.length) continue;
    const facet = normalizeText(batch.facet).toLowerCase() || "unknown";
    const current = byFacet.get(facet) || [];
    current.push(...missing);
    byFacet.set(facet, uniqueIds(current));
  }
  return [...byFacet.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([facet, ids]) => `${facet}=${ids.length}${ids.length ? `（${ids.slice(0, 5).join(",")}）` : ""}`)
    .join("，");
}

function writeCurrentShopDomainSyncState(db, {
  shopId,
  domain,
  status,
  activeSnapshotId,
  committedCursor,
  proofHash,
} = {}) {
  if (!hasSqliteTable(db, "shop_domain_sync_state")) return null;
  const shop = db.prepare(`
    SELECT profile_id, id, shop_incarnation, credential_revision
      FROM shops WHERE id = ?
  `).get(normalizeText(shopId));
  if (!shop) throw new Error("PRODUCT_SYNC_SHOP_NOT_FOUND");
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO shop_domain_sync_state (
      profile_id, shop_id, shop_incarnation, credential_revision, domain,
      status, active_snapshot_id, committed_cursor, proof_hash,
      last_attempt_at, last_success_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, shop_id, shop_incarnation, domain) DO UPDATE SET
      credential_revision = excluded.credential_revision,
      status = excluded.status,
      active_snapshot_id = excluded.active_snapshot_id,
      committed_cursor = excluded.committed_cursor,
      proof_hash = excluded.proof_hash,
      last_error_code = NULL,
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = excluded.last_success_at,
      updated_at = excluded.updated_at
  `).run(
    shop.profile_id,
    shop.id,
    shop.shop_incarnation,
    Number(shop.credential_revision),
    normalizeText(domain),
    normalizeText(status),
    normalizeText(activeSnapshotId) || null,
    normalizeText(committedCursor) || null,
    normalizeText(proofHash) || null,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );
  return { shopId: shop.id, domain: normalizeText(domain), status: normalizeText(status) };
}

function isCompleteProductVisibilitySet(values = []) {
  const normalized = new Set(
    (Array.isArray(values) ? values : []).map(normalizeVisibility),
  );
  return (
    normalized.size === PRODUCT_FULL_SYNC_VISIBILITIES.length &&
    PRODUCT_FULL_SYNC_VISIBILITIES.every((visibility) => normalized.has(visibility))
  );
}
