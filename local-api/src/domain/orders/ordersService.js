import { createOrderRepository } from '../../db/repositories/orderRepository.js';
import { createSyncJobService, SYNC_JOB_STATUS } from '../../sync/syncJobService.js';
import { createShopOrderRepositoryRouter } from '../../db/shopOrderRepositoryRouter.js';
import { createSyncStateService } from '../../sync/syncStateService.js';
import { createStableHash } from '../../utils/stableHash.js';
import {
  normalizeOrderLikeCacheQueryWithDefaultRange,
  normalizeOrderLikeSyncParamsWithDefaultRange,
} from '../orderTimeRange.js';
import { createOrdersWriteService } from './ordersWriteService.js';

const DEFAULT_ORDER_PAGE_SIZE = 100;
const DEFAULT_ORDER_MAX_PAGES = 1;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

function firstFilled(...values) {
  for (const value of values) {
    const normalized = normalizeId(value);
    if (normalized) return normalized;
  }
  return '';
}

function toPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function resolveEndpointKey(input = {}) {
  const endpointKey = normalizeText(input.endpointKey ?? input.endpoint_key);
  if (endpointKey) return endpointKey;
  const source = normalizeText(input.source ?? input.fulfillment).toUpperCase();
  if (source === 'FBO') return 'orders.fboList';
  if (input.unfulfilled || input.scope === 'unfulfilled') return 'orders.fbsUnfulfilledList';
  return 'orders.fbsList';
}

function endpointSource(endpointKey) {
  if (endpointKey === 'orders.fboList' || endpointKey === 'orders.fboGet') return 'FBO';
  return 'FBS';
}

function normalizePostingNumber(row = {}) {
  if (typeof row === 'string' || typeof row === 'number') return normalizeId(row);
  return normalizeId(firstFilled(row.posting_number, row.postingNumber, row.posting?.posting_number, row.id));
}

function normalizeSplitQuantities(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toPositiveInteger(typeof item === 'object' ? item.quantity ?? item.qty ?? item.count : item, 0, 1000))
    .filter((quantity) => quantity > 0);
}

