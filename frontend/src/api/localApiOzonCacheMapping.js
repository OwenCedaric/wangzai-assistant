import { LocalApiError } from "./localApiError.js";

export function getLocalOzonShopId(shop = {}, body = {}) {
  return String(shop?.id || shop?.shopId || body?.shopId || body?.shop_id || '').trim();
}

export function getLocalOzonShopName(shop = {}, shopId = '') {
  return String(shop?.shopAlias || shop?.alias || shop?.name || shopId || 'Ozon 店铺').trim();
}

export function normalizeOzonEndpoint(endpoint = '') {
  return String(endpoint || '')
    .trim()
    .replace(/^https?:\/\/api-seller\.ozon\.ru/u, '');
}

export function parseLocalProductOffsetCursor(lastId) {
  const text = String(lastId || '').trim();
  if (!text) return 0;
  if (text.startsWith('offset:')) {
    const offset = Number(text.slice('offset:'.length));
    return Number.isFinite(offset) && offset > 0 ? offset : 0;
  }
  return 0;
}

export function countLocalProductIdentityValues(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).length;
  const text = String(value || '').trim();
  if (!text) return 0;
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean).length;
}

export function getProductSoftwareCategoryText(row = {}) {
  return row.softwareCategoryPath || row.categoryPath || row.categoryName || row.category_name || '';
}

export function getProductDisplayCurrencyCode(row = {}) {
  const code = String(row.currencyCode || row.currency_code || '')
    .trim()
    .toUpperCase();
  if (!code || code === 'RUB' || code === 'RUR' || code === 'RMB') return 'CNY';
  return code;
}

export function getLocalProductStockInfo(row = {}) {
  const stockValue = row.stockValue ?? row.stock_value;
  const hasStock = stockValue === null || stockValue === undefined ? undefined : Number(stockValue) > 0;
  const stockJson = row.stockJson ?? row.stock_json;
  if (stockJson && typeof stockJson === 'object' && !Array.isArray(stockJson)) return stockJson;
  return stockValue === null || stockValue === undefined ? undefined : { present: stockValue, has_stock: hasStock };
}

export function getLocalProductV4StockItems(row = {}) {
  const stockInfo = getLocalProductStockInfo(row);
  if (Array.isArray(stockInfo?.stocks)) return stockInfo.stocks;
  const stockValue = row.stockValue ?? row.stock_value;
  return stockValue === null || stockValue === undefined ? [] : [{ present: stockValue }];
}

export function getLocalProductSellerWarehouseStocks(row = {}) {
  if (Array.isArray(row.warehouseStocks)) return row.warehouseStocks;
  if (Array.isArray(row.warehouse_stocks)) return row.warehouse_stocks;
  return undefined;
}

export function toOzonProductListItem(row = {}) {
  const productId = row.productId || row.product_id || '';
  const offerId = row.offerId || row.offer_id || '';
  const images = Array.isArray(row.images) ? row.images.filter(Boolean) : [];
  const primaryImage = row.primaryImageUrl || row.primary_image || images[0] || '';
  const stockValue = row.stockValue ?? row.stock_value;
  const hasStock = stockValue === null || stockValue === undefined ? undefined : Number(stockValue) > 0;
  const statusLabel = row.statusLabel === '全部商品' ? '' : row.statusLabel || row.status || '';
  const categoryText = getProductSoftwareCategoryText(row);
  const warehouseStocks = getLocalProductSellerWarehouseStocks(row);
  const sellerWarehouseStockTotal = row.sellerWarehouseStockTotal ?? row.seller_warehouse_stock_total;
  const warehouseStockComplete = row.warehouseStockComplete === true || row.warehouse_stock_complete === true;
  const warehouseStockObservation = row.warehouseStockObservation ?? row.warehouse_stock_observation ?? null;
  return {
    product_id: productId ? Number(productId) || productId : undefined,
    id: productId ? Number(productId) || productId : undefined,
    offer_id: offerId,
    sku: row.sku || '',
    name: row.name || '未返回',
    visibility: row.visibility || 'ALL',
    visibility_status: row.visibility || '',
    status: statusLabel || row.visibility || '',
    status_label: statusLabel,
    productSnapshotVisibility: row.productSnapshotVisibility || row.snapshotVisibilities?.[0] || '',
    productSnapshotVisibilities: row.productSnapshotVisibilities || row.snapshotVisibilities || [],
    snapshotVisibilities: row.snapshotVisibilities || row.productSnapshotVisibilities || [],
    type_id: row.typeId || row.type_id || undefined,
    primary_image: primaryImage,
    images: images.length ? images : primaryImage ? [primaryImage] : [],
    price: row.priceValue ?? undefined,
    currency_code: getProductDisplayCurrencyCode(row),
    has_fbo_stocks: hasStock,
    has_fbs_stocks: hasStock,
    stocks: getLocalProductStockInfo(row),
    stock_json: row.stockJson || row.stock_json || undefined,
    stockInfo: row.stockJson || row.stock_json || undefined,
    warehouse_stocks: warehouseStocks,
    warehouseStocks,
    seller_warehouse_stock_total: sellerWarehouseStockTotal,
    sellerWarehouseStockTotal,
    warehouse_stock_complete: warehouseStockComplete,
    warehouseStockComplete,
    warehouse_stock_observation: warehouseStockObservation,
    warehouseStockObservation,
    description_category_id: row.categoryId || undefined,
    category_name: categoryText || undefined,
    description_category_name: categoryText || undefined,
    categoryPath: categoryText || undefined,
    softwareCategoryName: row.softwareCategoryName || undefined,
    softwareCategoryPath: row.softwareCategoryPath || categoryText || undefined,
    softwareCategoryRootName: row.softwareCategoryRootName || undefined,
  };
}

