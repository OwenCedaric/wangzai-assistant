const WRITE_ENDPOINT_PATTERNS = [
  /\/cancel/i,
  /\/create/i,
  /\/update/i,
  /\/import/i,
  /\/archive/i,
  /\/unarchive/i,
  /\/stocks?$/i,
  /\/prices?$/i,
  /\/ship/i,
  /\/approve/i,
  /\/reject/i,
  /\/verify/i,
  /\/receive-return/i,
  /\/return-money/i,
  /\/compensate/i,
  /\/action\/set/i,
  /\/delivered/i,
  /\/delivering/i,
  /\/last-mile/i,
  /\/tracking-number\/set/i,
  /\/timeslot\/set/i,
  /\/cutoff\/set/i,
  /\/multiboxqty\/set/i,
  /\/exemplar\/(set|update|create-or-get)/i,
  /\/order\/(create|update|cancel|cancelOrder|createOrder|updateOrderSheet|updateOrderPackage)/i,
];

const SENSITIVE_FIELD_PATTERNS = [
  /api[-_ ]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /authorization/i,
  /client[-_ ]?id/i,
  /client[-_ ]?secret/i,
  /company[-_ ]?secret/i,
];
const SENSITIVE_VALUE_PATTERNS = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /(api[-_ ]?key|token|secret|password|authorization|client[-_ ]?secret|company[-_ ]?secret)\s*[:=]\s*[^,\s}]+/gi,
];

const INTERFACE_REGISTRY = new Map();

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeProvider(value) {
  return normalizeText(value || 'unknown').toLowerCase();
}

function normalizeMethod(value) {
  return normalizeText(value || 'POST').toUpperCase();
}

function normalizeEndpoint(value) {
  return normalizeText(value);
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map(normalizeText).filter(Boolean) : [];
}