function clonePlain(value, fallback) {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function getOrderProducts(order = {}) {
  if (Array.isArray(order.products)) return order.products;
  if (Array.isArray(order.items)) return order.items;
  if (Array.isArray(order.raw?.products)) return order.raw.products;
  if (Array.isArray(order.raw?.items)) return order.raw.items;
  return [];
}

function getOrderFinancial(order = {}) {
  return order.financial_data || order.financialData || order.raw?.financial_data || order.raw?.financialData || null;
}

function isTestSplitOrder(order = {}, postingNumber = '') {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw : {};
  return Boolean(
    order.uiTestOrder ||
      order.splitUiTestOrder ||
      raw.uiTestOrder ||
      raw.splitUiTestOrder ||
      /^TEST-SPLIT-/i.test(String(postingNumber || normalizePostingNumber(order))),
  );
}

function buildSequentialChildPostingNumbers(parentPostingNumber = '', count = 0) {
  const text = normalizeText(parentPostingNumber);
  const basePosting = text.replace(/-\d+$/u, '');
  const suffixSeed = Number(text.match(/-(\d+)$/u)?.[1] || 0);
  return Array.from({ length: Math.max(0, count) }, (_, index) => `${basePosting}-${suffixSeed + index + 1}`);
}

function applyProductQuantity(product = {}, quantity = 1) {
  const next = clonePlain(product, {});
  next.quantity = quantity;
  next.qty = quantity;
  if (Object.prototype.hasOwnProperty.call(next, 'count')) next.count = quantity;
  return next;
}

function applyFinancialQuantity(financial, quantity = 1) {
  const next = clonePlain(financial, financial);
  if (!next || typeof next !== 'object') return next;
  if (Array.isArray(next.products)) {
    next.products = next.products.map((product) => applyProductQuantity(product, quantity));
  }
  if (Array.isArray(next.items)) {
    next.items = next.items.map((item) => applyProductQuantity(item, quantity));
  }
  return next;
}

function buildSplitTestParentRow({ parentOrder, parentPostingNumber, quantity, timestamp } = {}) {
  const parentRaw = clonePlain(parentOrder.raw || parentOrder, {});
  const products = getOrderProducts(parentOrder);
  const sourceProduct = products[0] || {};
  const financial = getOrderFinancial(parentOrder);
  return {
    ...parentRaw,
    id: parentPostingNumber,
    posting_number: parentPostingNumber,
    postingNumber: parentPostingNumber,
    parent_posting_number: '',
    parentPostingNumber: '',
    order_id: parentOrder.order_id || parentOrder.orderId || parentRaw.order_id || parentRaw.orderId,
    orderId: parentOrder.orderId || parentOrder.order_id || parentRaw.orderId || parentRaw.order_id,
    status: parentOrder.status || parentRaw.status || 'awaiting_packaging',
    substatus: parentOrder.substatus || parentRaw.substatus || 'posting_created',
    source: parentOrder.source || parentOrder.fulfillment || parentRaw.source || 'FBS',
    fulfillment: parentOrder.fulfillment || parentOrder.source || parentRaw.fulfillment || 'FBS',
    items: quantity,
    quantity,
    products: [applyProductQuantity(sourceProduct, quantity)],
    financial_data: applyFinancialQuantity(financial, quantity),
    analytics_data: parentOrder.analytics_data || parentOrder.analyticsData || parentRaw.analytics_data || parentRaw.analyticsData,
    uiTestOrder: true,
    splitUiTestOrder: true,
    splitSimulatedParent: true,
    splitSimulatedAt: timestamp,
    split: {
      simulated: true,
      role: 'parent',
      posting_number: parentPostingNumber,
      quantity,
    },
  };
}

function buildSplitTestChildRows({ parentOrder, parentPostingNumber, childPostingNumbers, quantities, timestamp } = {}) {
  const parentRaw = clonePlain(parentOrder.raw || parentOrder, {});
  const products = getOrderProducts(parentOrder);
  const sourceProduct = products[0] || {};
  const financial = getOrderFinancial(parentOrder);
  return childPostingNumbers.map((childPostingNumber, index) => {
    const quantity = quantities[index];
    const childProduct = applyProductQuantity(sourceProduct, quantity);
    const childFinancial = applyFinancialQuantity(financial, quantity);
    return {
      ...parentRaw,
      id: childPostingNumber,
      posting_number: childPostingNumber,
      postingNumber: childPostingNumber,
      parent_posting_number: parentPostingNumber,
      parentPostingNumber: parentPostingNumber,
      order_id: parentOrder.order_id || parentOrder.orderId || parentRaw.order_id || parentRaw.orderId,
      orderId: parentOrder.orderId || parentOrder.order_id || parentRaw.orderId || parentRaw.order_id,
      status: parentOrder.status || parentRaw.status || 'awaiting_packaging',
      substatus: parentOrder.substatus || parentRaw.substatus || 'posting_created',
      source: parentOrder.source || parentOrder.fulfillment || parentRaw.source || 'FBS',
      fulfillment: parentOrder.fulfillment || parentOrder.source || parentRaw.fulfillment || 'FBS',
      items: quantity,
      quantity,
      products: [childProduct],
      financial_data: childFinancial,
      analytics_data: parentOrder.analytics_data || parentOrder.analyticsData || parentRaw.analytics_data || parentRaw.analyticsData,
      uiTestOrder: true,
      splitUiTestOrder: true,
      splitSimulatedChild: true,
      splitSimulatedAt: timestamp,
      split: {
        simulated: true,
        parent_posting_number: parentPostingNumber,
        posting_number: childPostingNumber,
        quantity,
      },
    };
  });
}

function isOrderDetailEndpoint(endpointKey) {
  return endpointKey === 'orders.fbsGet' || endpointKey === 'orders.fboGet';
}

function normalizeDetailPostingNumberParam(params = {}, input = {}) {
  const postingNumbers = params.posting_number;
  if (Array.isArray(postingNumbers)) {
    const firstPostingNumber = postingNumbers.map(normalizeId).find(Boolean);
    return firstPostingNumber ? { ...params, posting_number: firstPostingNumber } : params;
  }
  const postingNumber = firstFilled(
    params.posting_number,
    params.postingNumber,
    params.filter?.posting_number,
    input.posting_number,
    input.postingNumber,
  );
  return postingNumber ? { ...params, posting_number: postingNumber } : params;
}

function normalizeOrderSyncParams(endpointKey, params = {}, input = {}) {
  const source = params && typeof params === 'object' ? params : {};
  if (isOrderDetailEndpoint(endpointKey)) return normalizeDetailPostingNumberParam(source, input);
  return normalizeOrderLikeSyncParamsWithDefaultRange(source, input);
}

function isOrderPayloadObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function filterOrderPayloadObjects(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter(isOrderPayloadObject);
}

export function extractOrders(data = {}) {
  if (Array.isArray(data)) return filterOrderPayloadObjects(data);
  if (!isOrderPayloadObject(data)) return [];
  if (Array.isArray(data.items)) return filterOrderPayloadObjects(data.items);
  if (Array.isArray(data.postings)) return filterOrderPayloadObjects(data.postings);
  if (Array.isArray(data.result?.postings)) return filterOrderPayloadObjects(data.result.postings);
  if (Array.isArray(data.result?.items)) return filterOrderPayloadObjects(data.result.items);
  if (Array.isArray(data.result)) return filterOrderPayloadObjects(data.result);
  if (isOrderPayloadObject(data.result)) return [data.result];
  if (data.posting_number || data.order_id) return [data];
  return [];
}

function getSchedulerData(result = {}) {
  return result.data ?? result.cache?.payload ?? null;
}

function isSchedulerOk(result = {}) {
  return Boolean(result.ok || result.status === 'success' || result.status === 'partial' || result.status === 'cache_hit');
}

function schedulerErrorMessage(result, fallback = 'Ozon 订单接口调用失败') {
  const first = result?.errors?.[0];
  return first?.message || result?.job?.lastError || result?.error?.message || fallback;
}

function hasOrdersTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ozon_orders'").get());
  } catch {
    return false;
  }
}