export function toOzonProductInfoItem(row = {}) {
  const images = Array.isArray(row.images) ? row.images.filter(Boolean) : [];
  const primaryImage = row.primaryImageUrl || images[0] || '';
  return {
    ...toOzonProductListItem(row),
    offer_id: row.offerId || '',
    sku: row.sku || '',
    primary_image: primaryImage,
    images: images.length ? images : primaryImage ? [primaryImage] : [],
    price: row.priceValue ?? undefined,
    currency_code: getProductDisplayCurrencyCode(row),
    weight: row.weightKg ?? undefined,
    description_category_id: row.categoryId || undefined,
    category_name: getProductSoftwareCategoryText(row) || undefined,
    description_category_name: getProductSoftwareCategoryText(row) || undefined,
    dimensions: {
      width: row.widthCm ?? undefined,
      height: row.heightCm ?? undefined,
      depth: row.depthCm ?? undefined,
      dimension_unit: 'cm',
      weight_unit: 'kg',
    },
  };
}

export function getOrderEndpointMeta(endpoint = '') {
  if (endpoint === '/v2/posting/fbo/list') return { source: 'FBO', endpointKey: 'orders.fboList', detail: false };
  if (endpoint === '/v3/posting/fbs/unfulfilled/list')
    return { source: 'FBS', endpointKey: 'orders.fbsUnfulfilledList', detail: false };
  if (endpoint === '/v3/posting/fbs/get') return { source: 'FBS', endpointKey: 'orders.fbsGet', detail: true };
  if (endpoint === '/v2/posting/fbo/get') return { source: 'FBO', endpointKey: 'orders.fboGet', detail: true };
  return { source: 'FBS', endpointKey: 'orders.fbsList', detail: false };
}

export function isLocalApiTransportError(error = {}) {
  const code = String(error?.code || error?.payload?.error?.code || '').trim();
  const status = Number(error?.status) || 0;
  const message = [
    error?.message,
    error?.payload?.errorMessage,
    error?.payload?.error?.message,
    error?.cause?.message,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (code === 'LOCAL_API_TRANSPORT_FAILED' || code === 'LOCAL_API_TIMEOUT') return true;
  if (status !== 0) return false;
  return /(?:无法连接本地\s*API|local-api 请求超时|ECONNREFUSED|ECONNRESET|EPIPE|socket\s*hang\s*up|fetch\s*failed|network\s*error|connection\s*(?:refused|reset))/iu.test(
    message
  );
}

export function sleepLocalOrderSync(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, ms));
  });
}

export function getLocalOrderSyncJobId(payload = {}) {
  return String(payload?.jobId || payload?.job?.jobId || payload?.job?.id || payload?.id || '').trim();
}

export function getLocalOrderSyncJob(payload = {}) {
  return payload?.job && typeof payload.job === 'object' ? payload.job : payload;
}

export function getLocalOrderSyncStatus(payload = {}) {
  const job = getLocalOrderSyncJob(payload);
  return String(job?.status || payload?.status || '').trim();
}