function normalizeBoolean(value, fallback = true) {
  if (value === true || value === false) return value;
  return fallback;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function compactMetadataKeyParts(parts = []) {
  return parts.map(normalizeText).filter(Boolean).join(':');
}

function getRegistryKey(provider, endpoint, method = 'POST') {
  return `${normalizeProvider(provider)}:${normalizeMethod(method)}:${normalizeEndpoint(endpoint)}`;
}

function isProbablyWriteEndpoint(endpoint) {
  const text = normalizeEndpoint(endpoint);
  return WRITE_ENDPOINT_PATTERNS.some((pattern) => pattern.test(text));
}

export function registerExternalInterface(definition = {}) {
  const provider = normalizeProvider(definition.provider);
  const endpoint = normalizeEndpoint(definition.endpoint);
  if (!provider || !endpoint) return null;
  const method = normalizeMethod(definition.method);
  const access = definition.access === 'write' || definition.write === true ? 'write' : 'read';
  const domain = normalizeText(definition.domain || 'unknown');
  const page = normalizeText(definition.page || definition.module || '');
  const purpose = normalizeText(definition.purpose || definition.use || `${domain}:${page || endpoint}`);
  const entityKey = normalizeText(
    definition.entityKey ||
      compactMetadataKeyParts([domain, page, access === 'write' ? 'write-operation' : 'response-row'])
  );
  const entry = {
    provider,
    endpoint,
    method,
    access,
    allowed: normalizeBoolean(definition.allowed, true),
    domain,
    purpose,
    page,
    shopScope: normalizeText(definition.shopScope || 'shop'),
    timeScope: normalizeText(definition.timeScope || ''),
    pagination: normalizeText(definition.pagination || ''),
    concurrencyLimit: normalizePositiveInteger(definition.concurrencyLimit || definition.concurrency, access === 'write' ? 1 : 2),
    cache: normalizeText(definition.cache || ''),
    cacheKey: normalizeText(definition.cacheKey || compactMetadataKeyParts([provider, domain, page, endpoint])),
    entityKey,
    retry: normalizeText(definition.retry || definition.retryPolicy || ''),
    retryPolicy: normalizeText(definition.retryPolicy || definition.retry || ''),
    merge: normalizeText(definition.merge || definition.mergePolicy || ''),
    mergePolicy: normalizeText(definition.mergePolicy || definition.merge || ''),
    logPolicy: normalizeText(definition.logPolicy || ''),
    sensitiveFields: normalizeStringList(definition.sensitiveFields),
    indexFields: normalizeStringList(definition.indexFields),
    returnFieldMapping: normalizeText(definition.returnFieldMapping || definition.returnFields || 'provider-response-to-domain-entity'),
  };
  INTERFACE_REGISTRY.set(getRegistryKey(provider, endpoint, method), entry);
  return entry;
}

export function getExternalInterfaceRegistration(provider, endpoint, method = 'POST') {
  return INTERFACE_REGISTRY.get(getRegistryKey(provider, endpoint, method)) || null;
}

export function listExternalInterfaceRegistrations() {
  return Array.from(INTERFACE_REGISTRY.values());
}

export function getExternalInterfaceAccess(provider, endpoint, method = 'POST') {
  const registered = getExternalInterfaceRegistration(provider, endpoint, method);
  if (registered) return registered.access;
  return isProbablyWriteEndpoint(endpoint) ? 'write' : 'read';
}

export function assertExternalInterfaceAllowed(options = {}) {
  const provider = normalizeProvider(options.provider);
  const endpoint = normalizeEndpoint(options.endpoint);
  const method = normalizeMethod(options.method);
  const requestedAccess = options.access === 'write' ? 'write' : 'read';
  const registeredEntry = getExternalInterfaceRegistration(provider, endpoint, method);
  if (!registeredEntry) {
    throw new Error(`${provider} ${endpoint} is not registered in the external interface registry.`);
  }
  if (registeredEntry.allowed === false) {
    throw new Error(`${provider} ${endpoint} is registered but not allowed to be called.`);
  }
  const actualAccess = registeredEntry.access;

  if (requestedAccess === 'read' && actualAccess === 'write') {
    throw new Error(`${provider} ${endpoint} is registered as a write interface and cannot use the read channel.`);
  }

  if (requestedAccess === 'write' && actualAccess === 'read') {
    throw new Error(`${provider} ${endpoint} is registered as a read interface and cannot use the write channel.`);
  }

  if (requestedAccess === 'write' && options.confirmed !== true) {
    throw new Error(`${provider} ${endpoint} is a write interface and requires confirmed=true.`);
  }

  return {
    provider,
    endpoint,
    method,
    access: actualAccess,
    registered: true,
  };
}

export function sanitizeExternalInterfaceLog(value) {
  if (Array.isArray(value)) return value.map(sanitizeExternalInterfaceLog);
  if (typeof value === 'string') {
    return SENSITIVE_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key)) ? '[REDACTED]' : sanitizeExternalInterfaceLog(entryValue),
    ])
  );
}