function createOrdersJobId() {
  return `orders_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function publicJobPayload(job, extra = {}) {
  return {
    ok: true,
    accepted: true,
    domain: 'orders',
    jobId: job?.jobId || job?.id,
    job,
    status: job?.status || 'queued',
    ...extra,
  };
}

function buildRequestFingerprint(input = {}) {
  return createStableHash({
    domain: 'orders',
    shopId: input.shopId,
    endpointKey: input.endpointKey,
    params: input.params,
    pageSize: input.pageSize,
    maxPages: input.maxPages,
    forceRefresh: input.forceRefresh === true,
  }, { length: 32 });
}

function withOffsetParams(params = {}, { limit, offset } = {}) {
  return { ...(params || {}), limit, offset };
}

export function createOrdersService({
  db,
  ozonScheduler,
  shopOrderStorage = null,
  shopOrderReadRouter = null,
  shopRepository = null,
  backgroundRunner = (task) => setImmediate(task),
} = {}) {
  const canonicalRepository = db && hasOrdersTable(db)
      ? createOrderRepository(db, {
        resolveOrderReadDatabase: shopOrderReadRouter?.resolve,
        onOrderReadDatabaseError(error, context) {
          shopOrderReadRouter?.recordQueryFallback?.({
            shopId: context?.shopId,
            errorCode: error?.code || error?.message,
          });
        },
      })
    : null;
  const repository = canonicalRepository && shopOrderStorage?.resolveDirectWriteSession
    ? createShopOrderRepositoryRouter({
        canonicalRepository,
        shopOrderStorage,
        listShopIds: () => shopRepository?.listShops?.()
          ?.filter((shop) => shop?.status !== 'disabled')
          .map((shop) => shop.id) || [],
      })
    : canonicalRepository;
  const jobService = db ? createSyncJobService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;
  const ordersWriteService = repository
    ? createOrdersWriteService({ repository, ozonScheduler, scheduleReadBack: scheduleOrderWriteReadBack })
    : null;

  function simulateTestSplit(input = {}) {
    if (!repository) {
      return { ok: false, error: { code: 'ORDERS_CACHE_NOT_CONNECTED', message: 'orders SQLite cache is not connected.' } };
    }

    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const parentPostingNumber = normalizePostingNumber(
      input.parentPostingNumber ?? input.parent_posting_number ?? input.postingNumber ?? input.posting_number,
    );
    const quantities = normalizeSplitQuantities(input.splitQuantities ?? input.split_quantities ?? input.quantities);
    if (!shopId) {
      return { ok: false, error: { code: 'ORDER_TEST_SPLIT_SHOP_ID_REQUIRED', message: '测试拆单模拟需要 shopId。' } };
    }
    if (!parentPostingNumber) {
      return { ok: false, error: { code: 'ORDER_TEST_SPLIT_PARENT_REQUIRED', message: '测试拆单模拟需要母单货件号。' } };
    }
    if (quantities.length < 2) {
      return { ok: false, error: { code: 'ORDER_TEST_SPLIT_PLAN_REQUIRED', message: '测试拆单至少需要两组数量。' } };
    }

    const parentPage = repository.listOrders({ shopId, postingNumber: parentPostingNumber, pageSize: 5 });
    const parentOrder = parentPage.rows.find((row) => normalizePostingNumber(row) === parentPostingNumber);
    if (!parentOrder) {
      return {
        ok: false,
        error: { code: 'ORDER_TEST_SPLIT_PARENT_NOT_FOUND', message: `未在 SQLite 缓存中找到测试母单：${parentPostingNumber}` },
      };
    }
    if (!isTestSplitOrder(parentOrder, parentPostingNumber)) {
      return {
        ok: false,
        error: {
          code: 'ORDER_TEST_SPLIT_REAL_ORDER_BLOCKED',
          message: '拆单列表模拟只允许 TEST-SPLIT/uiTestOrder 测试单，真实订单必须走 Ozon 回读。',
        },
      };
    }

    const products = getOrderProducts(parentOrder);
    if (products.length !== 1) {
      return {
        ok: false,
        error: { code: 'ORDER_TEST_SPLIT_SINGLE_PRODUCT_REQUIRED', message: '当前测试拆单模拟只支持单商品订单。' },
      };
    }
    const parentQuantity = toPositiveInteger(products[0]?.quantity ?? products[0]?.qty ?? products[0]?.count, 0, 1000);
    const quantitySum = quantities.reduce((sum, quantity) => sum + quantity, 0);
    if (parentQuantity <= 0 || quantitySum !== parentQuantity) {
      return {
        ok: false,
        error: {
          code: 'ORDER_TEST_SPLIT_QUANTITY_MISMATCH',
          message: `拆单数量合计是 ${quantitySum}，和测试母单数量 ${parentQuantity || '未返回'} 不一致。`,
        },
      };
    }

    const timestamp = nowIso();
    const parentSplitQuantity = quantities[0];
    const childQuantities = quantities.slice(1);
    const childPostingNumbers = buildSequentialChildPostingNumbers(parentPostingNumber, childQuantities.length);
    const parentRow = buildSplitTestParentRow({
      parentOrder,
      parentPostingNumber,
      quantity: parentSplitQuantity,
      timestamp,
    });
    const childRows = buildSplitTestChildRows({
      parentOrder,
      parentPostingNumber,
      childPostingNumbers,
      quantities: childQuantities,
      timestamp,
    });
    repository.pruneSimulatedTestSplitChildren?.({
      shopId,
      parentPostingNumber,
      keepPostingNumbers: [parentPostingNumber, ...childPostingNumbers],
    });
    const merge = repository.upsertOrders({ shopId, rows: [parentRow, ...childRows], source: 'FBS' });
    const submittedSplitQuantities = quantities.map((quantity, index) => ({
      posting_number: index === 0 ? parentPostingNumber : childPostingNumbers[index - 1],
      offer_id: normalizeText(firstFilled(products[0]?.offer_id, products[0]?.offerId, products[0]?.sku, products[0]?.skuId)),
      product_id: normalizeText(firstFilled(products[0]?.product_id, products[0]?.productId)),
      quantity,
    }));
    const relation = repository.upsertSplitRelation({
      shopId,
      parentPostingNumber,
      childPostingNumbers,
      splitQuantities: submittedSplitQuantities,
      status: 'readback_merged',
      readbackStatus: 'merged',
      parentOzonVisible: true,
      forceParentOzonVisibleUpdate: true,
      childrenConfirmed: true,
      submittedPayload: {
        posting_number: parentPostingNumber,
        postings: submittedSplitQuantities.map((item) => ({
          products: [{ product_id: item.product_id || item.offer_id, offer_id: item.offer_id, quantity: item.quantity }],
        })),
      },
      ozonResponse: {
        simulated: true,
        result: {
          parent_posting: { posting_number: parentPostingNumber, quantity: parentSplitQuantity },
          postings: childPostingNumbers.map((postingNumber, index) => ({
            posting_number: postingNumber,
            quantity: childQuantities[index],
          })),
        },
      },
      parentSnapshot: parentRow,
      childSnapshots: childRows,
      readBackRows: [parentRow, ...childRows],
      mismatchReason: '',
      readbackAt: timestamp,
    }).relation;
    const resultPage = repository.listOrders({
      shopId,
      postingNumbers: [parentPostingNumber, ...childPostingNumbers].join(','),
      pageSize: childPostingNumbers.length + 1,
    });
    return {
      ok: true,
      simulated: true,
      domain: 'orders',
      action: 'splitFbsPosting',
      writeStatus: 'readback_merged',
      postingNumber: parentPostingNumber,
      parentPostingNumber,
      childPostingNumbers,
      resultPostingNumbers: [parentPostingNumber, ...childPostingNumbers],
      splitQuantities: submittedSplitQuantities,
      submittedSplitQuantities,
      readBack: {
        status: 'merged',
        rows: childRows.length + 1,
        merge,
      },
      splitRelation: relation,
      rows: resultPage.rows,
      message: `测试单已模拟拆解并写入 SQLite：${parentPostingNumber} -> ${quantities.join('+')}。`,
    };
  }

  function readCache(query = {}) {
    if (!repository) {
      return { ok: false, error: { code: 'ORDERS_CACHE_NOT_CONNECTED', message: 'orders SQLite cache is not connected.' } };
    }
    const started = Date.now();
    const normalizedQuery = normalizeOrderLikeCacheQueryWithDefaultRange(query);
    const payload = repository.listOrders(normalizedQuery);
    const includeSummary = query.includeSummary === true || query.includeSummary === 'true' || query.includeSummary === '1';
    if (includeSummary && typeof repository.summarizeOrders === 'function') {
      const summaryQuery = { ...normalizedQuery, status: '', statusScope: '', salesStatus: '', displayStatus: '' };
      payload.summary = repository.summarizeOrders(summaryQuery);
    }
    const includePrintShippingFacets =
      query.includePrintShippingFacets === true ||
      query.includePrintShippingFacets === 'true' ||
      query.includePrintShippingFacets === '1';
    if (includePrintShippingFacets && typeof repository.listPrintShippingFacets === 'function') {
      payload.printShippingFacets = repository.listPrintShippingFacets(normalizedQuery);
    }
    payload.durationMs = Date.now() - started;
    payload.syncState = stateService?.listStates('orders', { shopId: query.shopId || query.shop_id, limit: 5 }) ?? [];
    return payload;
  }

  async function runOrdersSyncJob(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const endpointKey = resolveEndpointKey(input);
    const detailEndpoint = isOrderDetailEndpoint(endpointKey);
    const baseParams = normalizeOrderSyncParams(
      endpointKey,
      input.params && typeof input.params === 'object' ? input.params : {},
      input,
    );
    const pageSize = detailEndpoint
      ? 1
      : toPositiveInteger(input.pageSize ?? input.limit ?? baseParams.limit, DEFAULT_ORDER_PAGE_SIZE, 1000);
    const maxPages = detailEndpoint ? 1 : toPositiveInteger(input.maxPages, DEFAULT_ORDER_MAX_PAGES, 100);
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || 'orders-domain-service';
    const syncSource = normalizeText(input.source ?? input.syncSource) || requestedBy;
    const schedulerProfile = normalizeText(input.profile ?? input.schedulerProfile);
    const syncMode = normalizeText(input.syncMode ?? input.sync_mode);
    const recoveryRestoreId = normalizeText(input.recoveryRestoreId ?? input.recovery_restore_id);
    const recoveryGenerationId = normalizeText(input.recoveryGenerationId ?? input.recovery_generation_id);
    const recoveryOverlapMinutes = Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes) || null;
    const forceRefresh = input.forceRefresh === true;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let done = 0;
    const errors = [];

    jobService.updateJob(job.jobId, { status: SYNC_JOB_STATUS.running, startedAt: nowIso(), progressTotal: maxPages });
    stateService.upsertState({ domain: 'orders', shopId, scopeKey: `orders:${endpointKey}`, status: 'running', lastAttemptAt: nowIso() });

    for (let page = 1; page <= maxPages; page += 1) {
      const offset = (page - 1) * pageSize;
      let stopAfterPage = false;
      try {
        const scheduled = await ozonScheduler.executeReadOnly({
          shopId,
          domain: 'orders',
          endpointKey,
          action: detailEndpoint ? 'sync-order-detail' : 'sync-orders-list',
          priority: input.priority || 'P2',
          ...(schedulerProfile ? { profile: schedulerProfile } : {}),
          params: detailEndpoint ? baseParams : withOffsetParams(baseParams, { limit: pageSize, offset }),
          cacheKey: detailEndpoint
            ? `orders:${shopId}:${endpointKey}:${baseParams.posting_number || 'detail'}`
            : `orders:${shopId}:${endpointKey}:offset:${offset}:limit:${pageSize}`,
          idempotencyKey: `${job.jobId}:${endpointKey}:page:${page}`,
          requestedBy,
          source: syncSource,
          ...(syncMode ? { syncMode } : {}),
          ...(recoveryRestoreId ? { recoveryRestoreId } : {}),
          ...(recoveryGenerationId ? { recoveryGenerationId } : {}),
          ...(recoveryOverlapMinutes ? { recoveryOverlapMinutes } : {}),
          forceRefresh,
          allowStale: true,
        });
        if (!isSchedulerOk(scheduled)) {
          failedCount += 1;
          errors.push(`page ${page}: ${schedulerErrorMessage(scheduled)}`);
          break;
        }
        const data = getSchedulerData(scheduled);
        const rows = extractOrders(data);
        const merge = repository.upsertOrders({ shopId, rows, source: endpointSource(endpointKey) });
        if (repository.reconcileSplitRelationsFromReadback) {
          repository.reconcileSplitRelationsFromReadback({
            shopId,
            rows,
            parentPostingNumbers: input.parentPostingNumbers ?? input.parentPostingNumber,
            parentVisibilityChecked: !detailEndpoint,
          });
        }
        changedCount += merge.changed || 0;
        unchangedCount += merge.unchanged || 0;
        if (rows.length < pageSize) stopAfterPage = true;
      } catch (error) {
        failedCount += 1;
        errors.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`);
        stopAfterPage = true;
        break;
      } finally {
        done += 1;
        jobService.updateJob(job.jobId, {
          progressDone: done,
          progressTotal: stopAfterPage && failedCount === 0 ? done : maxPages,
          changedCount,
          unchangedCount,
          failedCount,
        });
      }
      if (stopAfterPage) break;
    }

    const finalStatus = failedCount === 0 ? SYNC_JOB_STATUS.success : changedCount + unchangedCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
    const lastError = errors[0] || null;
    const finalProgressTotal = finalStatus === SYNC_JOB_STATUS.success ? Math.max(done, 1) : maxPages;
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: done,
      progressTotal: finalProgressTotal,
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      finishedAt: nowIso(),
    });
    stateService.upsertState({
      domain: 'orders',
      shopId,
      scopeKey: `orders:${endpointKey}`,
      status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
      lastAttemptAt: nowIso(),
      lastError,
      changedCount,
      unchangedCount,
    });
    return { job: finalJob, errors };
  }

  function startSync(input = {}) {
    if (!repository || !jobService) {
      return { ok: false, domain: 'orders', error: { code: 'ORDERS_SYNC_NOT_CONNECTED', message: 'orders domain service is not connected to SQLite cache.' } };
    }
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    if (!shopId) {
      return { ok: false, domain: 'orders', error: { code: 'ORDERS_SHOP_ID_REQUIRED', message: 'shopId is required for orders sync.' } };
    }
    const endpointKey = resolveEndpointKey(input);
    const requestFingerprint = buildRequestFingerprint({ ...input, shopId, endpointKey });
    const reusable = jobService.findReusableJob({ requestFingerprint, idempotencyKey: input.idempotencyKey ?? input.idempotency_key });
    if (reusable?.job) {
      return publicJobPayload(reusable.job, { reused: true, reusedFromJobId: reusable.job.jobId, reason: reusable.reason });
    }
    const job = jobService.createJob({
      id: createOrdersJobId(),
      domain: 'orders',
      shopId,
      endpointKey,
      action: isOrderDetailEndpoint(endpointKey) ? 'sync-order-detail' : 'sync-orders-list',
      priority: input.priority || 'P2',
      requestedBy: input.requestedBy || input.requested_by || 'orders-domain-service',
      cacheKey: `orders:${shopId}:${endpointKey}`,
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + 60_000).toISOString(),
      progressTotal: 0,
    });
    backgroundRunner(() => {
      runOrdersSyncJob(job, { ...input, shopId, endpointKey }).catch((error) => {
        jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
        });
      });
    });
    return publicJobPayload(job, { reused: false, endpointKey });
  }

  function scheduleOrderWriteReadBack(requests = [], context = {}) {
    if (!Array.isArray(requests) || !requests.length) {
      return { ok: true, scheduled: false, jobs: [], reason: 'empty_readback_requests' };
    }
    if (!repository || !jobService) {
      return { ok: false, scheduled: false, jobs: [], error: { code: 'ORDERS_READBACK_NOT_CONNECTED', message: '订单回读任务服务尚未连接。' } };
    }

    const jobs = [];
    const errors = [];
    for (const request of requests) {
      try {
        const postingNumber = normalizeId(request.postingNumber ?? request.posting_number);
        const endpointKey = normalizeText(request.endpointKey) || (postingNumber ? 'orders.fbsGet' : 'orders.fbsList');
        const params = {
          ...(request.params && typeof request.params === 'object' ? request.params : {}),
          ...(postingNumber ? { posting_number: postingNumber } : {}),
        };
        const payload = startSync({
          shopId: context.shopId || request.shopId,
          endpointKey,
          params,
          source: endpointSource(endpointKey),
          pageSize: request.pageSize || (postingNumber ? 1 : DEFAULT_ORDER_PAGE_SIZE),
          maxPages: request.maxPages || 1,
          forceRefresh: true,
          priority: request.priority || 'P1',
          requestedBy: request.requestedBy || 'orders-write-readback',
          parentPostingNumbers: request.parentPostingNumbers || context.parentPostingNumber,
          idempotencyKey:
            request.idempotencyKey ||
            `orders-readback:${context.action || 'write'}:${context.shopId || request.shopId}:${postingNumber || endpointKey}:${Date.now()}`,
        });
        jobs.push(payload);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      ok: errors.length === 0,
      scheduled: jobs.length > 0,
      jobs,
      errors,
    };
  }

  /**
   * Read one or more historical Ozon posting numbers from the official detail
   * endpoints and merge the returned rows into the canonical orders cache.
   * The caller waits for SQLite merge before continuing order matching.
   */
  async function refreshOrdersByPostingNumbers(input = {}) {
    if (!repository || !ozonScheduler) {
      return {
        ok: false,
        error: {
          code: 'ORDERS_OFFICIAL_LOOKUP_NOT_CONNECTED',
          message: 'Ozon 订单读取服务尚未连接。',
        },
      };
    }
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const postingNumbers = [...new Set(
      (Array.isArray(input.postingNumbers) ? input.postingNumbers : [])
        .map(normalizeId)
        .filter(Boolean),
    )];
    const sourceHints = input.sourceHints && typeof input.sourceHints === 'object'
      ? input.sourceHints
      : {};
    if (!shopId || !postingNumbers.length) {
      return { ok: true, shopId, foundCount: 0, notFoundCount: 0, failedCount: 0, results: [] };
    }

    const results = [];
    const requestCycle = normalizeText(input.requestCycle ?? input.request_cycle)
      || String(Math.floor(Date.now() / 60_000));
    for (const postingNumber of postingNumbers) {
      let found = false;
      let lastError = null;
      const sourceHint = normalizeText(sourceHints[postingNumber]).toUpperCase();
      const endpointKeys = sourceHint === 'FBS'
        ? ['orders.fbsGet']
        : sourceHint === 'FBO'
          ? ['orders.fboGet']
          : ['orders.fbsGet', 'orders.fboGet'];
      for (const endpointKey of endpointKeys) {
        try {
          const scheduled = await ozonScheduler.executeReadOnly({
            shopId,
            domain: 'orders',
            endpointKey,
            action: 'historical-order-import-backfill',
            priority: input.priority || 'P1',
            params: { posting_number: postingNumber },
            cacheKey: `orders:${shopId}:historical-backfill:${postingNumber}:${endpointKey}`,
            idempotencyKey: `historical-order-import-backfill:${shopId}:${postingNumber}:${endpointKey}:${requestCycle}`,
            requestedBy: input.requestedBy || 'historical-order-import-backfill',
            forceRefresh: true,
            allowStale: false,
          });
          if (!isSchedulerOk(scheduled)) {
            lastError = schedulerErrorMessage(scheduled);
            continue;
          }
          const rows = extractOrders(getSchedulerData(scheduled))
            .filter((row) => normalizePostingNumber(row) === postingNumber);
          if (!rows.length) continue;
          const merge = repository.upsertOrders({
            shopId,
            rows,
            source: endpointSource(endpointKey),
          });
          if (repository.reconcileSplitRelationsFromReadback) {
            repository.reconcileSplitRelationsFromReadback({
              shopId,
              rows,
              parentVisibilityChecked: false,
            });
          }
          found = true;
          results.push({
            postingNumber,
            found: true,
            endpointKey,
            changedCount: merge.changed || 0,
            unchangedCount: merge.unchanged || 0,
          });
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!found) {
        results.push({
          postingNumber,
          found: false,
          error: lastError || 'Ozon 未返回该订单。',
        });
      }
    }
    const foundCount = results.filter((item) => item.found).length;
    const failedCount = results.filter((item) => !item.found && item.error).length;
    return {
      ok: true,
      shopId,
      foundCount,
      notFoundCount: results.length - foundCount,
      failedCount,
      results,
    };
  }

  function executeConfirmedWrite(context = {}) {
    if (!ordersWriteService) {
      return { ok: false, error: { code: 'ORDERS_WRITE_NOT_CONNECTED', message: '订单写入安全门尚未连接订单缓存。' } };
    }
    return ordersWriteService.executeConfirmedWrite(context);
  }

  return {
    domain: 'orders',
    orderReadPort: repository ? Object.freeze({ listOrders: query => repository.listOrders(query) }) : null,
    readCache,
    startSync,
    runOrdersSyncJob,
    refreshOrdersByPostingNumbers,
    simulateTestSplit,
    executeConfirmedWrite,
  };
}