export function createLocalOrderSyncSubmitError(syncPayload = {}) {
  if (isLocalApiTransportError(syncPayload?.submitError)) {
    return new LocalApiError('本地服务连接中断，已停止本批剩余店铺读取并保留当前缓存。', {
      status: 0,
      code: 'LOCAL_API_TRANSPORT_FAILED',
      payload: { submitError: syncPayload.submitError },
    });
  }
  return new LocalApiError('订单 Ozon 同步任务提交失败，已保留当前本地缓存。', {
    status: 0,
    code: 'LOCAL_ORDER_SYNC_SUBMIT_FAILED',
    payload: syncPayload,
  });
}

export function createLocalReturnsSyncSubmitError(syncPayload = {}) {
  return new LocalApiError('售后 Ozon 同步任务提交失败，已保留当前本地缓存。', {
    status: 0,
    code: 'LOCAL_RETURNS_SYNC_SUBMIT_FAILED',
    payload: syncPayload,
  });
}

export function toOzonOrderPosting(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  return {
    ...raw,
    posting_number: row.posting_number || row.postingNumber || raw.posting_number,
    postingNumber: row.postingNumber || row.posting_number || raw.postingNumber,
    order_id: row.order_id || row.orderId || raw.order_id,
    orderId: row.orderId || row.order_id || raw.orderId,
    status: row.status || raw.status,
    substatus: row.substatus || raw.substatus,
    in_process_at: row.in_process_at || row.inProcessAt || raw.in_process_at,
    shipment_date: row.shipment_date || raw.shipment_date,
    delivering_date: row.delivering_date || raw.delivering_date,
    cutoff_at: row.cutoff_at || raw.cutoff_at,
    products: Array.isArray(row.products) ? row.products : Array.isArray(raw.products) ? raw.products : [],
    analytics_data: row.analytics_data || raw.analytics_data,
    financial_data: row.financial_data || raw.financial_data,
    source: row.source || row.fulfillment || raw.source,
  };
}

export function getLocalOrderSyncParams(body = {}) {
  const params = body && typeof body === 'object' ? { ...body } : {};
  [
    'autoSync',
    'syncMaxPages',
    'maxPages',
    'forceRefresh',
    'pageSize',
    'offset',
    'limit',
    'priority',
    'profile',
    'schedulerProfile',
    'syncSource',
    'requestedBy',
  ].forEach((key) => delete params[key]);
  return params;
}

export function getFinanceDateRangeFromBody(body = {}) {
  const filterDate = body?.filter?.date || body?.date || {};
  return {
    from: filterDate.from || body.from || body.since || body.dateFrom || '',
    to: filterDate.to || body.to || body.dateTo || '',
  };
}

export function toOzonFinanceOperation(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  return {
    ...raw,
    operation_id: row.operation_id || row.operationId || raw.operation_id,
    posting_number: row.posting_number || row.postingNumber || raw.posting_number || raw.posting?.posting_number,
    order_id: row.order_id || row.orderId || raw.order_id || raw.posting?.order_id,
    operation_type: row.operation_type || row.operationType || raw.operation_type,
    operation_type_name: row.operation_type_name || row.operationTypeName || raw.operation_type_name,
    transaction_type: row.transaction_type || row.transactionType || raw.transaction_type,
    operation_date: row.operation_date || row.operationDate || raw.operation_date,
    amount: raw.amount ?? row.amountTotal,
    currency_code: row.currency_code || row.currencyCode || raw.currency_code,
    services: Array.isArray(row.services) ? row.services : Array.isArray(raw.services) ? raw.services : [],
    acquiringFeeCny: row.acquiringFeeCny,
    sale_commission:
      raw.sale_commission ??
      row.sale_commission ??
      row.saleCommission ??
      row.sale_commission_cny ??
      row.saleCommissionCny,
    saleCommissionCny: row.saleCommissionCny,
    deliveryFeeCny: row.deliveryFeeCny,
  };
}

export function getReturnsEndpointMeta(endpoint = '') {
  if (endpoint === '/v2/returns/rfbs/list')
    return { source: 'rfbs-return', endpointKey: 'returns.rfbsList', detail: false };
  if (endpoint === '/v2/returns/rfbs/get')
    return { source: 'rfbs-return', endpointKey: 'returns.rfbsGet', detail: true };
  if (endpoint === '/v2/conditional-cancellation/list') {
    return { source: 'conditional', endpointKey: 'returns.conditionalCancellationList', detail: false };
  }
  return { source: 'returns', endpointKey: 'returns.list', detail: false };
}

export function normalizeReturnStateText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    return String(
      value.state || value.status || value.state_name || value.group_state || value.name || value.title || ''
    ).trim();
  }
  const text = String(value || '').trim();
  return text === '[object Object]' ? '' : text;
}