const READ_INTERFACES = [
  { provider: 'ozon', endpoint: '/v2/chat/file/', method: 'GET', domain: 'customerService', page: 'customerService/chat', entityKey: 'clientId+chatFilePath' },
  { provider: 'ozon', endpoint: '/v3/product/list', domain: 'products', page: 'products', pagination: 'last_id/offset', entityKey: 'clientId+offerId/productId/sku', indexFields: ['shop', 'offerId', 'sku', 'status'] },
  { provider: 'ozon', endpoint: '/v3/product/info/list', domain: 'products', page: 'products', entityKey: 'clientId+offerId/productId/sku' },
  { provider: 'ozon', endpoint: '/v1/product/import/info', domain: 'products', page: 'products' },
  { provider: 'ozon', endpoint: '/v1/description-category/tree', domain: 'products', page: 'products/categories', entityKey: 'categoryId' },
  { provider: 'ozon', endpoint: '/v1/description-category/attribute', domain: 'products', page: 'products' },
  { provider: 'ozon', endpoint: '/v1/description-category/attribute/values/search', domain: 'products', page: 'products/categories', pagination: 'offset', entityKey: 'categoryId+attributeId+valueId' },
  { provider: 'ozon', endpoint: '/v3/products/info/attributes', domain: 'products', page: 'products', entityKey: 'clientId+offerId/productId/sku' },
  { provider: 'ozon', endpoint: '/v4/product/info/attributes', domain: 'products', page: 'products' },
  { provider: 'ozon', endpoint: '/v4/product/info/limit', domain: 'products', page: 'products/settings' },
  { provider: 'ozon', endpoint: '/v4/product/info/prices', domain: 'products', page: 'products/profit', entityKey: 'clientId+productId' },
  { provider: 'ozon', endpoint: '/v2/product/pictures/info', domain: 'productImages', page: 'products', entityKey: 'imageUrlHash/productId+imageUrl' },
  { provider: 'ozon', endpoint: '/v5/product/info/prices', domain: 'products', page: 'products/profit', entityKey: 'clientId+productId' },
  { provider: 'ozon', endpoint: '/v4/product/info/stocks', domain: 'products', page: 'products/warehouse', entityKey: 'clientId+productId+warehouseId' },
  { provider: 'ozon', endpoint: '/v2/product/info/stocks-by-warehouse/fbs', domain: 'products', page: 'warehouse', entityKey: 'clientId+productId+warehouseId' },
  { provider: 'ozon', endpoint: '/v1/roles', domain: 'shops', page: 'settings' },
  { provider: 'ozon', endpoint: '/v1/seller/info', domain: 'shops', page: 'settings' },
  { provider: 'ozon', endpoint: '/v1/seller/ozon-logistics/info', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v3/posting/fbs/list', domain: 'salesOrders', page: 'sales/purchase/profit', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+postingNumber', indexFields: ['shop', 'postingNumber', 'offerId', 'sku', 'status'] },
  { provider: 'ozon', endpoint: '/v3/posting/fbs/unfulfilled/list', domain: 'salesOrders', page: 'sales/purchase/profit', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+postingNumber' },
  { provider: 'ozon', endpoint: '/v2/posting/fbo/list', domain: 'salesOrders', page: 'sales/purchase/profit', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+postingNumber' },
  { provider: 'ozon', endpoint: '/v3/posting/fbs/get', domain: 'salesOrders', page: 'sales/details', entityKey: 'clientId+postingNumber' },
  { provider: 'ozon', endpoint: '/v2/posting/fbo/get', domain: 'salesOrders', page: 'sales/details', entityKey: 'clientId+postingNumber' },
  { provider: 'ozon', endpoint: '/v2/posting/fbs/cancel-reason/list', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/returns/list', domain: 'afterSales', page: 'afterSales', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+returnId+postingNumber', indexFields: ['shop', 'returnId', 'postingNumber', 'status'] },
  { provider: 'ozon', endpoint: '/v1/returns/rfbs/get', domain: 'afterSales', page: 'afterSales/details', entityKey: 'clientId+returnId+postingNumber' },
  { provider: 'ozon', endpoint: '/v2/returns/company/fbs', domain: 'afterSales', page: 'afterSales', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+returnId+postingNumber' },
  { provider: 'ozon', endpoint: '/v2/returns/company/fbs/list', domain: 'afterSales', page: 'afterSales', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+returnId+postingNumber' },
  { provider: 'ozon', endpoint: '/v2/returns/rfbs/list', domain: 'afterSales', page: 'afterSales', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+returnId+postingNumber' },
  { provider: 'ozon', endpoint: '/v2/returns/rfbs/get', domain: 'afterSales', page: 'afterSales/details', entityKey: 'clientId+returnId+postingNumber' },
  { provider: 'ozon', endpoint: '/v3/returns/company/fbs', domain: 'afterSales', page: 'afterSales', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+returnId+postingNumber' },
  { provider: 'ozon', endpoint: '/v2/conditional-cancellation/list', domain: 'afterSales', page: 'afterSales', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+cancellationId+postingNumber' },
  { provider: 'ozon', endpoint: '/v3/finance/transaction/list', domain: 'finance', page: 'profit/finance', timeScope: 'selectedRange', pagination: 'page', entityKey: 'clientId+operationId', indexFields: ['shop', 'postingNumber', 'operationId'] },
  { provider: 'ozon', endpoint: '/v1/finance/accrual/by-day', domain: 'finance', page: 'profit/finance', timeScope: 'selectedRange', pagination: 'date/page', entityKey: 'clientId+accrualId/operationId/postingNumber', indexFields: ['shop', 'postingNumber', 'operationId', 'accrualDate'] },
  { provider: 'ozon', endpoint: '/v1/finance/cash-flow-statement/list', domain: 'profit-report', page: 'profit/report', timeScope: 'selectedRange', pagination: 'page', entityKey: 'clientId+periodId', indexFields: ['shop', 'periodBegin', 'periodEnd'] },
  { provider: 'ozon', endpoint: '/v1/finance/balance', domain: 'profit-report', page: 'profit/report', entityKey: 'clientId+recordedAt', indexFields: ['shop', 'recordedAt'] },
  { provider: 'ozon', endpoint: '/v1/rating/index/fbs/posting/list', domain: 'finance', page: 'profit', timeScope: 'selectedRange', pagination: 'offset', entityKey: 'clientId+operationId/postingNumber' },
  { provider: 'ozon', endpoint: '/v2/warehouse/list', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v2/delivery-method/list', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/operation/status', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/fbs/create/drop-off/list', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/fbs/create/drop-off/timeslot/list', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/fbs/create/pick-up/timeslot/list', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/fbs/create/return-point/list', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/actions', method: 'GET', domain: 'marketing', page: 'marketing' },
  { provider: 'ozon', endpoint: '/v1/seller-actions/list', domain: 'marketing', page: 'marketing' },
  { provider: 'ozon', endpoint: '/v1/actions/products', domain: 'marketing', page: 'marketing', pagination: 'offset', entityKey: 'clientId+actionId+productId' },
  { provider: 'ozon', endpoint: '/v1/actions/candidates', domain: 'marketing', page: 'marketing', pagination: 'offset', entityKey: 'clientId+actionId+productId' },
  { provider: 'ozon', endpoint: '/v1/seller-actions/products/list', domain: 'marketing', page: 'marketing', pagination: 'offset', entityKey: 'clientId+actionId+productId' },
  { provider: 'ozon', endpoint: '/v1/seller-actions/products/candidates', domain: 'marketing', page: 'marketing', pagination: 'offset', entityKey: 'clientId+actionId+productId' },
  { provider: 'ozon', endpoint: '/v1/analytics/data', domain: 'analytics', page: 'dashboard/analytics', timeScope: 'selectedRange', entityKey: 'clientId+metric+date', indexFields: ['shop', 'metric', 'date'] },
  { provider: 'ozon', endpoint: '/v5/fbs/posting/product/exemplar/status', domain: 'salesOrders', page: 'sales/details', entityKey: 'clientId+postingNumber+productId' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/token/index', domain: 'crossBorderBus', page: 'settings' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/token/refresh', domain: 'crossBorderBus', page: 'settings' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/user/queryauthorization', domain: 'crossBorderBus', page: 'settings' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/storehouse/searchStorehouseSection', domain: 'crossBorderBus', page: 'settings' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/storehouse/cooperationStorehouse', domain: 'crossBorderBus', page: 'settings' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/orderlist/search', domain: 'crossBorderBus', page: 'purchase/profit', pagination: 'page', entityKey: 'clientId+postingNumber+busOrderId', indexFields: ['shop', 'postingNumber', 'busOrderId'] },
  { provider: 'cross-border-bus', endpoint: '/erpapi/orderlist/status', domain: 'crossBorderBus', page: 'purchase' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/order/get_order_out_info', domain: 'crossBorderBus', page: 'purchase' },
];

const WRITE_INTERFACES = [
  { provider: 'ozon', endpoint: '/v3/product/import', domain: 'products', page: 'products' },
  { provider: 'ozon', endpoint: '/v1/product/import/prices', domain: 'products', page: 'products' },
  { provider: 'ozon', endpoint: '/v2/products/stocks', domain: 'products', page: 'products' },
  { provider: 'ozon', endpoint: '/v1/product/archive', domain: 'products', page: 'products' },
  { provider: 'ozon', endpoint: '/v1/product/unarchive', domain: 'products', page: 'products' },
  { provider: 'ozon', endpoint: '/v1/order/cancel', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/order/create', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/posting/cancel', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/posting/fbs/cancel', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/posting/fbs/product/cancel', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/posting/fbs/awaiting-delivery', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v4/posting/fbs/ship', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v4/posting/fbs/ship/package', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/posting/fbs/package-label/create', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/posting/fbs/package-label/get', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/posting/fbs/split', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/posting/fbs/traceable/split', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v3/posting/multiboxqty/set', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/fbs/posting/product/exemplar/update', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v6/fbs/posting/product/exemplar/set', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v6/fbs/posting/product/exemplar/create-or-get', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/carriage/create', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/carriage/approve', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/carriage/set-postings', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/carriage/cancel', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/posting/fbs/act/create', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/posting/fbs/timeslot/set', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/posting/cutoff/set', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/fbs/posting/tracking-number/set', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/fbs/posting/delivering', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/fbs/posting/last-mile', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/fbs/posting/delivered', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v2/posting/fbs/product/country/set', domain: 'salesOrders', page: 'sales' },
  { provider: 'ozon', endpoint: '/v1/returns/rfbs/action/set', domain: 'afterSales', page: 'afterSales' },
  { provider: 'ozon', endpoint: '/v2/returns/rfbs/reject', domain: 'afterSales', page: 'afterSales' },
  { provider: 'ozon', endpoint: '/v2/returns/rfbs/compensate', domain: 'afterSales', page: 'afterSales' },
  { provider: 'ozon', endpoint: '/v2/returns/rfbs/verify', domain: 'afterSales', page: 'afterSales' },
  { provider: 'ozon', endpoint: '/v2/returns/rfbs/receive-return', domain: 'afterSales', page: 'afterSales' },
  { provider: 'ozon', endpoint: '/v2/returns/rfbs/return-money', domain: 'afterSales', page: 'afterSales' },
  { provider: 'ozon', endpoint: '/v2/conditional-cancellation/approve', domain: 'afterSales', page: 'afterSales' },
  { provider: 'ozon', endpoint: '/v2/conditional-cancellation/reject', domain: 'afterSales', page: 'afterSales' },
  { provider: 'ozon', endpoint: '/v1/actions/products/activate', domain: 'marketing', page: 'marketing' },
  { provider: 'ozon', endpoint: '/v1/actions/products/deactivate', domain: 'marketing', page: 'marketing' },
  { provider: 'ozon', endpoint: '/v1/seller-actions/products/add', domain: 'marketing', page: 'marketing' },
  { provider: 'ozon', endpoint: '/v1/seller-actions/products/delete', domain: 'marketing', page: 'marketing' },
  { provider: 'ozon', endpoint: '/v1/warehouse/fbs/update', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/fbs/create', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/erfbs/aggregator/create', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/erfbs/non-integrated/create', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/polygon/create', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/fbs/first-mile/update', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/archive', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/unarchive', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/rfbs/pause', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/rfbs/unpause', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/erfbs/update', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/erfbs/aggregator/delivery-method/update', domain: 'warehouse', page: 'warehouse' },
  { provider: 'ozon', endpoint: '/v1/warehouse/erfbs/non-integrated/delivery-method/update', domain: 'warehouse', page: 'warehouse' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/user/authorization', domain: 'crossBorderBus', page: 'settings' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/user/unauthorization', domain: 'crossBorderBus', page: 'settings' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/order/createOrder', domain: 'crossBorderBus', page: 'purchase' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/order/updateOrder', domain: 'crossBorderBus', page: 'purchase' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/order/updateOrderSheet', domain: 'crossBorderBus', page: 'purchase' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/order/updateOrderPackage', domain: 'crossBorderBus', page: 'purchase' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/order/cancelOrder', domain: 'crossBorderBus', page: 'purchase' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/ordersync/order_update', domain: 'crossBorderBus', page: 'purchase' },
  { provider: 'cross-border-bus', endpoint: '/erpapi/orderassociation/association_order_account', domain: 'crossBorderBus', page: 'purchase' },
];

READ_INTERFACES.forEach((entry) =>
  registerExternalInterface({
    ...entry,
    access: 'read',
    cache: entry.cache || 'local-mirror',
    retryPolicy: entry.retryPolicy || 'bounded',
    mergePolicy: entry.mergePolicy || 'non-empty-field-merge',
    logPolicy: entry.logPolicy || 'redacted-summary',
    sensitiveFields: entry.sensitiveFields || ['Client-Id', 'Api-Key', 'client_secret', 'access_token', 'authorization'],
  })
);

WRITE_INTERFACES.forEach((entry) =>
  registerExternalInterface({
    ...entry,
    access: 'write',
    cache: 'none',
    retryPolicy: 'manual-confirmation-only',
    mergePolicy: 'not-applicable',
    logPolicy: 'redacted-summary',
    sensitiveFields: ['Client-Id', 'Api-Key', 'client_secret', 'access_token', 'authorization'],
  })
);