export function firstReturnText(...values) {
  for (const value of values) {
    const text = normalizeReturnStateText(value);
    if (text) return text;
  }
  return '';
}

export function toOzonReturnItem(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const statusText = firstReturnText(row.status, raw.status, row.state, raw.state, raw.return_status);
  const stateValue =
    raw.state && typeof raw.state === 'object'
      ? raw.state
      : firstReturnText(row.state, statusText, raw.state, raw.status);
  return {
    ...raw,
    id: row.return_id || row.returnId || row.id || raw.id,
    return_id: row.return_id || row.returnId || raw.return_id,
    returnId: row.returnId || row.return_id || raw.returnId,
    posting_number: row.posting_number || row.postingNumber || raw.posting_number,
    postingNumber: row.postingNumber || row.posting_number || raw.postingNumber,
    order_id: row.order_id || row.orderId || raw.order_id,
    orderId: row.orderId || row.order_id || raw.orderId,
    source: row.source || raw.source,
    status: statusText,
    state: stateValue,
    substatus: row.substatus || raw.substatus,
    reason: row.reason || row.return_reason || raw.reason,
    return_reason: row.return_reason || row.reason || raw.return_reason,
    reasonRaw:
      row.reasonRaw || row.reason_raw || row.return_reason_raw || raw.reasonRaw || raw.reason_raw || raw.return_reason_raw,
    reason_raw:
      row.reason_raw || row.reasonRaw || row.return_reason_raw || raw.reason_raw || raw.reasonRaw || raw.return_reason_raw,
    return_reason_raw:
      row.return_reason_raw || row.reasonRaw || row.reason_raw || raw.return_reason_raw || raw.reasonRaw || raw.reason_raw,
    reasonZh: row.reasonZh || row.reason_zh || row.return_reason_zh || raw.reasonZh || raw.reason_zh || raw.return_reason_zh,
    reason_zh: row.reason_zh || row.reasonZh || row.return_reason_zh || raw.reason_zh || raw.reasonZh || raw.return_reason_zh,
    return_reason_zh:
      row.return_reason_zh || row.reasonZh || row.reason_zh || raw.return_reason_zh || raw.reasonZh || raw.reason_zh,
    reasonTranslationStatus:
      row.reasonTranslationStatus || row.reason_translation_status || raw.reasonTranslationStatus || raw.reason_translation_status,
    reason_translation_status:
      row.reason_translation_status || row.reasonTranslationStatus || raw.reason_translation_status || raw.reasonTranslationStatus,
    reasonTranslationProvider:
      row.reasonTranslationProvider || row.reason_translation_provider || raw.reasonTranslationProvider || raw.reason_translation_provider,
    reason_translation_provider:
      row.reason_translation_provider || row.reasonTranslationProvider || raw.reason_translation_provider || raw.reasonTranslationProvider,
    decision: row.decision || raw.decision,
    created_at: row.created_at || row.createdAt || raw.created_at,
    updated_at: row.updated_at || row.updatedAt || raw.updated_at,
    product: row.product || raw.product,
    products: Array.isArray(row.products) ? row.products : row.product ? [row.product] : raw.products,
    financial_data: row.financial_data || raw.financial_data,
  };
}

export function getReturnsDateRangeFromBody(body = {}) {
  const filter = body?.filter && typeof body.filter === 'object' ? body.filter : {};
  return {
    since: filter.since || filter.created_since || body.since || body.created_since || '',
    to: filter.to || filter.created_to || body.to || body.created_to || '',
  };
}

export function getLogisticsEndpointMeta(endpoint = '') {
  if (endpoint === '/v2/delivery-method/list') return { endpointKey: 'deliveryMethod.list', type: 'delivery-methods' };
  return { endpointKey: 'warehouse.list', type: 'warehouses' };
}

export function getLogisticsPayloadItems(payload = {}, type = '') {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.result?.items)) return payload.result.items;
  if (type === 'warehouses') {
    if (Array.isArray(payload.warehouses)) return payload.warehouses;
    if (Array.isArray(payload.result?.warehouses)) return payload.result.warehouses;
    if (Array.isArray(payload.warehouse_list)) return payload.warehouse_list;
    if (Array.isArray(payload.result?.warehouse_list)) return payload.result.warehouse_list;
  }
  if (type === 'delivery-methods') {
    if (Array.isArray(payload.delivery_methods)) return payload.delivery_methods;
    if (Array.isArray(payload.result?.delivery_methods)) return payload.result.delivery_methods;
    if (Array.isArray(payload.methods)) return payload.methods;
    if (Array.isArray(payload.result?.methods)) return payload.result.methods;
  }
  return [];
}

export function normalizeLocalLogisticsLimit(value, fallback = 100) {
  const numeric = Number(value);
  const limit = Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
  return Math.min(Math.max(limit, 1), 100);
}

export function getLocalLogisticsSyncParams(body = {}, meta = {}) {
  const {
    autoSync: _autoSync,
    backgroundRefresh: _backgroundRefresh,
    forceRefresh: _forceRefresh,
    shopId: _shopId,
    shop_id: _shop_id,
    clientId: _clientId,
    client_id: _client_id,
    apiKey: _apiKey,
    api_key: _api_key,
    ...params
  } = body && typeof body === 'object' ? body : {};
  if (meta.endpointKey === 'deliveryMethod.list' || meta.endpointKey === 'warehouse.list') {
    params.limit = normalizeLocalLogisticsLimit(params.limit);
  }
  return params;
}

export function createLocalLogisticsSyncError(syncWaitResult = {}) {
  if (syncWaitResult.timedOut) {
    return new LocalApiError('仓库物流同步已提交 Ozon，但后台确认超时，已保留当前本地缓存。', {
      status: 0,
      code: 'LOCAL_LOGISTICS_SYNC_TIMEOUT',
      payload: syncWaitResult,
    });
  }
  const message =
    syncWaitResult?.job?.lastError ||
    syncWaitResult?.payload?.error?.message ||
    syncWaitResult?.error?.message ||
    '仓库物流 Ozon 同步未完成，已保留当前本地缓存。';
  return new LocalApiError('仓库物流 Ozon 同步未完成，已保留当前本地缓存。', {
    status: 0,
    code: 'LOCAL_LOGISTICS_SYNC_FAILED',
    payload: {
      ...syncWaitResult,
      errorMessage: message,
    },
  });
}

export function createLocalLogisticsSyncSubmitError(syncPayload = {}) {
  return new LocalApiError('仓库物流 Ozon 同步任务提交失败，已保留当前本地缓存。', {
    status: 0,
    code: 'LOCAL_LOGISTICS_SYNC_SUBMIT_FAILED',
    payload: syncPayload,
  });
}

export function getRatingPenaltyDateRangeFromBody(body = {}) {
  const filter = body?.filter && typeof body.filter === 'object' ? body.filter : {};
  return {
    since: filter.date_from || filter.from || body.from || body.since || '',
    to: filter.date_to || filter.to || body.to || body.dateTo || '',
  };
}

export function getLocalProductPriceJson(row = {}) {
  return row.priceJson && typeof row.priceJson === 'object' ? row.priceJson : {};
}

export function buildLocalProductPriceEvidence(row, displayCurrencyCode) {
  const rawPrice = getLocalProductPriceJson(row);
  return {
    price: rawPrice.price ?? row.priceValue ?? undefined,
    marketing_price: rawPrice.marketing_price ?? row.priceValue ?? undefined,
    marketing_seller_price: rawPrice.marketing_seller_price ?? row.priceValue ?? undefined,
    old_price: rawPrice.old_price ?? undefined,
    min_price: rawPrice.min_price ?? undefined,
    currency_code: rawPrice.currency_code || displayCurrencyCode,
  };
}

export function buildLocalProductFinancialData(row = {}) {
  return row.acquiringFeeValue === null || row.acquiringFeeValue === undefined
    ? {}
    : { acquiring: row.acquiringFeeValue, acquiring_amount: row.acquiringFeeValue };
}

export function buildLocalProductCommissions(row = {}) {
  const rawPrice = getLocalProductPriceJson(row);
  const raw = rawPrice.commissions && typeof rawPrice.commissions === 'object' ? rawPrice.commissions : {};
  const normalized = row.commissionPercents && typeof row.commissionPercents === 'object' ? row.commissionPercents : {};
  return {
    sales_percent_fbo: raw.sales_percent_fbo ?? normalized.fbo ?? undefined,
    sales_percent_fbs: raw.sales_percent_fbs ?? normalized.fbs ?? undefined,
    sales_percent_rfbs: raw.sales_percent_rfbs ?? normalized.rfbs ?? row.commissionPercent ?? undefined,
    sales_percent_fbp: raw.sales_percent_fbp ?? normalized.fbp ?? undefined,
  };
}
